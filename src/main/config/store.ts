import { app } from 'electron'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  CONFIG_VERSION,
  DEFAULT_YANDEX_SCOPE,
  LEGACY_YANDEX_SCOPE_V1,
  normalizeScope,
  type AppConfig,
  type InstanceConfig
} from '@shared/types'
import { AppError } from '../core/errors'
import { writeFileAtomic } from '../core/fsx'
import { BUILD_CLIENT_ID, BUILD_CLIENT_SECRET, BUILD_SCOPE } from './build-defaults'

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

function defaults(): AppConfig {
  return {
    version: CONFIG_VERSION,
    machineName: os.hostname() || 'unknown-pc',
    cloud: {
      provider: 'yandex',
      clientId: BUILD_CLIENT_ID,
      clientSecret: BUILD_CLIENT_SECRET,
      scope: BUILD_SCOPE
    },
    instances: [],
    backups: { keepPerWorld: 3, maxTotalGb: 60 },
    worlds: {}
  }
}

let cache: AppConfig | null = null

/**
 * Разовая миграция прав. Версия 1 запрашивала только папку приложения; версия 2
 * добавляет сведения о диске. Трогаем значение только если оно ровно совпадает
 * со старым дефолтом — осознанно изменённый пользователем список не переписываем.
 */
function migrateScope(rawScope: string | undefined, fromVersion: number): string {
  if (rawScope === undefined) return BUILD_SCOPE
  const scope = rawScope.trim().replace(/\s+/g, ' ')
  if (scope.length === 0) return BUILD_SCOPE
  if (fromVersion < 2 && normalizeScope(scope) === normalizeScope(LEGACY_YANDEX_SCOPE_V1)) {
    return DEFAULT_YANDEX_SCOPE
  }
  return scope
}

/** Сливаем прочитанное с дефолтами — недостающие поля не должны падать. */
function normalize(raw: unknown): AppConfig {
  const base = defaults()
  if (typeof raw !== 'object' || raw === null) return base
  const input = raw as Partial<AppConfig>
  const fromVersion = typeof input.version === 'number' ? input.version : 0
  return {
    version: CONFIG_VERSION,
    machineName:
      typeof input.machineName === 'string' && input.machineName.length > 0
        ? input.machineName
        : base.machineName,
    cloud: {
      provider: 'yandex',
      // Пустое значение в сохранённом конфиге — повод взять вшитое в сборку:
      // так обновление приложения с ключами подхватывает их без вмешательства.
      clientId: firstNonEmpty(input.cloud?.clientId, BUILD_CLIENT_ID),
      clientSecret: firstNonEmpty(input.cloud?.clientSecret, BUILD_CLIENT_SECRET),
      scope: migrateScope(
        typeof input.cloud?.scope === 'string' ? input.cloud.scope : undefined,
        fromVersion
      )
    },
    instances: Array.isArray(input.instances)
      ? input.instances.filter(isInstance).map((i) => ({
          id: i.id,
          name: i.name,
          savesPath: i.savesPath,
          backupsPath: i.backupsPath,
          cloudFolder: i.cloudFolder
        }))
      : [],
    backups: {
      keepPerWorld: clampInt(input.backups?.keepPerWorld, 1, 50, base.backups.keepPerWorld),
      maxTotalGb: clampInt(input.backups?.maxTotalGb, 1, 10_000, base.backups.maxTotalGb)
    },
    worlds:
      typeof input.worlds === 'object' && input.worlds !== null
        ? (input.worlds as AppConfig['worlds'])
        : {}
  }
}

function firstNonEmpty(stored: unknown, fallback: string): string {
  const value = typeof stored === 'string' ? stored.trim() : ''
  return value.length > 0 ? value : fallback
}

function isInstance(value: unknown): value is InstanceConfig {
  if (typeof value !== 'object' || value === null) return false
  const i = value as Partial<InstanceConfig>
  return (
    typeof i.id === 'string' &&
    i.id.length > 0 &&
    typeof i.name === 'string' &&
    typeof i.savesPath === 'string' &&
    typeof i.backupsPath === 'string' &&
    typeof i.cloudFolder === 'string' &&
    i.cloudFolder.length > 0
  )
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

export async function loadConfig(): Promise<AppConfig> {
  if (cache !== null) return cache
  try {
    const raw = await fsp.readFile(configPath(), 'utf8')
    cache = normalize(JSON.parse(raw))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Битый конфиг не должен блокировать запуск: отложим его в сторону.
      await fsp
        .rename(configPath(), `${configPath()}.broken-${Date.now()}`)
        .catch(() => undefined)
    }
    cache = defaults()
  }
  return cache
}

export async function saveConfig(next: AppConfig): Promise<AppConfig> {
  cache = normalize(next)
  await writeFileAtomic(configPath(), `${JSON.stringify(cache, null, 2)}\n`)
  return cache
}

export async function patchConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const current = await loadConfig()
  return await saveConfig({ ...current, ...patch })
}

export async function upsertInstance(instance: InstanceConfig): Promise<AppConfig> {
  const current = await loadConfig()
  const instances = [...current.instances]
  const index = instances.findIndex((i) => i.id === instance.id)
  if (index >= 0) instances[index] = instance
  else instances.push(instance)
  return await saveConfig({ ...current, instances })
}

export async function removeInstance(id: string): Promise<AppConfig> {
  const current = await loadConfig()
  const instances = current.instances.filter((i) => i.id !== id)
  const worlds = Object.fromEntries(
    Object.entries(current.worlds).filter(([key]) => !key.startsWith(`${id}/`))
  )
  return await saveConfig({ ...current, instances, worlds })
}

export async function getInstance(id: string): Promise<InstanceConfig> {
  const config = await loadConfig()
  const found = config.instances.find((i) => i.id === id)
  if (found === undefined) {
    throw new AppError('NO_INSTANCE', `Сборка "${id}" не найдена в настройках`)
  }
  return found
}

export function worldKey(instanceId: string, world: string): string {
  return `${instanceId}/${world}`
}

export async function getSyncedLastPlayed(
  instanceId: string,
  world: string
): Promise<number | null> {
  const config = await loadConfig()
  return config.worlds[worldKey(instanceId, world)]?.syncedLastPlayed ?? null
}

export async function setSyncedLastPlayed(
  instanceId: string,
  world: string,
  value: number | null
): Promise<void> {
  const config = await loadConfig()
  await saveConfig({
    ...config,
    worlds: { ...config.worlds, [worldKey(instanceId, world)]: { syncedLastPlayed: value } }
  })
}
