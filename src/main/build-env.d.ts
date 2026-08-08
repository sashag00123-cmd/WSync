/**
 * Константы, подставляемые Vite на этапе сборки из переменных окружения.
 * В обычном Node (смоук-тест, бенчмарки) их нет — обращаться к ним можно
 * только через `typeof ... !== 'undefined'`.
 */
declare const __WSYNC_CLIENT_ID__: string | undefined
declare const __WSYNC_CLIENT_SECRET__: string | undefined
declare const __WSYNC_SCOPE__: string | undefined
