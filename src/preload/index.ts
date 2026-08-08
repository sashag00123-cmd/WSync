import { contextBridge, ipcRenderer } from 'electron'

import { IPC, type Envelope, type WSyncApi } from '@shared/ipc'
import type { AppErrorInfo, AuthState, LogEntry, ProgressEvent } from '@shared/types'

/** Ошибка с кодом, восстановленная из конверта main-процесса. */
export class IpcError extends Error {
  readonly code: string
  readonly details?: string

  constructor(info: AppErrorInfo) {
    super(info.message)
    this.name = 'IpcError'
    this.code = info.code
    if (info.details !== undefined) this.details = info.details
  }
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const envelope = (await ipcRenderer.invoke(channel, ...args)) as Envelope<T>
  if (!envelope.ok) throw new IpcError(envelope.error)
  return envelope.data
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: WSyncApi = {
  getConfig: () => invoke(IPC.configGet),
  patchConfig: (patch) => invoke(IPC.configPatch, patch),
  upsertInstance: (instance) => invoke(IPC.instanceUpsert, instance),
  removeInstance: (id) => invoke(IPC.instanceRemove, id),
  detectInstances: () => invoke(IPC.detectInstances),

  authState: () => invoke(IPC.authState),
  authStart: () => invoke(IPC.authStart),
  authSubmitCode: (code) => invoke(IPC.authSubmitCode, code),
  authLogout: () => invoke(IPC.authLogout),
  quota: () => invoke(IPC.cloudQuota),
  speedTest: () => invoke(IPC.cloudSpeedTest),

  listWorlds: (instanceId) => invoke(IPC.worldsList, instanceId),
  worldSize: (instanceId, world) => invoke(IPC.worldSize, instanceId, world),
  readLock: (instanceId) => invoke(IPC.lockRead, instanceId),

  upload: (request) => invoke(IPC.opUpload, request),
  download: (request) => invoke(IPC.opDownload, request),
  cancel: (opId) => invoke(IPC.opCancel, opId),

  pickDirectory: (defaultPath) => invoke(IPC.pickDirectory, defaultPath),
  openPath: (target) => invoke(IPC.openPath, target),
  openExternal: (url) => invoke(IPC.openExternal, url),

  onProgress: (cb) => subscribe<ProgressEvent>(IPC.evProgress, cb),
  onLog: (cb) => subscribe<LogEntry>(IPC.evLog, cb),
  onAuthChange: (cb) => subscribe<AuthState>(IPC.evAuth, cb)
}

contextBridge.exposeInMainWorld('wsync', api)
contextBridge.exposeInMainWorld('wsyncPlatform', {
  platform: process.platform
})
