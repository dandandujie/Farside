import { useEffect, useState } from 'react'
import { useActiveSession } from '../../lib/store'
import { SectionLabel } from '../../design-system/SectionLabel'
import type { AppInfo, CliStatus, McpServerInfo } from '@shared/ipc'
import { useFarsideStore } from '../../lib/store'
import { usePreferences } from '../../lib/preferences'

const PLATFORM_LABEL: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux'
}

function EnvRow({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', gap: 12, fontSize: 12.5 }}>
      <span
        className="mono"
        style={{ width: 56, flexShrink: 0, color: 'var(--faint)', letterSpacing: '0.04em' }}
      >
        {k}
      </span>
      <span className="mono selectable" style={{ color: 'var(--dust)', wordBreak: 'break-all' }}>
        {v}
      </span>
    </div>
  )
}

/** 环境 tab：动态探测 CLI / AppInfo（链路未建立时占位），静态展示 cwd / shell / MCP。 */
export function EnvTab() {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
  const active = useActiveSession()
  const [cli, setCli] = useState<CliStatus | null>(null)
  const [app, setApp] = useState<AppInfo | null>(null)
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([])
  const connected = useFarsideStore((state) => state.connected)
  /** true = preload 未注入或探测失败 */
  const [linkDown, setLinkDown] = useState(false)

  useEffect(() => {
    if (!window.api) {
      setLinkDown(true)
      return
    }
    let cancelled = false
    Promise.all([
      window.api.detectCli(),
      window.api.getAppInfo(),
      window.api.agent.listMcpServers()
    ])
      .then(([cliStatus, appInfo, mcp]) => {
        if (cancelled) return
        setCli(cliStatus)
        setApp(appInfo)
        if (mcp.ok) setMcpServers(mcp.servers)
      })
      .catch(() => {
        if (!cancelled) setLinkDown(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const cliText = linkDown
    ? (english ? 'Unavailable' : '链路未建立')
    : cli === null
      ? (english ? 'Connecting…' : '正在建立链路…')
      : cli.installed
        ? (cli.version ?? 'kimi')
        : (english ? 'Kimi Code runtime not detected' : '未检测到 kimi CLI')
  const loginText = linkDown
    ? (english ? 'Unavailable' : '链路未建立')
    : cli === null
      ? '…'
      : cli.loggedIn === true
        ? (english ? 'Signed in' : '已登录')
        : cli.loggedIn === false
          ? (english ? 'Signed out' : '未登录')
          : (english ? 'Unknown' : '登录态未知')

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <SectionLabel>{english ? 'ENVIRONMENT' : '环境'}</SectionLabel>
      <EnvRow k="cwd" v={active?.cwd ?? '—'} />
      <EnvRow k="shell" v="Git Bash" />
      <EnvRow k="CLI" v={cliText} />
      <EnvRow k={english ? 'login' : '登录态'} v={loginText} />
      <EnvRow k="Agent" v={connected ? (english ? 'Event link connected' : '事件链路已建立') : (english ? 'Event link disconnected' : '事件链路未建立')} />
      <EnvRow
        k="Electron"
        v={linkDown ? (english ? 'Unavailable' : '链路未建立') : app === null ? '…' : `v${app.electronVersion} · Farside v${app.appVersion}`}
      />
      <EnvRow
        k={english ? 'platform' : '平台'}
        v={
          linkDown
            ? (english ? 'Unavailable' : '链路未建立')
            : app === null
              ? '…'
              : `${PLATFORM_LABEL[app.platform] ?? app.platform} · ${app.arch}`
        }
      />

      <div
        style={{
          borderTop: '1px solid var(--line)',
          paddingTop: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 10
        }}
      >
        <SectionLabel>{english ? 'MCP SERVERS' : 'MCP 服务器'}</SectionLabel>
        {mcpServers.map((s) => (
          <div
            key={s.name}
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}
          >
            <span className="mono" style={{ fontSize: 12.5, color: 'var(--dust)' }}>
              {s.name}
            </span>
            <span
              className="mono"
              style={{
                fontSize: 11,
                color: /连接|运行|ready|connected/i.test(s.status)
                  ? 'var(--signal)'
                  : 'var(--faint)'
              }}
            >
              {s.status}
            </span>
          </div>
        ))}
        {mcpServers.length === 0 ? (
          <span className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>
            {english ? 'No MCP Servers configured' : '未配置 MCP 服务器'}
          </span>
        ) : null}
      </div>
    </div>
  )
}
