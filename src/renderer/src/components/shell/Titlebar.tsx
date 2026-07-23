import { useEffect, useState } from 'react'
import { useFarsideStore, useActiveSession, type RailView } from '../../lib/store'
import { CrescentLogo } from '../../design-system/CrescentLogo'
import { usePreferences } from '../../lib/preferences'

/** 标题栏右侧的视图名（sessions 为主视图，不标注）。 */
const VIEW_LABELS: Record<Exclude<RailView, 'sessions'>, string> = {
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

/** 无边框窗口标题栏：左字标 + 项目名，右主题开关 + ─□×。整栏可拖拽。 */
export function Titlebar() {
  const { locale, theme, setTheme, t } = usePreferences()
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
        <button
          type="button"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label={locale === 'en-US' ? 'Toggle light and dark theme' : '切换明亮/暗黑模式'}
          title={locale === 'en-US'
            ? `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`
            : `切换到${theme === 'dark' ? '明亮' : '暗黑'}模式`}
          style={{
            ...NO_DRAG,
            width: 28,
            height: 28,
            marginRight: 7,
            display: 'grid',
            placeItems: 'center',
            border: '1px solid var(--line)',
            borderRadius: 999,
            color: 'var(--dust)',
            background: 'var(--regolith)',
            transition: 'background 150ms var(--ease-farside), color 150ms var(--ease-farside), transform 150ms var(--ease-farside)'
          }}
        >
          {theme === 'dark' ? (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
              <circle cx="8" cy="8" r="3" stroke="currentColor" />
              <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" stroke="currentColor" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path d="M12.8 10.5A5.5 5.5 0 0 1 5.5 3.2 5.5 5.5 0 1 0 12.8 10.5Z" stroke="currentColor" strokeLinejoin="round" />
            </svg>
          )}
        </button>
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
