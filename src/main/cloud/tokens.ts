import { app, safeStorage } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { writeFileAtomic } from '../core/fsx'

export interface StoredTokens {
  accessToken: string
  refreshToken?: string
  /** Абсолютное время истечения, мс. */
  expiresAt: number
  login?: string
  /** Права, с которыми выдан токен: расширение прав в кабинете его не меняет. */
  scope?: string
}

interface Envelope {
  encrypted: boolean
  payload: string
}

function tokensPath(): string {
  return path.join(app.getPath('userData'), 'tokens.dat')
}

/**
 * Токены лежат зашифрованными средствами ОС (DPAPI на Windows,
 * Keychain на macOS). safeStorage встроен в Electron — нативный keytar
 * с его проблемами сборки не нужен.
 */
export async function saveTokens(tokens: StoredTokens): Promise<void> {
  const json = JSON.stringify(tokens)
  const envelope: Envelope = safeStorage.isEncryptionAvailable()
    ? { encrypted: true, payload: safeStorage.encryptString(json).toString('base64') }
    : { encrypted: false, payload: Buffer.from(json, 'utf8').toString('base64') }
  await writeFileAtomic(tokensPath(), JSON.stringify(envelope))
}

export async function loadTokens(): Promise<StoredTokens | null> {
  let raw: string
  try {
    raw = await fsp.readFile(tokensPath(), 'utf8')
  } catch {
    return null
  }
  try {
    const envelope = JSON.parse(raw) as Envelope
    const buffer = Buffer.from(envelope.payload, 'base64')
    const json = envelope.encrypted ? safeStorage.decryptString(buffer) : buffer.toString('utf8')
    const parsed = JSON.parse(json) as StoredTokens
    if (typeof parsed.accessToken !== 'string' || parsed.accessToken.length === 0) return null
    return parsed
  } catch {
    // Профиль ОС сменился или файл повреждён — считаем, что токена нет.
    return null
  }
}

export async function clearTokens(): Promise<void> {
  await fsp.rm(tokensPath(), { force: true }).catch(() => undefined)
}

/** Шифрование недоступно — предупредим пользователя в UI. */
export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}
