import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { DetectedInstance } from '@shared/types'
import { isDirectory, pathExists } from '../core/fsx'

interface Pattern {
  launcher: string
  /** Ровно один сегмент может быть '*' — уровень инстансов лончера. */
  template: string
}

function home(): string {
  return os.homedir()
}

function appData(): string {
  return process.env['APPDATA'] ?? path.join(home(), 'AppData', 'Roaming')
}

function patterns(): Pattern[] {
  if (process.platform === 'win32') {
    return [
      { launcher: 'CurseForge', template: path.join(home(), 'curseforge', 'minecraft', 'Instances', '*', 'saves') },
      { launcher: 'Prism Launcher', template: path.join(appData(), 'PrismLauncher', 'instances', '*', '.minecraft', 'saves') },
      { launcher: 'Prism Launcher', template: path.join(appData(), 'PrismLauncher', 'instances', '*', 'minecraft', 'saves') },
      { launcher: 'MultiMC', template: path.join(appData(), 'MultiMC', 'instances', '*', '.minecraft', 'saves') },
      { launcher: 'Modrinth App', template: path.join(appData(), 'com.modrinth.theseus', 'profiles', '*', 'saves') },
      { launcher: 'Modrinth App', template: path.join(appData(), 'ModrinthApp', 'profiles', '*', 'saves') },
      { launcher: 'GDLauncher', template: path.join(appData(), 'gdlauncher_next', 'instances', '*', 'saves') },
      { launcher: 'ATLauncher', template: path.join(home(), 'ATLauncher', 'instances', '*', 'saves') },
      { launcher: 'Minecraft (ванильный)', template: path.join(appData(), '.minecraft', 'saves') }
    ]
  }
  if (process.platform === 'darwin') {
    const support = path.join(home(), 'Library', 'Application Support')
    return [
      { launcher: 'CurseForge', template: path.join(home(), 'curseforge', 'minecraft', 'Instances', '*', 'saves') },
      { launcher: 'CurseForge', template: path.join(support, 'CurseForge', 'minecraft', 'Instances', '*', 'saves') },
      { launcher: 'Prism Launcher', template: path.join(support, 'PrismLauncher', 'instances', '*', '.minecraft', 'saves') },
      { launcher: 'Prism Launcher', template: path.join(support, 'PrismLauncher', 'instances', '*', 'minecraft', 'saves') },
      { launcher: 'MultiMC', template: path.join(support, 'MultiMC', 'instances', '*', '.minecraft', 'saves') },
      { launcher: 'Modrinth App', template: path.join(support, 'com.modrinth.theseus', 'profiles', '*', 'saves') },
      { launcher: 'Modrinth App', template: path.join(support, 'ModrinthApp', 'profiles', '*', 'saves') },
      { launcher: 'Minecraft (ванильный)', template: path.join(support, 'minecraft', 'saves') }
    ]
  }
  return [
    { launcher: 'Prism Launcher', template: path.join(home(), '.local', 'share', 'PrismLauncher', 'instances', '*', '.minecraft', 'saves') },
    { launcher: 'Modrinth App', template: path.join(home(), '.local', 'share', 'com.modrinth.theseus', 'profiles', '*', 'saves') },
    { launcher: 'Minecraft (ванильный)', template: path.join(home(), '.minecraft', 'saves') }
  ]
}

/** Раскрывает единственный '*' в шаблоне в реальные пути. */
async function expand(template: string): Promise<string[]> {
  const star = `${path.sep}*${path.sep}`
  const index = template.indexOf(star)
  if (index < 0) {
    return (await isDirectory(template)) ? [template] : []
  }
  const base = template.slice(0, index)
  const tail = template.slice(index + star.length)
  if (!(await isDirectory(base))) return []
  let names: string[]
  try {
    names = (await fsp.readdir(base, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of names) {
    const candidate = path.join(base, name, tail)
    if (await isDirectory(candidate)) out.push(candidate)
  }
  return out
}

/** Имя, которое покажем пользователю: папка инстанса, а не «saves». */
function instanceNameFor(savesPath: string): string {
  const parts = savesPath.split(path.sep).filter((p) => p.length > 0)
  for (let i = parts.length - 2; i >= 0; i--) {
    const part = parts[i]
    if (part === undefined) continue
    if (part === '.minecraft' || part === 'minecraft') continue
    return part
  }
  return 'Minecraft'
}

/**
 * Ищет каталоги saves известных лончеров. Каталог считается подходящим,
 * только если внутри есть хотя бы один мир (папка с level.dat) — иначе
 * пользователь получит список пустых заготовок.
 */
export async function detectInstances(): Promise<DetectedInstance[]> {
  const found = new Map<string, DetectedInstance>()
  for (const pattern of patterns()) {
    for (const savesPath of await expand(pattern.template)) {
      const key = path.resolve(savesPath).toLowerCase()
      if (found.has(key)) continue
      if (!(await hasAnyWorld(savesPath))) continue
      found.set(key, {
        launcher: pattern.launcher,
        name: instanceNameFor(savesPath),
        savesPath
      })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'))
}

async function hasAnyWorld(savesPath: string): Promise<boolean> {
  try {
    const entries = await fsp.readdir(savesPath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (await pathExists(path.join(savesPath, entry.name, 'level.dat'))) return true
    }
  } catch {
    return false
  }
  return false
}

/** Путь бэкапов по умолчанию — рядом с saves, но не внутри него. */
export function defaultBackupsPath(savesPath: string): string {
  return path.join(path.dirname(savesPath), 'wsync_backups')
}
