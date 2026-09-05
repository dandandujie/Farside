import type { BrowserWindow } from 'electron'

/**
 * 关闭确认的来源标记：渲染层（标题栏 × / /exit）在弹出确认后才发起
 * window.close()，走 IPC 的关闭视为已确认；macOS 红绿灯等原生关闭
 * 路径不经过 IPC，由窗口 close 事件守卫补上“任务运行中”确认。
 */
const confirmed = new WeakSet<BrowserWindow>()

export function markRendererConfirmedClose(win: BrowserWindow | null): void {
  if (win) confirmed.add(win)
}

export function isRendererConfirmedClose(win: BrowserWindow): boolean {
  return confirmed.has(win)
}
