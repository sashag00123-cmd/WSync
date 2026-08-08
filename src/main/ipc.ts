import { BrowserWindow, app, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { IPC, type Envelope, type OpRequest, type WSyncApi } from '@shared/ipc'
import type {
  AppConfig,
  AuthState,
  BuildInfo,
  CloudLock,
  CloudManifest,
  DetectedInstance,
  InstanceConfig,
  LogEntry,
  OperationResult,
  ProgressEvent,
  Quota,
  SpeedTestResult,
  UpdateStatus,
  WorldRow
} from '@shared/types'
import { YandexAuth } from './cloud/yandex/auth'
import { YandexDisk } from './cloud/yandex/client'
import type { CloudProvider } from './cloud/types'
import { HAS_BUILD_CREDENTIALS } from './config/build-defaults'
import { defaultBackupsPath, detectInstances } from './config/detect'
import {
  getInstance,
  loadConfig,
  patchConfig,
  removeInstance,
  upsertInstance
} from './config/store'
import { runDownload } from './core/download'
import { AppError, toErrorInfo } from './core/errors'
import { readLock } from './core/lock'
import { manifestWorld, manifestWorlds, readManifestDetailed } from './core/manifest'
import { isWorldInUse } from './core/running'
import { runCloudSpeedTest } from './core/speedtest'
import { computeStatus } from './core/status'
import { localWorldSize, scanLocalWorlds } from './core/worlds'
import { runUpload } from './core/upload'
import {
  checkForUpdate,
  downloadAndInstall,
  getUpdateStatus,
  initUpdater,
  quitAndInstall
} from './updater'

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

function emitLog(entry: LogEntry): void {
  broadcast(IPC.evLog, entry)
}

function emitProgress(event: ProgressEvent): void {
  broadcast(IPC.evProgress, event)
}

function emitAuth(state: AuthState): void {
  broadcast(IPC.evAuth, state)
}

let authInstance: YandexAuth | null = null
let providerInstance: CloudProvider | null = null

function auth(): YandexAuth {
  if (authInstance === null) {
    authInstance = new YandexAuth(async () => {
      const config = await loadConfig()
      return {
        clientId: config.cloud.clientId,
        clientSecret: config.cloud.clientSecret,
        scope: config.cloud.scope
      }
    }, emitAuth)
    authInstance.onInfo = (message) => {
      emitLog({ ts: Date.now(), level: 'info', message })
    }
  }
  return authInstance
}

function provider(): CloudProvider {
  if (providerInstance === null) {
    providerInstance = new YandexDisk(auth(), (notice) => {
      emitLog({ ts: Date.now(), level: 'warn', message: notice.message })
    })
  }
  return providerInstance
}

/** Одновременно выполняется одна операция: параллельные ломали бы друг другу лок. */
let running: { opId: string; controller: AbortController; label: string } | null = null

function handle<T>(channel: string, fn: (...args: never[]) => Promise<T>): void {
  ipcMain.handle(channel, async (_event, ...args): Promise<Envelope<T>> => {
    try {
      const data = await fn(...(args as never[]))
      return { ok: true, data }
    } catch (err) {
      const error = toErrorInfo(err)
      emitLog({
        ts: Date.now(),
        level: 'error',
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {})
      })
      return { ok: false, error }
    }
  })
}

/**
 * Список миров: локальные и облачные в одной таблице. Статус считается здесь,
 * чтобы renderer не знал ничего о правилах сравнения.
 */
async function listWorlds(instanceId: string): Promise<WorldRow[]> {
  const config = await loadConfig()
  const instance = await getInstance(instanceId)
  const localWorlds = await scanLocalWorlds(instance.savesPath)

  let cloudNames: string[] = []
  let manifest: CloudManifest | null = null
  const authState = await auth().state()
  if (authState.authorized) {
    try {
      const read = await readManifestDetailed(provider(), instance)
      manifest = read.manifest
      cloudNames = manifestWorlds(manifest).map((w) => w.name)
      if (read.skipped.length > 0) {
        emitLog({
          ts: Date.now(),
          level: 'warn',
          message:
            `Миры в облаке, выгруженные прошлой версией одним файлом, не поддерживаются ` +
            `и показаны как локальные: ${read.skipped.join(', ')}. Выгрузите их заново.`
        })
      }
    } catch (err) {
      emitLog({
        ts: Date.now(),
        level: 'warn',
        message: `Не удалось прочитать манифест облака: ${err instanceof Error ? err.message : String(err)}`
      })
    }
  }

  const names = [...new Set([...localWorlds.map((w) => w.name), ...cloudNames])].sort((a, b) =>
    a.localeCompare(b, 'ru')
  )

  const rows: WorldRow[] = []
  for (const name of names) {
    const local = localWorlds.find((w) => w.name === name) ?? null
    const cloud = manifest === null ? null : manifestWorld(manifest, name)
    const inUse = local === null ? { inUse: false, unknown: false } : await isWorldInUse(local.path)
    rows.push({
      name,
      local,
      cloud,
      status: computeStatus({
        localLastPlayed: local?.lastPlayed ?? null,
        cloudLastPlayed: cloud?.lastPlayed ?? null,
        syncedLastPlayed: config.worlds[`${instanceId}/${name}`]?.syncedLastPlayed ?? null
      }),
      inUse: inUse.inUse,
      inUseUnknown: inUse.unknown
    })
  }
  return rows
}

async function startOperation(
  kind: 'upload' | 'download',
  request: OpRequest
): Promise<OperationResult> {
  if (running !== null) {
    throw new AppError(
      'BUSY',
      `Уже выполняется операция: ${running.label}. Дождитесь её завершения или отмените.`
    )
  }
  const config = await loadConfig()
  const instance = await getInstance(request.instanceId)
  const opId = randomUUID()
  const controller = new AbortController()
  running = {
    opId,
    controller,
    label: `${kind === 'upload' ? 'выгрузка' : 'загрузка'} «${request.world}»`
  }

  const params = {
    opId,
    provider: provider(),
    config,
    instance,
    world: request.world,
    confirm: request.confirm,
    signal: controller.signal,
    sinks: { progress: emitProgress, log: emitLog }
  }

  try {
    return kind === 'upload' ? await runUpload(params) : await runDownload(params)
  } finally {
    running = null
  }
}

export function registerIpc(): void {
  initUpdater((next) => broadcast(IPC.evUpdate, next))
  handle<UpdateStatus>(IPC.updateStatus, async () => getUpdateStatus())
  handle<UpdateStatus>(IPC.updateCheck, async () => await checkForUpdate())
  handle<boolean>(IPC.updateInstall, async () => await downloadAndInstall())
  handle<void>(IPC.updateRestart, async () => await quitAndInstall())

  handle<BuildInfo>(IPC.buildInfo, async () => ({
    version: app.getVersion(),
    hasBuildCredentials: HAS_BUILD_CREDENTIALS
  }))

  handle<AppConfig>(IPC.configGet, async () => await loadConfig())
  handle<AppConfig>(IPC.configPatch, async (patch: Partial<AppConfig>) => {
    const saved = await patchConfig(patch)
    // Тему держит и системная часть окна: рамка, нативные диалоги, фон при
    // создании окна. Без этого светлая тема соседствует с тёмной рамкой.
    nativeTheme.themeSource = saved.theme
    return saved
  })
  handle<AppConfig>(IPC.instanceUpsert, async (instance: InstanceConfig) => await upsertInstance(instance))
  handle<AppConfig>(IPC.instanceRemove, async (id: string) => await removeInstance(id))
  handle<DetectedInstance[]>(IPC.detectInstances, async () => await detectInstances())

  handle<AuthState>(IPC.authState, async () => await auth().state())
  handle<{ started: boolean; manualUrl?: string }>(IPC.authStart, async () => await auth().start())
  handle<AuthState>(IPC.authSubmitCode, async (code: string) => await auth().submitCode(code))
  handle<AuthState>(IPC.authLogout, async () => await auth().logout())
  // Квота — необязательная информация: с правом только на папку приложения
  // Диск отвечает 403. Возвращаем null, а не ошибку, чтобы не сорить в журнал
  // при каждом обновлении списка.
  handle<Quota | null>(IPC.cloudQuota, async () => {
    try {
      return await provider().quota()
    } catch {
      return null
    }
  })

  handle<SpeedTestResult>(IPC.cloudSpeedTest, async () => {
    if (running !== null) {
      throw new AppError('BUSY', `Уже выполняется операция: ${running.label}`)
    }
    return await runCloudSpeedTest(provider(), { progress: emitProgress, log: emitLog })
  })

  handle<WorldRow[]>(IPC.worldsList, async (instanceId: string) => await listWorlds(instanceId))
  handle<number>(IPC.worldSize, async (instanceId: string, world: string) => {
    const instance = await getInstance(instanceId)
    return await localWorldSize(instance.savesPath, world)
  })
  handle<CloudLock | null>(IPC.lockRead, async (instanceId: string) => {
    const instance = await getInstance(instanceId)
    return await readLock(provider(), instance)
  })

  handle<OperationResult>(IPC.opUpload, async (request: OpRequest) => await startOperation('upload', request))
  handle<OperationResult>(IPC.opDownload, async (request: OpRequest) => await startOperation('download', request))
  handle<void>(IPC.opCancel, async (opId: string) => {
    if (running !== null && running.opId === opId) {
      running.controller.abort()
      emitLog({ ts: Date.now(), level: 'warn', message: 'Отмена операции…' })
    }
  })

  handle<string | null>(IPC.pickDirectory, async (defaultPath?: string) => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      ...(defaultPath !== undefined && defaultPath.length > 0 ? { defaultPath } : {})
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] ?? null
  })
  handle<void>(IPC.openPath, async (target: string) => {
    await shell.openPath(path.normalize(target))
  })
  handle<void>(IPC.openExternal, async (url: string) => {
    // Открываем только http(s) — не хочется превратить это в запуск чего угодно.
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new AppError('BAD_URL', `Недопустимый протокол: ${parsed.protocol}`)
    }
    await shell.openExternal(url)
  })
}

/** Используется при создании сборки из автодетекта. */
export { defaultBackupsPath }

export type { WSyncApi }
