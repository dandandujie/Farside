import { useEffect, useState } from 'react'
import { useFarsideStore, useActiveSession, type RailView } from '../../lib/store'
import { CrescentLogo } from '../../design-system/CrescentLogo'
import { MoonPhase } from '../../design-system/MoonPhase'
import { usePreferences } from '../../lib/preferences'

/** 标题栏右侧的视图名（sessions 为主视图，不标注）。 */
const VIEW_LABELS: Record<Exclude<RailView, 'sessions'>, string> = {
  terminal: '终端',
  goals: '目标',
  settings: '设置'
}

const DRAG: React.CSSProperties = { WebkitAppRegion: 'drag' } as React.CSSProperties
const NO_DRAG: React.CSSProperties = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

function WindowButton({
  onClick,
  label,
  close,
  children
}: {
  onClick(): void
  label: string
  close?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      style={{
        ...NO_DRAG,
        width: 42,
        height: 36,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--dust)',
        transition: 'background 150ms var(--ease-farside), color 150ms var(--ease-farside)'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = close ? 'var(--redshift)' : 'var(--crater)'
        e.currentTarget.style.color = 'var(--moonlight)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.color = 'var(--dust)'
      }}
    >
      {children}
    </button>
  )
}

/** 无边框窗口标题栏：左字标 + 项目名，右月相 + ─□×。整栏可拖拽。 */
export function Titlebar() {
  const { locale, t } = usePreferences()
  const active = useActiveSession()
  const view = useFarsideStore((s) => s.view)
  const [isMac, setIsMac] = useState(false)

  useEffect(() => {
    void window.api?.getAppInfo().then((info) => setIsMac(info.platform === 'darwin'))
  }, [])

  return (
    <header
      style={{
        ...DRAG,
        height: 36,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: 'var(--void)',
        borderBottom: '1px solid var(--line)',
        // macOS hiddenInset 的红绿灯占左侧约 78px，内容右移避让
        paddingLeft: isMac ? 82 : 12
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <CrescentLogo size={15} />
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 700,
            fontSize: 12.5,
            letterSpacing: '0.24em',
            color: 'var(--moonlight)'
          }}
        >
          FARSIDE
        </span>
        {active ? (
          <span
            style={{
              fontSize: 12.5,
              color: 'var(--faint)',
              letterSpacing: '0.01em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            · {active.project}
            {view !== 'sessions' ? ` / ${t(VIEW_LABELS[view])}` : ''}
          </span>
        ) : null}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
        {active ? (
          <div style={{ ...NO_DRAG, marginRight: 8, display: 'flex', alignItems: 'center' }}>
            <MoonPhase phase={active.phase} size={15} title={locale === 'en-US' ? `Current status: ${active.phase}` : `当前状态：${active.phase}`} />
          </div>
        ) : null}
        <WindowButton label={t('最小化')} onClick={() => void window.api?.window.minimize()}>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1" />
          </svg>
        </WindowButton>
        <WindowButton label={t('最大化')} onClick={() => void window.api?.window.toggleMaximize()}>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
          </svg>
        </WindowButton>
        <WindowButton label={t('关闭')} close onClick={() => void window.api?.window.close()}>
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1" />
            <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </WindowButton>
      </div>
    </header>
  )
}
