import { useEffect, useRef, useState } from 'react'
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
 * 地面站终端：xterm.js + FitAddon，经 pty:* IPC 与主进程的 shell 对话。
 * PTY 不可用（node-pty 缺失且管道降级也失败）时显示占位与重试，不影响其余界面。
 */
export function TerminalView() {
  const { locale, theme } = usePreferences()
  const containerRef = useRef<HTMLDivElement>(null)
  const ptyIdRef = useRef<string | null>(null)
  const session = useActiveSession()
  const cwd = session?.cwd
  const [link, setLink] = useState<LinkState>('connecting')
  const [shellName, setShellName] = useState('bash')
  /** 重试计数：递增触发 effect 重建链路 */
  const [attempt, setAttempt] = useState(0)
  const [retryHover, setRetryHover] = useState(false)
  const pendingCommand = useFarsideStore((state) => state.pendingTerminalCommand)
  const consumeTerminalCommand = useFarsideStore((state) => state.consumeTerminalCommand)

  useEffect(() => {
    const container = containerRef.current
    const api = window.api
    if (!container || !api) {
      setLink('failed') // 浏览器调试模式：preload 未注入
      return
    }

    let disposed = false
    let ptyId: string | undefined
    let unsubscribe: (() => void) | undefined

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

    // 键盘输入 → shell
    term.onData((data) => {
      if (ptyId) void api.pty.write(ptyId, data)
    })

    // 容器尺寸变化 → 重排 + 同步 PTY 窗口大小（管道后端为空操作）
    const observer = new ResizeObserver(() => {
      safeFit()
      if (ptyId) void api.pty.resize(ptyId, term.cols, term.rows)
    })
    observer.observe(container)

    setLink('connecting')
    void api.pty
      .create(cwd)
      .then((result) => {
        if (disposed) {
          // effect 已清理（如 StrictMode 双挂载），补杀这个孤儿终端
          if (result.ok) void api.pty.kill(result.id)
          return
        }
        if (!result.ok) {
          setLink('failed')
          return
        }
        ptyId = result.id
        ptyIdRef.current = result.id
        setShellName(shellBaseName(result.shell))
        unsubscribe = api.pty.onData(result.id, (data) => {
          if (!disposed) term.write(data)
        })
        setLink('ready')
        safeFit()
        void api.pty.resize(result.id, term.cols, term.rows)
        term.focus()
      })
      .catch(() => {
        if (!disposed) setLink('failed')
      })

    return () => {
      disposed = true
      observer.disconnect()
      unsubscribe?.()
      if (ptyId) void api.pty.kill(ptyId)
      ptyIdRef.current = null
      term.dispose()
    }
  }, [attempt, cwd, theme])

  useEffect(() => {
    if (link !== 'ready' || !pendingCommand || !ptyIdRef.current || !window.api) return
    const command = pendingCommand.command.replace(/\r?\n/g, '\r')
    void window.api.pty.write(ptyIdRef.current, `${command}\r`)
    consumeTerminalCommand(pendingCommand.id)
  }, [consumeTerminalCommand, link, pendingCommand])

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
        {locale === 'en-US' ? 'TERMINAL' : '地面站终端'} · {shellName}
      </div>

      <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
        <div
          ref={containerRef}
          style={{ height: '100%', padding: '8px 0 0 12px', boxSizing: 'border-box' }}
        />

        {/* 链路未建立：占位 + 重试（覆盖在终端之上） */}
        {link === 'failed' ? (
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
              onClick={() => {
                setLink('connecting')
                setAttempt((n) => n + 1)
              }}
              onMouseEnter={() => setRetryHover(true)}
              onMouseLeave={() => setRetryHover(false)}
              style={{
                fontSize: 12.5,
                letterSpacing: '0.02em',
                padding: '5px 14px',
                color: 'var(--moonlight)',
                background: retryHover ? 'var(--crater)' : 'var(--regolith)',
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
