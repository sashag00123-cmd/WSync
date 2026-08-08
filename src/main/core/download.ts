import fsp from 'node:fs/promises'
import path from 'node:path'

import {
  DOWNLOAD_PHASES,
  TRANSFER_STREAMS,
  type AppConfig,
  type ConfirmToken,
  type InstanceConfig,
  type OperationResult
} from '@shared/types'
import type { CloudProvider } from '../cloud/types'
import { setSyncedLastPlayed } from '../config/store'
import { extractZip } from './archive'
import { backupLocalWorld, newStamp, rotateLocalBackups } from './backups'
import { AppError, isCancel, throwIfAborted, toErrorInfo } from './errors'
import { ensureDir, hashFileRange, movePath, pathExists, preallocate, rmrf, sameVolume } from './fsx'
import { mapWithConcurrency } from './parallel'
import { CloudLayout, assertCloudSafeName, localTempWorldDir } from './layout'
import { clearLock, describeLock, isForeignActiveLock, readLock, writeLock } from './lock'
import { manifestWorld, readManifest } from './manifest'
import {
  PhaseReporter,
  assertLocalSpace,
  formatBytes,
  operationTempDir,
  type OperationIdentity,
  type OperationSinks
} from './operation'
import { isWorldInUse } from './running'
import { computeStatus, needsOverwriteConfirm } from './status'
import { getLocalWorld } from './worlds'

export interface DownloadParams {
  opId: string
  provider: CloudProvider
  config: AppConfig
  instance: InstanceConfig
  world: string
  confirm: ConfirmToken
  signal: AbortSignal
  sinks: OperationSinks
}

/**
 * Облако → ПК.
 *
 * Локальный мир не трогается, пока архив не скачан целиком и не сверен по
 * размеру и sha256, а распакованная копия не проверена на наличие level.dat.
 * Подмена делается двумя rename: мир уходит в бэкап, распакованное встаёт
 * на его место — момента «старого уже нет, нового ещё нет» не существует.
 */
export async function runDownload(params: DownloadParams): Promise<OperationResult> {
  const { opId, provider, config, instance, world, confirm, signal, sinks } = params
  const identity: OperationIdentity = { opId, kind: 'download', instanceId: instance.id, world }
  const reporter = new PhaseReporter(identity, DOWNLOAD_PHASES, sinks)
  const layout = new CloudLayout(instance)
  const stamp = newStamp()
  const tempDir = operationTempDir(instance)
  const tempArchive = path.join(tempDir, `${world}__${stamp}.download.zip`)
  const worldPath = path.join(instance.savesPath, world)
  const stagingPath = path.join(instance.savesPath, localTempWorldDir(world))

  let lockTaken = false
  let backupPath: string | undefined
  let swapped = false

  try {
    assertCloudSafeName(world)

    // ── Проверки ──────────────────────────────────────────────────────────
    reporter.enter('checks')
    throwIfAborted(signal)

    const manifest = await readManifest(provider, instance)
    const cloud = manifestWorld(manifest, world)
    if (cloud === null) {
      throw new AppError('NO_CLOUD_WORLD', `Мир «${world}» отсутствует в облаке`)
    }

    const local = await getLocalWorld(instance.savesPath, world)
    if (local !== null) {
      const inUse = await isWorldInUse(local.path)
      if (inUse.inUse) {
        throw new AppError(
          'WORLD_IN_USE',
          `Мир «${world}» открыт запущенной игрой. Закройте Minecraft и повторите.`
        )
      }
      if (inUse.unknown) {
        reporter.warn(
          `Не удалось проверить, запущена ли игра для мира «${world}». Убедитесь, что Minecraft закрыт.`
        )
      }
    }

    const lock = await readLock(provider, instance)
    if (lock !== null && isForeignActiveLock(lock, config.machineName) && !confirm.ignoreLock) {
      throw new AppError('CLOUD_LOCKED', `${describeLock(lock)}. Подтвердите продолжение в интерфейсе.`)
    }

    const syncedLastPlayed = config.worlds[`${instance.id}/${world}`]?.syncedLastPlayed ?? null
    const status = computeStatus({
      localLastPlayed: local?.lastPlayed ?? null,
      cloudLastPlayed: cloud.lastPlayed,
      syncedLastPlayed
    })
    if (needsOverwriteConfirm(status, 'download') && !confirm.overwriteNewer) {
      throw new AppError(
        'CONFIRM_REQUIRED',
        `Локальная копия мира «${world}» может быть новее (статус: ${status}). ` +
          `Требуется подтверждение перезаписи.`
      )
    }

    await ensureDir(tempDir)
    await ensureDir(instance.backupsPath)
    await assertLocalSpace(tempDir, cloud.archiveSize, 'скачиваемого архива')
    await assertLocalSpace(instance.savesPath, cloud.uncompressedSize, 'распаковки мира')

    if (!(await sameVolume(instance.savesPath, instance.backupsPath))) {
      reporter.warn(
        'Каталоги saves и бэкапов на разных дисках: бэкап будет копироваться, а не переноситься. ' +
          'Это медленно и требует места на обоих дисках.'
      )
    }

    // Остатки прерванной прошлой попытки: staging мог остаться на диске.
    if (await pathExists(stagingPath)) {
      reporter.warn('Найден остаток прошлой прерванной загрузки — удаляю')
      await rmrf(stagingPath)
    }

    await writeLock(provider, instance, world, config.machineName, 'download')
    lockTaken = true

    reporter.info(
      `Облачная копия: ${formatBytes(cloud.archiveSize)}, выгружена машиной «${cloud.uploadedBy}»`
    )

    // ── Скачивание ────────────────────────────────────────────────────────
    // Части качаются параллельно каждая в своё смещение заранее созданного
    // файла: промежуточных файлов нет, поэтому на диске нужен один архив,
    // а не два.
    reporter.enter('transfer', 'скачивание архива')
    if (cloud.parts.length === 0) {
      throw new AppError(
        'NO_PARTS',
        `В манифесте нет частей для мира «${world}». Выгрузите его заново с той машины, ` +
          `где он есть.`
      )
    }
    await preallocate(tempArchive, cloud.archiveSize)

    const offsets: number[] = []
    let offset = 0
    for (const part of cloud.parts) {
      offsets.push(offset)
      offset += part.size
    }

    const gotByPart = new Array<number>(cloud.parts.length).fill(0)
    const publishProgress = (): void => {
      reporter.set(
        gotByPart.reduce((sum, value) => sum + value, 0),
        cloud.archiveSize
      )
    }

    reporter.info(
      `Архив состоит из ${cloud.parts.length} частей, скачиваю до ${TRANSFER_STREAMS} одновременно`
    )
    await mapWithConcurrency(
      cloud.parts,
      TRANSFER_STREAMS,
      async (part, index) => {
        await provider.downloadFile(`${layout.archiveDir(world)}/${part.name}`, tempArchive, {
          signal,
          writeOffset: offsets[index]!,
          expectedSize: part.size,
          onProgress: (p) => {
            gotByPart[index] = p.done
            publishProgress()
          }
        })
        gotByPart[index] = part.size
        publishProgress()
      },
      signal
    )
    reporter.finish(cloud.archiveSize, cloud.archiveSize)

    // ── Сверка ────────────────────────────────────────────────────────────
    reporter.enter('verify', 'проверка целостности архива')
    const actualSize = (await fsp.stat(tempArchive)).size
    if (actualSize !== cloud.archiveSize) {
      throw new AppError(
        'VERIFY_SIZE',
        `Размер собранного архива (${formatBytes(actualSize)}) не совпал с манифестом ` +
          `(${formatBytes(cloud.archiveSize)}). Локальный мир не изменён.`
      )
    }
    // Проверяем каждую часть на своём месте: это покрывает и содержимое, и то,
    // что части легли по правильным смещениям. Отдельный проход по всему
    // архиву тогда не нужен — на 8 ГБ это сэкономленные минуты.
    let verified = 0
    for (const [index, part] of cloud.parts.entries()) {
      const start = offsets[index]!
      const actual = await hashFileRange(tempArchive, start, start + part.size - 1, signal)
      if (actual.toLowerCase() !== part.sha256.toLowerCase()) {
        throw new AppError(
          'VERIFY_HASH',
          `Контрольная сумма части ${part.name} не совпала с манифестом. Локальный мир не изменён.`,
          `ожидалось ${part.sha256}\nполучено ${actual}`
        )
      }
      verified += part.size
      reporter.set(verified, cloud.archiveSize)
    }
    reporter.finish(actualSize, actualSize)

    // ── Распаковка ────────────────────────────────────────────────────────
    reporter.enter('extract', 'распаковка')
    await extractZip(tempArchive, stagingPath, {
      signal,
      expectedTotal: cloud.uncompressedSize,
      onProgress: (p) => reporter.set(p.done, p.total)
    })
    if (!(await pathExists(path.join(stagingPath, 'level.dat')))) {
      throw new AppError(
        'BAD_ARCHIVE',
        'В распакованном архиве нет level.dat — это не похоже на мир Minecraft. ' +
          'Локальный мир не изменён.'
      )
    }
    reporter.finish(cloud.uncompressedSize, cloud.uncompressedSize)

    // ── Бэкап локальной копии ────────────────────────────────────────────
    reporter.enter('backup', 'резервная копия локального мира')
    if (local !== null) {
      backupPath = await backupLocalWorld(worldPath, instance.backupsPath, stamp)
      reporter.info(`Локальный мир сохранён в ${backupPath}`)
    } else {
      reporter.info('Локальной копии нет — бэкап не нужен')
    }
    reporter.finish(1, 1)

    // ── Замена ────────────────────────────────────────────────────────────
    reporter.enter('swap', 'установка нового мира')
    await movePath(stagingPath, worldPath)
    swapped = true
    reporter.finish(1, 1)

    await setSyncedLastPlayed(instance.id, world, cloud.lastPlayed)

    // ── Очистка ───────────────────────────────────────────────────────────
    reporter.enter('cleanup')
    await fsp.rm(tempArchive, { force: true }).catch(() => undefined)
    const rotation = await rotateLocalBackups(instance.backupsPath, {
      keepPerWorld: config.backups.keepPerWorld,
      maxTotalBytes: config.backups.maxTotalGb * 1024 ** 3
    })
    if (rotation.removed.length > 0) {
      reporter.info(
        `Удалено старых бэкапов: ${rotation.removed.length} (освобождено ${formatBytes(rotation.freedBytes)})`
      )
    }
    await clearLock(provider, instance)
    lockTaken = false
    reporter.finish(1, 1)

    reporter.info(`Мир «${world}» загружен из облака`)
    return backupPath === undefined ? { ok: true, opId } : { ok: true, opId, backupPath }
  } catch (err) {
    const cancelled = isCancel(err)

    // Откат. Единственная опасная точка — падение между переносом мира в
    // бэкап и установкой нового. Если это случилось, возвращаем бэкап назад.
    if (!swapped && backupPath !== undefined) {
      try {
        if (!(await pathExists(worldPath))) {
          await movePath(backupPath, worldPath)
          reporter.warn('Локальный мир восстановлен из бэкапа')
          backupPath = undefined
        }
      } catch (restoreErr) {
        reporter.error(
          `Не удалось автоматически вернуть мир из бэкапа. Он лежит здесь: ${backupPath}`,
          restoreErr instanceof Error ? restoreErr.message : String(restoreErr)
        )
      }
    }

    await fsp.rm(tempArchive, { force: true }).catch(() => undefined)
    await rmrf(stagingPath).catch(() => undefined)
    if (lockTaken) await clearLock(provider, instance).catch(() => undefined)

    const info = toErrorInfo(err)
    if (cancelled) {
      reporter.warn(`Загрузка мира «${world}» отменена. Локальный мир не изменён.`)
      return { ok: false, opId, cancelled: true }
    }
    reporter.error(`Загрузка мира «${world}» не удалась: ${info.message}`, info.details)
    return { ok: false, opId, error: info }
  }
}
