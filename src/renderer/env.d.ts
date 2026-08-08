import type { WSyncApi } from '@shared/ipc'

declare global {
  interface Window {
    wsync: WSyncApi
    wsyncPlatform: { platform: string }
  }
}

export {}
