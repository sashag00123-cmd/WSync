import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import type { Readable } from 'node:stream'

import { AppError, CancelledError, throwIfAborted } from '../core/errors'
import { ensureDir } from '../core/fsx'
import type { DownloadResult, TransferOptions } from './types'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_REDIRECTS = 5

export interface HttpResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

interface RequestInit {
  method?: string
  headers?: Record<string, string>
  body?: Buffer | string
  signal?: AbortSignal
  timeoutMs?: number
  /** Не следовать редиректам — нужно, когда важен сам Location. */
  noRedirect?: boolean
}

function agentFor(url: URL): typeof https | typeof http {
  return url.protocol === 'http:' ? http : https
}

/** Обычный запрос с полным чтением тела в память. Только для мелких ответов. */
export async function httpRequest(
  rawUrl: string,
  init: RequestInit = {},
  redirectsLeft = MAX_REDIRECTS
): Promise<HttpResponse> {
  throwIfAborted(init.signal)
  const url = new URL(rawUrl)
  const lib = agentFor(url)

  const response = await new Promise<HttpResponse>((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: init.method ?? 'GET',
        headers: init.headers ?? {}
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks)
          })
        })
      }
    )

    const onAbort = (): void => {
      req.destroy(new CancelledError())
    }
    init.signal?.addEventListener('abort', onAbort, { once: true })
    req.on('close', () => init.signal?.removeEventListener('abort', onAbort))

    req.setTimeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
      req.destroy(new AppError('HTTP_TIMEOUT', 'Истекло время ожидания ответа сервера'))
    })
    req.on('error', reject)

    if (init.body !== undefined) req.write(init.body)
    req.end()
  })

  if (
    init.noRedirect !== true &&
    response.status >= 300 &&
    response.status < 400 &&
    typeof response.headers.location === 'string'
  ) {
    if (redirectsLeft <= 0) {
      throw new AppError('HTTP_REDIRECT_LOOP', 'Слишком много перенаправлений')
    }
    const next = new URL(response.headers.location, url).toString()
    return await httpRequest(rawUrl === next ? next : next, init, redirectsLeft - 1)
  }

  return response
}

export async function httpJson<T>(rawUrl: string, init: RequestInit = {}): Promise<T> {
  const res = await httpRequest(rawUrl, init)
  const text = res.body.toString('utf8')
  if (res.status < 200 || res.status >= 300) {
    throw httpError(res.status, text, rawUrl)
  }
  if (text.trim().length === 0) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new AppError('HTTP_BAD_JSON', 'Сервер вернул не JSON', text.slice(0, 2000))
  }
}

export function httpError(status: number, body: string, url: string): AppError {
  let message = `HTTP ${status}`
  try {
    const parsed = JSON.parse(body) as { message?: string; description?: string; error?: string }
    const detail = parsed.message ?? parsed.description ?? parsed.error
    if (typeof detail === 'string' && detail.length > 0) message = `${message}: ${detail}`
  } catch {
    if (body.trim().length > 0) message = `${message}: ${body.slice(0, 300)}`
  }
  return new AppError(`HTTP_${status}`, message, `${url}\n\n${body.slice(0, 2000)}`)
}

export interface UploadInit extends RequestInit, TransferOptions {
  /** Простой во время передачи тела — признак зависшего соединения. */
  idleTimeoutMs?: number
  /**
   * Ожидание ответа после того, как тело отправлено целиком. Здесь тишина в
   * сокете нормальна: сервер принимает файл, считает хеши, раскладывает его.
   * Поэтому лимит принципиально другой, гораздо больший.
   */
  responseTimeoutMs?: number
  /** Тело ушло полностью — дальше ждём сервер. Полезно в журнале. */
  onBodySent?: () => void
  /** Размер чтения с диска. Влияет на ритм записи в сокет, см. комментарий ниже. */
  readHighWaterMark?: number
}

/**
 * 64 КБ, а не мегабайты. pipe() ждёт полного опустошения буфера сокета перед
 * следующей записью: с куском 4 МБ соединение работает рывками «отдали кусок —
 * ждём» и TCP не успевает разогнать окно. Мелкие куски держат буфер постоянно
 * заполненным. Локально разницы не видно, на реальном канале с задержкой — видно.
 */
const READ_CHUNK_BYTES = 256 * 1024

/** Как часто опрашиваем сокет о реально отправленных байтах. */
const SAMPLE_INTERVAL_MS = 100

const UPLOAD_IDLE_TIMEOUT_MS = 120_000
const UPLOAD_RESPONSE_TIMEOUT_MS = 10 * 60_000

/** Выгрузка файла потоком с прогрессом по фактически отданным байтам. */
export async function uploadFileStream(
  rawUrl: string,
  filePath: string,
  init: UploadInit = {}
): Promise<HttpResponse> {
  throwIfAborted(init.signal)
  const fileSize = (await fsp.stat(filePath)).size
  const range = init.range
  const bodyStart = range === undefined ? 0 : range.start
  const bodyEnd = range === undefined ? fileSize - 1 : range.end
  const stat = { size: Math.max(0, bodyEnd - bodyStart + 1) }
  const url = new URL(rawUrl)
  const lib = agentFor(url)

  return await new Promise<HttpResponse>((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: init.method ?? 'PUT',
        headers: {
          'Content-Length': String(stat.size),
          'Content-Type': 'application/octet-stream',
          ...(init.headers ?? {})
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks)
          })
        })
      }
    )

    const source = createReadStream(filePath, {
      highWaterMark: init.readHighWaterMark ?? READ_CHUNK_BYTES,
      start: bodyStart,
      end: bodyEnd
    })

    // Таймаут считаем сами, а не через req.setTimeout: нужны разные лимиты на
    // передачу и на ожидание ответа, иначе успешно отправленный файл убивается
    // по «простою», хотя сервер в этот момент честно работает.
    let timer: NodeJS.Timeout | null = null
    let sampler: NodeJS.Timeout | null = null
    const clearTimers = (): void => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (sampler !== null) {
        clearInterval(sampler)
        sampler = null
      }
    }
    const arm = (ms: number, message: string): void => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        source.destroy()
        req.destroy(new AppError('HTTP_TIMEOUT', message))
      }, ms)
    }
    const idleMs = init.idleTimeoutMs ?? UPLOAD_IDLE_TIMEOUT_MS
    const armIdle = (): void => {
      arm(idleMs, 'Соединение зависло во время выгрузки: данные перестали уходить')
    }

    const onAbort = (): void => {
      clearTimers()
      source.destroy()
      req.destroy(new CancelledError())
    }
    init.signal?.addEventListener('abort', onAbort, { once: true })
    req.on('close', () => {
      clearTimers()
      init.signal?.removeEventListener('abort', onAbort)
    })

    req.on('error', reject)
    source.on('error', reject)

    /**
     * Прогресс считаем по socket.bytesWritten, а не по прочитанным с диска
     * байтам. Через TLS backpressure протекает: данные уходят в буфер нижнего
     * сокета, и «прочитано с диска» опережает реальную отправку на десятки
     * мегабайт — индикатор показывал 54% и «осталось 1 с», когда на провод
     * ушло втрое меньше. Здесь же и определяем простой: зависшим считается
     * соединение, из которого перестали уходить байты, а не то, из которого
     * перестали читать файл.
     */
    let bodyDone = false
    req.on('socket', (socket) => {
      let lastOnWire = -1
      sampler = setInterval(() => {
        // bytesWritten учитывает и то, что ещё стоит в очереди записи, —
        // вычитаем writableLength, остаётся отданное операционной системе.
        const onWire = Math.max(
          0,
          Math.min(stat.size, socket.bytesWritten - socket.writableLength)
        )
        if (onWire > lastOnWire) {
          lastOnWire = onWire
          init.onProgress?.({ done: onWire, total: stat.size })
          if (!bodyDone) armIdle()
        }
        if (!bodyDone && onWire >= stat.size) {
          bodyDone = true
          init.onBodySent?.()
          arm(
            init.responseTimeoutMs ?? UPLOAD_RESPONSE_TIMEOUT_MS,
            'Файл отправлен, но Яндекс.Диск не ответил о результате'
          )
        }
      }, SAMPLE_INTERVAL_MS)
      if (sampler.unref !== undefined) sampler.unref()
    })

    armIdle()
    source.pipe(req)
  })
}

export interface DownloadInit extends TransferOptions {
  headers?: Record<string, string>
  /** Смещение для докачки. При 0 хеш считается на лету. */
  resumeFrom?: number
  expectedTotal?: number
  timeoutMs?: number
}

/**
 * Скачивание части архива прямо по своему смещению в собираемом файле.
 * Части идут параллельно в один заранее созданный файл, поэтому промежуточных
 * файлов на диске не появляется — для мира на 8 ГБ это экономит 8 ГБ.
 */
export async function downloadIntoFileAt(
  rawUrl: string,
  destPath: string,
  offset: number,
  init: Omit<DownloadInit, 'resumeFrom' | 'writeOffset'> = {}
): Promise<number> {
  throwIfAborted(init.signal)
  const url = new URL(rawUrl)
  const started = await openResponse(url, init, MAX_REDIRECTS)
  if (started.status < 200 || started.status >= 300) {
    const body = await readAll(started.res)
    throw httpError(started.status, body.toString('utf8'), rawUrl)
  }

  const total =
    init.expectedSize ??
    (typeof started.res.headers['content-length'] === 'string'
      ? Number(started.res.headers['content-length'])
      : 0)

  // 'r+' не усекает файл: остальные части пишутся в него одновременно.
  const sink = createWriteStream(destPath, { flags: 'r+', start: offset })
  let written = 0

  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      started.res.destroy()
      sink.destroy()
      reject(new CancelledError())
    }
    init.signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = (): void => init.signal?.removeEventListener('abort', onAbort)

    started.res.on('data', (chunk: Buffer) => {
      written += chunk.length
      init.onProgress?.({ done: written, total })
    })
    started.res.on('error', (err) => {
      cleanup()
      reject(err)
    })
    sink.on('error', (err) => {
      cleanup()
      reject(err)
    })
    sink.on('close', () => {
      cleanup()
      resolve()
    })
    started.res.pipe(sink)
  })

  return written
}

interface StartedResponse {
  status: number
  res: Readable & { headers: http.IncomingHttpHeaders }
}

/** Отправляет GET и отдаёт поток ответа, разворачивая перенаправления. */
async function openResponse(
  url: URL,
  init: DownloadInit,
  redirectsLeft: number
): Promise<StartedResponse> {
  const lib = agentFor(url)
  const started = await new Promise<StartedResponse & { location?: string }>((resolve, reject) => {
    const req = lib.request(url, { method: 'GET', headers: init.headers ?? {} }, (res) => {
      resolve({
        status: res.statusCode ?? 0,
        res: res as StartedResponse['res'],
        location: typeof res.headers.location === 'string' ? res.headers.location : undefined
      })
    })
    const onAbort = (): void => {
      req.destroy(new CancelledError())
    }
    init.signal?.addEventListener('abort', onAbort, { once: true })
    req.on('close', () => init.signal?.removeEventListener('abort', onAbort))
    req.setTimeout(init.timeoutMs ?? 120_000, () => {
      req.destroy(new AppError('HTTP_TIMEOUT', 'Соединение зависло во время скачивания'))
    })
    req.on('error', reject)
    req.end()
  })

  if (started.status >= 300 && started.status < 400 && started.location !== undefined) {
    started.res.resume()
    if (redirectsLeft <= 0) {
      throw new AppError('HTTP_REDIRECT_LOOP', 'Слишком много перенаправлений')
    }
    return await openResponse(new URL(started.location, url), init, redirectsLeft - 1)
  }
  return started
}

/**
 * Скачивание в файл. Поддерживает докачку через Range: если сервер её не
 * поддерживает и отвечает 200 на запрос с Range, файл переписывается с нуля —
 * иначе получим склейку двух половин и битый архив.
 */
export async function downloadToFile(
  rawUrl: string,
  destPath: string,
  init: DownloadInit = {},
  redirectsLeft = MAX_REDIRECTS
): Promise<DownloadResult> {
  throwIfAborted(init.signal)
  await ensureDir(path.dirname(destPath))

  const resumeFrom = init.resumeFrom ?? 0
  const url = new URL(rawUrl)
  const lib = agentFor(url)

  const headers: Record<string, string> = { ...(init.headers ?? {}) }
  if (resumeFrom > 0) headers['Range'] = `bytes=${resumeFrom}-`

  interface Started {
    status: number
    res: Readable & { headers: http.IncomingHttpHeaders }
    location?: string
  }

  const started = await new Promise<Started>((resolve, reject) => {
    const req = lib.request(url, { method: 'GET', headers }, (res) => {
      resolve({
        status: res.statusCode ?? 0,
        res: res as Started['res'],
        location: typeof res.headers.location === 'string' ? res.headers.location : undefined
      })
    })
    const onAbort = (): void => {
      req.destroy(new CancelledError())
    }
    init.signal?.addEventListener('abort', onAbort, { once: true })
    req.on('close', () => init.signal?.removeEventListener('abort', onAbort))
    req.setTimeout(init.timeoutMs ?? 120_000, () => {
      req.destroy(new AppError('HTTP_TIMEOUT', 'Соединение зависло во время скачивания'))
    })
    req.on('error', reject)
    req.end()
  })

  if (started.status >= 300 && started.status < 400 && started.location !== undefined) {
    started.res.resume()
    if (redirectsLeft <= 0) {
      throw new AppError('HTTP_REDIRECT_LOOP', 'Слишком много перенаправлений')
    }
    const next = new URL(started.location, url).toString()
    return await downloadToFile(next, destPath, init, redirectsLeft - 1)
  }

  if (started.status < 200 || started.status >= 300) {
    const body = await readAll(started.res)
    throw httpError(started.status, body.toString('utf8'), rawUrl)
  }

  // Range запрошен, но проигнорирован — начинаем файл заново.
  const appending = resumeFrom > 0 && started.status === 206
  const startOffset = appending ? resumeFrom : 0
  const hash = startOffset === 0 ? createHash('sha256') : null

  const total =
    init.expectedTotal ??
    (typeof started.res.headers['content-length'] === 'string'
      ? Number(started.res.headers['content-length']) + startOffset
      : 0)

  const sink = createWriteStream(destPath, appending ? { flags: 'a' } : { flags: 'w' })
  let written = startOffset

  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      started.res.destroy()
      sink.destroy()
      reject(new CancelledError())
    }
    init.signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = (): void => init.signal?.removeEventListener('abort', onAbort)

    started.res.on('data', (chunk: Buffer) => {
      hash?.update(chunk)
      written += chunk.length
      init.onProgress?.({ done: written, total })
    })
    started.res.on('error', (err) => {
      cleanup()
      reject(err)
    })
    sink.on('error', (err) => {
      cleanup()
      reject(err)
    })
    sink.on('close', () => {
      cleanup()
      resolve()
    })
    started.res.pipe(sink)
  })

  return { bytes: written, sha256: hash?.digest('hex') ?? null }
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

export interface RetryOptions {
  attempts?: number
  signal?: AbortSignal
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void
}

/** Транспортные сбои и 5xx/429 повторяем; 4xx — нет, это наша ошибка. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof CancelledError) return false
  if (err instanceof AppError) {
    if (err.code === 'HTTP_TIMEOUT') return true
    const match = /^HTTP_(\d{3})$/.exec(err.code)
    if (match !== null) {
      const status = Number(match[1])
      return status === 429 || status >= 500
    }
    return false
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    code === 'EPIPE' ||
    code === 'ENETUNREACH' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND' ||
    code === 'UND_ERR_SOCKET'
  )
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 4
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    throwIfAborted(opts.signal)
    try {
      return await fn(attempt)
    } catch (err) {
      lastError = err
      if (attempt === attempts || !isRetryable(err)) throw err
      const delayMs = Math.min(30_000, 1000 * 2 ** (attempt - 1))
      opts.onRetry?.(attempt, err, delayMs)
      await sleep(delayMs, opts.signal)
    }
  }
  throw lastError
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(new CancelledError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function formToBody(fields: Record<string, string>): { body: string; headers: Record<string, string> } {
  const params = new URLSearchParams(fields)
  const body = params.toString()
  return {
    body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(Buffer.byteLength(body))
    }
  }
}
