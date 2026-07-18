/**
 * 离屏截图走查脚本（不进 src，不参与构建）。
 *
 * 用法：
 *   node scripts/screenshot.mjs            # 默认拍全部场景
 *   node scripts/screenshot.mjs main diff  # 只拍指定场景
 *
 * 场景对应 App.tsx 的 dev-only 钩子（?shot=...）：
 *   main / palette / diff|files / goals / terminal / settings / account / preview / turns
 *
 * 产出：shots/<场景>.png（1440×900，deviceScaleFactor 1）
 *
 * 实现备注：
 * - Windows 上 loadFile + query 会 ERR_FAILED，改走 loadURL 手动拼 file:// URL；
 * - 且第二个 BrowserWindow 起 loadURL 也间歇 ERR_FAILED，故全程复用同一个窗口逐场景跳转；
 * - show:false 时页面被视为后台、定时器节流到 1s，BootSplash 播不完，须关 backgroundThrottling。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// README 保持 `node scripts/screenshot.mjs`：普通 Node 进程先自举到 Electron runtime。
if (!process.versions.electron) {
  const { default: electronPath } = await import('electron')
  const result = spawnSync(electronPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit'
  })
  process.exit(result.status ?? 1)
}

const { app, BrowserWindow } = await import('electron')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'shots')

// 锁定 DSF=1，避免 Windows 显示缩放把截图放大；部分环境需要 no-sandbox
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('no-sandbox')

const ALL = ['main', 'palette', 'diff', 'files', 'goals', 'terminal', 'settings', 'settings-light', 'account', 'preview', 'image-input', 'turns', 'profile', 'project-menu', 'resize']
const targets = process.argv.slice(2).filter((s) => ALL.includes(s))
const shots = targets.length > 0 ? targets : ALL

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

void app.whenReady().then(async () => {
  mkdirSync(outDir, { recursive: true })
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: '#0A0B0F',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      // 隐藏窗口的合成器不出新帧，capturePage 只会拿到旧画面；
      // offscreen 软件渲染持续产出帧，capturePage 才能读到实时内容
      offscreen: true
    }
  })
  const href = pathToFileURL(join(root, 'out/renderer/index.html')).href

  for (const name of shots) {
    try {
      await win.webContents.loadURL(`${href}?shot=${name}`)
      // 等渲染就绪：React 已挂载（#root 有子节点）且 BootSplash 遮罩（fixed 全屏 z-100）已卸载。
      // 只判遮罩会在 React 挂载前误判“已消失”，两个条件必须同时满足。
      for (let i = 0; i < 50; i++) {
        await sleep(200)
        const ready = await win.webContents
          .executeJavaScript(
            `document.querySelector('#root')?.children.length > 0 && !document.querySelector('div[style*="z-index: 100"]')`
          )
          .catch(() => false)
        if (ready) break
      }
      // 再等字体就绪，避免衬线回退被误拍
      await win.webContents
        .executeJavaScript('document.fonts.ready.then(() => true)')
        .catch(() => {})
      if (name === 'profile') {
        await win.webContents.executeJavaScript(`document.querySelector('button[aria-label="账户"]')?.click()`)
        await sleep(150)
      }
      if (name === 'project-menu') {
        await win.webContents.executeJavaScript(`document.querySelector('button[aria-label$="项目操作"]')?.click()`)
        await sleep(150)
      }
      if (name === 'resize') {
        await win.webContents.executeJavaScript(`(() => {
          const handles = [...document.querySelectorAll('[role="separator"]')]
          const drag = (handle, start, end) => {
            handle?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: start }))
            window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: end }))
            window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: end }))
          }
          drag(handles[0], 252, 342)
          drag(handles[1], 1080, 1000)
        })()`)
        await sleep(200)
      }
      await sleep(200)
      const domState = await win.webContents
        .executeJavaScript(
          `JSON.stringify({splash: !!document.querySelector('div[style*="z-index: 100"]'), text: document.body.innerText.length})`
        )
        .catch(() => 'eval-failed')
      console.log(`[diag] ${name} dom=${domState}`)

      const image = await win.webContents.capturePage()
      const file = join(outDir, `${name}.png`)
      writeFileSync(file, image.toPNG())
      const { width, height } = image.getSize()
      console.log(`[shot] ${name} -> ${file} (${width}x${height})`)

      if (name === 'turns') {
        await win.webContents.executeJavaScript(`(() => {
          const buttons = [...document.querySelectorAll('[data-activity-batch]')]
          const latest = buttons.at(-1)
          if (latest?.getAttribute('aria-expanded') !== 'true') latest?.click()
        })()`)
        await sleep(180)
        const activity = await win.webContents.capturePage()
        writeFileSync(join(outDir, 'turns-activity.png'), activity.toPNG())
        console.log(`[shot] turns-activity -> ${join(outDir, 'turns-activity.png')}`)

        await win.webContents.executeJavaScript(`document.querySelector('[data-activity-list] [data-instrument-toggle]')?.click()`)
        await sleep(180)
        const detail = await win.webContents.capturePage()
        writeFileSync(join(outDir, 'turns-tool-detail.png'), detail.toPNG())
        console.log(`[shot] turns-tool-detail -> ${join(outDir, 'turns-tool-detail.png')}`)

        await win.webContents.executeJavaScript(`(() => {
          const header = document.querySelector('.swarm-panel__header')
          if (header?.getAttribute('aria-expanded') !== 'true') header?.click()
          header?.scrollIntoView({ block: 'center' })
        })()`)
        await sleep(220)
        const swarm = await win.webContents.capturePage()
        writeFileSync(join(outDir, 'turns-swarm.png'), swarm.toPNG())
        console.log(`[shot] turns-swarm -> ${join(outDir, 'turns-swarm.png')}`)
      }

      // main 附加一张 main-clear：点击审批卡「允许一次」（顺带验证 data-approval-card 接线），
      // 露出完整 Trajectory 轨道线走查
      if (name === 'main') {
        await win.webContents
          .executeJavaScript(`document.querySelector('[data-approval-card] button')?.click()`)
          .catch(() => {})
        await sleep(400)
        const clear = await win.webContents.capturePage()
        writeFileSync(join(outDir, 'main-clear.png'), clear.toPNG())
        console.log(`[shot] main-clear -> ${join(outDir, 'main-clear.png')}`)
      }
    } catch (err) {
      console.error(`[shot] ${name} failed:`, err)
    }
  }
  win.destroy()
  app.quit()
})
