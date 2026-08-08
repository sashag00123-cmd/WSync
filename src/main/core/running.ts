import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { pathExists } from './fsx'

export interface InUseResult {
  inUse: boolean
  /** На этой ОС надёжно определить не удалось — UI показывает предупреждение. */
  unknown: boolean
}

/**
 * Занят ли мир запущенной игрой. Minecraft держит session.lock открытым,
 * но механика различается по ОС:
 *  - Windows: файл нельзя открыть на запись, пока игра работает;
 *  - macOS/Linux: используется fcntl-блокировка, открытие не запрещено,
 *    поэтому спрашиваем lsof.
 * Если ответить точно нельзя — возвращаем unknown, а не «свободен»:
 * подмена каталога под работающей игрой ломает мир.
 */
export async function isWorldInUse(worldPath: string): Promise<InUseResult> {
  const lockFile = path.join(worldPath, 'session.lock')
  if (!(await pathExists(lockFile))) return { inUse: false, unknown: false }

  if (process.platform === 'win32') {
    try {
      const handle = await fsp.open(lockFile, 'r+')
      await handle.close()
      return { inUse: false, unknown: false }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        return { inUse: true, unknown: false }
      }
      if (code === 'ENOENT') return { inUse: false, unknown: false }
      return { inUse: false, unknown: true }
    }
  }

  const viaLsof = await lsofHasOpenFile(lockFile)
  if (viaLsof === null) return { inUse: false, unknown: true }
  return { inUse: viaLsof, unknown: false }
}

/** null — lsof недоступен или ответил непонятно. */
function lsofHasOpenFile(file: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    const child = execFile(
      'lsof',
      ['-t', '--', file],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err === null) {
          resolve(stdout.trim().length > 0)
          return
        }
        const code = (err as NodeJS.ErrnoException).code
        // lsof возвращает 1, когда открытых дескрипторов нет — это валидный ответ.
        if (typeof err.code === 'number' && err.code === 1) {
          resolve(false)
          return
        }
        if (code === 'ENOENT') {
          resolve(null)
          return
        }
        resolve(null)
      }
    )
    child.on('error', () => resolve(null))
  })
}
