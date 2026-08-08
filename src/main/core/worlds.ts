import type { Dirent } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import type { LocalWorld } from '@shared/types'
import { AppError } from './errors'
import { assertSafeName, dirSize, pathExists } from './fsx'
import { readLevelInfo } from './nbt'

/** Каталоги, которые создаёт сама утилита и которые миром не являются. */
function isInternal(name: string): boolean {
  return name.startsWith('.wsync_')
}

/**
 * Список миров в каталоге saves. Размер не считается: обход дерева на
 * 30 000 файлов заметно тормозит открытие окна, поэтому размер запрашивается
 * отдельно и лениво.
 */
export async function scanLocalWorlds(savesPath: string): Promise<LocalWorld[]> {
  let entries: Dirent[]
  try {
    entries = await fsp.readdir(savesPath, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new AppError('NO_SAVES_DIR', `Каталог сейвов не найден: ${savesPath}`)
    }
    throw err
  }

  const out: LocalWorld[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || isInternal(entry.name)) continue
    const worldPath = path.join(savesPath, entry.name)
    if (!(await pathExists(path.join(worldPath, 'level.dat')))) continue
    const info = await readLevelInfo(path.join(worldPath, 'level.dat'))
    out.push({
      name: entry.name,
      path: worldPath,
      sizeBytes: null,
      lastPlayed: info.lastPlayed,
      levelName: info.levelName
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'ru'))
}

export async function getLocalWorld(savesPath: string, name: string): Promise<LocalWorld | null> {
  assertSafeName(name)
  const worldPath = path.join(savesPath, name)
  if (!(await pathExists(path.join(worldPath, 'level.dat')))) return null
  const info = await readLevelInfo(path.join(worldPath, 'level.dat'))
  return {
    name,
    path: worldPath,
    sizeBytes: null,
    lastPlayed: info.lastPlayed,
    levelName: info.levelName
  }
}

export async function localWorldSize(
  savesPath: string,
  name: string,
  signal?: AbortSignal
): Promise<number> {
  assertSafeName(name)
  return await dirSize(path.join(savesPath, name), signal)
}
