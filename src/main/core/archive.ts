import archiver from 'archiver'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import yauzl from 'yauzl'

import { AppError, CancelledError, throwIfAborted } from './errors'
import { collectTree, ensureDir, resolveInside } from './fsx'

/**
 * Расширения, которые уже сжаты: region-файлы Minecraft содержат чанки,
 * упакованные zlib. Повторный deflate даёт единицы процентов и упирает
 * архивацию в CPU вместо диска — поэтому кладём их как есть (store).
 */
const STORED_EXTENSIONS = new Set(['.mca', '.mcc', '.mcr', '.zip', '.jar', '.png', '.gz', '.ogg'])

/** Файл блокировки запущенной игры — в архиве не нужен и мешает. */
const SKIPPED_NAMES = new Set(['session.lock'])

const ZIP64_THRESHOLD = 3.5 * 1024 * 1024 * 1024

export interface ArchiveProgress {
  done: number
  total: number
}

export interface CreateZipOptions {
  signal?: AbortSignal
  onProgress?: (p: ArchiveProgress) => void
}

export interface ArchiveResult {
  sha256: string
  /** Диск не всегда отдаёт sha256; md5 считается тем же проходом и служит запасной сверкой. */
  md5: string
  archiveSize: number
  entryCount: number
  uncompressedSize: number
}

function isStored(rel: string): boolean {
  return STORED_EXTENSIONS.has(path.extname(rel).toLowerCase())
}

/**
 * Упаковывает содержимое каталога в zip. Записи кладутся в корень архива,
 * без папки мира сверху — распаковка целится прямо в каталог мира.
 * Хеши считаются на лету, второго прохода по гигабайтам нет.
 */
export async function createZip(
  sourceDir: string,
  outFile: string,
  opts: CreateZipOptions = {}
): Promise<ArchiveResult> {
  const { signal, onProgress } = opts
  throwIfAborted(signal)

  const tree = await collectTree(sourceDir, signal)
  const files = tree.files.filter((f) => !SKIPPED_NAMES.has(path.basename(f.rel)))
  const uncompressedSize = files.reduce((sum, f) => sum + f.size, 0)

  await ensureDir(path.dirname(outFile))

  const sha = createHash('sha256')
  const md5 = createHash('md5')
  let archiveSize = 0
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      sha.update(chunk)
      md5.update(chunk)
      archiveSize += chunk.length
      cb(null, chunk)
    }
  })

  const out = createWriteStream(outFile)
  const archive = archiver('zip', {
    zlib: { level: 6 },
    forceZip64: uncompressedSize > ZIP64_THRESHOLD
  })

  const finished = new Promise<void>((resolve, reject) => {
    let settled = false
    const fail = (err: unknown): void => {
      if (settled) return
      settled = true
      reject(err)
    }
    const done = (): void => {
      if (settled) return
      settled = true
      resolve()
    }

    out.on('close', done)
    out.on('error', fail)
    tap.on('error', fail)
    archive.on('error', fail)
    // Отсутствие файла или отказ в доступе — не повод молча получить битый архив.
    archive.on('warning', fail)
    archive.on('progress', (data: archiver.ProgressData) => {
      onProgress?.({ done: data.fs.processedBytes, total: uncompressedSize })
    })
  })

  const onAbort = (): void => {
    archive.abort()
    out.destroy()
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    archive.pipe(tap).pipe(out)

    for (const dir of tree.dirs) {
      archive.append(Buffer.alloc(0), { name: `${dir}/` })
    }
    for (const file of files) {
      // Именно file(), а не append(createReadStream(...)): archiver откроет
      // файл, когда дойдёт до него, иначе на 30 000 записей кончатся дескрипторы.
      // Типы объявляют store только в ZipEntryData, хотя file() его учитывает.
      const entry: archiver.ZipEntryData = { name: file.rel, store: isStored(file.rel) }
      archive.file(file.abs, entry)
    }

    void archive.finalize()
    await finished
    throwIfAborted(signal)
  } catch (err) {
    await fsp.rm(outFile, { force: true }).catch(() => undefined)
    if (signal?.aborted) throw new CancelledError()
    throw err
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }

  return {
    sha256: sha.digest('hex'),
    md5: md5.digest('hex'),
    archiveSize,
    entryCount: files.length,
    uncompressedSize
  }
}

export interface ExtractZipOptions {
  signal?: AbortSignal
  /** Ожидаемый суммарный размер из манифеста — для процентов. */
  expectedTotal?: number
  onProgress?: (p: ArchiveProgress) => void
}

export interface ExtractResult {
  entryCount: number
  bytesWritten: number
}

/**
 * Распаковка в существующий пустой каталог. Пути проверяются на выход
 * за пределы каталога (zip-slip), символические ссылки пропускаются.
 */
export async function extractZip(
  zipFile: string,
  destDir: string,
  opts: ExtractZipOptions = {}
): Promise<ExtractResult> {
  const { signal, onProgress, expectedTotal } = opts
  throwIfAborted(signal)
  await ensureDir(destDir)

  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true, autoClose: true }, (err, zipFileHandle) => {
      if (err !== null && err !== undefined) reject(err)
      else if (zipFileHandle === undefined) reject(new AppError('ZIP_OPEN', 'Не удалось открыть архив'))
      else resolve(zipFileHandle)
    })
  })

  // yauzl не даёт суммарный несжатый размер до обхода записей — берём его
  // из манифеста, иначе процентов не будет и полоса станет неопределённой.
  const total = expectedTotal ?? 0
  let bytesWritten = 0
  let entryCount = 0
  const createdDirs = new Set<string>()

  const mkdirOnce = async (dir: string): Promise<void> => {
    if (createdDirs.has(dir)) return
    await ensureDir(dir)
    createdDirs.add(dir)
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const fail = (err: unknown): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      zip.close()
      reject(err)
    }
    const done = (): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    function onAbort(): void {
      fail(new CancelledError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    zip.on('error', fail)
    zip.on('end', done)

    zip.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        try {
          if (signal?.aborted) {
            fail(new CancelledError())
            return
          }
          // Часть архиваторов пишет '\' как разделитель.
          const name = entry.fileName.replace(/\\/g, '/')
          if (name.length === 0) {
            zip.readEntry()
            return
          }
          if (name.endsWith('/')) {
            await mkdirOnce(resolveInside(destDir, name))
            zip.readEntry()
            return
          }
          // Символические ссылки в сейве нам не нужны и небезопасны.
          const unixMode = (entry.externalFileAttributes >>> 16) & 0xf000
          if (unixMode === 0xa000) {
            zip.readEntry()
            return
          }

          const target = resolveInside(destDir, name)
          await mkdirOnce(path.dirname(target))

          const readStream = await new Promise<NodeJS.ReadableStream>((res, rej) => {
            zip.openReadStream(entry, (err, stream) => {
              if (err !== null && err !== undefined) rej(err)
              else if (stream === undefined) rej(new AppError('ZIP_READ', `Не читается запись "${name}"`))
              else res(stream)
            })
          })

          const writeStream = createWriteStream(target)
          await new Promise<void>((res, rej) => {
            readStream.on('data', (chunk: Buffer) => {
              bytesWritten += chunk.length
              onProgress?.({ done: bytesWritten, total })
            })
            readStream.on('error', rej)
            writeStream.on('error', rej)
            writeStream.on('close', res)
            readStream.pipe(writeStream)
          })

          entryCount += 1
          zip.readEntry()
        } catch (err) {
          fail(err)
        }
      })()
    })

    zip.readEntry()
  })

  return { entryCount, bytesWritten }
}
