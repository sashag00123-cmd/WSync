/*
 * Рисует build/icon.png из знака приложения. Растеризуем средствами Chromium,
 * который уже есть в зависимостях, — тянуть отдельный конвертер SVG ради
 * одной картинки не нужно. electron-builder сам сделает из PNG .ico и .icns.
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const SIZE = 1024
const OUT = path.join(__dirname, '..', 'build', 'icon.png')

const html = `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; width: ${SIZE}px; height: ${SIZE}px; background: transparent; }
  svg { display: block; }
</style>
<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse">
      <stop stop-color="#6ea1ff"/>
      <stop offset="1" stop-color="#2a5fd6"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1024" gradientUnits="userSpaceOnUse">
      <stop stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="72" y="72" width="880" height="880" rx="216" fill="url(#bg)"/>
  <rect x="72" y="72" width="880" height="880" rx="216" fill="url(#gloss)"/>
  <g transform="translate(0 -104)">
    <path d="M360 660h304a98 98 0 0 0 14-195 155 155 0 0 0-291-19 109 109 0 0 0-27 214Z"
          fill="none" stroke="#ffffff" stroke-width="46" stroke-linejoin="round"/>
  </g>
  <path d="M512 848V632m-84 84 84-84 84 84"
        fill="none" stroke="#ffffff" stroke-width="48" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true }
  })
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((resolve) => setTimeout(resolve, 500))
  const image = await window.webContents.capturePage()
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, image.toPNG())
  const size = image.getSize()
  console.log(`icon.png: ${size.width}x${size.height}, ${fs.statSync(OUT).size} байт`)
  app.exit(0)
})
