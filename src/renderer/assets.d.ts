// Vite превращает импорт таблицы стилей в побочный эффект — для TypeScript
// это надо объявить явно.
declare module '*.css' {
  const content: string
  export default content
}
