import type {
  AppConfig,
  AppErrorInfo,
  AuthState,
  ConfirmToken,
  DetectedInstance,
  InstanceConfig,
  LogEntry,
  OperationResult,
  ProgressEvent,
  Quota,
  SpeedTestResult,
  WorldRow,
  CloudLock
} from './types'

export const IPC = {
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

  evProgress: 'ev:progress',
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

  onProgress(cb: (e: ProgressEvent) => void): () => void
  onLog(cb: (e: LogEntry) => void): () => void
  onAuthChange(cb: (e: AuthState) => void): () => void
}
