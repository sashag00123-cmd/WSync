import type { Quota } from '@shared/types'

export interface CloudEntry {
  name: string
  /** Путь в терминах провайдера, например app:/atm10/saves/World.zip. */
  path: string
  type: 'file' | 'dir'
  size: number
  md5?: string
  sha256?: string
  modified?: number
}

export interface TransferProgress {
  done: number
  total: number
}

/** Диапазон байт файла, включая оба конца — как в createReadStream. */
export interface ByteRange {
  start: number
  end: number
}

export interface TransferOptions {
  signal?: AbortSignal
  /** Выгружать не файл целиком, а его диапазон — часть архива. */
  range?: ByteRange
  /** Писать скачанное по смещению в существующий файл — сборка архива из частей. */
  writeOffset?: number
  /** Ожидаемый размер: при записи по смещению определить его из файла нельзя. */
  expectedSize?: number
  onProgress?: (p: TransferProgress) => void
  /** Сообщение о ходе передачи для журнала — например «файл отправлен, ждём сервер». */
  onNote?: (message: string) => void
  /**
   * Все байты отданы в сеть, дальше ждём ответа сервера. С этого момента
   * проценты и ETA бессмысленны: сколько данных подтвердил получатель,
   * пользовательскому процессу не известно.
   */
  onBodySent?: () => void
}

export interface MoveOptions {
  overwrite?: boolean
  /** Долгая операция Диска — сообщаем, что ждём, иначе UI выглядит зависшим. */
  onNote?: (message: string) => void
  /** Без сигнала кнопка «Отменить» во время ожидания операции ничего не делает. */
  signal?: AbortSignal
}

export interface DownloadResult {
  bytes: number
  /** null — файл догружался с середины, хеш надо считать отдельным проходом. */
  sha256: string | null
}

/**
 * Абстракция облака. Google Drive добавляется как вторая реализация
 * без правок ядра — все операции ядра выражены через этот интерфейс.
 */
export interface CloudProvider {
  readonly id: string

  ensureFolder(remotePath: string): Promise<void>
  list(remotePath: string): Promise<CloudEntry[]>
  stat(remotePath: string): Promise<CloudEntry | null>

  readJson<T>(remotePath: string): Promise<T | null>
  writeJson(remotePath: string, data: unknown): Promise<void>

  uploadFile(localPath: string, remotePath: string, opts?: TransferOptions): Promise<CloudEntry>
  downloadFile(remotePath: string, localPath: string, opts?: TransferOptions): Promise<DownloadResult>

  move(from: string, to: string, opts?: MoveOptions): Promise<void>
  remove(remotePath: string): Promise<void>

  quota(): Promise<Quota>
}
