import { useState } from 'react'

import {
  DEFAULT_YANDEX_SCOPE,
  normalizeScope,
  type AppConfig,
  type AuthState,
  type BuildInfo,
  type DetectedInstance,
  type InstanceConfig,
  type Quota,
  type SpeedTestResult,
  type ThemeMode,
  type UpdateStatus
} from '@shared/types'

import { formatBytes } from '../lib/format'
import { Icon } from './Icon'

export interface SettingsViewProps {
  config: AppConfig
  buildInfo: BuildInfo
  authState: AuthState
  quota: Quota | null
  onSave: (next: AppConfig) => Promise<void>
  onConnect: () => Promise<void>
  onSubmitCode: (code: string) => Promise<void>
  onDisconnect: () => Promise<void>
  onRefreshQuota: () => Promise<void>
  onSpeedTest: () => Promise<SpeedTestResult>
  updateStatus: UpdateStatus
  onCheckUpdate: () => Promise<void>
  onInstallUpdate: () => Promise<void>
  onRestartUpdate: () => Promise<void>
}

/** Текст состояния обновления — вся ветвистость собрана в одном месте. */
export function updateText(status: UpdateStatus, currentVersion: string): string {
  switch (status.state) {
    case 'checking':
      return 'проверяю…'
    case 'available':
      return `доступна ${status.latestVersion}`
    case 'downloading':
      return `скачиваю ${status.percent ?? 0}%`
    case 'ready':
      return `${status.latestVersion} скачана, нужен перезапуск`
    case 'none':
      return `установлена последняя версия (${currentVersion})`
    case 'error':
      return `не удалось проверить: ${status.error ?? 'неизвестная ошибка'}`
    case 'idle':
    default:
      return ''
  }
}

/** Кнопка действия зависит и от состояния, и от того, умеет ли платформа ставить сама. */
export function UpdateAction(props: {
  status: UpdateStatus
  onInstall: () => Promise<void>
  onRestart: () => Promise<void>
}): React.JSX.Element | null {
  const { status } = props
  if (status.state === 'ready') {
    return (
      <button className="primary" onClick={() => void props.onRestart()}>
        <Icon name="refresh" size={16} />
        Перезапустить и обновить
      </button>
    )
  }
  if (status.state === 'downloading') {
    return (
      <button disabled>
        <Icon name="spinner" size={16} />
        Скачиваю {status.percent ?? 0}%
      </button>
    )
  }
  if (status.state !== 'available') return null
  return (
    <button className="primary" onClick={() => void props.onInstall()}>
      <Icon name={status.canInstall ? 'download' : 'external'} size={16} />
      {status.canInstall ? `Обновить до ${status.latestVersion}` : 'Открыть страницу релиза'}
    </button>
  )
}

function slug(value: string): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '')
  return base.length > 0 ? base : 'instance'
}

function parentOf(dir: string): { parent: string; sep: string; name: string } {
  const sep = dir.includes('\\') ? '\\' : '/'
  const parts = dir.split(sep).filter((part) => part.length > 0)
  return {
    sep,
    parent: parts.slice(0, -1).join(sep),
    name: parts[parts.length - 2] ?? 'Minecraft'
  }
}

export function SettingsView(props: SettingsViewProps): React.JSX.Element {
  const [draft, setDraft] = useState<AppConfig>(props.config)
  const [detected, setDetected] = useState<DetectedInstance[] | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [code, setCode] = useState('')
  const [saving, setSaving] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [testing, setTesting] = useState(false)
  const [speed, setSpeed] = useState<SpeedTestResult | null>(null)

  const dirty = JSON.stringify(draft) !== JSON.stringify(props.config)

  /** Права поменяли после подключения — токен их не подхватит, нужен переввод кода. */
  const scopeChanged =
    props.authState.authorized &&
    props.authState.grantedScope !== undefined &&
    normalizeScope(props.authState.grantedScope) !== normalizeScope(draft.cloud.scope)

  const patchCloud = (patch: Partial<AppConfig['cloud']>): void => {
    setDraft((current) => ({ ...current, cloud: { ...current.cloud, ...patch } }))
  }

  const patchInstance = (id: string, patch: Partial<InstanceConfig>): void => {
    setDraft((current) => ({
      ...current,
      instances: current.instances.map((item) => (item.id === id ? { ...item, ...patch } : item))
    }))
  }

  const pick = async (
    id: string,
    field: 'savesPath' | 'backupsPath',
    current: string
  ): Promise<void> => {
    const chosen = await window.wsync.pickDirectory(current)
    if (chosen !== null) patchInstance(id, { [field]: chosen })
  }

  /** Подключение само сохраняет правки: иначе авторизация ушла бы со старым client_id. */
  const connect = async (): Promise<void> => {
    setConnecting(true)
    try {
      if (dirty) await props.onSave(draft)
      await props.onConnect()
    } finally {
      setConnecting(false)
    }
  }

  const runSpeedTest = async (): Promise<void> => {
    setTesting(true)
    setSpeed(null)
    try {
      setSpeed(await props.onSpeedTest())
    } finally {
      setTesting(false)
    }
  }

  const addInstance = (name: string, savesPath: string): void => {
    const { parent, sep } = parentOf(savesPath)
    setDraft((current) => ({
      ...current,
      instances: [
        ...current.instances,
        {
          id: `${slug(name)}-${Math.random().toString(36).slice(2, 6)}`,
          name,
          savesPath,
          backupsPath: `${parent}${sep}wsync_backups`,
          cloudFolder: slug(name)
        }
      ]
    }))
    setDetected(null)
  }

  const addManual = async (): Promise<void> => {
    const chosen = await window.wsync.pickDirectory()
    if (chosen === null) return
    addInstance(parentOf(chosen).name, chosen)
  }

  const usedRatio =
    props.quota === null || props.quota.total === 0 ? 0 : props.quota.used / props.quota.total

  const credentialFields = (
    <>
      <div className="label">client_id приложения</div>
      <input
        className="mono"
        value={draft.cloud.clientId}
        placeholder="1a2b3c4d5e6f7890abcdef1234567890"
        onChange={(event) => patchCloud({ clientId: event.target.value })}
      />

      <div className="label">client_secret</div>
      <input
        type="password"
        className="mono"
        value={draft.cloud.clientSecret}
        placeholder="необязательно"
        onChange={(event) => patchCloud({ clientSecret: event.target.value })}
      />

      <div className="label">Запрашиваемые права</div>
      <input
        className="mono"
        value={draft.cloud.scope}
        placeholder={DEFAULT_YANDEX_SCOPE}
        onChange={(event) => patchCloud({ scope: event.target.value })}
      />
    </>
  )

  return (
    <div className="page">
      {/* ── Облако ─────────────────────────────────────────────────────── */}
      <section className="card">
        <div className="card-head">
          <span className="hicon">
            <Icon name={props.authState.authorized ? 'cloud' : 'cloudOff'} size={18} />
          </span>
          <h2>Яндекс.Диск</h2>
          <span className="grow" />
          <span className={`pill ${props.authState.authorized ? 'ok' : props.authState.needsClientId ? 'warn' : 'muted'}`}>
            <i className="dot" />
            {props.authState.authorized
              ? (props.authState.login ?? 'подключено')
              : props.authState.needsClientId
                ? 'нужен client_id'
                : 'не подключено'}
          </span>
        </div>

        <div className="card-body">
          {/*
            Когда ключи вшиты в сборку, поля прячутся: пользователю в них нечего
            делать. Совсем убирать нельзя — они нужны при запуске из исходников
            без переменных окружения, при диагностике прав (мы так лечили
            invalid_scope) и если вшитый ключ придётся перевыпустить.
          */}
          {props.buildInfo.hasBuildCredentials ? (
            <details className="det keys">
              <summary>Ключи приложения — вшиты в сборку</summary>
              <div className="fields" style={{ marginTop: 14 }}>
                {credentialFields}
              </div>
            </details>
          ) : (
            <div className="fields">{credentialFields}</div>
          )}

          {scopeChanged && (
            <p className="hint warn">
              Права изменились после подключения — переподключитесь, чтобы токен их получил.
            </p>
          )}

          {props.authState.authorized ? (
            <>
              <div className="row wrap" style={{ marginTop: 16 }}>
                <button onClick={() => void props.onDisconnect()}>
                  <Icon name="logout" size={16} />
                  Отключить
                </button>
                <button onClick={() => void props.onRefreshQuota()}>
                  <Icon name="refresh" size={16} />
                  Обновить сведения
                </button>
                <button disabled={testing} onClick={() => void runSpeedTest()}>
                  <Icon name={testing ? 'spinner' : 'gauge'} size={16} />
                  {testing ? 'Проверяю скорость' : 'Проверить скорость'}
                </button>
              </div>

              {props.quota !== null ? (
                <div style={{ marginTop: 14, maxWidth: 380 }}>
                  <div className="row" style={{ justifyContent: 'space-between', fontSize: 12.5 }}>
                    <span style={{ color: 'var(--text-dim)' }}>
                      Занято {formatBytes(props.quota.used)} из {formatBytes(props.quota.total)}
                    </span>
                    <span className="num" style={{ color: 'var(--text-mute)' }}>
                      {formatBytes(props.quota.total - props.quota.used)} свободно
                    </span>
                  </div>
                  <div className={`quota${usedRatio > 0.9 ? ' tight' : ''}`} style={{ width: '100%', height: 7, marginTop: 6 }}>
                    <i style={{ width: `${Math.min(100, usedRatio * 100)}%` }} />
                  </div>
                </div>
              ) : (
                <p className="hint">
                  Сведения о диске недоступны: нет права <code className="mono">cloud_api:disk.info</code>
                </p>
              )}

              {speed !== null && (
                <p className="hint">
                  Один поток: <b>{formatBytes(speed.singleBytesPerSec)}/с</b>. {speed.streams} потока:{' '}
                  <b>{formatBytes(speed.parallelBytesPerSec)}/с</b>. Выигрыш ×
                  {speed.speedup.toFixed(1)}.
                </p>
              )}
            </>
          ) : (
            <>
              <div className="row wrap" style={{ marginTop: 16 }}>
                <button
                  className="primary"
                  disabled={draft.cloud.clientId.trim().length === 0 || connecting}
                  onClick={() => void connect()}
                >
                  <Icon name={connecting ? 'spinner' : 'external'} size={16} />
                  {connecting ? 'Открываем браузер' : 'Подключить Яндекс.Диск'}
                </button>
                {draft.cloud.clientId.trim().length === 0 && (
                  <span style={{ fontSize: 12.5, color: 'var(--text-mute)' }}>
                    Сначала вставьте client_id
                  </span>
                )}
              </div>

              <div className="row" style={{ marginTop: 12, maxWidth: 480 }}>
                <input
                  value={code}
                  placeholder="Код подтверждения из браузера"
                  onChange={(event) => setCode(event.target.value)}
                />
                <button
                  disabled={code.trim().length === 0}
                  onClick={() => {
                    void props.onSubmitCode(code).then(() => setCode(''))
                  }}
                >
                  <Icon name="check" size={16} />
                  Готово
                </button>
              </div>
            </>
          )}
        </div>
      </section>

      {/* ── Сборки ─────────────────────────────────────────────────────── */}
      <section className="card">
        <div className="card-head">
          <span className="hicon">
            <Icon name="folder" size={18} />
          </span>
          <h2>Сборки</h2>
          <span className="grow" />
          <button className="sm" disabled={detecting} onClick={() => void runDetect()}>
            <Icon name={detecting ? 'spinner' : 'search'} size={15} />
            {detecting ? 'Поиск' : 'Найти автоматически'}
          </button>
          <button className="sm" onClick={() => void addManual()}>
            <Icon name="plus" size={15} />
            Добавить вручную
          </button>
        </div>

        <div className="card-body">
          {draft.instances.length === 0 && detected === null && (
            <div className="empty-state" style={{ padding: '30px 20px' }}>
              <div className="ring">
                <Icon name="folderOpen" size={22} />
              </div>
              <b>Сборки не добавлены</b>
            </div>
          )}

          {draft.instances.map((instance) => (
            <div className="instance" key={instance.id}>
              <div className="instance-top">
                <Icon name="drive" size={18} />
                <input
                  value={instance.name}
                  onChange={(event) => patchInstance(instance.id, { name: event.target.value })}
                />
                <button
                  className="ghost icon-only"
                  title="Удалить сборку"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      instances: current.instances.filter((item) => item.id !== instance.id)
                    }))
                  }
                >
                  <Icon name="trash" size={16} />
                </button>
              </div>

              <div className="fields">
                <div className="label">Каталог saves</div>
                <div className="row">
                  <span className="path-box mono" title={instance.savesPath}>
                    <Icon name="folder" size={15} />
                    <span>{instance.savesPath}</span>
                  </span>
                  <button
                    className="sm"
                    onClick={() => void pick(instance.id, 'savesPath', instance.savesPath)}
                  >
                    Выбрать
                  </button>
                  <button
                    className="ghost icon-only"
                    title="Открыть в проводнике"
                    onClick={() => void window.wsync.openPath(instance.savesPath)}
                  >
                    <Icon name="external" size={15} />
                  </button>
                </div>

                <div className="label">Каталог бэкапов</div>
                <div className="row">
                  <span className="path-box mono" title={instance.backupsPath}>
                    <Icon name="folder" size={15} />
                    <span>{instance.backupsPath}</span>
                  </span>
                  <button
                    className="sm"
                    onClick={() => void pick(instance.id, 'backupsPath', instance.backupsPath)}
                  >
                    Выбрать
                  </button>
                  <button
                    className="ghost icon-only"
                    title="Открыть в проводнике"
                    onClick={() => void window.wsync.openPath(instance.backupsPath)}
                  >
                    <Icon name="external" size={15} />
                  </button>
                </div>

                <div className="label">Папка в облаке</div>
                <input
                  className="mono"
                  value={instance.cloudFolder}
                  onChange={(event) => patchInstance(instance.id, { cloudFolder: event.target.value })}
                />
              </div>
            </div>
          ))}

          {detected !== null && (
            <div className="found">
              {detected.length === 0 ? (
                <p className="hint" style={{ margin: 0 }}>
                  Ничего не найдено
                </p>
              ) : (
                detected.map((item) => (
                  <div className="found-item" key={item.savesPath}>
                    <Icon name="drive" size={18} />
                    <div className="grow">
                      <b>{item.name}</b>{' '}
                      <span style={{ fontSize: 12, color: 'var(--text-mute)' }}>{item.launcher}</span>
                      <div className="mono" style={{ color: 'var(--text-mute)' }} title={item.savesPath}>
                        {item.savesPath}
                      </div>
                    </div>
                    <button className="sm" onClick={() => addInstance(item.name, item.savesPath)}>
                      <Icon name="plus" size={15} />
                      Добавить
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </section>

      {/* ── Бэкапы ─────────────────────────────────────────────────────── */}
      <section className="card">
        <div className="card-head">
          <span className="hicon">
            <Icon name="settings" size={18} />
          </span>
          <h2>Приложение и бэкапы</h2>
        </div>
        <div className="card-body">
          <div className="fields">
            <div className="label">Обновления</div>
            <div className="row wrap">
              <button
                disabled={props.updateStatus.state === 'checking'}
                onClick={() => void props.onCheckUpdate()}
              >
                <Icon
                  name={props.updateStatus.state === 'checking' ? 'spinner' : 'refresh'}
                  size={16}
                />
                {props.updateStatus.state === 'checking' ? 'Проверяю' : 'Проверить обновления'}
              </button>
              <UpdateAction status={props.updateStatus} onInstall={props.onInstallUpdate} onRestart={props.onRestartUpdate} />
              <span style={{ fontSize: 12.5, color: 'var(--text-mute)' }}>
                {updateText(props.updateStatus, props.buildInfo.version)}
              </span>
            </div>

            <div className="label">Оформление</div>
            <div className="segmented" role="group">
              {(
                [
                  ['system', 'Как в системе'],
                  ['dark', 'Тёмная'],
                  ['light', 'Светлая']
                ] as Array<[ThemeMode, string]>
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  aria-pressed={draft.theme === mode}
                  onClick={() => setDraft((current) => ({ ...current, theme: mode }))}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="label">Имя этой машины</div>
            <input
              value={draft.machineName}
              onChange={(event) =>
                setDraft((current) => ({ ...current, machineName: event.target.value }))
              }
            />

            <div className="label">Хранить бэкапов на мир</div>
            <input
              type="number"
              min={1}
              max={50}
              className="num"
              value={draft.backups.keepPerWorld}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  backups: { ...current.backups, keepPerWorld: Number(event.target.value) }
                }))
              }
            />

            <div className="label">Лимит объёма бэкапов, ГБ</div>
            <input
              type="number"
              min={1}
              max={10000}
              className="num"
              value={draft.backups.maxTotalGb}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  backups: { ...current.backups, maxTotalGb: Number(event.target.value) }
                }))
              }
            />
          </div>
        </div>
      </section>

      <div className="version">WSync {props.buildInfo.version}</div>

      {dirty && (
        <div className="save-bar">
          <Icon name="info" size={17} />
          <span className="grow">Есть несохранённые изменения</span>
          <button onClick={() => setDraft(props.config)}>Отменить</button>
          <button className="primary" disabled={saving} onClick={() => void save()}>
            <Icon name={saving ? 'spinner' : 'check'} size={16} />
            {saving ? 'Сохранение' : 'Сохранить'}
          </button>
        </div>
      )}
    </div>
  )

  async function runDetect(): Promise<void> {
    setDetecting(true)
    try {
      setDetected(await window.wsync.detectInstances())
    } finally {
      setDetecting(false)
    }
  }

  async function save(): Promise<void> {
    setSaving(true)
    try {
      await props.onSave(draft)
    } finally {
      setSaving(false)
    }
  }
}
