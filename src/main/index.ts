import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, shell, BrowserWindow } from 'electron'
import { isAllowedExternalUrl, isAllowedPreviewUrl } from '@shared/security'
import { registerIpcHandlers } from './ipc'
import { isTrustedRendererUrl } from './security'

const isDev = !!process.env['ELECTRON_RENDERER_URL']
const rendererPath = join(__dirname, '../renderer/index.html')
const rendererUrl = isDev
  ? process.env['ELECTRON_RENDERER_URL'] as string
  : pathToFileURL(rendererPath).href

function openExternal(url: string): void {
  if (isAllowedExternalUrl(url)) void shell.openExternal(url).catch(() => undefined)
}

function lockPreviewPermissions(contents: Electron.WebContents): void {
  const previewSession = contents.session
  previewSession.setPermissionCheckHandler(() => false)
  previewSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  previewSession.setDevicePermissionHandler(() => false)
  const preventDownload = (event: Electron.Event, _item: Electron.DownloadItem, webContents: Electron.WebContents): void => {
    if (webContents === contents) event.preventDefault()
  }
  previewSession.on('will-download', preventDownload)
  contents.once('destroyed', () => previewSession.removeListener('will-download', preventDownload))
}

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
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  })

  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!isAllowedPreviewUrl(params.src)) {
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
    openExternal(details.url)
    return { action: 'deny' }
  })

  const preventUntrustedNavigation = (event: Electron.Event, url: string): void => {
    if (!isTrustedRendererUrl(url, rendererUrl)) event.preventDefault()
  }
  mainWindow.webContents.on('will-navigate', preventUntrustedNavigation)
  mainWindow.webContents.on('will-redirect', preventUntrustedNavigation)

  if (process.env['FARSIDE_SMOKE_TEST'] === '1') {
    mainWindow.webContents.once('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame) return
      console.error(`FARSIDE_SMOKE_TEST_FAILED ${code} ${description} ${url}`)
      app.exit(1)
    })
    mainWindow.webContents.once('did-finish-load', () => {
      console.log(`FARSIDE_SMOKE_TEST_OK Electron ${process.versions.electron}`)
      setTimeout(() => app.quit(), 250)
    })
  }

  if (isDev) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(rendererPath)
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  if (process.env['FARSIDE_SMOKE_TEST'] === '1') app.exit(2)
  else app.quit()
} else {
  app.on('second-instance', () => {
    const mainWindow = BrowserWindow.getAllWindows()[0]
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    app.setAppUserModelId('com.moonshot.farside')

    app.on('web-contents-created', (_event, contents) => {
      if (contents.getType() !== 'webview') return
      lockPreviewPermissions(contents)
      contents.setWindowOpenHandler((details) => {
        openExternal(details.url)
        return { action: 'deny' }
      })
      const preventUntrustedPreviewNavigation = (event: Electron.Event, url: string): void => {
        if (!isAllowedPreviewUrl(url)) event.preventDefault()
      }
      contents.on('will-navigate', preventUntrustedPreviewNavigation)
      contents.on('will-redirect', preventUntrustedPreviewNavigation)
    })

    registerIpcHandlers()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
