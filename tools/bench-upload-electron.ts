/*
 * Сравнение двух транспортов выгрузки на локальном сервере: сетевой стек
 * Chromium против node:https. Запускается под Electron, потому что стек
 * Chromium доступен только там.
 */
import { app } from 'electron'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { electronNetAvailable, uploadFileViaElectronNet } from '../src/main/cloud/electron-upload'
import { uploadFileStream } from '../src/main/cloud/http'

const SIZE = 44 * 1024 * 1024

async function main(): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wsync-bench-el-'))
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
  const url = `http://127.0.0.1:${port}/`

  console.log(`стек Chromium доступен: ${electronNetAvailable()}`)

  const measure = async (
    label: string,
    run: () => Promise<{ status: number; body: Buffer }>
  ): Promise<void> => {
    const started = Date.now()
    let lastDone = 0
    const response = await run()
    const elapsed = Date.now() - started
    console.log(
      `${label}: ${elapsed} мс, ${(SIZE / 1024 / 1024 / (elapsed / 1000)).toFixed(1)} МБ/с, ` +
        `HTTP ${response.status}, сервер принял ${response.body.toString('utf8')} байт` +
        (lastDone > 0 ? '' : '')
    )
  }

  let bodySentSeen = false
  let maxProgress = 0
  await measure('Chromium', async () =>
    await uploadFileViaElectronNet(url, file, {
      onProgress: (p) => {
        maxProgress = Math.max(maxProgress, p.done)
      },
      onBodySent: () => {
        bodySentSeen = true
      }
    })
  )
  console.log(
    `  прогресс дошёл до ${maxProgress} из ${SIZE}, onBodySent сработал: ${bodySentSeen}`
  )

  await measure('Node    ', async () => await uploadFileStream(url, file, {}))

  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fsp.rm(dir, { recursive: true, force: true })
}

void app.whenReady().then(async () => {
  try {
    await main()
    app.exit(0)
  } catch (err) {
    console.error('ПРОВАЛ:', err)
    app.exit(1)
  }
})
