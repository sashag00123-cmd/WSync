import { BrowserWindow, app, nativeTheme, shell } from 'electron'
import path from 'node:path'

import { loadConfig } from './config/store'
import { registerIpc } from './ipc'

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 560,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d1016' : '#f6f7fa',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  window.on('ready-to-show', () => window.show())

  // Внешние ссылки уходят в системный браузер, а не открывают окно Electron.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl !== undefined && devServerUrl.length > 0) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return window
}

// Второй экземпляр опасен: две копии могут одновременно двигать один и тот же
// мир. Активируем уже открытое окно вместо запуска второго процесса.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (existing !== undefined) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    }
  })

  void app.whenReady().then(async () => {
    // Тему применяем до создания окна: иначе первый кадр мигнёт чужим фоном.
    try {
      nativeTheme.themeSource = (await loadConfig()).theme
    } catch {
      // Битый конфиг не должен мешать запуску — останется системная тема.
    }
    registerIpc()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
