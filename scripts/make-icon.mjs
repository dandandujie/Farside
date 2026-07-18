/**
 * 从 resources/icon.svg 渲染 512×512 PNG 图标（electron-builder 用它自动生成 ico/icns）。
 * 不进 src，不参与构建。用法：node scripts/make-icon.mjs
 */
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('no-sandbox')

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 512,
    height: 512,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true, // 圆角外保持透明通道
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, backgroundThrottling: false }
  })
  // SVG 内联进 data: URL，规避 data 文档加载 file:// 资源的跨域限制
  const svg = readFileSync(join(root, 'resources/icon.svg'), 'utf8').replace(
    '<svg ',
    '<svg width="512" height="512" '
  )
  const html = `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((r) => setTimeout(r, 400))
  const image = await win.webContents.capturePage()
  const file = join(root, 'resources/icon.png')
  writeFileSync(file, image.toPNG())
  const { width, height } = image.getSize()
  console.log(`[icon] ${file} (${width}x${height})`)
  win.destroy()
  app.quit()
})
