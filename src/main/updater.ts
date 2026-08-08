import { app, shell } from 'electron'
import type { AppUpdater } from 'electron-updater'

import type { UpdateStatus } from '@shared/types'
import { isNewerVersion } from '@shared/version'
import { httpJson } from './cloud/http'
import { AppError } from './core/errors'

/**
 * Обновления через GitHub Releases.
 *
 * Две платформы ведут себя по-разному, и это не наша прихоть:
 *  - Windows: electron-updater скачивает установщик и ставит его при выходе;
 *  - macOS: Squirrel.Mac отказывается принимать неподписанное обновление,
 *    обойти это нельзя. Поэтому там мы только сообщаем о новой версии и
 *    открываем страницу релиза — до покупки подписи Apple это максимум.
 *
 * Проверка наличия версии сделана своим запросом к API, а не средствами
 * electron-updater: она нужна одинаково на обеих платформах и работает даже
 * в режиме разработки, где app-update.yml отсутствует.
 */

const REPO = 'sashag00123-cmd/WSync'
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`

/** Обновление умеем устанавливать сами только на Windows. */
const CAN_SELF_INSTALL = process.platform === 'win32'

interface GithubRelease {
  tag_name?: string
  name?: string
  body?: string
  html_url?: string
  draft?: boolean
  prerelease?: boolean
}

let status: UpdateStatus = {
  state: 'idle',
  canInstall: false,
  releaseUrl: RELEASES_PAGE
}

let notify: (next: UpdateStatus) => void = () => undefined
let updaterWired = false

/** Только те члены, которыми пользуемся; quitAndInstall объявлен в BaseUpdater. */
type Updater = AppUpdater & {
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

/**
 * electron-updater объявляет autoUpdater геттером на module.exports, а такие
 * экспорты статический анализатор Node не распознаёт: при import() они не
 * попадают в именованные и доступны только через default. Проверено —
 * mod.autoUpdater равен undefined, отсюда и была ошибка
 * «Cannot set properties of undefined (setting 'autoDownload')».
 */
async function loadUpdater(): Promise<Updater> {
  const mod = (await import('electron-updater')) as unknown as {
    autoUpdater?: Updater
    default?: { autoUpdater?: Updater }
  }
  const updater = mod.default?.autoUpdater ?? mod.autoUpdater
  if (updater === undefined) {
    throw new AppError(
      'UPDATER_UNAVAILABLE',
      'Модуль обновления недоступен в этой сборке — обновитесь со страницы релиза'
    )
  }
  return updater
}

export function initUpdater(onChange: (next: UpdateStatus) => void): void {
  notify = onChange
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

function setStatus(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch }
  notify(status)
}

export async function checkForUpdate(): Promise<UpdateStatus> {
  setStatus({ state: 'checking', error: undefined })
  try {
    const release = await httpJson<GithubRelease>(LATEST_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        // GitHub отклоняет запросы без User-Agent.
        'User-Agent': `WSync/${app.getVersion()}`
      },
      timeoutMs: 15_000
    })

    const tag = release.tag_name ?? ''
    if (tag.length === 0 || release.draft === true) {
      setStatus({ state: 'none', latestVersion: undefined })
      return status
    }

    const latest = tag.replace(/^v/i, '')
    const current = app.getVersion()
    if (!isNewerVersion(latest, current)) {
      setStatus({ state: 'none', latestVersion: latest })
      return status
    }

    setStatus({
      state: 'available',
      latestVersion: latest,
      canInstall: CAN_SELF_INSTALL && app.isPackaged,
      releaseUrl: release.html_url ?? RELEASES_PAGE,
      ...(release.body !== undefined && release.body.trim().length > 0
        ? { notes: release.body.trim().slice(0, 2000) }
        : {})
    })
    return status
  } catch (err) {
    setStatus({
      state: 'error',
      error: err instanceof Error ? err.message : String(err)
    })
    return status
  }
}

/**
 * Скачивает и ставит обновление. Возвращает false, если платформа этого не
 * умеет — тогда вызывающий открывает страницу релиза.
 */
export async function downloadAndInstall(): Promise<boolean> {
  if (!CAN_SELF_INSTALL || !app.isPackaged) {
    await shell.openExternal(status.releaseUrl)
    return false
  }

  // Импорт по требованию: обращение к autoUpdater создаёт объект обновления,
  // которому нужен app-update.yml, а в режиме разработки его нет.
  const autoUpdater = await loadUpdater()

  if (!updaterWired) {
    updaterWired = true
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('download-progress', (progress) => {
      setStatus({ state: 'downloading', percent: Math.round(progress.percent) })
    })
    autoUpdater.on('update-downloaded', () => {
      setStatus({ state: 'ready', percent: 100 })
    })
    autoUpdater.on('error', (err) => {
      setStatus({ state: 'error', error: err.message })
    })
  }

  setStatus({ state: 'downloading', percent: 0, error: undefined })
  try {
    // checkForUpdates обязателен: downloadUpdate без него не знает, что качать.
    await autoUpdater.checkForUpdates()
    await autoUpdater.downloadUpdate()
    return true
  } catch (err) {
    setStatus({ state: 'error', error: err instanceof Error ? err.message : String(err) })
    return false
  }
}

/** Перезапуск с установкой скачанного обновления. */
export async function quitAndInstall(): Promise<void> {
  if (status.state !== 'ready') return
  const autoUpdater = await loadUpdater()
  // isSilent=false, чтобы пользователь видел установщик; isForceRunAfter=true —
  // приложение поднимется само.
  autoUpdater.quitAndInstall(false, true)
}

export function releasesPage(): string {
  return status.releaseUrl
}
