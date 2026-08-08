import type { WorldSyncStatus } from '@shared/types'

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} Б`
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`
}

export function formatSpeed(bytesPerSec: number | null): string {
  if (bytesPerSec === null || bytesPerSec <= 0) return ''
  return `${formatBytes(bytesPerSec)}/с`
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return `${Math.round(seconds)} с`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} мин ${Math.round(seconds % 60)} с`
  return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`
}

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit'
})

export function formatDate(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms <= 0) return '—'
  return dateFormatter.format(new Date(ms))
}

const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})

export function formatTime(ms: number): string {
  return timeFormatter.format(new Date(ms))
}

export function relativeDays(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms <= 0) return ''
  const diff = Date.now() - ms
  const hours = Math.round(diff / 3_600_000)
  if (hours < 1) return 'меньше часа назад'
  if (hours < 24) return `${hours} ч назад`
  const days = Math.round(hours / 24)
  return `${days} дн назад`
}

/**
 * Укорачивает путь по границам сегментов, оставляя хвост.
 *
 * Раньше это делалось трюком с direction: rtl, и он резал посреди слова —
 * «…orge\Instances\…» вместо «…\All the Mods 10\saves». Хвост важнее начала:
 * по нему видно, о какой сборке речь, а полный путь остаётся в подсказке.
 */
export function shortenPath(value: string, segments = 2): string {
  const separator = value.includes('\\') ? '\\' : '/'
  const parts = value.split(/[\\/]/).filter((part) => part.length > 0)
  if (parts.length <= segments) return value
  return `…${separator}${parts.slice(-segments).join(separator)}`
}

export interface StatusView {
  label: string
  tone: 'ok' | 'info' | 'warn' | 'muted'
  hint: string
}

export function statusView(status: WorldSyncStatus): StatusView {
  switch (status) {
    case 'synced':
      return { label: 'синхронизирован', tone: 'ok', hint: 'Локальная и облачная копии совпадают' }
    case 'local-only':
      return { label: 'только на ПК', tone: 'info', hint: 'В облаке этого мира нет' }
    case 'cloud-only':
      return { label: 'только в облаке', tone: 'info', hint: 'Локальной копии нет' }
    case 'local-newer':
      return {
        label: 'локальный новее',
        tone: 'info',
        hint: 'На этом ПК играли позже — безопасно выгрузить в облако'
      }
    case 'cloud-newer':
      return {
        label: 'облачный новее',
        tone: 'info',
        hint: 'На другой машине играли позже — безопасно загрузить на ПК'
      }
    case 'diverged':
      return {
        label: 'расхождение',
        tone: 'warn',
        hint: 'Играли и здесь, и на другой машине после последней синхронизации. ' +
          'Любая операция перезапишет чей-то прогресс — бэкап будет создан.'
      }
    case 'unknown':
    default:
      return {
        label: 'неизвестно',
        tone: 'muted',
        hint: 'Не удалось прочитать level.dat — сравнить версии нельзя'
      }
  }
}
