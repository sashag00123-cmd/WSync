/** Типы, общие для main, preload и renderer. */

/** 2 — архив хранится частями, чтобы выгружать их параллельно. */
export const MANIFEST_VERSION = 2
export const CONFIG_VERSION = 2

/**
 * Сколько частей передаём одновременно. На реальном канале до Яндекса один
 * поток даёт ~126 КБ/с, четыре — ~474 КБ/с: узкое место в одном соединении,
 * а не в полосе. Восемь — компромисс между выигрышем и вежливостью к API.
 */
export const TRANSFER_STREAMS = 8

/** Границы размера части: слишком мелкие дробят зря, слишком крупные не параллелятся. */
export const MIN_PART_BYTES = 4 * 1024 * 1024
export const MAX_PART_BYTES = 64 * 1024 * 1024

/** Разбивка архива на части: стремимся занять все потоки, оставаясь в границах. */
export function planParts(totalBytes: number): Array<{ index: number; start: number; end: number }> {
  const target = Math.ceil(totalBytes / TRANSFER_STREAMS)
  const partSize = Math.min(MAX_PART_BYTES, Math.max(MIN_PART_BYTES, target))
  const parts: Array<{ index: number; start: number; end: number }> = []
  let start = 0
  let index = 0
  while (start < totalBytes) {
    const end = Math.min(totalBytes, start + partSize) - 1
    parts.push({ index, start, end })
    start = end + 1
    index += 1
  }
  // Пустой архив невозможен (в мире всегда есть level.dat), но пустой список
  // частей сломал бы сборку — подстрахуемся.
  if (parts.length === 0) parts.push({ index: 0, start: 0, end: -1 })
  return parts
}

export function partFileName(index: number): string {
  return `part${String(index + 1).padStart(4, '0')}`
}

export type CloudProviderId = 'yandex'

/** 'system' — следовать настройке операционной системы. */
export type ThemeMode = 'system' | 'dark' | 'light'

/**
 * Права по умолчанию: работа в папке приложения плюс сведения о диске —
 * без второго не проверить заранее, хватит ли места под архив.
 */
export const DEFAULT_YANDEX_SCOPE = 'cloud_api:disk.app_folder cloud_api:disk.info'

/** Дефолт конфига версии 1 — нужен для разовой миграции. */
export const LEGACY_YANDEX_SCOPE_V1 = 'cloud_api:disk.app_folder'

/** Приводит список прав к сравнимому виду: порядок и пробелы значения не имеют. */
export function normalizeScope(scope: string): string {
  return scope
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .sort()
    .join(' ')
}

export interface InstanceConfig {
  /** Стабильный идентификатор, используется как ключ в конфиге. */
  id: string
  name: string
  savesPath: string
  backupsPath: string
  /** Имя папки сборки внутри app:/ на диске. */
  cloudFolder: string
}

export interface BackupPolicy {
  keepPerWorld: number
  maxTotalGb: number
}

export interface AppConfig {
  version: number
  machineName: string
  theme: ThemeMode
  cloud: {
    provider: CloudProviderId
    clientId: string
    /**
     * Яндекс требует client_secret при обновлении токена даже для
     * приложений с PKCE. Поле опциональное: без него приложение работает,
     * но при истечении токена попросит авторизоваться заново.
     */
    clientSecret: string
    /**
     * Права, запрашиваемые у Яндекс.OAuth, через пробел. Должны совпадать с
     * тем, что выдано приложению в кабинете: если запросить лишнее, Яндекс
     * отвергает запрос целиком с invalid_scope. Пустая строка — не передавать
     * параметр вообще.
     */
    scope: string
  }
  instances: InstanceConfig[]
  backups: BackupPolicy
  /**
   * Точка последней успешной синхронизации, ключ `${instanceId}/${world}`.
   * Нужна, чтобы отличить «одна сторона новее» от настоящего расхождения.
   */
  worlds: Record<string, { syncedLastPlayed: number | null }>
}

export interface LocalWorld {
  name: string
  path: string
  /** null, если размер ещё не считался (считается лениво). */
  sizeBytes: number | null
  /** LastPlayed из level.dat, мс. Единственный надёжный признак свежести. */
  lastPlayed: number | null
  levelName: string | null
}

export interface CloudPart {
  name: string
  size: number
  sha256: string
}

export interface CloudWorld {
  name: string
  /** Каталог с частями внутри папки сборки, например saves/MyWorld. */
  archive: string
  /** Размер собранного архива — сумма размеров частей. */
  archiveSize: number
  /** sha256 собранного архива. Целостность при загрузке проверяется по частям. */
  sha256: string
  uncompressedSize: number
  entryCount: number
  parts: CloudPart[]
  lastPlayed: number
  uploadedAt: number
  uploadedBy: string
  appVersion: string
}

export interface CloudManifest {
  version: number
  instanceId: string
  worlds: Record<string, Omit<CloudWorld, 'name'>>
}

export type WorldSyncStatus =
  | 'synced'
  | 'local-only'
  | 'cloud-only'
  | 'local-newer'
  | 'cloud-newer'
  | 'diverged'
  | 'unknown'

export interface WorldRow {
  name: string
  local: LocalWorld | null
  cloud: CloudWorld | null
  status: WorldSyncStatus
  /** Мир открыт запущенной игрой — операции запрещены. */
  inUse: boolean
  /** Детект «в игре» неточен на этой ОС, показываем предупреждение. */
  inUseUnknown: boolean
}

export type OperationKind = 'upload' | 'download'

export type PhaseId =
  | 'checks'
  | 'archive'
  | 'transfer'
  | 'verify'
  | 'extract'
  | 'backup'
  | 'swap'
  | 'manifest'
  | 'cleanup'

export interface PhaseDescriptor {
  id: PhaseId
  label: string
}

export const UPLOAD_PHASES: PhaseDescriptor[] = [
  { id: 'checks', label: 'Проверки' },
  { id: 'archive', label: 'Архивация' },
  { id: 'transfer', label: 'Выгрузка' },
  { id: 'verify', label: 'Сверка' },
  { id: 'backup', label: 'Бэкап облачной копии' },
  { id: 'swap', label: 'Замена' },
  { id: 'manifest', label: 'Манифест' },
  { id: 'cleanup', label: 'Очистка' }
]

export const DOWNLOAD_PHASES: PhaseDescriptor[] = [
  { id: 'checks', label: 'Проверки' },
  { id: 'transfer', label: 'Скачивание' },
  { id: 'verify', label: 'Сверка' },
  { id: 'extract', label: 'Распаковка' },
  { id: 'backup', label: 'Бэкап локальной копии' },
  { id: 'swap', label: 'Замена' },
  { id: 'cleanup', label: 'Очистка' }
]

export interface ProgressEvent {
  opId: string
  kind: OperationKind
  instanceId: string
  world: string
  phase: PhaseId
  phaseIndex: number
  phaseCount: number
  /** Байты или единицы внутри фазы. total === 0 → индикатор без процентов. */
  done: number
  total: number
  bytesPerSec: number | null
  etaSec: number | null
  message?: string
}

export interface AppErrorInfo {
  code: string
  message: string
  details?: string
}

export interface OperationResult {
  ok: boolean
  opId: string
  cancelled?: boolean
  error?: AppErrorInfo
  /** Куда положен бэкап, если он создавался — для кнопки «показать». */
  backupPath?: string
}

export interface LogEntry {
  ts: number
  level: 'info' | 'warn' | 'error'
  message: string
  details?: string
}

export interface CloudLock {
  world: string
  machine: string
  takenAt: number
  operation: OperationKind
}

export interface AuthState {
  authorized: boolean
  login?: string
  expiresAt?: number
  /**
   * Права, с которыми был выдан действующий токен. Отличаются от настроек —
   * значит настройки поменяли после подключения, и нужно переподключиться:
   * права зашиты в токен, изменение в кабинете само его не расширит.
   */
  grantedScope?: string
  /** Не задан clientId — авторизация невозможна, нужен экран настроек. */
  needsClientId: boolean
}

export interface Quota {
  total: number
  used: number
}

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'none'
  | 'error'

export interface UpdateStatus {
  state: UpdateState
  latestVersion?: string
  notes?: string
  percent?: number
  error?: string
  /**
   * Приложение может поставить обновление само. На macOS без подписи —
   * не может: Squirrel.Mac отклоняет неподписанные обновления.
   */
  canInstall: boolean
  releaseUrl: string
}

/** Сведения о самой сборке — влияют на то, что показывать в настройках. */
export interface BuildInfo {
  version: string
  /**
   * Ключи приложения Яндекс.OAuth вшиты при сборке. Тогда поля для их ввода
   * в настройках — лишний шум: пользователю нечего в них делать.
   */
  hasBuildCredentials: boolean
}

/** Результат проверки: даёт ли параллельная выгрузка выигрыш на этом канале. */
export interface SpeedTestResult {
  payloadBytes: number
  streams: number
  singleBytesPerSec: number
  parallelBytesPerSec: number
  speedup: number
}

export interface DetectedInstance {
  launcher: string
  name: string
  savesPath: string
}

/** Подтверждение перезаписи, которое UI обязан получить от пользователя. */
export interface ConfirmToken {
  /** Пользователь видел статус и согласился перезаписать более свежие данные. */
  overwriteNewer: boolean
  /** Пользователь видел чужой lock и согласился продолжить. */
  ignoreLock: boolean
}
