import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, screen, type BrowserWindow } from 'electron'

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  isMaximized?: boolean
}

const MIN_WIDTH = 1080
const MIN_HEIGHT = 700

function statePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 至少保证窗口左上角区域在某个显示器的工作区内，避免拔掉副屏后窗口落在屏外。 */
function clampToWorkArea(state: WindowState): WindowState {
  if (state.x === undefined || state.y === undefined) return state
  const display = screen.getDisplayMatching({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height
  })
  const area = display.workArea
  return {
    ...state,
    x: clamp(state.x, area.x - state.width + 160, area.x + area.width - 160),
    y: clamp(state.y, area.y, area.y + area.height - 80)
  }
}

export function loadWindowState(): WindowState {
  const fallback: WindowState = { width: 1280, height: 800 }
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<WindowState>
    if (typeof raw.width !== 'number' || typeof raw.height !== 'number') return fallback
    const state: WindowState = {
      width: clamp(Math.floor(raw.width), MIN_WIDTH, 7680),
      height: clamp(Math.floor(raw.height), MIN_HEIGHT, 4320),
      isMaximized: raw.isMaximized === true
    }
    if (typeof raw.x === 'number' && typeof raw.y === 'number') {
      state.x = Math.floor(raw.x)
      state.y = Math.floor(raw.y)
    }
    return clampToWorkArea(state)
  } catch {
    return fallback
  }
}

/** 原子写窗口状态；失败只意味着下次启动回到默认位置，不提示用户。 */
export function saveWindowState(win: BrowserWindow): void {
  try {
    const bounds = win.getNormalBounds()
    const payload: WindowState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: win.isMaximized()
    }
    const file = statePath()
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(payload))
    renameSync(tmp, file)
  } catch {
    // 状态保存失败不影响退出
  }
}
