import type { WorldSyncStatus } from '@shared/types'

export interface StatusInput {
  localLastPlayed: number | null
  cloudLastPlayed: number | null
  /** Значение на момент последней успешной синхронизации этой машиной. */
  syncedLastPlayed: number | null
}

/**
 * Статус мира. Ключевая мысль: сравнение только по LastPlayed из level.dat —
 * mtime файлов врёт после копирования, распаковки и облачных клиентов.
 *
 * Расхождение (diverged) — это когда обе стороны уходили вперёд от общей
 * точки. Именно этот случай молча съедает прогресс, если его не показать.
 */
export function computeStatus(input: StatusInput): WorldSyncStatus {
  const { localLastPlayed, cloudLastPlayed, syncedLastPlayed } = input

  if (localLastPlayed === null && cloudLastPlayed === null) return 'unknown'
  if (cloudLastPlayed === null) return 'local-only'
  if (localLastPlayed === null) return 'cloud-only'
  if (localLastPlayed === cloudLastPlayed) return 'synced'

  // Ни одной успешной синхронизации на этой машине: чья версия является
  // продолжением чьей — неизвестно. Честнее потребовать решения.
  if (syncedLastPlayed === null) return 'diverged'

  const localMoved = localLastPlayed > syncedLastPlayed
  const cloudMoved = cloudLastPlayed > syncedLastPlayed
  if (localMoved && cloudMoved) return 'diverged'
  if (localLastPlayed > cloudLastPlayed) return 'local-newer'
  return 'cloud-newer'
}

/** Требуется ли явное подтверждение пользователя для операции. */
export function needsOverwriteConfirm(
  status: WorldSyncStatus,
  kind: 'upload' | 'download'
): boolean {
  if (status === 'diverged' || status === 'unknown') return true
  if (kind === 'upload') return status === 'cloud-newer'
  return status === 'local-newer'
}
