import { DEFAULT_YANDEX_SCOPE } from '@shared/types'

/**
 * Значения, вшитые в сборку. Подставляются Vite из переменных окружения
 * (в CI — из секретов репозитория), чтобы установщик приходил уже настроенным
 * и на каждой машине не приходилось вставлять client_id руками.
 *
 * Важно понимать границу: секрет, попавший в распространяемое приложение,
 * секретом быть перестаёт — его можно достать из бандла. Секреты репозитория
 * защищают ключи в логах CI и в исходниках, но не в готовом бинарнике.
 * Для личного приложения на два компьютера это приемлемо, тем более что
 * авторизация построена на PKCE и client_secret нужен только для обновления
 * токена. Пользователь всегда может переопределить значения в настройках.
 *
 * Проверка через typeof обязательна: те же модули собираются esbuild-ом для
 * смоук-теста, где подстановки Vite нет.
 */

function injected(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

export const BUILD_CLIENT_ID = injected(
  typeof __WSYNC_CLIENT_ID__ !== 'undefined' ? __WSYNC_CLIENT_ID__ : undefined
)

export const BUILD_CLIENT_SECRET = injected(
  typeof __WSYNC_CLIENT_SECRET__ !== 'undefined' ? __WSYNC_CLIENT_SECRET__ : undefined
)

export const BUILD_SCOPE = (() => {
  const value = injected(
    typeof __WSYNC_SCOPE__ !== 'undefined' ? __WSYNC_SCOPE__ : undefined
  )
  return value.length > 0 ? value : DEFAULT_YANDEX_SCOPE
})()

/** Сборка пришла с вшитыми ключами — UI не должен просить их у пользователя. */
export const HAS_BUILD_CREDENTIALS = BUILD_CLIENT_ID.length > 0
