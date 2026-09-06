import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, dialog, shell, BrowserWindow } from 'electron'
import { isAllowedExternalUrl, isAllowedPreviewUrl } from '@shared/security'
import { hasActiveAgentWork, registerIpcHandlers } from './ipc'
import { isRendererConfirmedClose, markRendererConfirmedClose } from './services/close-guard'
import { loadWindowState, saveWindowState } from './services/window-state'
import { isTrustedRendererUrl } from './security'

const isDev = !!process.env['ELECTRON_RENDERER_URL']
const rendererPath = join(__dirname, '../renderer/index.html')
const rendererUrl = isDev
  ? process.env['ELECTRON_RENDERER_URL'] as string
  : pathToFileURL(rendererPath).href
const smokeMode = process.env['FARSIDE_SMOKE_TEST']

// ── 主进程兜底：任何未捕获异常不再静默丢栈，也不无声地丢掉正在运行的任务 ──
let errorBoxShown = false
process.on('uncaughtException', (error) => {
  console.error('[farside] 主进程未捕获异常', error)
  if (errorBoxShown || smokeMode) return
  errorBoxShown = true
  // 与 VS Code 同策略：记录并提示，但不立刻退出——正在运行的 Agent 任务、
  // 终端与本地服务比"理论上的状态污染"更值得保住。真正致命的退出路径仍走
  // before-quit 清场（回收终端与自启 server）。
  try {
    dialog.showErrorBox(
      'Farside 遇到内部错误',
      `${error.message || String(error)}\n\n应用会继续运行；若功能异常，请保存工作后重启。`
    )
  } catch {
    // 弹窗失败时保持静默，栈已打到 stderr
  }
})
process.on('unhandledRejection', (reason) => {
  console.error('[farside] 主进程未处理的 Promise 拒绝', reason)
})
app.on('child-process-gone', (_event, details) => {
  // GPU/渲染进程由各自路径处理；这里只留诊断线索
  if (details.type === 'Utility' || details.type === 'GPU') {
    console.error(`[farside] 子进程退出 ${details.type} ${details.reason}`)
  }
})

function openExternal(url: string): void {
  if (smokeMode) return
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
  const saved = loadWindowState()
  const mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    // 上次是最大化时忽略还原位置，由 maximize() 恢复；否则恢复保存的位置
    ...(saved.x !== undefined && saved.y !== undefined && !saved.isMaximized
      ? { x: saved.x, y: saved.y }
      : {}),
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
  if (saved.isMaximized) mainWindow.maximize()

  // 位置/尺寸持久化：close 在被守卫 preventDefault 时也会触发，重复写是幂等的
  mainWindow.on('close', () => saveWindowState(mainWindow))

  // 审批等待期间设置的 badge/任务栏闪烁，在用户回到窗口时清除
  mainWindow.on('focus', () => {
    app.setBadgeCount(0)
    mainWindow.flashFrame(false)
  })

  // 渲染进程崩溃不再白屏无提示：短窗口内自动重载，反复崩溃才升级为人工处理
  let rendererCrashCount = 0
  let lastRendererCrashAt = 0
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    console.error('[farside] 渲染进程异常退出', details.reason)
    const now = Date.now()
    if (now - lastRendererCrashAt > 300_000) rendererCrashCount = 0
    lastRendererCrashAt = now
    rendererCrashCount += 1
    if (rendererCrashCount <= 3) {
      setTimeout(() => {
        if (!mainWindow.isDestroyed()) mainWindow.webContents.reload()
      }, 400)
    } else if (!errorBoxShown) {
      errorBoxShown = true
      dialog.showErrorBox(
        'Farside 界面反复崩溃',
        '界面进程多次异常退出，已停止自动恢复。请重启应用；若持续出现，请通过会话导出的诊断日志反馈。'
      )
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

  // 任务运行中拦截静默关闭：标题栏 × 与 /exit 在渲染层确认后经 IPC 关闭
  // （视为已确认）；macOS 红绿灯等原生路径在这里补确认。app.quit() 的
  // 退出流程（含 Windows 更新自动退出）在 before-quit 中放行。
  let quitting = false
  app.once('before-quit', () => {
    quitting = true
  })
  mainWindow.on('close', (event) => {
    if (quitting || isRendererConfirmedClose(mainWindow) || !hasActiveAgentWork()) return
    event.preventDefault()
    void dialog
      .showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['仍要关闭', '取消'],
        defaultId: 1,
        cancelId: 1,
        message: '仍有会话在运行中',
        detail: '关闭 Farside 会中断正在运行的任务与终端进程。确定要关闭吗？'
      })
      .then(({ response }) => {
        if (response !== 0) return
        markRendererConfirmedClose(mainWindow)
        mainWindow.close()
      })
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

  if (smokeMode) {
    mainWindow.webContents.once('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame) return
      console.error(`FARSIDE_SMOKE_TEST_FAILED ${code} ${description} ${url}`)
      app.exit(1)
    })
    mainWindow.webContents.once('did-finish-load', () => {
      if (smokeMode === 'account' || smokeMode === 'login') {
        const deadline = Date.now() + 45_000
        const verifyLoginStarted = (): void => {
          void mainWindow.webContents.executeJavaScript(
            "document.body.innerText.includes('设备码') || document.body.innerText.includes('DEVICE CODE')"
          ).then((started) => {
            if (started) {
              console.log(`FARSIDE_LOGIN_SMOKE_TEST_OK Electron ${process.versions.electron}`)
              app.quit()
            } else if (Date.now() >= deadline) {
              console.error('FARSIDE_LOGIN_SMOKE_TEST_FAILED Kimi 设备码未显示')
              app.exit(1)
            } else {
              setTimeout(verifyLoginStarted, 250)
            }
          }).catch((error) => {
            console.error(`FARSIDE_LOGIN_SMOKE_TEST_FAILED ${error instanceof Error ? error.message : String(error)}`)
            app.exit(1)
          })
        }
        const verifyOnboarding = (): void => {
          void mainWindow.webContents.executeJavaScript(
            "document.body.innerText.includes('连接你的 Kimi 链路') || document.body.innerText.includes('Connect a Kimi provider')"
          ).then((visible) => {
            if (visible) {
              if (smokeMode === 'account') {
                console.log(`FARSIDE_ACCOUNT_SMOKE_TEST_OK Electron ${process.versions.electron}`)
                app.quit()
                return
              }
              void mainWindow.webContents.executeJavaScript(
                "(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('使用 Kimi 登录') || item.textContent?.includes('Sign in with Kimi')); button?.click(); return Boolean(button) })()"
              ).then((clicked) => {
                if (!clicked) throw new Error('未找到 Kimi 登录按钮')
                verifyLoginStarted()
              }).catch((error) => {
                console.error(`FARSIDE_LOGIN_SMOKE_TEST_FAILED ${error instanceof Error ? error.message : String(error)}`)
                app.exit(1)
              })
            } else if (Date.now() >= deadline) {
              console.error('FARSIDE_ACCOUNT_SMOKE_TEST_FAILED 首次账户设置未显示')
              app.exit(1)
            } else {
              setTimeout(verifyOnboarding, 250)
            }
          }).catch((error) => {
            console.error(`FARSIDE_ACCOUNT_SMOKE_TEST_FAILED ${error instanceof Error ? error.message : String(error)}`)
            app.exit(1)
          })
        }
        verifyOnboarding()
        return
      }
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
  if (smokeMode) app.exit(2)
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
