import { MANIFEST_VERSION, type CloudManifest, type CloudWorld, type InstanceConfig } from '@shared/types'
import type { CloudProvider } from '../cloud/types'
import { CloudLayout } from './layout'

function empty(instance: InstanceConfig): CloudManifest {
  return { version: MANIFEST_VERSION, instanceId: instance.id, worlds: {} }
}

/**
 * Манифест — источник истины о том, что лежит в облаке. Он позволяет
 * отрисовать список миров одним запросом и, главное, знать LastPlayed
 * облачной копии без её скачивания.
 */
export interface ReadManifestResult {
  manifest: CloudManifest
  /** Миры, выгруженные старой версией одним файлом: их надо выгрузить заново. */
  skipped: string[]
}

export async function readManifest(
  provider: CloudProvider,
  instance: InstanceConfig
): Promise<CloudManifest> {
  return (await readManifestDetailed(provider, instance)).manifest
}

/**
 * Записи версии 1 (архив одним файлом) не поддерживаются: параллельная
 * передача требует частей. Такие миры отбрасываются, и в списке они выглядят
 * как «только на ПК» — то есть исправляются обычной повторной выгрузкой.
 */
export async function readManifestDetailed(
  provider: CloudProvider,
  instance: InstanceConfig
): Promise<ReadManifestResult> {
  const layout = new CloudLayout(instance)
  const raw = await provider.readJson<CloudManifest>(layout.manifest)
  if (raw === null || typeof raw !== 'object') {
    return { manifest: empty(instance), skipped: [] }
  }
  const source = typeof raw.worlds === 'object' && raw.worlds !== null ? raw.worlds : {}
  const worlds: CloudManifest['worlds'] = {}
  const skipped: string[] = []
  for (const [name, data] of Object.entries(source)) {
    if (Array.isArray(data?.parts) && data.parts.length > 0) worlds[name] = data
    else skipped.push(name)
  }
  return {
    manifest: { version: MANIFEST_VERSION, instanceId: instance.id, worlds },
    skipped
  }
}

export async function writeManifest(
  provider: CloudProvider,
  instance: InstanceConfig,
  manifest: CloudManifest
): Promise<void> {
  const layout = new CloudLayout(instance)
  await provider.writeJson(layout.manifest, manifest)
}

export function manifestWorlds(manifest: CloudManifest): CloudWorld[] {
  return Object.entries(manifest.worlds)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
}

export function manifestWorld(manifest: CloudManifest, name: string): CloudWorld | null {
  const data = manifest.worlds[name]
  return data === undefined ? null : { name, ...data }
}

export function withWorld(manifest: CloudManifest, world: CloudWorld): CloudManifest {
  const { name, ...rest } = world
  return { ...manifest, worlds: { ...manifest.worlds, [name]: rest } }
}

export function withoutWorld(manifest: CloudManifest, name: string): CloudManifest {
  const worlds = { ...manifest.worlds }
  delete worlds[name]
  return { ...manifest, worlds }
}
