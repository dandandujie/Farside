import type { Session } from '@shared/types'
import { MODELS } from '@shared/types'
import { useFarsideStore } from '../../lib/store'
import { usePreferences } from '../../lib/preferences'
import { EnvironmentSummary } from './EnvironmentSummary'

/** cwd 缩短：命中 home 前缀换成 ~，否则只保留末两段路径。 */
function shortenCwd(cwd: string): string {
  const norm = cwd.replace(/\\/g, '/')
  const home = /^(?:[A-Za-z]:)?\/(?:Users|home)\/[^/]+(\/.*)?$/.exec(norm)
  if (home) return `~${home[1] ?? ''}`
  const segs = norm.split('/').filter(Boolean)
  return segs.slice(-2).join('/')
}

/** SessionHeader：会话标题 + 模型 label + 缩短后的 cwd。 */
export function SessionHeader({ session }: { session: Session }) {
  const model = MODELS.find((m) => m.id === session.model)
  const { locale } = usePreferences()
  const missionOpen = useFarsideStore((state) => state.missionOpen)
  const toggleMission = useFarsideStore((state) => state.toggleMission)
  const terminalOpen = useFarsideStore((state) => state.terminalOpen)
  const toggleTerminal = useFarsideStore((state) => state.toggleTerminal)
  const panelLabel = locale === 'en-US'
    ? `${missionOpen ? 'Hide' : 'Show'} mission panel`
    : `${missionOpen ? '收起' : '展开'}右侧边栏`
  const terminalLabel = locale === 'en-US'
    ? `${terminalOpen ? 'Hide' : 'Show'} terminal`
    : `${terminalOpen ? '收起' : '展开'}终端`

  return (
    <div
      style={{
        flexShrink: 0,
        padding: '14px 24px 12px',
        borderBottom: '1px solid var(--line)',
        display: 'flex',
        alignItems: 'baseline',
        gap: 12
      }}
    >
      <h1
        style={{
          margin: 0,
          fontSize: 16,
          fontWeight: 500,
          color: 'var(--moonlight)',
          letterSpacing: '0.01em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0
        }}
      >
        {session.title}
      </h1>
      <span className="mono" style={{ fontSize: 11, color: 'var(--faint)', flexShrink: 0 }}>
        {model?.label ?? session.model}
      </span>
      <span style={{ flex: 1 }} />
      <span
        className="mono"
        title={session.cwd}
        style={{ fontSize: 11, color: 'var(--ghost)', flexShrink: 0, letterSpacing: '0.02em' }}
      >
        {shortenCwd(session.cwd)}
      </span>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          margin: '-6px -10px -6px 0',
          flexShrink: 0
        }}
      >
        <EnvironmentSummary session={session} />
        <button
          type="button"
          onClick={toggleTerminal}
          aria-label={terminalLabel}
          aria-pressed={terminalOpen}
          title={terminalLabel}
          style={{
            width: 28,
            height: 28,
            display: 'grid',
            placeItems: 'center',
            border: `1px solid ${terminalOpen ? 'var(--line-hi)' : 'transparent'}`,
            borderRadius: 6,
            background: terminalOpen ? 'var(--regolith)' : 'transparent',
            color: terminalOpen ? 'var(--moonlight)' : 'var(--faint)',
            transition: 'background 150ms var(--ease-farside), border-color 150ms var(--ease-farside), color 150ms var(--ease-farside)'
          }}
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
            <rect x="1.5" y="2" width="12" height="11" rx="1.5" stroke="currentColor" />
            <path d="m4 5 2.25 2L4 9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M7.7 9h3.1" stroke="currentColor" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          onClick={toggleMission}
          aria-label={panelLabel}
          aria-pressed={missionOpen}
          title={`${panelLabel} · Ctrl/⌘+J`}
          style={{
            width: 28,
            height: 28,
            display: 'grid',
            placeItems: 'center',
            border: `1px solid ${missionOpen ? 'var(--line-hi)' : 'transparent'}`,
            borderRadius: 6,
            background: missionOpen ? 'var(--regolith)' : 'transparent',
            color: missionOpen ? 'var(--moonlight)' : 'var(--faint)',
            transition: 'background 150ms var(--ease-farside), border-color 150ms var(--ease-farside), color 150ms var(--ease-farside)'
          }}
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
            <rect x="1.5" y="2" width="12" height="11" rx="1.5" stroke="currentColor" />
            <path d="M9.5 2.5v10" stroke="currentColor" />
            <path d={missionOpen ? 'm7.4 5.3-2.2 2.2 2.2 2.2' : 'm6.1 5.3 2.2 2.2-2.2 2.2'} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}
