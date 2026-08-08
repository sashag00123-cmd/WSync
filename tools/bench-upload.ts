/* Замер пропускной способности uploadFileStream без участия сети. */
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { uploadFileStream } from '../src/main/cloud/http'

const SIZE = 44 * 1024 * 1024

async function main(): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wsync-bench-'))
  const file = path.join(dir, 'payload.bin')
  await fsp.writeFile(file, crypto.randomBytes(SIZE))

  const server = http.createServer((req, res) => {
    let received = 0
    req.on('data', (chunk: Buffer) => {
      received += chunk.length
    })
    req.on('end', () => {
      res.writeHead(201, { 'Content-Type': 'text/plain' })
      res.end(String(received))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port

  // Сколько времени проходит между событиями прогресса — так видно рывки.
  const run = async (label: string, readHighWaterMark: number): Promise<void> => {
    const gaps: number[] = []
    let last = Date.now()
    let chunks = 0
    const started = Date.now()
    const response = await uploadFileStream(`http://127.0.0.1:${port}/`, file, {
      readHighWaterMark,
      onProgress: () => {
        const now = Date.now()
        gaps.push(now - last)
        last = now
        chunks += 1
      }
    })
    const elapsedMs = Date.now() - started
    const mbps = SIZE / 1024 / 1024 / (elapsedMs / 1000)
    gaps.sort((a, b) => b - a)
    console.log(
      `${label}: ${elapsedMs} мс, ${mbps.toFixed(1)} МБ/с, HTTP ${response.status}, ` +
        `событий прогресса ${chunks}, худшая пауза ${gaps[0]} мс, вторая ${gaps[1] ?? 0} мс`
    )
  }

  await run('кусок 4 МБ  ', 4 * 1024 * 1024)
  await run('кусок 256 КБ', 256 * 1024)
  await run('кусок 64 КБ ', 64 * 1024)
  await run('кусок 64 КБ ', 64 * 1024)

  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fsp.rm(dir, { recursive: true, force: true })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
