import { join } from 'node:path'
import { app, shell, BrowserWindow } from 'electron'
import { registerIpcHandlers } from './ipc'

const isDev = !!process.env['ELECTRON_RENDERER_URL']

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: '#0A0B0F',
    autoHideMenuBar: true,
    // 无边框：Windows 自绘 ─□×；macOS 隐藏红绿灯但保留拖拽
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!/^https?:\/\//i.test(params.src)) {
      event.preventDefault()
      return
    }
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // 渲染层一律禁止开新窗口；http/https 外链交给系统浏览器（Markdown 的 target=_blank 走这里）
  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//i.test(details.url)) {
      void shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  if (isDev) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] as string)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  app.setAppUserModelId('dev.farside.app')

  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return
    contents.setWindowOpenHandler((details) => {
      if (/^https?:\/\//i.test(details.url)) void shell.openExternal(details.url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (!/^https?:\/\//i.test(url)) event.preventDefault()
    })
  })

  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
