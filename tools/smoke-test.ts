/* Смоук-тест ядра: NBT, архивация, распаковка, хеши, ротация, статусы. */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { MAX_PART_BYTES, partFileName, planParts } from '../src/shared/types'
import { compareVersions, isNewerVersion } from '../src/shared/version'
import { uploadFileStream } from '../src/main/cloud/http'
import { mapWithConcurrency } from '../src/main/core/parallel'

import { createZip, extractZip } from '../src/main/core/archive'
import { rotateLocalBackups, backupLocalWorld, parseBackupName, newStamp } from '../src/main/core/backups'
import {
  assertSafeName,
  collectFiles,
  dirSize,
  hashFile,
  hashFileRange,
  preallocate,
  resolveInside
} from '../src/main/core/fsx'
import { readLevelInfo } from '../src/main/core/nbt'
import { computeStatus, needsOverwriteConfirm } from '../src/main/core/status'
import { scanLocalWorlds } from '../src/main/core/worlds'

let passed = 0
function ok(name: string): void {
  passed += 1
  console.log(`  ok  ${name}`)
}

/** Собирает level.dat: gzip(TAG_Compound "" { Data: { LastPlayed, LevelName } }). */
function buildLevelDat(lastPlayed: bigint, levelName: string): Buffer {
  const parts: Buffer[] = []
  const str = (value: string): Buffer => {
    const bytes = Buffer.from(value, 'utf8')
    const header = Buffer.alloc(2)
    header.writeUInt16BE(bytes.length)
    return Buffer.concat([header, bytes])
  }
  parts.push(Buffer.from([0x0a]), str(''))
  parts.push(Buffer.from([0x0a]), str('Data'))
  const longBuf = Buffer.alloc(8)
  longBuf.writeBigInt64BE(lastPlayed)
  parts.push(Buffer.from([0x04]), str('LastPlayed'), longBuf)
  parts.push(Buffer.from([0x08]), str('LevelName'), str(levelName))
  const seed = Buffer.alloc(4)
  seed.writeInt32BE(1337)
  parts.push(Buffer.from([0x03]), str('version'), seed)
  parts.push(Buffer.from([0x00])) // конец Data
  parts.push(Buffer.from([0x00])) // конец корня
  return zlib.gzipSync(Buffer.concat(parts))
}

async function main(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wsync-smoke-'))
  const saves = path.join(root, 'saves')
  const world = path.join(saves, 'TestWorld')
  const backups = path.join(root, 'backups')

  // ── Готовим синтетический мир ──────────────────────────────────────────
  const lastPlayed = 1754650000000n
  await fsp.mkdir(path.join(world, 'region'), { recursive: true })
  await fsp.mkdir(path.join(world, 'data'), { recursive: true })
  await fsp.mkdir(path.join(world, 'datapacks'), { recursive: true }) // пустой каталог
  await fsp.writeFile(path.join(world, 'level.dat'), buildLevelDat(lastPlayed, 'Мой мир'))
  await fsp.writeFile(path.join(world, 'region', 'r.0.0.mca'), crypto.randomBytes(3 * 1024 * 1024))
  await fsp.writeFile(path.join(world, 'region', 'r.-1.0.mca'), crypto.randomBytes(512 * 1024))
  await fsp.writeFile(path.join(world, 'data', 'raids.dat'), Buffer.from('a'.repeat(50_000)))
  await fsp.writeFile(path.join(world, 'session.lock'), Buffer.from([1, 2, 3, 4]))

  console.log('\nNBT / level.dat')
  const info = await readLevelInfo(path.join(world, 'level.dat'))
  assert.equal(info.lastPlayed, Number(lastPlayed))
  assert.equal(info.levelName, 'Мой мир')
  ok('LastPlayed и LevelName читаются, включая кириллицу')

  const broken = path.join(root, 'broken.dat')
  await fsp.writeFile(broken, crypto.randomBytes(64))
  const brokenInfo = await readLevelInfo(broken)
  assert.deepEqual(brokenInfo, { lastPlayed: null, levelName: null })
  ok('битый level.dat не бросает исключение, а даёт null')

  console.log('\nСписок миров')
  const worlds = await scanLocalWorlds(saves)
  assert.equal(worlds.length, 1)
  assert.equal(worlds[0]!.name, 'TestWorld')
  assert.equal(worlds[0]!.lastPlayed, Number(lastPlayed))
  ok('мир найден по наличию level.dat')

  console.log('\nАрхивация')
  const zipPath = path.join(root, 'TestWorld.zip')
  const sourceFiles = await collectFiles(world)
  const sourceBytes = sourceFiles
    .filter((f) => path.basename(f.rel) !== 'session.lock')
    .reduce((sum, f) => sum + f.size, 0)

  let lastProgress = 0
  const result = await createZip(world, zipPath, {
    onProgress: (p) => {
      lastProgress = p.done
    }
  })
  assert.equal(result.entryCount, 4, 'session.lock должен быть исключён')
  assert.equal(result.uncompressedSize, sourceBytes)
  assert.ok(lastProgress > 0, 'прогресс архивации должен приходить')
  ok(`архив создан: ${result.entryCount} файлов, ${result.archiveSize} байт`)

  const zipHash = await hashFile(zipPath)
  assert.equal(zipHash, result.sha256)
  const zipMd5 = crypto.createHash('md5').update(await fsp.readFile(zipPath)).digest('hex')
  assert.equal(zipMd5, result.md5)
  ok('sha256 и md5, посчитанные на лету, совпадают с полным проходом по файлу')

  // .mca кладутся без сжатия — архив не должен быть заметно меньше исходника.
  const mcaBytes = 3 * 1024 * 1024 + 512 * 1024
  assert.ok(
    result.archiveSize > mcaBytes,
    `архив (${result.archiveSize}) не должен пережимать region-файлы (${mcaBytes})`
  )
  ok('region-файлы попадают в архив без повторного сжатия (store)')

  console.log('\nРаспаковка')
  const restored = path.join(root, 'restored')
  const extracted = await extractZip(zipPath, restored, { expectedTotal: result.uncompressedSize })
  assert.equal(extracted.entryCount, 4)

  const originalList = sourceFiles
    .filter((f) => path.basename(f.rel) !== 'session.lock')
    .map((f) => f.rel)
    .sort()
  const restoredList = (await collectFiles(restored)).map((f) => f.rel).sort()
  assert.deepEqual(restoredList, originalList)
  ok('состав файлов после round-trip совпадает')

  for (const rel of originalList) {
    const a = await fsp.readFile(path.join(world, ...rel.split('/')))
    const b = await fsp.readFile(path.join(restored, ...rel.split('/')))
    assert.ok(a.equals(b), `содержимое ${rel} должно совпадать`)
  }
  ok('содержимое всех файлов побайтово совпадает')

  const restoredStat = await fsp.stat(path.join(restored, 'datapacks'))
  assert.ok(restoredStat.isDirectory())
  ok('пустой каталог datapacks сохранён')

  assert.equal(await dirSize(restored), sourceBytes)
  ok('суммарный размер распакованного равен исходному без session.lock')

  console.log('\nБэкапы и ротация')
  await fsp.mkdir(backups, { recursive: true })
  const stamps = [
    '2026-08-01_10-00-00',
    '2026-08-02_10-00-00',
    '2026-08-03_10-00-00',
    '2026-08-04_10-00-00'
  ]
  for (const stamp of stamps) {
    const dir = path.join(backups, `TestWorld__${stamp}`)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'level.dat'), Buffer.alloc(1024))
  }
  await fsp.mkdir(path.join(backups, 'OtherWorld__2026-07-01_10-00-00'), { recursive: true })
  await fsp.writeFile(path.join(backups, 'OtherWorld__2026-07-01_10-00-00', 'level.dat'), Buffer.alloc(10))
  await fsp.mkdir(path.join(backups, 'НеНашаПапка'), { recursive: true })

  const rotation = await rotateLocalBackups(backups, { keepPerWorld: 2, maxTotalBytes: 10 ** 12 })
  assert.deepEqual(rotation.removed.sort(), [
    'TestWorld__2026-08-01_10-00-00',
    'TestWorld__2026-08-02_10-00-00'
  ])
  const left = (await fsp.readdir(backups)).sort()
  assert.ok(left.includes('НеНашаПапка'), 'посторонние папки не трогаем')
  assert.ok(left.includes('OtherWorld__2026-07-01_10-00-00'), 'бэкап другого мира не трогаем')
  ok('ротация удаляет только лишние бэкапы своего мира, старейшие первыми')

  const tight = await rotateLocalBackups(backups, { keepPerWorld: 5, maxTotalBytes: 1 })
  assert.ok(
    !tight.removed.includes('TestWorld__2026-08-04_10-00-00'),
    'последний бэкап мира не должен удаляться даже при переполнении лимита'
  )
  ok('последний бэкап мира выживает при жёстком лимите объёма')

  assert.deepEqual(parseBackupName('MyWorld__2026-08-08_14-30-12'), {
    world: 'MyWorld',
    stamp: '2026-08-08_14-30-12'
  })
  assert.deepEqual(parseBackupName('MyWorld__2025__2026-08-08_14-30-12'), {
    world: 'MyWorld__2025',
    stamp: '2026-08-08_14-30-12'
  })
  assert.equal(parseBackupName('РандомнаяПапка'), null)
  ok('имена бэкапов разбираются, включая мир с "__" в названии')

  console.log('\nПеренос мира в бэкап')
  const movedWorld = path.join(saves, 'Movable')
  await fsp.mkdir(movedWorld, { recursive: true })
  await fsp.writeFile(path.join(movedWorld, 'level.dat'), Buffer.alloc(8))
  const stamp = newStamp(new Date(Date.UTC(2026, 7, 8, 12, 0, 0)))
  const backupPath = await backupLocalWorld(movedWorld, backups, stamp)
  assert.ok(!(await exists(movedWorld)), 'мир должен переехать, а не скопироваться')
  assert.ok(await exists(path.join(backupPath, 'level.dat')))
  ok('backupLocalWorld переносит каталог целиком')

  console.log('\nСтатусы синхронизации')
  const cases: Array<[Parameters<typeof computeStatus>[0], string]> = [
    [{ localLastPlayed: 100, cloudLastPlayed: 100, syncedLastPlayed: 100 }, 'synced'],
    [{ localLastPlayed: 100, cloudLastPlayed: null, syncedLastPlayed: null }, 'local-only'],
    [{ localLastPlayed: null, cloudLastPlayed: 100, syncedLastPlayed: null }, 'cloud-only'],
    [{ localLastPlayed: 200, cloudLastPlayed: 100, syncedLastPlayed: 100 }, 'local-newer'],
    [{ localLastPlayed: 100, cloudLastPlayed: 200, syncedLastPlayed: 100 }, 'cloud-newer'],
    [{ localLastPlayed: 200, cloudLastPlayed: 300, syncedLastPlayed: 100 }, 'diverged'],
    [{ localLastPlayed: 200, cloudLastPlayed: 300, syncedLastPlayed: null }, 'diverged'],
    [{ localLastPlayed: null, cloudLastPlayed: null, syncedLastPlayed: null }, 'unknown']
  ]
  for (const [input, expected] of cases) {
    assert.equal(computeStatus(input), expected, JSON.stringify(input))
  }
  ok('все восемь комбинаций дают ожидаемый статус')

  assert.equal(needsOverwriteConfirm('cloud-newer', 'upload'), true)
  assert.equal(needsOverwriteConfirm('cloud-newer', 'download'), false)
  assert.equal(needsOverwriteConfirm('local-newer', 'upload'), false)
  assert.equal(needsOverwriteConfirm('local-newer', 'download'), true)
  assert.equal(needsOverwriteConfirm('diverged', 'upload'), true)
  assert.equal(needsOverwriteConfirm('diverged', 'download'), true)
  assert.equal(needsOverwriteConfirm('synced', 'upload'), false)
  ok('подтверждение требуется ровно там, где перезаписывается более свежая копия')

  console.log('\nЗащита путей')
  for (const bad of ['..', '.', '', 'a/b', 'a\\b', 'C:\\evil']) {
    assert.throws(() => assertSafeName(bad), /BAD_NAME|Недопустимое/, `должно отклоняться: "${bad}"`)
  }
  assert.doesNotThrow(() => assertSafeName('Мой мир 2'))
  ok('имена с путями и точками отклоняются')

  assert.throws(() => resolveInside(restored, '../escape.txt'), /ZIP_SLIP|за пределы/)
  assert.throws(() => resolveInside(restored, 'a/../../escape.txt'), /ZIP_SLIP|за пределы/)
  assert.ok(resolveInside(restored, 'region/r.0.0.mca').startsWith(path.resolve(restored)))
  ok('zip-slip блокируется')

  console.log('\nВыгрузка: таймаут передачи и таймаут ответа — это разные вещи')
  // Сервер принимает тело целиком и отвечает с задержкой из заголовка.
  const server = http.createServer((req, res) => {
    const delay = Number(req.headers['x-delay'] ?? 0)
    req.on('data', () => undefined)
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(201, { 'Content-Type': 'text/plain' })
        res.end('created')
      }, delay)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  const smallFile = path.join(root, 'upload-probe.bin')
  await fsp.writeFile(smallFile, crypto.randomBytes(256 * 1024))

  let bodySent = false
  const accepted = await uploadFileStream(`http://127.0.0.1:${port}/`, smallFile, {
    headers: { 'x-delay': '900' },
    idleTimeoutMs: 300,
    responseTimeoutMs: 4000,
    onBodySent: () => {
      bodySent = true
    }
  })
  assert.equal(accepted.status, 201)
  assert.ok(bodySent, 'onBodySent должен сработать после отправки тела')
  ok('ожидание ответа дольше idle-таймаута не убивает успешную выгрузку')

  await assert.rejects(
    uploadFileStream(`http://127.0.0.1:${port}/`, smallFile, {
      headers: { 'x-delay': '3000' },
      idleTimeoutMs: 300,
      responseTimeoutMs: 600
    }),
    /не ответил о результате/,
    'при действительно зависшем ответе выгрузка должна падать'
  )
  ok('превышение таймаута ответа диагностируется отдельным сообщением')

  await new Promise<void>((resolve) => server.close(() => resolve()))

  console.log('\nВыгрузка: прогресс монотонен, а ожидание приёма отделено от передачи')
  // Сервер читает тело медленно и отвечает с задержкой. Проверяем два свойства,
  // которые действительно можно гарантировать из пользовательского процесса:
  // прогресс не превышает размер файла и не идёт назад, а моменты «байты отданы»
  // и «сервер ответил» различимы. Сколько байт подтвердил получатель, узнать
  // нельзя — поэтому после отдачи данных UI и не показывает проценты.
  const slowServer = http.createServer((req, res) => {
    req.on('data', () => {
      req.pause()
      setTimeout(() => req.resume(), 15)
    })
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(201)
        res.end()
      }, 500)
    })
  })
  await new Promise<void>((resolve) => slowServer.listen(0, '127.0.0.1', () => resolve()))
  const slowPort = (slowServer.address() as AddressInfo).port

  const payload = path.join(root, 'slow-upload.bin')
  const payloadSize = 8 * 1024 * 1024
  await fsp.writeFile(payload, crypto.randomBytes(payloadSize))

  const samples: number[] = []
  let bodySentAt: number | null = null
  const startedAt = Date.now()
  await uploadFileStream(`http://127.0.0.1:${slowPort}/`, payload, {
    idleTimeoutMs: 30_000,
    responseTimeoutMs: 30_000,
    onProgress: (p) => {
      assert.equal(p.total, payloadSize, 'total должен равняться размеру файла')
      assert.ok(p.done <= p.total, `прогресс не должен превышать размер: ${p.done} > ${p.total}`)
      samples.push(p.done)
    },
    onBodySent: () => {
      bodySentAt = Date.now()
    }
  })
  const finishedAt = Date.now()
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i]! >= samples[i - 1]!, 'прогресс не должен идти назад')
  }
  assert.equal(samples.at(-1), payloadSize, 'последний отсчёт должен быть равен размеру файла')
  assert.notEqual(bodySentAt, null, 'onBodySent обязан сработать')
  assert.ok(
    bodySentAt! > startedAt && bodySentAt! < finishedAt,
    'onBodySent должен сработать между началом и ответом сервера'
  )
  await new Promise<void>((resolve) => slowServer.close(() => resolve()))
  ok('прогресс монотонен и не превышает размер, отдача и ожидание различимы')

  console.log('\nРазбиение архива на части')
  for (const size of [1, 1024, 5 * 1024 * 1024, 44 * 1024 * 1024, 232 * 1024 * 1024, 8 * 1024 ** 3]) {
    const plan = planParts(size)
    assert.ok(plan.length > 0, `план не должен быть пустым для ${size}`)
    assert.equal(plan[0]!.start, 0, 'первая часть начинается с нуля')
    assert.equal(plan.at(-1)!.end, size - 1, 'последняя часть кончается на последнем байте')
    for (let i = 1; i < plan.length; i++) {
      assert.equal(plan[i]!.start, plan[i - 1]!.end + 1, 'части идут без разрывов и наложений')
    }
    const covered = plan.reduce((sum, part) => sum + (part.end - part.start + 1), 0)
    assert.equal(covered, size, 'части покрывают файл целиком')
    for (const part of plan.slice(0, -1)) {
      const partSize = part.end - part.start + 1
      assert.ok(partSize <= MAX_PART_BYTES, `часть не больше максимума: ${partSize}`)
    }
  }
  assert.equal(planParts(8 * 1024 ** 3).length, Math.ceil((8 * 1024 ** 3) / MAX_PART_BYTES))
  ok('план частей непрерывен, покрывает файл и уважает границы размеров')

  assert.equal(partFileName(0), 'part0001')
  assert.equal(partFileName(11), 'part0012')
  ok('имена частей сортируются лексикографически')

  console.log('\nСборка архива из частей по смещениям')
  const original = path.join(root, 'parts-source.bin')
  const sourceSize = 20 * 1024 * 1024 + 12345
  await fsp.writeFile(original, crypto.randomBytes(sourceSize))
  const originalHash = await hashFile(original)

  const plan = planParts(sourceSize)
  const partHashes = await Promise.all(
    plan.map(async (part) => await hashFileRange(original, part.start, part.end))
  )

  // Так же, как при загрузке: заранее создаём файл нужного размера и пишем
  // части параллельно каждую по своему смещению.
  const assembled = path.join(root, 'parts-assembled.bin')
  await preallocate(assembled, sourceSize)
  assert.equal((await fsp.stat(assembled)).size, sourceSize, 'файл должен быть создан нужного размера')

  await Promise.all(
    plan.map(async (part) => {
      const bytes = await fsp.readFile(original)
      const slice = bytes.subarray(part.start, part.end + 1)
      const handle = await fsp.open(assembled, 'r+')
      try {
        await handle.write(slice, 0, slice.length, part.start)
      } finally {
        await handle.close()
      }
    })
  )

  assert.equal(await hashFile(assembled), originalHash, 'собранный файл должен совпасть с исходным')
  for (const [index, part] of plan.entries()) {
    const actual = await hashFileRange(assembled, part.start, part.end)
    assert.equal(actual, partHashes[index], `часть ${index} должна совпасть по хешу`)
  }
  ok('файл, собранный параллельной записью по смещениям, идентичен исходному')

  console.log('\nПул параллельных задач')
  let peak = 0
  let active = 0
  const order = await mapWithConcurrency(
    Array.from({ length: 17 }, (_, i) => i),
    4,
    async (item) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return item * 2
    }
  )
  assert.deepEqual(order, Array.from({ length: 17 }, (_, i) => i * 2), 'порядок результатов сохраняется')
  assert.ok(peak <= 4, `одновременно не больше лимита, а было ${peak}`)
  assert.ok(peak > 1, 'задачи должны идти параллельно')
  ok(`порядок результатов сохранён, одновременно не больше 4 задач (пик ${peak})`)

  await assert.rejects(
    mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
      if (item === 3) throw new Error('часть не выгрузилась')
      return item
    }),
    /часть не выгрузилась/
  )
  ok('ошибка одной задачи прекращает работу пула')

  console.log('\nСравнение версий для обновлений')
  // Лексикографическое сравнение здесь даёт '0.10.0' < '0.9.0' — именно на этом
  // ломаются самодельные проверки обновлений, поэтому случай проверяем прямо.
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1, '0.10.0 новее 0.9.0')
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1)
  assert.equal(compareVersions('1.0.0', '0.999.999'), 1)
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0)
  assert.equal(compareVersions('v0.2.0', '0.1.9'), 1, 'префикс v не должен мешать')
  assert.equal(compareVersions('0.2', '0.2.0'), 0, 'недостающие части считаются нулями')
  assert.equal(compareVersions('0.2.1', '0.2'), 1)
  assert.equal(compareVersions('0.3.0-beta.1', '0.3.0'), 0, 'предвыпуски не различаем')
  assert.equal(compareVersions('мусор', '0.0.0'), 0, 'нечисловое не должно падать')
  ok('сравнение версий устойчиво к префиксам, разной длине и мусору')

  assert.equal(isNewerVersion('0.2.0', '0.1.9'), true)
  assert.equal(isNewerVersion('0.1.0', '0.1.0'), false, 'та же версия — не обновление')
  assert.equal(isNewerVersion('0.0.9', '0.1.0'), false, 'откат не считается обновлением')
  ok('обновлением считается только строго более новая версия')

  console.log('\nОтмена операции')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    createZip(world, path.join(root, 'aborted.zip'), { signal: controller.signal }),
    /CANCELLED|отменена/
  )
  assert.ok(!(await exists(path.join(root, 'aborted.zip'))), 'после отмены не должно остаться файла')
  ok('отменённая архивация не оставляет мусора')

  await fsp.rm(root, { recursive: true, force: true })
  console.log(`\nВсе проверки пройдены: ${passed}\n`)
}

async function exists(target: string): Promise<boolean> {
  try {
    await fsp.stat(target)
    return true
  } catch {
    return false
  }
}

main().catch((err) => {
  console.error('\nПРОВАЛ:', err)
  process.exit(1)
})
