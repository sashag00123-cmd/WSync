import path from 'node:path'

import type {
  InstanceConfig,
  LogEntry,
  OperationKind,
  PhaseDescriptor,
  PhaseId,
  ProgressEvent
} from '@shared/types'
import { AppError } from './errors'
import { freeSpace } from './fsx'

export interface OperationSinks {
  progress: (event: ProgressEvent) => void
  log: (entry: LogEntry) => void
}

export interface OperationIdentity {
  opId: string
  kind: OperationKind
  instanceId: string
  world: string
}

const EMIT_INTERVAL_MS = 120

/**
 * Прогресс по фазам. Единый бар на 8 ГБ бесполезен: пользователь не понимает,
 * архивация это или выгрузка, и почему «40%» стоит на месте. Поэтому фазы
 * объявлены заранее, и каждая рапортует свои байты.
 */
export class PhaseReporter {
  private phaseIndex = -1
  private currentPhase: PhaseId | null = null
  private phaseStartedAt = 0
  private lastEmitAt = 0
  private lastDone = 0
  private lastSampleAt = 0
  private rate: number | null = null

  constructor(
    private readonly identity: OperationIdentity,
    private readonly phases: PhaseDescriptor[],
    private readonly sinks: OperationSinks
  ) {}

  enter(phase: PhaseId, message?: string): void {
    const index = this.phases.findIndex((p) => p.id === phase)
    this.phaseIndex = index >= 0 ? index : Math.max(0, this.phaseIndex)
    this.currentPhase = phase
    this.phaseStartedAt = Date.now()
    this.lastEmitAt = 0
    this.lastDone = 0
    this.lastSampleAt = 0
    this.rate = null
    this.emit(0, 0, message, true)
    const label = this.phases[this.phaseIndex]?.label ?? phase
    this.info(message !== undefined ? `${label}: ${message}` : label)
  }

  set(done: number, total: number, message?: string): void {
    this.emit(done, total, message, false)
  }

  /** Гарантированно отправить финальное состояние фазы. */
  finish(done: number, total: number): void {
    this.emit(done, total, undefined, true)
  }

  private emit(done: number, total: number, message: string | undefined, force: boolean): void {
    if (this.currentPhase === null) return
    const now = Date.now()
    if (!force && now - this.lastEmitAt < EMIT_INTERVAL_MS) return
    this.lastEmitAt = now

    // Экспоненциальное сглаживание: мгновенная скорость пляшет и ETA скачет.
    if (this.lastSampleAt > 0 && now > this.lastSampleAt && done >= this.lastDone) {
      const instant = ((done - this.lastDone) * 1000) / (now - this.lastSampleAt)
      this.rate = this.rate === null ? instant : this.rate * 0.7 + instant * 0.3
    }
    this.lastSampleAt = now
    this.lastDone = done

    const bytesPerSec = this.rate !== null && this.rate > 0 ? Math.round(this.rate) : null
    const etaSec =
      bytesPerSec !== null && total > done ? Math.round((total - done) / bytesPerSec) : null

    const event: ProgressEvent = {
      opId: this.identity.opId,
      kind: this.identity.kind,
      instanceId: this.identity.instanceId,
      world: this.identity.world,
      phase: this.currentPhase,
      phaseIndex: this.phaseIndex,
      phaseCount: this.phases.length,
      done,
      total,
      bytesPerSec,
      etaSec
    }
    if (message !== undefined) event.message = message
    this.sinks.progress(event)
  }

  info(message: string, details?: string): void {
    this.sinks.log({ ts: Date.now(), level: 'info', message, ...(details !== undefined ? { details } : {}) })
  }

  warn(message: string, details?: string): void {
    this.sinks.log({ ts: Date.now(), level: 'warn', message, ...(details !== undefined ? { details } : {}) })
  }

  error(message: string, details?: string): void {
    this.sinks.log({ ts: Date.now(), level: 'error', message, ...(details !== undefined ? { details } : {}) })
  }

  elapsedMs(): number {
    return Date.now() - this.phaseStartedAt
  }
}

/**
 * Временный каталог операции — рядом с бэкапами, то есть по умолчанию на том
 * же томе, что и saves. Так распаковка и подмена делаются rename без
 * копирования между дисками.
 */
export function operationTempDir(instance: InstanceConfig): string {
  return path.join(instance.backupsPath, '.wsync_tmp')
}

const SPACE_MARGIN = 1.05

export async function assertLocalSpace(target: string, needBytes: number, what: string): Promise<void> {
  const need = Math.ceil(needBytes * SPACE_MARGIN)
  const free = await freeSpace(target)
  if (free < need) {
    throw new AppError(
      'NO_LOCAL_SPACE',
      `Недостаточно места на диске для ${what}: нужно ~${formatBytes(need)}, свободно ${formatBytes(free)}`
    )
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unitIndex]}`
}
