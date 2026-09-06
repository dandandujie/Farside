import { app, BrowserWindow, Notification, type WebContents } from 'electron'
import type { AttentionNotice } from '@shared/ipc'

const MAX_BADGE = 99
const NOTIFY_MIN_INTERVAL_MS = 1_000

/**
 * 审批/提问等待的注意力引导：窗口未聚焦时设置 dock/taskbar badge、闪任务栏
 * 并发系统通知，点击通知回到窗口。文案由渲染层按当前语言拼好；本服务语言无关。
 * Windows 无 dock badge 概念，以 flashFrame（任务栏闪烁）为主要引导。
 */
export class AttentionService {
  private lastNotifiedAt = 0

  notify(sender: WebContents, notice: AttentionNotice): void {
    const win = BrowserWindow.fromWebContents(sender)
    if (!win || win.isDestroyed() || win.isFocused()) return
    app.setBadgeCount(Math.max(1, Math.min(MAX_BADGE, Math.floor(notice.pendingCount) || 1)))
    win.flashFrame(true)
    if (!Notification.isSupported()) return
    // 队列型事件（审批逐条上发）按 1s 合并，避免通知风暴；badge 数仍实时更新。
    const now = Date.now()
    if (now - this.lastNotifiedAt < NOTIFY_MIN_INTERVAL_MS) return
    this.lastNotifiedAt = now
    const notification = new Notification({
      title: notice.title,
      body: notice.body,
      silent: false
    })
    notification.on('click', () => {
      if (win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    notification.show()
  }

  /** 窗口重新聚焦后清除引导状态。 */
  clearAttention(): void {
    app.setBadgeCount(0)
  }
}
