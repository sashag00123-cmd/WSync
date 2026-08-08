import type { CloudLock, InstanceConfig, OperationKind } from '@shared/types'
import type { CloudProvider } from '../cloud/types'
import { CloudLayout } from './layout'

/**
 * Лок в облаке — предупреждающий, а не запрещающий. Жёсткая блокировка в
 * утилите на два ПК только мешает: забыл снять — заблокировал себя. Задача
 * лока — показать «мир взят на другой машине N часов назад».
 */
export const LOCK_STALE_MS = 6 * 60 * 60 * 1000

export async function readLock(
  provider: CloudProvider,
  instance: InstanceConfig
): Promise<CloudLock | null> {
  const layout = new CloudLayout(instance)
  const raw = await provider.readJson<CloudLock>(layout.lock)
  if (raw === null || typeof raw.world !== 'string' || typeof raw.machine !== 'string') return null
  return raw
}

export async function writeLock(
  provider: CloudProvider,
  instance: InstanceConfig,
  world: string,
  machine: string,
  operation: OperationKind
): Promise<void> {
  const layout = new CloudLayout(instance)
  await provider.writeJson(layout.lock, {
    world,
    machine,
    takenAt: Date.now(),
    operation
  } satisfies CloudLock)
}

export async function clearLock(provider: CloudProvider, instance: InstanceConfig): Promise<void> {
  const layout = new CloudLayout(instance)
  await provider.remove(layout.lock).catch(() => undefined)
}

export function isForeignActiveLock(lock: CloudLock | null, machine: string): boolean {
  if (lock === null) return false
  if (lock.machine === machine) return false
  return Date.now() - lock.takenAt < LOCK_STALE_MS
}

export function describeLock(lock: CloudLock): string {
  const minutes = Math.round((Date.now() - lock.takenAt) / 60_000)
  const when =
    minutes < 60 ? `${minutes} мин назад` : `${Math.round(minutes / 60)} ч назад`
  const what = lock.operation === 'upload' ? 'выгружает' : 'загружает'
  return `Машина «${lock.machine}» ${what} мир «${lock.world}» (${when})`
}
