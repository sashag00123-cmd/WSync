import { throwIfAborted } from './errors'

/**
 * Выполняет задачи с ограничением одновременности, сохраняя порядок
 * результатов. Первая же ошибка прекращает запуск новых задач: если часть
 * архива не выгрузилась, продолжать остальные бессмысленно.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  if (items.length === 0) return results

  const workers = Math.max(1, Math.min(limit, items.length))
  let next = 0
  let failed: unknown = null

  const worker = async (): Promise<void> => {
    for (;;) {
      if (failed !== null) return
      throwIfAborted(signal)
      const index = next
      next += 1
      if (index >= items.length) return
      try {
        results[index] = await fn(items[index]!, index)
      } catch (err) {
        failed ??= err
        return
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, async () => await worker()))
  if (failed !== null) throw failed
  return results
}
