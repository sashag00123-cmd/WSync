import { net } from 'electron'
import { createReadStream } from 'node:fs'
import fsp from 'node:fs/promises'

import { AppError, CancelledError, throwIfAborted } from '../core/errors'
import type { HttpResponse } from './http'
import type { TransferOptions } from './types'

/**
 * Выгрузка через сетевой стек Chromium вместо `node:https`.
 *
 * Причина прозаична: на реальном канале Node-транспорт выдавал до Яндекса
 * ~0.2 МБ/с, а браузер на той же машине и том же аккаунте — ~9 МБ/с. Chromium
 * несёт своё управление перегрузкой, свои размеры буферов, HTTP/2 и работу с
 * системным прокси; воспроизводить это поверх `node:https` бессмысленно, когда
 * готовый стек уже в процессе.
 *
 * Прогресс считается по колбэкам записи: чанк считается отданным, когда
 * Chromium подтвердил его приём. Это не «байты, подтверждённые сервером» —
 * такого знания у пользовательского процесса нет ни в одном стеке, — но
 * backpressure здесь честный, поэтому цифра близка к реальности.
 */

const CHUNK_BYTES = 256 * 1024
const IDLE_TIMEOUT_MS = 120_000
const RESPONSE_TIMEOUT_MS = 10 * 60_000

export interface ElectronUploadInit extends TransferOptions {
  method?: string
  headers?: Record<string, string>
  idleTimeoutMs?: number
  responseTimeoutMs?: number
  onBodySent?: () => void
}

/** Доступен ли транспорт: в обычном Node (тесты, бенчмарк) — нет. */
export function electronNetAvailable(): boolean {
  try {
    return typeof net?.request === 'function'
  } catch {
    return false
  }
}

export async function uploadFileViaElectronNet(
  rawUrl: string,
  filePath: string,
  init: ElectronUploadInit = {}
): Promise<HttpResponse> {
  throwIfAborted(init.signal)
  const fileSize = (await fsp.stat(filePath)).size
  const bodyStart = init.range === undefined ? 0 : init.range.start
  const bodyEnd = init.range === undefined ? fileSize - 1 : init.range.end
  const stat = { size: Math.max(0, bodyEnd - bodyStart + 1) }

  return await new Promise<HttpResponse>((resolve, reject) => {
    let settled = false
    const fail = (err: unknown): void => {
      if (settled) return
      settled = true
      clearTimers()
      try {
        request.abort()
      } catch {
        // Запрос мог уже завершиться — это не ошибка.
      }
      source.destroy()
      reject(err)
    }
    const succeed = (response: HttpResponse): void => {
      if (settled) return
      settled = true
      clearTimers()
      resolve(response)
    }

    let timer: NodeJS.Timeout | null = null
    const clearTimers = (): void => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      init.signal?.removeEventListener('abort', onAbort)
    }
    const arm = (ms: number, message: string): void => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => fail(new AppError('HTTP_TIMEOUT', message)), ms)
    }
    function onAbort(): void {
      fail(new CancelledError())
    }
    init.signal?.addEventListener('abort', onAbort, { once: true })

    const request = net.request({
      method: init.method ?? 'PUT',
      url: rawUrl
    })
    request.setHeader('Content-Type', 'application/octet-stream')
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      request.setHeader(name, value)
    }
    // Content-Length выставлять нельзя — Chromium управляет им сам и отвечает
    // ERR_INVALID_ARGUMENT. Поэтому включаем chunked: иначе стек попытается
    // определить длину сам, а для многогигабайтного файла это неприемлемо.
    request.chunkedEncoding = true

    const source = createReadStream(filePath, {
      highWaterMark: CHUNK_BYTES,
      start: bodyStart,
      end: bodyEnd
    })

    request.on('error', fail)
    request.on('response', (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('error', fail)
      response.on('end', () => {
        succeed({
          status: response.statusCode,
          headers: response.headers as HttpResponse['headers'],
          body: Buffer.concat(chunks)
        })
      })
    })

    arm(
      init.idleTimeoutMs ?? IDLE_TIMEOUT_MS,
      'Соединение зависло во время выгрузки: данные перестали уходить'
    )

    void (async () => {
      let sent = 0
      try {
        for await (const chunk of source) {
          if (settled) return
          const buffer = chunk as Buffer
          // Ждём подтверждения записи: без этого мы бы просто набивали
          // внутреннюю очередь и снова получили бы врущий прогресс.
          // Ошибки приходят событием 'error' и обрабатываются в fail().
          await new Promise<void>((res) => {
            request.write(buffer, undefined, () => res())
          })
          sent += buffer.length
          init.onProgress?.({ done: sent, total: stat.size })
          arm(
            init.idleTimeoutMs ?? IDLE_TIMEOUT_MS,
            'Соединение зависло во время выгрузки: данные перестали уходить'
          )
        }
        if (settled) return
        request.end()
        init.onBodySent?.()
        arm(
          init.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS,
          'Файл отправлен, но Яндекс.Диск не ответил о результате'
        )
      } catch (err) {
        fail(err)
      }
    })()
  })
}
