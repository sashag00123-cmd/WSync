import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * Ключи приложения Яндекс.OAuth вшиваются в сборку из окружения. В CI это
 * секреты репозитория, локально — переменные окружения; если их нет, значения
 * пустые и пользователь вводит ключи в настройках сам.
 */
const buildCredentials = {
  __WSYNC_CLIENT_ID__: JSON.stringify(process.env['WSYNC_YANDEX_CLIENT_ID'] ?? ''),
  __WSYNC_CLIENT_SECRET__: JSON.stringify(process.env['WSYNC_YANDEX_CLIENT_SECRET'] ?? ''),
  __WSYNC_SCOPE__: JSON.stringify(process.env['WSYNC_YANDEX_SCOPE'] ?? '')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: buildCredentials,
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    }
  }
})
