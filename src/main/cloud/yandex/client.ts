import fsp from 'node:fs/promises'

import type { Quota } from '@shared/types'
import { AppError, CancelledError, throwIfAborted } from '../../core/errors'
import { electronNetAvailable, uploadFileViaElectronNet } from '../electron-upload'
import {
  downloadIntoFileAt,
  downloadToFile,
  httpJson,
  httpRequest,
  isRetryable,
  uploadFileStream,
  withRetry,
  type HttpResponse
} from '../http'
import type {
  CloudEntry,
  CloudProvider,
  DownloadResult,
  MoveOptions,
  TransferOptions
} from '../types'
import type { YandexAuth } from './auth'

const API = 'https://cloud-api.yandex.net/v1/disk'
const PAGE_LIMIT = 200

interface YaResource {
  name: string
  path: string
  type: 'dir' | 'file'
  size?: number
  md5?: string
  sha256?: string
  modified?: string
  _embedded?: {
    items: YaResource[]
    total: number
    offset: number
    limit: number
  }
}

interface YaLink {
  href: string
  method: string
  templated?: boolean
}

interface YaOperation {
  status: 'success' | 'failed' | 'in-progress'
}

interface YaDisk {
  total_space: number
  used_space: number
}

function isStatus(err: unknown, status: number): boolean {
  return err instanceof AppError && err.code === `HTTP_${status}`
}

export interface RetryNotice {
  attempt: number
  delayMs: number
  message: string
}

/**
 * Яндекс.Диск через REST API. Работает внутри папки приложения (app:/),
 * поэтому доступа к остальному диску у программы нет — так и в согласии
 * пользователя выглядит честнее, и ревью приложения не требуется.
 */
export class YandexDisk implements CloudProvider {
  readonly id = 'yandex'

  constructor(
    private readonly auth: YandexAuth,
    private readonly onRetry?: (notice: RetryNotice) => void
  ) {}

  /** Логический путь ('atm10/saves/W.zip') → путь API ('app:/atm10/saves/W.zip'). */
  private remote(logical: string): string {
    const clean = logical.replace(/^\/+/, '').replace(/\/+$/, '')
    return clean.length === 0 ? 'app:/' : `app:/${clean}`
  }

  private async headers(): Promise<Record<string, string>> {
    return { Authorization: `OAuth ${await this.auth.accessToken()}` }
  }

  private retryOpts(signal: AbortSignal | undefined, what: string) {
    return {
      signal,
      attempts: 4,
      onRetry: (attempt: number, err: unknown, delayMs: number): void => {
        this.onRetry?.({
          attempt,
          delayMs,
          message: `${what}: попытка ${attempt} не удалась (${
            err instanceof Error ? err.message : String(err)
          }), повтор через ${Math.round(delayMs / 1000)} с`
        })
      }
    }
  }

  async quota(): Promise<Quota> {
    const disk = await withRetry(
      async () => await httpJson<YaDisk>(`${API}/`, { headers: await this.headers() }),
      this.retryOpts(undefined, 'Чтение сведений о диске')
    )
    return { total: disk.total_space, used: disk.used_space }
  }

  async ensureFolder(logical: string): Promise<void> {
    const clean = logical.replace(/^\/+/, '').replace(/\/+$/, '')
    if (clean.length === 0) return
    const segments = clean.split('/')
    let current = ''
    for (const segment of segments) {
      current = current.length === 0 ? segment : `${current}/${segment}`
      const url = `${API}/resources?path=${encodeURIComponent(this.remote(current))}`
      try {
        await withRetry(
          async () => await httpJson<YaResource>(url, { method: 'PUT', headers: await this.headers() }),
          this.retryOpts(undefined, `Создание папки ${current}`)
        )
      } catch (err) {
        // 409 — папка уже есть, это нормальный результат.
        if (!isStatus(err, 409)) throw err
      }
    }
  }

  async list(logical: string): Promise<CloudEntry[]> {
    const out: CloudEntry[] = []
    let offset = 0
    for (;;) {
      const url =
        `${API}/resources?path=${encodeURIComponent(this.remote(logical))}` +
        `&limit=${PAGE_LIMIT}&offset=${offset}`
      let resource: YaResource
      try {
        resource = await withRetry(
          async () => await httpJson<YaResource>(url, { headers: await this.headers() }),
          this.retryOpts(undefined, `Чтение папки ${logical}`)
        )
      } catch (err) {
        if (isStatus(err, 404)) return out
        throw err
      }
      const items = resource._embedded?.items ?? []
      for (const item of items) out.push(toEntry(item, `${logical}/${item.name}`))
      if (items.length < PAGE_LIMIT) return out
      offset += items.length
    }
  }

  async stat(logical: string): Promise<CloudEntry | null> {
    const url = `${API}/resources?path=${encodeURIComponent(this.remote(logical))}`
    try {
      const resource = await withRetry(
        async () => await httpJson<YaResource>(url, { headers: await this.headers() }),
        this.retryOpts(undefined, `Чтение ${logical}`)
      )
      return toEntry(resource, logical)
    } catch (err) {
      if (isStatus(err, 404)) return null
      throw err
    }
  }

  async readJson<T>(logical: string): Promise<T | null> {
    let link: YaLink
    try {
      link = await this.downloadLink(logical, undefined)
    } catch (err) {
      if (isStatus(err, 404)) return null
      throw err
    }
    const response = await withRetry(
      async () => await httpRequest(link.href, { headers: await this.headers() }),
      this.retryOpts(undefined, `Чтение ${logical}`)
    )
    if (response.status === 404) return null
    if (response.status < 200 || response.status >= 300) {
      throw new AppError(`HTTP_${response.status}`, `Не удалось прочитать ${logical}`)
    }
    const text = response.body.toString('utf8')
    if (text.trim().length === 0) return null
    try {
      return JSON.parse(text) as T
    } catch {
      throw new AppError('CLOUD_BAD_JSON', `Файл ${logical} в облаке повреждён (не JSON)`, text.slice(0, 2000))
    }
  }

  async writeJson(logical: string, data: unknown): Promise<void> {
    const body = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8')
    await withRetry(async () => {
      const link = await this.uploadLink(logical, true, undefined)
      const response = await httpRequest(link.href, {
        method: link.method === 'POST' ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
        body
      })
      if (response.status < 200 || response.status >= 300) {
        throw new AppError(`HTTP_${response.status}`, `Не удалось записать ${logical}`)
      }
    }, this.retryOpts(undefined, `Запись ${logical}`))
  }

  private async uploadLink(
    logical: string,
    overwrite: boolean,
    signal: AbortSignal | undefined
  ): Promise<YaLink> {
    const url =
      `${API}/resources/upload?path=${encodeURIComponent(this.remote(logical))}` +
      `&overwrite=${overwrite ? 'true' : 'false'}`
    return await httpJson<YaLink>(url, { headers: await this.headers(), signal })
  }

  private async downloadLink(logical: string, signal: AbortSignal | undefined): Promise<YaLink> {
    const url = `${API}/resources/download?path=${encodeURIComponent(this.remote(logical))}`
    return await httpJson<YaLink>(url, { headers: await this.headers(), signal })
  }

  async uploadFile(
    localPath: string,
    logical: string,
    opts: TransferOptions = {}
  ): Promise<CloudEntry> {
    const fileSize = (await fsp.stat(localPath)).size
    const stat = {
      size:
        opts.range === undefined
          ? fileSize
          : Math.max(0, opts.range.end - opts.range.start + 1)
    }

    await withRetry(async (attempt) => {
      throwIfAborted(opts.signal)

      // Таймаут ответа не означает, что файл не дошёл: Диск мог принять его и
      // промолчать. Перед повтором проверяем — иначе гоняем гигабайты впустую.
      if (attempt > 1) {
        const existing = await this.stat(logical)
        if (existing !== null && existing.size === stat.size) {
          opts.onNote?.('Файл уже оказался в облаке — повторная выгрузка не нужна')
          return
        }
      }

      // Ссылка на выгрузку одноразовая и живёт недолго — берём новую на каждую попытку.
      const link = await this.uploadLink(logical, true, opts.signal)
      // Хост загрузчика полезен в диагностике медленной выгрузки: Диск выдаёт
      // разные узлы, и скорость до них отличается.
      const viaChromium = electronNetAvailable()
      opts.onNote?.(
        `Узел загрузки: ${safeHost(link.href)} (транспорт: ${viaChromium ? 'Chromium' : 'Node'})`
      )
      const transferOpts = {
        method: link.method === 'POST' ? 'POST' : 'PUT',
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(opts.range !== undefined ? { range: opts.range } : {}),
        ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
        onBodySent: () => {
          opts.onNote?.('Данные отданы в сеть, ждём подтверждения Яндекс.Диска')
          opts.onBodySent?.()
        }
      }
      // Стек Chromium на реальном канале оказался кратно быстрее node:https.
      // Но он не даёт выставить Content-Length и передаёт тело chunked —
      // если Диск такое не примет, честно откатываемся на Node-транспорт.
      let response: HttpResponse
      if (viaChromium) {
        try {
          response = await uploadFileViaElectronNet(link.href, localPath, transferOpts)
          if (response.status === 400 || response.status === 411) {
            opts.onNote?.(
              `Диск отказался от потоковой передачи (HTTP ${response.status}) — ` +
                `повторяем через Node-транспорт`
            )
            response = await uploadFileStream(link.href, localPath, transferOpts)
          }
        } catch (err) {
          // Отмену и таймаут не «лечим» сменой транспорта: первое — воля
          // пользователя, второе — состояние сети, и повтор всё равно будет.
          if (err instanceof CancelledError) throw err
          if (err instanceof AppError && err.code === 'HTTP_TIMEOUT') throw err
          opts.onNote?.(
            `Транспорт Chromium не сработал (${err instanceof Error ? err.message : String(err)}) — ` +
              `повторяем через Node-транспорт`
          )
          response = await uploadFileStream(link.href, localPath, transferOpts)
        }
      } else {
        response = await uploadFileStream(link.href, localPath, transferOpts)
      }
      if (response.status === 202) return
      if (response.status < 200 || response.status >= 300) {
        throw new AppError(
          `HTTP_${response.status}`,
          `Выгрузка не удалась (HTTP ${response.status})`,
          response.body.toString('utf8').slice(0, 2000)
        )
      }
    }, this.retryOpts(opts.signal, 'Выгрузка архива'))

    // Диск считает хеши асинхронно после приёма файла — ждём, пока появятся.
    const entry = await this.awaitEntry(logical, stat.size, opts.signal, opts.onNote)
    return entry
  }

  /** Ждёт появления файла с посчитанными хешами (после 202 это не мгновенно). */
  private async awaitEntry(
    logical: string,
    expectedSize: number,
    signal: AbortSignal | undefined,
    onNote?: (message: string) => void
  ): Promise<CloudEntry> {
    const startedAt = Date.now()
    const deadline = startedAt + 60_000
    let delay = 1000
    let noted = false
    for (;;) {
      throwIfAborted(signal)
      if (!noted && Date.now() - startedAt > 5000) {
        onNote?.('Ждём, пока Яндекс.Диск посчитает контрольную сумму файла')
        noted = true
      }
      const entry = await this.stat(logical)
      const hashed = entry !== null && (entry.sha256 !== undefined || entry.md5 !== undefined)
      if (entry !== null && entry.size === expectedSize && hashed) return entry
      if (Date.now() > deadline) {
        if (entry !== null) return entry
        throw new AppError('UPLOAD_NOT_VISIBLE', `Файл ${logical} не появился в облаке после выгрузки`)
      }
      await sleep(delay, signal)
      delay = Math.min(5000, delay * 2)
    }
  }

  async downloadFile(
    logical: string,
    localPath: string,
    opts: TransferOptions = {}
  ): Promise<DownloadResult> {
    // Часть архива пишется по своему смещению в уже созданный файл. Докачки
    // здесь нет намеренно: часть невелика, повтор целиком проще и надёжнее,
    // чем вычислять, сколько её байт уже на месте.
    if (opts.writeOffset !== undefined) {
      const offset = opts.writeOffset
      const bytes = await withRetry(async () => {
        throwIfAborted(opts.signal)
        const link = await this.downloadLink(logical, opts.signal)
        return await downloadIntoFileAt(link.href, localPath, offset, {
          headers: await this.headers(),
          ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
          ...(opts.expectedSize !== undefined ? { expectedSize: opts.expectedSize } : {}),
          ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {})
        })
      }, this.retryOpts(opts.signal, `Скачивание ${logical}`))
      return { bytes, sha256: null }
    }

    let resumed = false
    const result = await withRetry(async (attempt) => {
      throwIfAborted(opts.signal)
      // Ссылка на скачивание тоже одноразовая — обновляем на каждой попытке.
      const link = await this.downloadLink(logical, opts.signal)
      let resumeFrom = 0
      if (attempt > 1) {
        resumeFrom = await currentSize(localPath)
        if (resumeFrom > 0) resumed = true
      }
      return await downloadToFile(link.href, localPath, {
        headers: await this.headers(),
        resumeFrom,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {})
      })
    }, this.retryOpts(opts.signal, 'Скачивание архива'))

    // Если была докачка, потоковый хеш неполный — пусть считает вызывающий.
    return resumed ? { bytes: result.bytes, sha256: null } : result
  }

  async move(from: string, to: string, opts: MoveOptions = {}): Promise<void> {
    const url =
      `${API}/resources/move?from=${encodeURIComponent(this.remote(from))}` +
      `&path=${encodeURIComponent(this.remote(to))}` +
      `&overwrite=${opts.overwrite === true ? 'true' : 'false'}`
    const link = await withRetry(
      async () => await httpJson<YaLink>(url, { method: 'POST', headers: await this.headers() }),
      this.retryOpts(undefined, `Перемещение ${from}`)
    )
    if (typeof link?.href === 'string' && link.href.length > 0) {
      await this.awaitOperation(link.href, opts.onNote, opts.signal)
    }
  }

  async remove(logical: string): Promise<void> {
    const url =
      `${API}/resources?path=${encodeURIComponent(this.remote(logical))}&permanently=true`
    const link = await withRetry(async () => {
      const response = await httpRequest(url, { method: 'DELETE', headers: await this.headers() })
      if (response.status === 404) return null
      if (response.status === 204) return null
      if (response.status === 202) {
        return JSON.parse(response.body.toString('utf8')) as YaLink
      }
      throw new AppError(
        `HTTP_${response.status}`,
        `Не удалось удалить ${logical}`,
        response.body.toString('utf8').slice(0, 2000)
      )
    }, this.retryOpts(undefined, `Удаление ${logical}`))

    if (link !== null && typeof link.href === 'string') {
      await this.awaitOperation(link.href)
    }
  }

  /** Долгие операции Диска асинхронные: 202 + ссылка на статус. */
  private async awaitOperation(
    href: string,
    onNote?: (message: string) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const startedAt = Date.now()
    const deadline = startedAt + 5 * 60_000
    let delay = 500
    let nextNoteAt = startedAt + 10_000
    for (;;) {
      throwIfAborted(signal)
      const operation = await withRetry(
        async () => await httpJson<YaOperation>(href, { headers: await this.headers() }),
        this.retryOpts(undefined, 'Ожидание операции Диска')
      )
      if (operation.status === 'success') return
      if (operation.status === 'failed') {
        throw new AppError('CLOUD_OP_FAILED', 'Яндекс.Диск сообщил об ошибке операции')
      }
      // Неизвестный статус раньше молча считался «ещё выполняется», и операция
      // крутилась до самого дедлайна без единого намёка на причину.
      if (operation.status !== 'in-progress') {
        throw new AppError(
          'CLOUD_OP_BAD_STATUS',
          'Яндекс.Диск вернул неожиданный статус операции',
          JSON.stringify(operation)
        )
      }
      if (Date.now() > deadline) {
        throw new AppError('CLOUD_OP_TIMEOUT', 'Операция на Яндекс.Диске не завершилась за 5 минут')
      }
      if (Date.now() >= nextNoteAt) {
        onNote?.(
          `Яндекс.Диск всё ещё выполняет операцию (${Math.round((Date.now() - startedAt) / 1000)} с)`
        )
        nextNoteAt = Date.now() + 30_000
      }
      await sleep(delay, signal)
      delay = Math.min(4000, delay * 2)
    }
  }
}

function toEntry(resource: YaResource, logicalPath: string): CloudEntry {
  const entry: CloudEntry = {
    name: resource.name,
    path: logicalPath,
    type: resource.type,
    size: resource.size ?? 0
  }
  if (resource.md5 !== undefined) entry.md5 = resource.md5
  if (resource.sha256 !== undefined) entry.sha256 = resource.sha256
  if (resource.modified !== undefined) {
    const parsed = Date.parse(resource.modified)
    if (Number.isFinite(parsed)) entry.modified = parsed
  }
  return entry
}

/** Только хост: сама ссылка одноразовая, но всё равно не место ей в журнале. */
function safeHost(href: string): string {
  try {
    return new URL(href).host
  } catch {
    return 'неизвестно'
  }
}

async function currentSize(file: string): Promise<number> {
  try {
    return (await fsp.stat(file)).size
  } catch {
    return 0
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(new AppError('CANCELLED', 'Операция отменена'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export { isRetryable }
