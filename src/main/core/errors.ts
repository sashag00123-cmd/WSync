import type { AppErrorInfo } from '@shared/types'

/** Ошибка с кодом — код показывается в UI и не переводится. */
export class AppError extends Error {
  readonly code: string
  readonly details?: string

  constructor(code: string, message: string, details?: string) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.details = details
  }

  toInfo(): AppErrorInfo {
    return { code: this.code, message: this.message, details: this.details }
  }
}

export class CancelledError extends AppError {
  constructor() {
    super('CANCELLED', 'Операция отменена')
  }
}

export function toErrorInfo(err: unknown): AppErrorInfo {
  if (err instanceof AppError) return err.toInfo()
  if (err instanceof Error) {
    return {
      code: (err as NodeJS.ErrnoException).code ?? 'UNKNOWN',
      message: err.message,
      details: err.stack
    }
  }
  return { code: 'UNKNOWN', message: String(err) }
}

export function isCancel(err: unknown): boolean {
  if (err instanceof CancelledError) return true
  if (err instanceof Error && err.name === 'AbortError') return true
  return false
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError()
}
