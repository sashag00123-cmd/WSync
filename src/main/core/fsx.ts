import { createHash } from 'node:crypto'
import { createReadStream, type Dirent } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { AppError, throwIfAborted } from './errors'

export interface FileEntry {
  abs: string
  /** Путь относительно корня обхода, всегда с '/' — так он и лежит в zip. */
  rel: string
  size: number
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target)
    return true
  } catch {
    return false
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fsp.stat(target)).isDirectory()
  } catch {
    return false
  }
}

export async function ensureDir(target: string): Promise<void> {
  await fsp.mkdir(target, { recursive: true })
}

export async function rmrf(target: string): Promise<void> {
  await fsp.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

/**
 * Обход дерева файлов. Символические ссылки не разыменовываются:
 * в сейве их быть не должно, а следование по ним даёт риск цикла.
 */
export async function* walkFiles(root: string, signal?: AbortSignal): AsyncGenerator<FileEntry> {
  const stack: Array<{ abs: string; rel: string }> = [{ abs: root, rel: '' }]
  while (stack.length > 0) {
    const dir = stack.pop()!
    throwIfAborted(signal)
    let entries: Dirent[]
    try {
      entries = await fsp.readdir(dir.abs, { withFileTypes: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') continue
      throw err
    }
    for (const entry of entries) {
      const abs = path.join(dir.abs, entry.name)
      const rel = dir.rel === '' ? entry.name : `${dir.rel}/${entry.name}`
      if (entry.isDirectory()) {
        stack.push({ abs, rel })
      } else if (entry.isFile()) {
        try {
          const st = await fsp.stat(abs)
          yield { abs, rel, size: st.size }
        } catch {
          // Файл исчез между readdir и stat — пропускаем.
        }
      }
    }
  }
}

export async function collectFiles(root: string, signal?: AbortSignal): Promise<FileEntry[]> {
  const out: FileEntry[] = []
  for await (const entry of walkFiles(root, signal)) out.push(entry)
  return out
}

export interface Tree {
  files: FileEntry[]
  /** Все каталоги, относительные пути. Нужны, чтобы не потерять пустые. */
  dirs: string[]
}

/**
 * Обход с сохранением каталогов. Пустые каталоги в сейве встречаются
 * (datapacks, advancements) — если их потерять, игра их пересоздаст,
 * но лучше вернуть мир байт-в-байт.
 */
export async function collectTree(root: string, signal?: AbortSignal): Promise<Tree> {
  const files: FileEntry[] = []
  const dirs: string[] = []
  const stack: Array<{ abs: string; rel: string }> = [{ abs: root, rel: '' }]
  while (stack.length > 0) {
    const dir = stack.pop()!
    throwIfAborted(signal)
    let entries: Dirent[]
    try {
      entries = await fsp.readdir(dir.abs, { withFileTypes: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') continue
      throw err
    }
    if (dir.rel !== '') dirs.push(dir.rel)
    for (const entry of entries) {
      const abs = path.join(dir.abs, entry.name)
      const rel = dir.rel === '' ? entry.name : `${dir.rel}/${entry.name}`
      if (entry.isDirectory()) {
        stack.push({ abs, rel })
      } else if (entry.isFile()) {
        try {
          const st = await fsp.stat(abs)
          files.push({ abs, rel, size: st.size })
        } catch {
          // Файл исчез между readdir и stat — пропускаем.
        }
      }
    }
  }
  return { files, dirs }
}

export async function dirSize(root: string, signal?: AbortSignal): Promise<number> {
  let total = 0
  for await (const entry of walkFiles(root, signal)) total += entry.size
  return total
}

/** Ближайший существующий предок — statfs и stat требуют существующий путь. */
async function nearestExisting(target: string): Promise<string> {
  let current = path.resolve(target)
  for (;;) {
    if (await pathExists(current)) return current
    const parent = path.dirname(current)
    if (parent === current) return current
    current = parent
  }
}

/** Свободно байт на томе, содержащем путь. */
export async function freeSpace(target: string): Promise<number> {
  const probe = await nearestExisting(target)
  const st = await fsp.statfs(probe)
  return Number(st.bavail) * Number(st.bsize)
}

/**
 * Один ли том у путей. Важно: rename атомарен только внутри тома,
 * иначе получим EXDEV и медленное копирование.
 */
export async function sameVolume(a: string, b: string): Promise<boolean> {
  if (process.platform === 'win32') {
    const rootA = path.parse(path.resolve(a)).root.toLowerCase()
    const rootB = path.parse(path.resolve(b)).root.toLowerCase()
    return rootA === rootB
  }
  const [stA, stB] = await Promise.all([
    fsp.stat(await nearestExisting(a)),
    fsp.stat(await nearestExisting(b))
  ])
  return stA.dev === stB.dev
}

/**
 * Перемещение каталога. Внутри тома — rename (мгновенно, почти атомарно).
 * Между томами — копирование, затем удаление источника, и только после
 * успешного копирования: иначе можно потерять данные.
 */
export async function movePath(from: string, to: string): Promise<void> {
  await ensureDir(path.dirname(to))
  try {
    await fsp.rename(from, to)
    return
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
  }
  await fsp.cp(from, to, { recursive: true, force: true, errorOnExist: false })
  await rmrf(from)
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export async function hashFile(
  file: string,
  signal?: AbortSignal,
  onProgress?: (done: number) => void
): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })
  let done = 0
  return await new Promise<string>((resolve, reject) => {
    const onAbort = (): void => {
      stream.destroy(new AppError('CANCELLED', 'Операция отменена'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    stream.on('data', (chunk) => {
      hash.update(chunk)
      done += chunk.length
      onProgress?.(done)
    })
    stream.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    stream.on('end', () => {
      signal?.removeEventListener('abort', onAbort)
      resolve(hash.digest('hex'))
    })
  })
}

/**
 * sha256 диапазона файла. Нужен для частей архива: сам архив пишется одним
 * потоком, а границы частей известны только после того, как он готов.
 */
export async function hashFileRange(
  file: string,
  start: number,
  end: number,
  signal?: AbortSignal
): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(file, { start, end, highWaterMark: 1024 * 1024 })
  return await new Promise<string>((resolve, reject) => {
    const onAbort = (): void => {
      stream.destroy(new AppError('CANCELLED', 'Операция отменена'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    stream.on('end', () => {
      signal?.removeEventListener('abort', onAbort)
      resolve(hash.digest('hex'))
    })
  })
}

/** Создаёт файл нужного размера, чтобы части писались параллельно по смещениям. */
export async function preallocate(file: string, size: number): Promise<void> {
  await ensureDir(path.dirname(file))
  const handle = await fsp.open(file, 'w')
  try {
    await handle.truncate(size)
  } finally {
    await handle.close()
  }
}

/** Атомарная запись небольшого файла: пишем рядом и переименовываем. */
export async function writeFileAtomic(target: string, data: string | Buffer): Promise<void> {
  await ensureDir(path.dirname(target))
  const tmp = `${target}.tmp-${process.pid}-${counter()}`
  await fsp.writeFile(tmp, data)
  await fsp.rename(tmp, target)
}

let seq = 0
function counter(): number {
  seq = (seq + 1) % 1_000_000
  return seq
}

/** Метка времени для имён бэкапов: сортируется лексикографически. */
export function timestampSlug(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `_${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`
  )
}

/**
 * Имя мира не должно вылезать за пределы каталога saves.
 * Приходит из UI и из манифеста в облаке — оба источника проверяем.
 */
export function assertSafeName(name: string): void {
  if (name.length === 0 || name === '.' || name === '..') {
    throw new AppError('BAD_NAME', `Недопустимое имя: "${name}"`)
  }
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new AppError('BAD_NAME', `Недопустимое имя: "${name}"`)
  }
  if (path.isAbsolute(name) || path.basename(name) !== name) {
    throw new AppError('BAD_NAME', `Недопустимое имя: "${name}"`)
  }
}

/** Защита от zip-slip: путь распаковки обязан остаться внутри корня. */
export function resolveInside(root: string, relative: string): string {
  const target = path.resolve(root, relative)
  const normalizedRoot = path.resolve(root)
  const withSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep
  if (target !== normalizedRoot && !target.startsWith(withSep)) {
    throw new AppError('ZIP_SLIP', `Запись архива указывает за пределы каталога: "${relative}"`)
  }
  return target
}
