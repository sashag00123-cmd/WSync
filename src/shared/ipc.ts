import type {
  AppConfig,
  AppErrorInfo,
  AuthState,
  BuildInfo,
  ConfirmToken,
  DetectedInstance,
  InstanceConfig,
  LogEntry,
  OperationResult,
  ProgressEvent,
  Quota,
  SpeedTestResult,
  UpdateStatus,
  WorldRow,
  CloudLock
} from './types'

export const IPC = {
  buildInfo: 'app:buildInfo',
  configGet: 'config:get',
  configPatch: 'config:patch',
  instanceUpsert: 'instance:upsert',
  instanceRemove: 'instance:remove',
  detectInstances: 'detect:instances',

  authState: 'auth:state',
  authStart: 'auth:start',
  authSubmitCode: 'auth:submitCode',
  authLogout: 'auth:logout',
  cloudQuota: 'cloud:quota',
  cloudSpeedTest: 'cloud:speedTest',

  worldsList: 'worlds:list',
  worldSize: 'worlds:size',
  lockRead: 'lock:read',

  opUpload: 'op:upload',
  opDownload: 'op:download',
  opCancel: 'op:cancel',

  pickDirectory: 'dialog:pickDirectory',
  openPath: 'shell:openPath',
  openExternal: 'shell:openExternal',

  updateCheck: 'update:check',
  updateStatus: 'update:status',
  updateInstall: 'update:install',
  updateRestart: 'update:restart',

  evProgress: 'ev:progress',
  evUpdate: 'ev:update',
  evLog: 'ev:log',
  evAuth: 'ev:auth'
} as const

/**
 * Ответ обработчика IPC. Обёртка нужна, чтобы до renderer доехал код ошибки
 * и подробности: Electron при отклонении промиса сохраняет только строку.
 */
export type Envelope<T> = { ok: true; data: T } | { ok: false; error: AppErrorInfo }

export interface OpRequest {
  instanceId: string
  world: string
  confirm: ConfirmToken
}

/** Поверхность, которую preload выставляет в renderer. */
export interface WSyncApi {
  buildInfo(): Promise<BuildInfo>
  getConfig(): Promise<AppConfig>
  patchConfig(patch: Partial<AppConfig>): Promise<AppConfig>
  upsertInstance(instance: InstanceConfig): Promise<AppConfig>
  removeInstance(id: string): Promise<AppConfig>
  detectInstances(): Promise<DetectedInstance[]>

  authState(): Promise<AuthState>
  /** Возвращает url, если режим 'code' и нужно вставить код вручную. */
  authStart(): Promise<{ started: boolean; manualUrl?: string }>
  authSubmitCode(code: string): Promise<AuthState>
  authLogout(): Promise<AuthState>
  /** null — Диск не отдал сведения (нужно право cloud_api:disk.info). */
  quota(): Promise<Quota | null>
  speedTest(): Promise<SpeedTestResult>

  listWorlds(instanceId: string): Promise<WorldRow[]>
  worldSize(instanceId: string, world: string): Promise<number>
  readLock(instanceId: string): Promise<CloudLock | null>

  upload(req: OpRequest): Promise<OperationResult>
  download(req: OpRequest): Promise<OperationResult>
  cancel(opId: string): Promise<void>

  pickDirectory(defaultPath?: string): Promise<string | null>
  openPath(target: string): Promise<void>
  openExternal(url: string): Promise<void>

  updateStatus(): Promise<UpdateStatus>
  checkUpdate(): Promise<UpdateStatus>
  /** Начинает скачивание; если платформа не умеет — открывает страницу релиза. */
  installUpdate(): Promise<boolean>
  restartToUpdate(): Promise<void>

  onProgress(cb: (e: ProgressEvent) => void): () => void
  onUpdate(cb: (e: UpdateStatus) => void): () => void
  onLog(cb: (e: LogEntry) => void): () => void
  onAuthChange(cb: (e: AuthState) => void): () => void
}
