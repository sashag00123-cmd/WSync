import type { Dirent } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { AppError } from './errors'
import { dirSize, ensureDir, movePath, rmrf, timestampSlug } from './fsx'

const SEPARATOR = '__'

export function backupName(world: string, stamp: string): string {
  return `${world}${SEPARATOR}${stamp}`
}

/** Разбор имени бэкапа. null, если имя не наше. */
export function parseBackupName(name: string): { world: string; stamp: string } | null {
  const index = name.lastIndexOf(SEPARATOR)
  if (index <= 0) return null
  const world = name.slice(0, index)
  const stamp = name.slice(index + SEPARATOR.length)
  if (world.length === 0 || stamp.length === 0) return null
  return { world, stamp }
}

export function newStamp(now: Date = new Date()): string {
  return timestampSlug(now)
}

/**
 * Убирает существующий мир в бэкапы. Именно переносом, не копированием:
 * rename внутри тома мгновенен и не требует второго места на диске.
 * Если тома разные — честно копируем и удаляем источник только после успеха.
 */
export async function backupLocalWorld(
  worldPath: string,
  backupsPath: string,
  stamp: string
): Promise<string> {
  const world = path.basename(worldPath)
  await ensureDir(backupsPath)
  const target = path.join(backupsPath, backupName(world, stamp))
  if (await exists(target)) {
    throw new AppError('BACKUP_EXISTS', `Бэкап уже существует: ${target}`)
  }
  await movePath(worldPath, target)
  return target
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target)
    return true
  } catch {
    return false
  }
}

export interface RotationPolicy {
  keepPerWorld: number
  maxTotalBytes: number
}

export interface RotationResult {
  removed: string[]
  freedBytes: number
}

/**
 * Ротация локальных бэкапов. Вызывается ТОЛЬКО после успешного завершения
 * операции — удалять что-либо в середине нельзя.
 *
 * Сначала обрезаем по количеству на мир, затем, если общий объём всё ещё
 * превышает лимит, удаляем самые старые бэкапы поверх этого.
 */
export async function rotateLocalBackups(
  backupsPath: string,
  policy: RotationPolicy
): Promise<RotationResult> {
  let entries: Dirent[]
  try {
    entries = await fsp.readdir(backupsPath, { withFileTypes: true })
  } catch {
    return { removed: [], freedBytes: 0 }
  }

  interface Item {
    name: string
    abs: string
    world: string
    stamp: string
    size: number
  }

  const items: Item[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const parsed = parseBackupName(entry.name)
    if (parsed === null) continue
    const abs = path.join(backupsPath, entry.name)
    items.push({
      name: entry.name,
      abs,
      world: parsed.world,
      stamp: parsed.stamp,
      size: await dirSize(abs)
    })
  }

  const doomed = new Set<string>()

  const byWorld = new Map<string, Item[]>()
  for (const item of items) {
    const list = byWorld.get(item.world) ?? []
    list.push(item)
    byWorld.set(item.world, list)
  }
  for (const list of byWorld.values()) {
    // Метка времени сортируется лексикографически, свежие в начале.
    list.sort((a, b) => b.stamp.localeCompare(a.stamp))
    for (const extra of list.slice(policy.keepPerWorld)) doomed.add(extra.abs)
  }

  const survivors = items.filter((i) => !doomed.has(i.abs)).sort((a, b) => a.stamp.localeCompare(b.stamp))
  let totalBytes = survivors.reduce((sum, i) => sum + i.size, 0)
  for (const item of survivors) {
    if (totalBytes <= policy.maxTotalBytes) break
    // Последний бэкап мира не удаляем даже при переполнении лимита —
    // остаться совсем без страховки хуже, чем занять лишнее место.
    const remaining = survivors.filter((s) => s.world === item.world && !doomed.has(s.abs))
    if (remaining.length <= 1) continue
    doomed.add(item.abs)
    totalBytes -= item.size
  }

  const removed: string[] = []
  let freedBytes = 0
  for (const item of items) {
    if (!doomed.has(item.abs)) continue
    try {
      await rmrf(item.abs)
      removed.push(item.name)
      freedBytes += item.size
    } catch {
      // Не смогли удалить — не критично, попробуем в следующий раз.
    }
  }
  return { removed, freedBytes }
}
