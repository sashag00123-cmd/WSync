import crypto from 'node:crypto'

import type { AuthState } from '@shared/types'
import { AppError } from '../../core/errors'
import { formToBody, httpJson } from '../http'
import { clearTokens, loadTokens, saveTokens, type StoredTokens } from '../tokens'

const AUTHORIZE_URL = 'https://oauth.yandex.ru/authorize'
const TOKEN_URL = 'https://oauth.yandex.ru/token'
const USERINFO_URL = 'https://login.yandex.ru/info?format=json'

/**
 * Единственный поддерживаемый redirect: страница Яндекса, которая показывает
 * код подтверждения. Локальный редирект на localhost убран — зарегистрировать
 * такой URI у приложения не выходит, а держать нерабочую ветку вредно.
 */
export const MANUAL_REDIRECT = 'https://oauth.yandex.ru/verification_code'

/** Обновляем токен заранее, чтобы не упасть посреди 8-гигабайтной выгрузки. */
const REFRESH_MARGIN_MS = 10 * 60_000

interface TokenResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
  token_type?: string
  scope?: string
}

interface PendingFlow {
  verifier: string
}

export interface AuthConfigSource {
  clientId: string
  clientSecret: string
  /** Пустая строка — параметр scope не передавать. */
  scope: string
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(64))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/**
 * OAuth для Яндекс.Диска: Authorization Code + PKCE. Пользователь разрешает
 * доступ в браузере, Яндекс показывает код, код вводится в приложении.
 * client_secret в открытом коде спрятать невозможно, поэтому основа — PKCE;
 * секрет остаётся опциональным, Яндекс требует его при обновлении токена.
 */
export class YandexAuth {
  private tokens: StoredTokens | null = null
  private loaded = false
  private pending: PendingFlow | null = null
  private refreshing: Promise<string> | null = null

  constructor(
    private readonly readConfig: () => Promise<AuthConfigSource>,
    private readonly notify: (state: AuthState) => void
  ) {}

  /** Диагностика в журнал: без точного URL авторизации ошибки Яндекса не разобрать. */
  onInfo: ((message: string) => void) | null = null

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.tokens = await loadTokens()
    this.loaded = true
  }

  async state(): Promise<AuthState> {
    await this.ensureLoaded()
    const config = await this.readConfig()
    if (config.clientId.length === 0) {
      return { authorized: false, needsClientId: true }
    }
    if (this.tokens === null) return { authorized: false, needsClientId: false }
    return {
      authorized: true,
      needsClientId: false,
      ...(this.tokens.login !== undefined ? { login: this.tokens.login } : {}),
      ...(this.tokens.scope !== undefined ? { grantedScope: this.tokens.scope } : {}),
      expiresAt: this.tokens.expiresAt
    }
  }

  /** Готовит ссылку авторизации. Код пользователь вводит через submitCode. */
  async start(): Promise<{ started: boolean; manualUrl?: string }> {
    const config = await this.readConfig()
    if (config.clientId.length === 0) {
      throw new AppError('NO_CLIENT_ID', 'Не задан client_id приложения Яндекс.OAuth')
    }

    const { verifier, challenge } = createPkce()
    this.pending = { verifier }

    const url = new URL(AUTHORIZE_URL)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', config.clientId)
    url.searchParams.set('redirect_uri', MANUAL_REDIRECT)
    // Запрашиваем ровно те права, что выданы приложению в кабинете. Лишнее
    // право отвергает весь запрос с invalid_scope; пустой scope Яндекс тоже
    // трактует как «прав не запрошено» и отвечает той же ошибкой.
    if (config.scope.length > 0) url.searchParams.set('scope', config.scope)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('force_confirm', 'yes')

    this.onInfo?.(`URL авторизации: ${url.toString()}`)
    return { started: true, manualUrl: url.toString() }
  }

  async submitCode(code: string): Promise<AuthState> {
    const trimmed = code.trim()
    if (trimmed.length === 0) {
      throw new AppError('OAUTH_NO_CODE', 'Код не введён')
    }
    return await this.exchange(trimmed)
  }

  private async exchange(code: string): Promise<AuthState> {
    const pending = this.pending
    if (pending === null) {
      throw new AppError('OAUTH_NO_FLOW', 'Авторизация не была начата — нажмите «Подключить» заново')
    }
    const config = await this.readConfig()
    const fields: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      code_verifier: pending.verifier,
      redirect_uri: MANUAL_REDIRECT
    }
    if (config.clientSecret.length > 0) fields['client_secret'] = config.clientSecret

    const form = formToBody(fields)
    const response = await httpJson<TokenResponse>(TOKEN_URL, {
      method: 'POST',
      headers: form.headers,
      body: form.body
    })

    this.pending = null
    await this.store(response, config.scope)
    const state = await this.state()
    this.notify(state)
    return state
  }

  private async store(response: TokenResponse, requestedScope: string): Promise<void> {
    const tokens: StoredTokens = {
      accessToken: response.access_token,
      expiresAt: Date.now() + Math.max(60, response.expires_in) * 1000,
      // Яндекс не всегда возвращает scope — тогда считаем выданным запрошенное.
      scope: response.scope ?? requestedScope
    }
    if (response.refresh_token !== undefined) tokens.refreshToken = response.refresh_token
    const login = await this.fetchLogin(response.access_token)
    if (login !== null) tokens.login = login
    this.tokens = tokens
    this.loaded = true
    await saveTokens(tokens)
  }

  private async fetchLogin(accessToken: string): Promise<string | null> {
    try {
      const info = await httpJson<{ login?: string; display_name?: string }>(USERINFO_URL, {
        headers: { Authorization: `OAuth ${accessToken}` },
        timeoutMs: 10_000
      })
      return info.display_name ?? info.login ?? null
    } catch {
      // Право login:info могло быть не выдано — имя пользователя не критично.
      return null
    }
  }

  async logout(): Promise<AuthState> {
    this.tokens = null
    this.loaded = true
    this.pending = null
    await clearTokens()
    const state = await this.state()
    this.notify(state)
    return state
  }

  /** Действующий access token, при необходимости обновлённый. */
  async accessToken(): Promise<string> {
    await this.ensureLoaded()
    const tokens = this.tokens
    if (tokens === null) {
      throw new AppError('NOT_AUTHORIZED', 'Нет подключения к Яндекс.Диску — авторизуйтесь в настройках')
    }
    if (tokens.expiresAt - REFRESH_MARGIN_MS > Date.now()) return tokens.accessToken

    // Параллельные операции не должны обновлять токен несколько раз.
    if (this.refreshing === null) {
      this.refreshing = this.refresh(tokens).finally(() => {
        this.refreshing = null
      })
    }
    return await this.refreshing
  }

  private async refresh(tokens: StoredTokens): Promise<string> {
    if (tokens.refreshToken === undefined) {
      await this.logout()
      throw new AppError(
        'TOKEN_EXPIRED',
        'Срок действия токена истёк, а refresh-токена нет. Подключитесь к Яндекс.Диску заново.'
      )
    }
    const config = await this.readConfig()
    const fields: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: config.clientId
    }
    if (config.clientSecret.length > 0) fields['client_secret'] = config.clientSecret

    const form = formToBody(fields)
    try {
      const response = await httpJson<TokenResponse>(TOKEN_URL, {
        method: 'POST',
        headers: form.headers,
        body: form.body
      })
      const next: StoredTokens = {
        accessToken: response.access_token,
        expiresAt: Date.now() + Math.max(60, response.expires_in) * 1000,
        refreshToken: response.refresh_token ?? tokens.refreshToken,
        scope: response.scope ?? tokens.scope ?? config.scope
      }
      if (tokens.login !== undefined) next.login = tokens.login
      this.tokens = next
      await saveTokens(next)
      this.notify(await this.state())
      return next.accessToken
    } catch (err) {
      await this.logout()
      throw new AppError(
        'TOKEN_REFRESH_FAILED',
        'Не удалось обновить токен — подключитесь к Яндекс.Диску заново. ' +
          'Если это повторяется, укажите client_secret приложения в настройках.',
        err instanceof Error ? err.message : String(err)
      )
    }
  }
}
