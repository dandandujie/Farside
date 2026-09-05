import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useActiveSession } from '../../lib/store'
import { useFarsideStore } from '../../lib/store'
import { usePreferences } from '../../lib/preferences'

/** xterm 主题：严格取 DESIGN token（void 底 / moonlight 字 / line 选区） */
const XTERM_THEME_DARK = {
  background: '#0A0B0F',
  foreground: '#F0F1F4',
  cursor: '#F0F1F4',
  cursorAccent: '#0A0B0F',
  selectionBackground: '#22242E'
}

const XTERM_THEME_LIGHT = {
  background: '#F4F4F0',
  foreground: '#17191F',
  cursor: '#17191F',
  cursorAccent: '#F4F4F0',
  selectionBackground: '#D7D8D2'
}

/** 从 shell 路径取显示名：C:\...\bash.exe → bash */
function shellBaseName(shell: string): string {
  return (shell.split(/[\\/]/).pop() ?? shell).replace(/\.exe$/i, '')
}

type LinkState = 'connecting' | 'ready' | 'failed'

/**
 * 按工作目录缓存的终端实例。切换会话/项目时只做显示切换，绝不杀掉
 * 正在运行的 shell；缓存超限时按最近使用淘汰最旧的非活动实例。
 * 容器 DOM 由本模块直接管理（不走 React 协调），xterm 挂载后整体显隐。
 */
interface TerminalEntry {
  cwd: string
  container: HTMLDivElement
  term: Terminal
  fit: FitAddon
  ptyId: string | null
  unsubscribe: (() => void) | null
  observer: ResizeObserver
  shell: string
  link: LinkState
  lastActive: number
  disposed: boolean
}

const MAX_TERMINALS = 8
const terminals = new Map<string, TerminalEntry>()

function disposeEntry(entry: TerminalEntry): void {
  if (entry.disposed) return
  entry.disposed = true
  entry.observer.disconnect()
  entry.unsubscribe?.()
  if (entry.ptyId) void window.api?.pty.kill(entry.ptyId).catch(() => undefined)
  entry.container.remove()
  entry.term.dispose()
  terminals.delete(entry.cwd)
}

function disposeAllTerminals(): void {
  for (const entry of [...terminals.values()]) disposeEntry(entry)
}

/**
 * 地面站终端：xterm.js + FitAddon，经 pty:* IPC 与主进程的 shell 对话。
 * 终端按 cwd 缓存复用；PTY 不可用（node-pty 缺失且管道降级也失败）时
 * 显示占位与重试，不影响其余界面。
 */
export function TerminalView() {
  const { locale, theme } = usePreferences()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [, setTick] = useState(0)
  const session = useActiveSession()
  const cwd = session?.cwd
  const activeKey = cwd ?? ''
  const pendingCommand = useFarsideStore((state) => state.pendingTerminalCommand)
  const consumeTerminalCommand = useFarsideStore((state) => state.consumeTerminalCommand)

  const activeEntry = terminals.get(activeKey) ?? null

  // 挂载/卸载：卸载（登出、关闭终端挂载点）时回收全部终端与 PTY。
  useEffect(() => {
    return () => disposeAllTerminals()
  }, [])

  // 主题切换同步到所有缓存终端（含后台实例）。
  useEffect(() => {
    const nextTheme = theme === 'light' ? XTERM_THEME_LIGHT : XTERM_THEME_DARK
    for (const entry of terminals.values()) {
      entry.term.options.theme = nextTheme
    }
  }, [theme])

  const ensureTerminal = useCallback((key: string): void => {
    const wrapper = wrapperRef.current
    const api = window.api
    if (!wrapper || !api) return

    let entry = terminals.get(key)
    if (!entry) {
      const container = document.createElement('div')
      container.style.cssText =
        'position:absolute;inset:0;padding:8px 0 0 12px;box-sizing:border-box;visibility:hidden;'
      wrapper.appendChild(container)
      const term = new Terminal({
        theme: theme === 'light' ? XTERM_THEME_LIGHT : XTERM_THEME_DARK,
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 12.5,
        cursorBlink: true,
        scrollback: 5000,
        // 管道降级模式下输出换行只有 \n，交给 xterm 补 \r，避免阶梯状文本
        convertEol: true
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(container)
      const safeFit = (): void => {
        try {
          fit.fit()
        } catch {
          // 容器隐藏或尺寸为 0 时 fit 会抛错，等下一次 resize 即可
        }
      }
      safeFit()
      const created: TerminalEntry = {
        cwd: key,
        container,
        term,
        fit,
        ptyId: null,
        unsubscribe: null,
        observer: new ResizeObserver(() => {
          safeFit()
          if (created.ptyId) void window.api!.pty.resize(created.ptyId, term.cols, term.rows)
        }),
        shell: 'bash',
        link: 'connecting',
        lastActive: Date.now(),
        disposed: false
      }
      entry = created
      terminals.set(key, created)
      created.observer.observe(container)
      term.onData((data) => {
        if (created.ptyId) void window.api!.pty.write(created.ptyId, data)
      })

      void api.pty
        .create(key === '' ? undefined : key)
        .then((result) => {
          if (created.disposed) {
            // 已被清理（如 StrictMode 双挂载、缓存淘汰），补杀这个孤儿终端
            if (result.ok) void window.api!.pty.kill(result.id)
            return
          }
          if (!result.ok) {
            created.link = 'failed'
            setTick((value) => value + 1)
            return
          }
          created.ptyId = result.id
          created.shell = shellBaseName(result.shell)
          created.unsubscribe = window.api!.pty.onData(result.id, (data) => {
            if (!created.disposed) term.write(data)
          })
          created.link = 'ready'
          setTick((value) => value + 1)
          safeFit()
          void window.api!.pty.resize(result.id, term.cols, term.rows)
          if (terminals.get(key) === created) term.focus()
        })
        .catch(() => {
          if (!created.disposed) {
            created.link = 'failed'
            setTick((value) => value + 1)
          }
        })

      // 缓存超限：淘汰最旧的非活动实例。
      if (terminals.size > MAX_TERMINALS) {
        const candidates = [...terminals.values()]
          .filter((item) => item.cwd !== key)
          .sort((left, right) => left.lastActive - right.lastActive)
        const evict = candidates[0]
        if (evict) disposeEntry(evict)
      }
    }

    entry.lastActive = Date.now()
    for (const item of terminals.values()) {
      item.container.style.visibility = item.cwd === key ? 'visible' : 'hidden'
    }
    if (entry.link === 'ready') {
      try {
        entry.fit.fit()
      } catch {
        // 抽屉刚展开时尺寸可能还是 0，等 ResizeObserver 处理
      }
      if (entry.ptyId) void window.api?.pty.resize(entry.ptyId, entry.term.cols, entry.term.rows)
      entry.term.focus()
    }
    setTick((value) => value + 1)
  }, [theme])

  // 激活 cwd 对应的终端；没有则创建。切换只改可见性，不重建进程。
  useEffect(() => {
    ensureTerminal(activeKey)
  }, [activeKey, ensureTerminal])

  // 失败重试：丢弃失败实例后立即按同一 cwd 重建。
  const retryEntry = (): void => {
    const entry = terminals.get(activeKey)
    if (entry) disposeEntry(entry)
    ensureTerminal(activeKey)
  }

  // 手动执行命令：写入当前活动终端。
  useEffect(() => {
    const entry = terminals.get(activeKey)
    if (entry?.link !== 'ready' || !pendingCommand || !entry.ptyId || !window.api) return
    const command = pendingCommand.command.replace(/\r?\n/g, '\r')
    consumeTerminalCommand(pendingCommand.id)
    const approved = window.confirm(
      locale === 'en-US'
        ? `Run this command in the terminal?\n\n${pendingCommand.command}`
        : `确认在终端执行这段命令？\n\n${pendingCommand.command}`
    )
    if (approved) void window.api.pty.write(entry.ptyId, `${command}\r`)
  }, [activeKey, consumeTerminalCommand, locale, pendingCommand])

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        background: 'var(--void)'
      }}
    >
      {/* 细标题栏：链路对端 */}
      <div
        style={{
          height: 28,
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          padding: '0 12px',
          borderBottom: '1px solid var(--line)',
          fontSize: 11,
          letterSpacing: '0.08em',
          color: 'var(--faint)',
          userSelect: 'none'
        }}
      >
        {locale === 'en-US' ? 'TERMINAL' : '地面站终端'} · {activeEntry?.shell ?? 'bash'}
      </div>

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div
          ref={wrapperRef}
          style={{ height: '100%', position: 'relative', boxSizing: 'border-box' }}
        />

        {/* 链路未建立：占位 + 重试（覆盖在终端之上） */}
        {activeEntry?.link === 'failed' ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 14,
              background: 'var(--void)'
            }}
          >
            <svg width="40" height="40" viewBox="0 0 18 18" fill="none" aria-hidden>
              <rect x="1.5" y="2.5" width="15" height="13" rx="2" stroke="var(--line-hi)" strokeWidth="1" />
              <path d="M4.5 6.5 7.5 9 4.5 11.5" stroke="var(--line-hi)" strokeWidth="1" strokeLinecap="round" />
              <line x1="9.5" y1="11.5" x2="13" y2="11.5" stroke="var(--line-hi)" strokeWidth="1" strokeLinecap="round" />
            </svg>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--faint)' }}>
              {locale === 'en-US' ? 'Terminal link unavailable (node-pty or shell backend failed)' : '终端链路未建立（node-pty 不可用或 CLI 缺失）'}
            </p>
            <button
              onClick={retryEntry}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--crater)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--regolith)')}
              style={{
                fontSize: 12.5,
                letterSpacing: '0.02em',
                padding: '5px 14px',
                color: 'var(--moonlight)',
                background: 'var(--regolith)',
                border: '1px solid var(--line-hi)',
                borderRadius: 6,
                cursor: 'pointer'
              }}
            >
              {locale === 'en-US' ? 'Reconnect' : '重新建立链路'}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
