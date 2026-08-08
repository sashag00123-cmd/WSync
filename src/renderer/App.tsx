import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  AppConfig,
  AppErrorInfo,
  AuthState,
  BuildInfo,
  CloudLock,
  LogEntry,
  OperationResult,
  ProgressEvent,
  Quota,
  SpeedTestResult,
  WorldRow
} from '@shared/types'

import { ConfirmDialog } from './components/ConfirmDialog'
import { BrandMark, Icon } from './components/Icon'
import { LogPanel } from './components/LogPanel'
import { ProgressDock } from './components/ProgressDock'
import { SettingsView } from './components/SettingsView'
import { Toasts, type Toast } from './components/Toasts'
import { WorldList } from './components/WorldList'
import { formatBytes, formatDate, statusView } from './lib/format'

const MAX_LOG_ENTRIES = 400

interface ConfirmRequest {
  title: string
  lines: string[]
  confirmLabel: string
  danger: boolean
  resolve: (agreed: boolean) => void
}

function errorInfo(err: unknown): AppErrorInfo {
  if (typeof err === 'object' && err !== null && 'code' in err && 'message' in err) {
    const typed = err as { code: string; message: string; details?: string }
    return {
      code: typed.code,
      message: typed.message,
      ...(typed.details !== undefined ? { details: typed.details } : {})
    }
  }
  return { code: 'UNKNOWN', message: err instanceof Error ? err.message : String(err) }
}

export function App(): React.JSX.Element {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [buildInfo, setBuildInfo] = useState<BuildInfo>({
    version: '',
    hasBuildCredentials: false
  })
  const [authState, setAuthState] = useState<AuthState>({ authorized: false, needsClientId: true })
  const [quota, setQuota] = useState<Quota | null>(null)
  const [instanceId, setInstanceId] = useState<string>('')
  const [rows, setRows] = useState<WorldRow[]>([])
  const [sizes, setSizes] = useState<Record<string, number>>({})
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [progress, setProgress] = useState<ProgressEvent | null>(null)
  const [activeOpId, setActiveOpId] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [view, setView] = useState<'worlds' | 'settings'>('worlds')
  const [toasts, setToasts] = useState<Toast[]>([])
  const [loadingWorlds, setLoadingWorlds] = useState(false)
  const [lock, setLock] = useState<CloudLock | null>(null)
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)

  const sizeRunId = useRef(0)
  const toastId = useRef(0)

  const pushLog = useCallback((entry: LogEntry): void => {
    setLogs((current) => [...current.slice(-(MAX_LOG_ENTRIES - 1)), entry])
  }, [])

  const dismissToast = useCallback((id: number): void => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const showToast = useCallback(
    (toast: Omit<Toast, 'id'>, autoHideMs?: number): void => {
      toastId.current += 1
      const id = toastId.current
      setToasts((current) => [...current.slice(-3), { ...toast, id }])
      if (autoHideMs !== undefined) {
        window.setTimeout(() => dismissToast(id), autoHideMs)
      }
    },
    [dismissToast]
  )

  const showError = useCallback(
    (info: AppErrorInfo): void => {
      showToast({
        level: 'error',
        title: info.message,
        code: info.code,
        ...(info.details !== undefined ? { details: info.details } : {})
      })
    },
    [showToast]
  )

  // ── Подписки на события main-процесса ─────────────────────────────────────
  useEffect(() => {
    const offLog = window.wsync.onLog(pushLog)
    const offProgress = window.wsync.onProgress((event) => {
      setProgress(event)
      setActiveOpId(event.opId)
    })
    const offAuth = window.wsync.onAuthChange(setAuthState)
    return () => {
      offLog()
      offProgress()
      offAuth()
    }
  }, [pushLog])

  const reloadConfig = useCallback(async (): Promise<AppConfig | null> => {
    try {
      const loaded = await window.wsync.getConfig()
      setConfig(loaded)
      setInstanceId((current) => {
        if (current !== '' && loaded.instances.some((item) => item.id === current)) return current
        return loaded.instances[0]?.id ?? ''
      })
      return loaded
    } catch (err) {
      showError(errorInfo(err))
      return null
    }
  }, [showError])

  useEffect(() => {
    void (async () => {
      const loaded = await reloadConfig()
      try {
        setBuildInfo(await window.wsync.buildInfo())
        setAuthState(await window.wsync.authState())
      } catch (err) {
        showError(errorInfo(err))
      }
      if (loaded !== null && loaded.instances.length === 0) setView('settings')
    })()
  }, [reloadConfig, showError])

  // ── Список миров ──────────────────────────────────────────────────────────
  const refreshWorlds = useCallback(async (): Promise<void> => {
    if (instanceId === '') {
      setRows([])
      return
    }
    setLoadingWorlds(true)
    try {
      const loaded = await window.wsync.listWorlds(instanceId)
      setRows(loaded)

      if (authState.authorized) {
        try {
          setLock(await window.wsync.readLock(instanceId))
        } catch {
          setLock(null)
        }
      } else {
        setLock(null)
      }

      // Размер мира — обход дерева на десятки тысяч файлов, поэтому считаем
      // его в фоне и по одному, чтобы не морозить окно и не грузить диск.
      const runId = sizeRunId.current + 1
      sizeRunId.current = runId
      void (async () => {
        for (const row of loaded) {
          if (sizeRunId.current !== runId) return
          if (row.local === null) continue
          try {
            const size = await window.wsync.worldSize(instanceId, row.name)
            if (sizeRunId.current !== runId) return
            setSizes((current) => ({ ...current, [row.name]: size }))
          } catch {
            // Размер не критичен — молча пропускаем.
          }
        }
      })()
    } catch (err) {
      setRows([])
      showError(errorInfo(err))
    } finally {
      setLoadingWorlds(false)
    }
  }, [instanceId, authState.authorized, showError])

  useEffect(() => {
    void refreshWorlds()
  }, [refreshWorlds])

  useEffect(() => {
    if (!authState.authorized) {
      setQuota(null)
      return
    }
    void window.wsync
      .quota()
      .then(setQuota)
      .catch(() => setQuota(null))
  }, [authState.authorized])

  // ── Подтверждения ─────────────────────────────────────────────────────────
  const ask = useCallback((request: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      setConfirmRequest({ ...request, resolve })
    })
  }, [])

  const resolveConfirm = (agreed: boolean): void => {
    confirmRequest?.resolve(agreed)
    setConfirmRequest(null)
  }

  const overwriteLines = (row: WorldRow | undefined, kind: 'upload' | 'download'): string[] => {
    const status = row === undefined ? null : statusView(row.status)
    const lines: string[] = []
    if (status !== null) lines.push(`Статус: ${status.label}. ${status.hint}`)
    if (kind === 'upload') {
      lines.push(
        row?.cloud != null
          ? `Облачная копия (последняя игра ${formatDate(row.cloud.lastPlayed)}, выгружена машиной «${row.cloud.uploadedBy}») будет заменена локальной (${formatDate(row.local?.lastPlayed ?? null)}).`
          : 'Локальная копия будет выгружена в облако.'
      )
      lines.push('Прежняя облачная копия сначала уйдёт в облачные бэкапы — потерять её нельзя.')
    } else {
      lines.push(
        row?.local != null
          ? `Локальный мир (последняя игра ${formatDate(row.local.lastPlayed)}) будет заменён облачной копией (${formatDate(row.cloud?.lastPlayed ?? null)}).`
          : 'Облачная копия будет распакована на этот ПК.'
      )
      lines.push('Прежний локальный мир сначала уйдёт в каталог бэкапов — потерять его нельзя.')
    }
    return lines
  }

  // ── Операции ──────────────────────────────────────────────────────────────
  const runOperation = useCallback(
    async (kind: 'upload' | 'download', world: string): Promise<void> => {
      if (activeOpId !== null) return
      const row = rows.find((item) => item.name === world)
      const confirm = { overwriteNewer: false, ignoreLock: false }
      setCancelling(false)

      for (let attempt = 0; attempt < 3; attempt++) {
        let result: OperationResult
        try {
          const request = { instanceId, world, confirm }
          result =
            kind === 'upload'
              ? await window.wsync.upload(request)
              : await window.wsync.download(request)
        } catch (err) {
          showError(errorInfo(err))
          break
        } finally {
          setActiveOpId(null)
        }

        if (result.ok) {
          setProgress(null)
          showToast(
            {
              level: 'ok',
              title:
                kind === 'upload'
                  ? `Мир «${world}» выгружен в облако`
                  : `Мир «${world}» загружен на этот ПК`
            },
            8000
          )
          if (result.backupPath !== undefined) {
            pushLog({ ts: Date.now(), level: 'info', message: `Бэкап: ${result.backupPath}` })
          }
          break
        }
        if (result.cancelled === true) {
          setProgress(null)
          break
        }

        const code = result.error?.code
        if (code === 'CONFIRM_REQUIRED' && !confirm.overwriteNewer) {
          const agreed = await ask({
            title: kind === 'upload' ? 'Перезаписать копию в облаке?' : 'Перезаписать мир на ПК?',
            lines: overwriteLines(row, kind),
            confirmLabel: kind === 'upload' ? 'Выгрузить' : 'Загрузить',
            danger: true
          })
          if (!agreed) {
            setProgress(null)
            break
          }
          confirm.overwriteNewer = true
          continue
        }
        if (code === 'CLOUD_LOCKED' && !confirm.ignoreLock) {
          const agreed = await ask({
            title: 'Мир занят другой машиной',
            lines: [
              result.error?.message ?? '',
              'Возможно, там прямо сейчас идёт синхронизация. Продолжайте только если уверены, что та операция завершилась или прервалась.'
            ],
            confirmLabel: 'Всё равно продолжить',
            danger: true
          })
          if (!agreed) {
            setProgress(null)
            break
          }
          confirm.ignoreLock = true
          continue
        }

        setProgress(null)
        if (result.error !== undefined) showError(result.error)
        break
      }

      setCancelling(false)
      await refreshWorlds()
    },
    [activeOpId, ask, instanceId, pushLog, refreshWorlds, rows, showError, showToast]
  )

  const cancel = useCallback((): void => {
    if (activeOpId === null) return
    setCancelling(true)
    void window.wsync.cancel(activeOpId)
  }, [activeOpId])

  // ── Настройки ─────────────────────────────────────────────────────────────
  const saveSettings = useCallback(
    async (next: AppConfig): Promise<void> => {
      try {
        const saved = await window.wsync.patchConfig(next)
        setConfig(saved)
        setInstanceId((current) =>
          saved.instances.some((item) => item.id === current) ? current : (saved.instances[0]?.id ?? '')
        )
        setAuthState(await window.wsync.authState())
        showToast({ level: 'ok', title: 'Настройки сохранены' }, 4000)
      } catch (err) {
        showError(errorInfo(err))
      }
    },
    [showError, showToast]
  )

  const connect = useCallback(async (): Promise<void> => {
    try {
      const result = await window.wsync.authStart()
      if (result.manualUrl !== undefined) await window.wsync.openExternal(result.manualUrl)
      pushLog({ ts: Date.now(), level: 'info', message: 'Открыт браузер для авторизации' })
    } catch (err) {
      showError(errorInfo(err))
    }
  }, [pushLog, showError])

  const submitCode = useCallback(
    async (code: string): Promise<void> => {
      try {
        setAuthState(await window.wsync.authSubmitCode(code))
        showToast({ level: 'ok', title: 'Яндекс.Диск подключён' }, 5000)
      } catch (err) {
        showError(errorInfo(err))
      }
    },
    [showError, showToast]
  )

  const disconnect = useCallback(async (): Promise<void> => {
    try {
      setAuthState(await window.wsync.authLogout())
    } catch (err) {
      showError(errorInfo(err))
    }
  }, [showError])

  const refreshQuota = useCallback(async (): Promise<void> => {
    try {
      setQuota(await window.wsync.quota())
    } catch (err) {
      showError(errorInfo(err))
    }
  }, [showError])

  const speedTest = useCallback(async (): Promise<SpeedTestResult> => {
    return await window.wsync.speedTest()
  }, [])

  const instances = config?.instances ?? []
  const busy = activeOpId !== null
  const currentInstance = instances.find((item) => item.id === instanceId)
  const divergedCount = useMemo(
    () => rows.filter((row) => row.status === 'diverged').length,
    [rows]
  )
  const freeSpace = quota === null ? null : quota.total - quota.used

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <BrandMark size={26} />
          <span className="brand-name">WSync</span>
        </div>

        {view === 'worlds' && instances.length > 1 && (
          <select
            className="instance-select"
            value={instanceId}
            onChange={(event) => setInstanceId(event.target.value)}
            disabled={busy}
          >
            {instances.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {instance.name}
              </option>
            ))}
          </select>
        )}
        {view === 'worlds' && instances.length === 1 && currentInstance !== undefined && (
          <span style={{ fontWeight: 550 }}>{currentInstance.name}</span>
        )}

        <span className="grow" />

        <div className={`account${authState.authorized ? '' : ' off'}`}>
          <Icon name={authState.authorized ? 'cloud' : 'cloudOff'} size={18} />
          <div className="who">
            <b>
              {authState.authorized
                ? (authState.login ?? 'Яндекс.Диск')
                : authState.needsClientId
                  ? 'Нужен client_id'
                  : 'Не подключено'}
            </b>
            {freeSpace !== null && quota !== null ? (
              <>
                <span className="num">{formatBytes(freeSpace)} свободно</span>
                <div className={`quota${freeSpace / quota.total < 0.1 ? ' tight' : ''}`}>
                  <i style={{ width: `${Math.min(100, (quota.used / quota.total) * 100)}%` }} />
                </div>
              </>
            ) : (
              <span>{authState.authorized ? 'сведения о диске недоступны' : 'нет подключения'}</span>
            )}
          </div>
        </div>

        {view === 'worlds' ? (
          <>
            <button
              className="ghost icon-only"
              title="Обновить список"
              onClick={() => void refreshWorlds()}
              disabled={loadingWorlds || busy}
            >
              <Icon name={loadingWorlds ? 'spinner' : 'refresh'} size={17} />
            </button>
            <button onClick={() => setView('settings')}>
              <Icon name="settings" size={16} />
              Настройки
            </button>
          </>
        ) : (
          <button onClick={() => setView('worlds')} disabled={instances.length === 0}>
            <Icon name="list" size={16} />
            К списку миров
          </button>
        )}
      </header>

      <main className="main">
        {view === 'settings' && config !== null ? (
          <SettingsView
            config={config}
            buildInfo={buildInfo}
            authState={authState}
            quota={quota}
            onSave={saveSettings}
            onConnect={connect}
            onSubmitCode={submitCode}
            onDisconnect={disconnect}
            onRefreshQuota={refreshQuota}
            onSpeedTest={speedTest}
          />
        ) : (
          <div className="page">
            {!authState.authorized && (
              <div className="notice warn">
                <Icon name="cloudOff" size={19} />
                <div className="grow">
                  <b>
                    {authState.needsClientId ? 'Не задан client_id' : 'Яндекс.Диск не подключён'}
                  </b>
                  <div className="sub">Облачные копии не видны</div>
                </div>
                <button className="sm" onClick={() => setView('settings')}>
                  <Icon name="settings" size={15} />
                  Настроить
                </button>
              </div>
            )}

            {lock !== null && (
              <div className="notice warn">
                <Icon name="lock" size={19} />
                <div className="grow">
                  <b>В облаке стоит метка операции</b>
                  <div className="sub">
                    Машина «{lock.machine}» {lock.operation === 'upload' ? 'выгружала' : 'загружала'}{' '}
                    мир «{lock.world}», {formatDate(lock.takenAt)}
                  </div>
                </div>
              </div>
            )}

            {divergedCount > 0 && (
              <div className="notice warn">
                <Icon name="alert" size={19} />
                <div className="grow">
                  <b>Расхождений: {divergedCount}</b>
                  <div className="sub">Играли и здесь, и на другой машине после синхронизации</div>
                </div>
              </div>
            )}

            <section className="card">
              <div className="card-head">
                <span className="hicon">
                  <Icon name="world" size={18} />
                </span>
                <h2>Миры</h2>
                <span className="grow" />
                {currentInstance !== undefined && (
                  <span className="sub mono" title={currentInstance.savesPath}>
                    {currentInstance.savesPath}
                  </span>
                )}
              </div>

              {instances.length === 0 ? (
                <div className="empty-state">
                  <div className="ring">
                    <Icon name="folderOpen" size={24} />
                  </div>
                  <b>Сборки не настроены</b>
                  <div>Добавьте каталог saves в настройках</div>
                  <button className="primary sm" onClick={() => setView('settings')}>
                    <Icon name="settings" size={15} />
                    Открыть настройки
                  </button>
                </div>
              ) : (
                <WorldList
                  rows={rows}
                  sizes={sizes}
                  busy={busy}
                  busyWorld={progress?.world ?? null}
                  authorized={authState.authorized}
                  onUpload={(world) => void runOperation('upload', world)}
                  onDownload={(world) => void runOperation('download', world)}
                />
              )}
            </section>

            <LogPanel entries={logs} onClear={() => setLogs([])} />
          </div>
        )}
      </main>

      {progress !== null && (
        <ProgressDock event={progress} onCancel={cancel} cancelling={cancelling} />
      )}

      <Toasts items={toasts} onDismiss={dismissToast} />

      {confirmRequest !== null && (
        <ConfirmDialog
          title={confirmRequest.title}
          lines={confirmRequest.lines}
          confirmLabel={confirmRequest.confirmLabel}
          danger={confirmRequest.danger}
          onConfirm={() => resolveConfirm(true)}
          onCancel={() => resolveConfirm(false)}
        />
      )}
    </div>
  )
}
