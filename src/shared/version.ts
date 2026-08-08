/**
 * Сравнение версий по числовым частям. Своё, а не библиотека: нужен ровно
 * один случай — «новее ли тег в релизе, чем установленная версия».
 *
 * Строковое сравнение здесь недопустимо: '0.10.0' < '0.9.0' лексикографически,
 * но 0.10.0 новее. Именно на этом ломаются самодельные проверки обновлений.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l !== r) return l > r ? 1 : -1
  }
  return 0
}

/** Суффикс вида -beta.1 отбрасывается: предвыпуски мы не различаем. */
function parseVersion(value: string): number[] {
  return value
    .trim()
    .replace(/^v/i, '')
    .split('-')[0]!
    .split('.')
    .map((part) => {
      const parsed = Number.parseInt(part, 10)
      return Number.isFinite(parsed) ? parsed : 0
    })
}

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}
