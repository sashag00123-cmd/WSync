import { app } from 'electron'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import type { SpeedTestResult } from '@shared/types'
import type { CloudProvider } from '../cloud/types'
import { ensureDir, rmrf } from './fsx'
import type { OperationSinks } from './operation'
import { formatBytes } from './operation'

/**
 * Проверка гипотезы «одиночный поток упирается в окно, параллельные — нет».
 *
 * Замер прямой: одна и та же порция данных заливается сначала одним файлом,
 * затем таким же объёмом, разрезанным на несколько файлов, выгружаемых
 * одновременно. Если параллельная выгрузка кратно быстрее — узкое место
 * в одном соединении, и резать архив на части имеет смысл.
 */

const PAYLOAD_BYTES = 12 * 1024 * 1024
const STREAMS = 4
const REMOTE_DIR = '.wsync_speedtest'

export async function runCloudSpeedTest(
  provider: CloudProvider,
  sinks: OperationSinks
): Promise<SpeedTestResult> {
  const log = (message: string): void => {
    sinks.log({ ts: Date.now(), level: 'info', message })
  }

  const localDir = path.join(app.getPath('temp'), 'wsync-speedtest')
  await ensureDir(localDir)
  const remotePaths: string[] = []

  try {
    await provider.ensureFolder(REMOTE_DIR)

    // ── Один поток ────────────────────────────────────────────────────────
    const singleLocal = path.join(localDir, 'single.bin')
    await fsp.writeFile(singleLocal, crypto.randomBytes(PAYLOAD_BYTES))
    const singleRemote = `${REMOTE_DIR}/single.bin`
    remotePaths.push(singleRemote)

    log(`Проверка скорости: выгружаю ${formatBytes(PAYLOAD_BYTES)} одним потоком…`)
    const singleStarted = Date.now()
    await provider.uploadFile(singleLocal, singleRemote)
    const singleMs = Date.now() - singleStarted
    const singleRate = PAYLOAD_BYTES / (singleMs / 1000)
    log(`Один поток: ${(singleMs / 1000).toFixed(1)} с, ${formatBytes(singleRate)}/с`)

    // ── Несколько потоков ─────────────────────────────────────────────────
    const partBytes = Math.floor(PAYLOAD_BYTES / STREAMS)
    const parts: Array<{ local: string; remote: string }> = []
    for (let index = 0; index < STREAMS; index++) {
      const local = path.join(localDir, `part${index}.bin`)
      await fsp.writeFile(local, crypto.randomBytes(partBytes))
      const remote = `${REMOTE_DIR}/part${index}.bin`
      remotePaths.push(remote)
      parts.push({ local, remote })
    }

    log(
      `Проверка скорости: тот же объём ${STREAMS} потоками по ` +
        `${formatBytes(partBytes)}…`
    )
    const parallelStarted = Date.now()
    await Promise.all(parts.map(async (part) => await provider.uploadFile(part.local, part.remote)))
    const parallelMs = Date.now() - parallelStarted
    const parallelRate = (partBytes * STREAMS) / (parallelMs / 1000)
    log(`${STREAMS} потока: ${(parallelMs / 1000).toFixed(1)} с, ${formatBytes(parallelRate)}/с`)

    const speedup = singleRate > 0 ? parallelRate / singleRate : 0
    log(
      speedup >= 1.8
        ? `Параллельная выгрузка быстрее в ${speedup.toFixed(1)} раза — узкое место ` +
            `в одном соединении, разбиение архива на части даст выигрыш`
        : `Параллельная выгрузка быстрее лишь в ${speedup.toFixed(1)} раза — ` +
            `разбиение архива на части заметного выигрыша не даст`
    )

    return {
      payloadBytes: PAYLOAD_BYTES,
      streams: STREAMS,
      singleBytesPerSec: singleRate,
      parallelBytesPerSec: parallelRate,
      speedup
    }
  } finally {
    // Мусор в облаке и в temp не оставляем даже при ошибке.
    for (const remote of remotePaths) {
      await provider.remove(remote).catch(() => undefined)
    }
    await provider.remove(REMOTE_DIR).catch(() => undefined)
    await rmrf(localDir).catch(() => undefined)
  }
}
