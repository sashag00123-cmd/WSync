import type { InstanceConfig } from '@shared/types'
import { AppError } from './errors'
import { assertSafeName } from './fsx'

/** Символы, которые Яндекс.Диск не принимает в именах файлов. */
const FORBIDDEN_IN_CLOUD = /[\\/:*?"<>|]/

export function assertCloudSafeName(name: string): void {
  assertSafeName(name)
  if (FORBIDDEN_IN_CLOUD.test(name)) {
    throw new AppError(
      'BAD_CLOUD_NAME',
      `Имя мира "${name}" содержит символы, недопустимые в облаке: \\ / : * ? " < > |`
    )
  }
}

/** Раскладка папки сборки в облаке. Все пути логические, без префикса app:/. */
export class CloudLayout {
  constructor(private readonly instance: InstanceConfig) {}

  get root(): string {
    return this.instance.cloudFolder
  }

  get savesDir(): string {
    return `${this.root}/saves`
  }

  get backupsDir(): string {
    return `${this.root}/backups`
  }

  get manifest(): string {
    return `${this.root}/manifest.json`
  }

  get lock(): string {
    return `${this.root}/lock.json`
  }

  /**
   * Мир в облаке — каталог с частями архива, а не один файл. Части заливаются
   * параллельно: одно соединение до Диска упирается в ~126 КБ/с независимо от
   * полосы канала, четыре дают ~474 КБ/с.
   */
  archiveDir(world: string): string {
    assertCloudSafeName(world)
    return `${this.savesDir}/${world}`
  }

  /** Пока части не проверены, каталог не должен выглядеть как готовый. */
  tempArchiveDir(world: string): string {
    assertCloudSafeName(world)
    return `${this.savesDir}/.wsync_tmp_${world}`
  }

  backupArchiveDir(world: string, stamp: string): string {
    assertCloudSafeName(world)
    return `${this.backupsDir}/${world}__${stamp}`
  }
}

/** Локальные временные имена внутри saves — на том же томе, чтобы rename был мгновенным. */
export function localTempWorldDir(world: string): string {
  return `.wsync_tmp_${world}`
}
