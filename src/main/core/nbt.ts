import fsp from 'node:fs/promises'
import zlib from 'node:zlib'

import { AppError } from './errors'

/**
 * Минимальный читатель NBT — ровно чтобы достать LastPlayed и LevelName
 * из level.dat. Полноценная библиотека (prismarine-nbt) тянет protodef
 * и весь его граф зависимостей; здесь достаточно 150 строк.
 */

export type NbtTag =
  | number
  | bigint
  | string
  | Buffer
  | number[]
  | bigint[]
  | NbtTag[]
  | NbtCompound

export interface NbtCompound {
  [key: string]: NbtTag
}

const TAG_END = 0
const TAG_BYTE = 1
const TAG_SHORT = 2
const TAG_INT = 3
const TAG_LONG = 4
const TAG_FLOAT = 5
const TAG_DOUBLE = 6
const TAG_BYTE_ARRAY = 7
const TAG_STRING = 8
const TAG_LIST = 9
const TAG_COMPOUND = 10
const TAG_INT_ARRAY = 11
const TAG_LONG_ARRAY = 12

class Reader {
  private off = 0

  constructor(private readonly buf: Buffer) {}

  private need(bytes: number): void {
    if (this.off + bytes > this.buf.length) {
      throw new AppError('NBT_TRUNCATED', 'Файл level.dat повреждён или обрезан')
    }
  }

  u8(): number {
    this.need(1)
    return this.buf.readUInt8(this.off++)
  }

  i8(): number {
    this.need(1)
    return this.buf.readInt8(this.off++)
  }

  i16(): number {
    this.need(2)
    const v = this.buf.readInt16BE(this.off)
    this.off += 2
    return v
  }

  u16(): number {
    this.need(2)
    const v = this.buf.readUInt16BE(this.off)
    this.off += 2
    return v
  }

  i32(): number {
    this.need(4)
    const v = this.buf.readInt32BE(this.off)
    this.off += 4
    return v
  }

  i64(): bigint {
    this.need(8)
    const v = this.buf.readBigInt64BE(this.off)
    this.off += 8
    return v
  }

  f32(): number {
    this.need(4)
    const v = this.buf.readFloatBE(this.off)
    this.off += 4
    return v
  }

  f64(): number {
    this.need(8)
    const v = this.buf.readDoubleBE(this.off)
    this.off += 8
    return v
  }

  bytes(length: number): Buffer {
    this.need(length)
    const v = this.buf.subarray(this.off, this.off + length)
    this.off += length
    return v
  }

  /** NBT-строки — modified UTF-8; для нашего набора полей совпадает с UTF-8. */
  str(): string {
    const length = this.u16()
    return this.bytes(length).toString('utf8')
  }
}

function readPayload(r: Reader, type: number): NbtTag {
  switch (type) {
    case TAG_BYTE:
      return r.i8()
    case TAG_SHORT:
      return r.i16()
    case TAG_INT:
      return r.i32()
    case TAG_LONG:
      return r.i64()
    case TAG_FLOAT:
      return r.f32()
    case TAG_DOUBLE:
      return r.f64()
    case TAG_BYTE_ARRAY:
      return Buffer.from(r.bytes(r.i32()))
    case TAG_STRING:
      return r.str()
    case TAG_LIST: {
      const itemType = r.u8()
      const length = r.i32()
      const out: NbtTag[] = []
      if (itemType === TAG_END) return out
      for (let i = 0; i < length; i++) out.push(readPayload(r, itemType))
      return out
    }
    case TAG_COMPOUND: {
      const out: NbtCompound = {}
      for (;;) {
        const childType = r.u8()
        if (childType === TAG_END) break
        const name = r.str()
        out[name] = readPayload(r, childType)
      }
      return out
    }
    case TAG_INT_ARRAY: {
      const length = r.i32()
      const out: number[] = []
      for (let i = 0; i < length; i++) out.push(r.i32())
      return out
    }
    case TAG_LONG_ARRAY: {
      const length = r.i32()
      const out: bigint[] = []
      for (let i = 0; i < length; i++) out.push(r.i64())
      return out
    }
    default:
      throw new AppError('NBT_BAD_TAG', `Неизвестный тег NBT: ${type}`)
  }
}

function decompress(raw: Buffer): Buffer {
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) return zlib.gunzipSync(raw)
  if (raw.length >= 1 && raw[0] === 0x78) return zlib.inflateSync(raw)
  return raw
}

export function parseNbt(raw: Buffer): NbtCompound {
  const buf = decompress(raw)
  const r = new Reader(buf)
  const rootType = r.u8()
  if (rootType !== TAG_COMPOUND) {
    throw new AppError('NBT_BAD_ROOT', `Ожидался TAG_Compound, получен тег ${rootType}`)
  }
  r.str() // имя корня, обычно пустое
  return readPayload(r, TAG_COMPOUND) as NbtCompound
}

export interface LevelInfo {
  /** LastPlayed в миллисекундах, null если поля нет. */
  lastPlayed: number | null
  levelName: string | null
}

/**
 * Читает level.dat. Ошибки не бросает: битый или отсутствующий level.dat
 * не должен ломать список миров — вернём null и покажем статус «unknown».
 */
export async function readLevelInfo(levelDatPath: string): Promise<LevelInfo> {
  try {
    const raw = await fsp.readFile(levelDatPath)
    const root = parseNbt(raw)
    const data = root['Data']
    if (data === undefined || typeof data !== 'object' || Array.isArray(data) || Buffer.isBuffer(data)) {
      return { lastPlayed: null, levelName: null }
    }
    const compound = data as NbtCompound
    const rawLastPlayed = compound['LastPlayed']
    const rawName = compound['LevelName']
    const lastPlayed =
      typeof rawLastPlayed === 'bigint'
        ? Number(rawLastPlayed)
        : typeof rawLastPlayed === 'number'
          ? rawLastPlayed
          : null
    return {
      lastPlayed: lastPlayed !== null && Number.isFinite(lastPlayed) && lastPlayed > 0 ? lastPlayed : null,
      levelName: typeof rawName === 'string' ? rawName : null
    }
  } catch {
    return { lastPlayed: null, levelName: null }
  }
}
