import { app } from 'electron'
import fsp from 'node:fs/promises'
import path from 'node:path'

import {
  TRANSFER_STREAMS,
  UPLOAD_PHASES,
  partFileName,
  planParts,
  type AppConfig,
  type ConfirmToken,
  type InstanceConfig,
  type OperationResult
} from '@shared/types'
import type { CloudEntry, CloudProvider } from '../cloud/types'
import { setSyncedLastPlayed } from '../config/store'
import { createZip } from './archive'
import { backupName, newStamp } from './backups'
import { AppError, isCancel, throwIfAborted, toErrorInfo } from './errors'
import { dirSize, ensureDir, hashFileRange } from './fsx'
import { mapWithConcurrency } from './parallel'
import { CloudLayout, assertCloudSafeName } from './layout'
import { clearLock, describeLock, isForeignActiveLock, readLock, writeLock } from './lock'
import { manifestWorld, readManifest, withWorld, writeManifest } from './manifest'
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

export interface UploadParams {
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
 * ПК → облако.
 *
 * Порядок шагов выбран так, что до успешной выгрузки и сверки хешей ничего
 * не двигается: старая облачная копия уходит в бэкапы только после того, как
 * новый архив уже лежит в облаке целым.
 */
export async function runUpload(params: UploadParams): Promise<OperationResult> {
  const { opId, provider, config, instance, world, confirm, signal, sinks } = params
  const identity: OperationIdentity = { opId, kind: 'upload', instanceId: instance.id, world }
  const reporter = new PhaseReporter(identity, UPLOAD_PHASES, sinks)
  const layout = new CloudLayout(instance)
  const stamp = newStamp()
  const tempDir = operationTempDir(instance)
  const tempArchive = path.join(tempDir, `${world}__${stamp}.zip`)

  let lockTaken = false
  let cloudBackupPath: string | undefined
  /** Каталог, куда лились части — только его и надо прибрать при ошибке. */
  let uploadedDir: string | null = null
  let published = false

  try {
    assertCloudSafeName(world)

    // ── Проверки ──────────────────────────────────────────────────────────
    reporter.enter('checks')
    throwIfAborted(signal)

    const local = await getLocalWorld(instance.savesPath, world)
    if (local === null) {
      throw new AppError('NO_LOCAL_WORLD', `Мир «${world}» не найден в ${instance.savesPath}`)
    }

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

    const lock = await readLock(provider, instance)
    if (lock !== null && isForeignActiveLock(lock, config.machineName) && !confirm.ignoreLock) {
      throw new AppError('CLOUD_LOCKED', `${describeLock(lock)}. Подтвердите продолжение в интерфейсе.`)
    }

    const manifest = await readManifest(provider, instance)
    const cloud = manifestWorld(manifest, world)
    const syncedLastPlayed = config.worlds[`${instance.id}/${world}`]?.syncedLastPlayed ?? null
    const status = computeStatus({
      localLastPlayed: local.lastPlayed,
      cloudLastPlayed: cloud?.lastPlayed ?? null,
      syncedLastPlayed
    })
    if (needsOverwriteConfirm(status, 'upload') && !confirm.overwriteNewer) {
      throw new AppError(
        'CONFIRM_REQUIRED',
        `Облачная копия мира «${world}» может быть новее (статус: ${status}). ` +
          `Требуется подтверждение перезаписи.`
      )
    }

    await ensureDir(tempDir)
    await provider.ensureFolder(layout.savesDir)
    await provider.ensureFolder(layout.backupsDir)

    // Оценка по несжатому размеру: region-файлы кладутся в архив как есть,
    // поэтому архив почти равен размеру мира.
    const worldSize = await dirSize(local.path, signal)
    await assertLocalSpace(tempDir, worldSize, 'временного архива')

    // Сведения о диске требуют права cloud_api:disk.info; с правом только на
    // папку приложения Диск отвечает 403. Отменять из-за этого выгрузку нельзя:
    // если места действительно не хватит, Диск откажет сам, и на этом этапе
    // ещё ничего не тронуто — облачная копия заменяется много позже.
    let cloudFree: number | null = null
    try {
      const quota = await provider.quota()
      cloudFree = quota.total - quota.used
    } catch (err) {
      reporter.warn(
        'Не удалось узнать свободное место в облаке — проверка пропущена. ' +
          'Чтобы она работала, выдайте приложению право cloud_api:disk.info и допишите его ' +
          'в поле «Запрашиваемые права».',
        err instanceof Error ? err.message : String(err)
      )
    }
    if (cloudFree !== null && cloudFree < worldSize) {
      throw new AppError(
        'NO_CLOUD_SPACE',
        `На Яндекс.Диске не хватает места: нужно ~${formatBytes(worldSize)}, ` +
          `свободно ${formatBytes(cloudFree)}`
      )
    }
    reporter.info(
      cloudFree === null
        ? `Мир «${world}»: ${formatBytes(worldSize)}`
        : `Мир «${world}»: ${formatBytes(worldSize)}, в облаке свободно ${formatBytes(cloudFree)}`
    )

    // Если в облаке копии этого мира ещё нет, перезаписывать нечего: выгружаем
    // сразу в финальный каталог. Это убирает лишнее переименование на стороне
    // Диска — операция асинхронная и на практике занимает минуты.
    const existing = await provider.stat(layout.archiveDir(world))
    const publishDirectly = existing === null
    const uploadDir = publishDirectly ? layout.archiveDir(world) : layout.tempArchiveDir(world)

    await writeLock(provider, instance, world, config.machineName, 'upload')
    lockTaken = true

    // ── Архивация ─────────────────────────────────────────────────────────
    reporter.enter('archive', 'упаковка мира')
    const archive = await createZip(local.path, tempArchive, {
      signal,
      onProgress: (p) => reporter.set(p.done, p.total)
    })
    reporter.finish(archive.uncompressedSize, archive.uncompressedSize)
    reporter.info(
      `Архив готов: ${formatBytes(archive.archiveSize)}, файлов ${archive.entryCount}, ` +
        `sha256 ${archive.sha256.slice(0, 12)}…`
    )

    // ── Выгрузка ──────────────────────────────────────────────────────────
    // Части идут параллельно: одно соединение до Диска упирается в ~126 КБ/с
    // независимо от полосы канала, четыре дают ~474 КБ/с. Части читаются
    // диапазонами из готового архива, второй копии на диске не появляется.
    reporter.enter('transfer', 'выгрузка в облако')
    uploadedDir = uploadDir
    await provider.ensureFolder(uploadDir)

    const plan = planParts(archive.archiveSize)
    reporter.info(
      `Архив разбит на ${plan.length} частей по ~${formatBytes(
        plan[0] === undefined ? 0 : plan[0].end - plan[0].start + 1
      )}, выгружаю до ${TRANSFER_STREAMS} одновременно`
    )

    const sentByPart = new Array<number>(plan.length).fill(0)
    const publishProgress = (): void => {
      const done = sentByPart.reduce((sum, value) => sum + value, 0)
      reporter.set(done, archive.archiveSize)
    }

    const parts = await mapWithConcurrency(
      plan,
      TRANSFER_STREAMS,
      async (part) => {
        const name = partFileName(part.index)
        const size = part.end - part.start + 1
        const sha256 = await hashFileRange(tempArchive, part.start, part.end, signal)
        const entry = await provider.uploadFile(tempArchive, `${uploadDir}/${name}`, {
          signal,
          range: { start: part.start, end: part.end },
          onProgress: (p) => {
            sentByPart[part.index] = p.done
            publishProgress()
          }
        })
        // Сверяем каждую часть сразу: битую нет смысла тащить до конца операции.
        verifyPart(name, size, sha256, entry, reporter)
        sentByPart[part.index] = size
        publishProgress()
        return { name, size, sha256 }
      },
      signal
    )
    reporter.finish(archive.archiveSize, archive.archiveSize)

    // ── Сверка ────────────────────────────────────────────────────────────
    reporter.enter('verify', 'проверка целостности')
    const totalUploaded = parts.reduce((sum, part) => sum + part.size, 0)
    if (totalUploaded !== archive.archiveSize) {
      throw new AppError(
        'VERIFY_SIZE',
        `Сумма размеров частей (${formatBytes(totalUploaded)}) не совпала с размером архива ` +
          `(${formatBytes(archive.archiveSize)}). Выгрузка отменена, облачная копия не изменена.`
      )
    }
    reporter.info(`Все ${parts.length} частей сверены по контрольным суммам`)
    reporter.finish(1, 1)

    // ── Бэкап старой облачной копии ──────────────────────────────────────
    reporter.enter('backup', 'резервная копия облачного сейва')
    if (publishDirectly) {
      reporter.info('Прежней копии в облаке нет — бэкап не нужен')
    } else {
      const target = layout.backupArchiveDir(world, stamp)
      await provider.move(layout.archiveDir(world), target, {
        signal,
        onNote: (message) => reporter.info(message)
      })
      cloudBackupPath = target
      reporter.info(`Прежняя облачная копия сохранена как ${backupName(world, stamp)}`)
    }
    reporter.finish(1, 1)

    // ── Замена ────────────────────────────────────────────────────────────
    reporter.enter('swap', 'публикация новой копии')
    if (publishDirectly) {
      reporter.info('Части выгружены сразу в финальный каталог — переименование не требуется')
    } else {
      await provider.move(layout.tempArchiveDir(world), layout.archiveDir(world), {
        overwrite: true,
        signal,
        onNote: (message) => reporter.info(message)
      })
    }
    published = true
    reporter.finish(1, 1)

    // ── Манифест ──────────────────────────────────────────────────────────
    reporter.enter('manifest')
    const nextManifest = withWorld(manifest, {
      name: world,
      archive: `saves/${world}`,
      archiveSize: archive.archiveSize,
      sha256: archive.sha256,
      uncompressedSize: archive.uncompressedSize,
      entryCount: archive.entryCount,
      parts,
      lastPlayed: local.lastPlayed ?? 0,
      uploadedAt: Date.now(),
      uploadedBy: config.machineName,
      appVersion: appVersion()
    })
    await writeManifest(provider, instance, nextManifest)
    await setSyncedLastPlayed(instance.id, world, local.lastPlayed)
    reporter.finish(1, 1)

    // ── Очистка ───────────────────────────────────────────────────────────
    reporter.enter('cleanup')
    await fsp.rm(tempArchive, { force: true }).catch(() => undefined)
    await rotateCloudBackups(provider, instance, world, config, reporter)
    await clearLock(provider, instance)
    lockTaken = false
    reporter.finish(1, 1)

    reporter.info(`Мир «${world}» выгружен в облако`)
    return cloudBackupPath === undefined
      ? { ok: true, opId }
      : { ok: true, opId, backupPath: cloudBackupPath }
  } catch (err) {
    const cancelled = isCancel(err)
    // Прибираем только то, что создали сами. Ни прежняя облачная копия, ни
    // локальный мир на этом пути не удалялись — терять нечего.
    await fsp.rm(tempArchive, { force: true }).catch(() => undefined)
    // Недовыгруженные части: при прямой публикации они лежат в финальном
    // каталоге, но манифест на них ещё не ссылается — убираем, чтобы в облаке
    // не осталось копии, целостность которой не подтверждена.
    if (uploadedDir !== null && !published) {
      await provider.remove(uploadedDir).catch(() => undefined)
    }
    if (lockTaken) await clearLock(provider, instance).catch(() => undefined)

    const info = toErrorInfo(err)
    if (cancelled) {
      reporter.warn(`Выгрузка мира «${world}» отменена. Облачная копия не изменена.`)
      return { ok: false, opId, cancelled: true }
    }
    reporter.error(`Выгрузка мира «${world}» не удалась: ${info.message}`, info.details)
    return { ok: false, opId, error: info }
  }
}

/**
 * Сверка одной части. Диск считает и sha256, и md5, но не гарантирует, что
 * оба появятся сразу, — поэтому сверяем по тому, что пришло, а локальный md5
 * части не считаем: расхождение размера уже отсекает большинство сбоев.
 */
function verifyPart(
  name: string,
  expectedSize: number,
  expectedSha256: string,
  entry: CloudEntry,
  reporter: PhaseReporter
): void {
  if (entry.size !== expectedSize) {
    throw new AppError(
      'VERIFY_SIZE',
      `Размер части ${name} в облаке (${formatBytes(entry.size)}) не совпал с локальным ` +
        `(${formatBytes(expectedSize)}). Выгрузка отменена, облачная копия не изменена.`
    )
  }
  if (entry.sha256 !== undefined) {
    if (entry.sha256.toLowerCase() !== expectedSha256) {
      throw new AppError(
        'VERIFY_HASH',
        `Контрольная сумма части ${name} не совпала. ` +
          'Выгрузка отменена, облачная копия не изменена.',
        `локально ${expectedSha256}\nв облаке ${entry.sha256}`
      )
    }
    return
  }
  reporter.warn(`Диск не сообщил sha256 для части ${name} — проверен только размер`)
}

/** Ротация облачных бэкапов — только после успеха всей операции. */
async function rotateCloudBackups(
  provider: CloudProvider,
  instance: InstanceConfig,
  world: string,
  config: AppConfig,
  reporter: PhaseReporter
): Promise<void> {
  try {
    const layout = new CloudLayout(instance)
    const entries = await provider.list(layout.backupsDir)
    // Бэкапы теперь каталоги с частями, а не одиночные zip.
    const mine = entries
      .filter((e) => e.type === 'dir' && e.name.startsWith(`${world}__`))
      .sort((a, b) => b.name.localeCompare(a.name))
    const extra = mine.slice(config.backups.keepPerWorld)
    for (const entry of extra) {
      await provider.remove(`${layout.backupsDir}/${entry.name}`)
      reporter.info(`Удалён старый облачный бэкап ${entry.name}`)
    }
  } catch (err) {
    // Не смогли почистить — операция всё равно успешна.
    reporter.warn(
      'Не удалось выполнить ротацию облачных бэкапов',
      err instanceof Error ? err.message : String(err)
    )
  }
}

function appVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return '0.0.0'
  }
}
