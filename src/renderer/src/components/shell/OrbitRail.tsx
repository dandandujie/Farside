import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useFarsideStore, useActiveSession, type RailView } from '../../lib/store'
import { FuelGauge } from '../../design-system/FuelGauge'
import { PrismLine } from '../../design-system/PrismLine'
import { CrescentLogo } from '../../design-system/CrescentLogo'
import { usePreferences } from '../../lib/preferences'

interface RailItem {
  view: RailView
  label: string
  icon: ReactNode
}

const STROKE = 'currentColor'

const ITEMS: RailItem[] = [
  {
    view: 'sessions',
    label: '会话',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <circle cx="9" cy="9" r="6.5" stroke={STROKE} strokeWidth="1" />
        <circle cx="9" cy="9" r="1.4" fill={STROKE} />
        <circle cx="13.5" cy="4.5" r="1.1" fill={STROKE} />
      </svg>
    )
  },
  {
    view: 'goals',
    label: '目标',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <circle cx="9" cy="9" r="6.5" stroke={STROKE} strokeWidth="1" />
        <circle cx="9" cy="9" r="3" stroke={STROKE} strokeWidth="1" />
        <circle cx="9" cy="9" r="0.9" fill={STROKE} />
      </svg>
    )
  },
  {
    view: 'settings',
    label: '设置',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <circle cx="9" cy="9" r="2.6" stroke={STROKE} strokeWidth="1" />
        <path
          d="M9 1.8v2.4M9 13.8v2.4M1.8 9h2.4M13.8 9h2.4M3.9 3.9l1.7 1.7M12.4 12.4l1.7 1.7M14.1 3.9l-1.7 1.7M5.6 12.4l-1.7 1.7"
          stroke={STROKE}
          strokeWidth="1"
          strokeLinecap="round"
        />
      </svg>
    )
  }
]

/** 左侧 56px 竖排导航：会话 / 终端 / 目标 / 设置；底部迷你燃料环 + 模型名。 */
export function OrbitRail() {
  const { t, locale } = usePreferences()
  const view = useFarsideStore((s) => s.view)
  const setView = useFarsideStore((s) => s.setView)
  const active = useActiveSession()
  const account = useFarsideStore((s) => s.account)
  const refreshAccount = useFarsideStore((s) => s.refreshAccount)
  const logoutAccount = useFarsideStore((s) => s.logoutAccount)
  const checkUpdates = useFarsideStore((s) => s.checkUpdates)
  const updateNotice = useFarsideStore((s) => s.updateNotice)
  const clearUpdateNotice = useFarsideStore((s) => s.clearUpdateNotice)
  const [accountOpen, setAccountOpen] = useState(false)
  const [updateChecking, setUpdateChecking] = useState(false)
  const accountPopoverRef = useRef<HTMLDivElement>(null)
  const provider = account?.providers.find((item) => item.active)
  const usage = account?.usage

  useEffect(() => {
    if (!accountOpen) return
    const closeOutside = (event: PointerEvent) => {
      if (!accountPopoverRef.current?.contains(event.target as Node)) setAccountOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAccountOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [accountOpen])

  const resetLabel = (resetAt?: string): string => {
    if (!resetAt || Number.isNaN(new Date(resetAt).getTime())) return t('重置时间未知')
    return new Date(resetAt).toLocaleString(locale, {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
    })
  }

  return (
    <nav
      style={{
        width: 56,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        background: 'var(--void)',
        borderRight: '1px solid var(--line)',
        paddingTop: 10,
        paddingBottom: 10
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {ITEMS.map((item) => {
          const activeItem = view === item.view
          return (
            <button
              key={item.view}
              onClick={() => setView(item.view)}
              aria-label={t(item.label)}
              title={t(item.label)}
              style={{
                position: 'relative',
                width: 40,
                height: 40,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 10,
                color: activeItem ? 'var(--moonlight)' : 'var(--faint)',
                background: activeItem ? 'var(--regolith)' : 'transparent',
                transition: 'background 150ms var(--ease-farside), color 150ms var(--ease-farside)'
              }}
            >
              {activeItem ? (
                <div style={{ position: 'absolute', left: -8, top: 10, bottom: 10 }}>
                  <PrismLine direction="vertical" />
                </div>
              ) : null}
              {item.icon}
            </button>
          )
        })}
      </div>

      <div style={{ flex: 1 }} />

      {active ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, marginBottom: 8 }}>
          <FuelGauge used={active.contextTokens} size={34} strokeWidth={2.5} showLabel={false} />
          <span
            className="mono"
            style={{
              fontSize: 9,
              color: 'var(--faint)',
              letterSpacing: '0.04em',
              writingMode: 'vertical-rl',
              maxHeight: 92,
              overflow: 'hidden'
            }}
          >
            {active.model}
          </span>
        </div>
      ) : null}
      <div ref={accountPopoverRef} style={{ position: 'relative' }}>
        <button
          onClick={() => {
            setAccountOpen((value) => {
              if (!value) clearUpdateNotice()
              return !value
            })
          }}
          aria-label={t('账户')}
          title={t('账户与用量')}
          style={{
            width: 36,
            height: 36,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 999,
            border: `1px solid ${account?.configured ? 'var(--line-hi)' : 'var(--line)'}`,
            background: 'var(--regolith)',
            color: account?.configured ? 'var(--moonlight)' : 'var(--faint)'
          }}
        >
          <CrescentLogo size={19} />
        </button>
        {accountOpen ? (
          <div
            style={{
              position: 'absolute',
              zIndex: 100,
              left: 45,
              bottom: 0,
              width: 286,
              padding: 14,
              border: '1px solid var(--line-hi)',
              borderRadius: 11,
              background: 'var(--regolith)',
              boxShadow: '0 18px 54px rgba(0,0,0,.45)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 34, height: 34, borderRadius: 999, display: 'grid', placeItems: 'center', border: '1px solid var(--line)', background: 'var(--mare)' }}><CrescentLogo size={18} /></div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, color: 'var(--moonlight)' }}>{usage?.planLabel ?? provider?.label ?? t('尚未登录')}</div>
                <div className="mono" style={{ marginTop: 2, fontSize: 10.5, color: 'var(--faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{account?.activeModel ?? t('选择 Provider 以连接 Kimi')}</div>
              </div>
            </div>
            {usage?.fiveHour || usage?.weekly ? (
              <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
                {[
                  ['5 小时', usage.fiveHour],
                  ['周限额', usage.weekly]
                ].map(([label, window]) => window && typeof window === 'object' ? (
                  <div key={String(label)}>
                    <div style={{ display: 'flex', fontSize: 10.5, color: 'var(--faint)' }}><span>{t(String(label))}</span><span className="mono" style={{ marginLeft: 'auto', color: 'var(--dust)' }}>{t('剩余')} {Math.round(window.remainingPct)}%</span></div>
                    <div style={{ height: 3, marginTop: 5, borderRadius: 99, background: 'var(--line)' }}><div style={{ width: `${window.usedPct}%`, height: '100%', borderRadius: 99, background: 'var(--moonlight)' }} /></div>
                    <div className="mono" style={{ marginTop: 4, fontSize: 9.5, color: 'var(--ghost)' }}>
                      {locale === 'en-US' ? 'Resets' : '额度刷新'} · {resetLabel(window.resetAt)}
                    </div>
                  </div>
                ) : null)}
              </div>
            ) : null}
            {usage?.updatedAt ? (
              <div className="mono" style={{ marginTop: 9, fontSize: 9.5, color: 'var(--ghost)' }}>
                {locale === 'en-US' ? 'Usage updated' : '数据更新'} · {new Date(usage.updatedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
              </div>
            ) : null}
            <div style={{ display: 'flex', gap: 8, marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
              <button onClick={() => { setView('settings'); setAccountOpen(false) }} style={{ fontSize: 11.5, color: 'var(--dust)' }}>{t('账户设置')}</button>
              <button
                disabled={updateChecking}
                onClick={() => {
                  setUpdateChecking(true)
                  void checkUpdates(true)
                    .then(() => {
                      // 有更新时收起账户弹窗，让更新弹窗完整露出
                      if (useFarsideStore.getState().updateInfo) setAccountOpen(false)
                    })
                    .finally(() => setUpdateChecking(false))
                }}
                style={{ fontSize: 11.5, color: updateChecking ? 'var(--ghost)' : 'var(--dust)' }}
              >
                {updateChecking ? t('检查中…') : t('检查更新')}
              </button>
              {account?.configured ? <button onClick={() => void refreshAccount()} style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--dust)' }}>{t('刷新')}</button> : null}
              {account?.configured ? <button onClick={() => { void logoutAccount(); setAccountOpen(false) }} style={{ fontSize: 11.5, color: 'var(--redshift)' }}>{t('退出')}</button> : null}
            </div>
            {updateNotice ? (
              <div style={{ marginTop: 8, fontSize: 10.5, color: updateNotice.kind === 'latest' ? 'var(--signal)' : 'var(--redshift)' }}>
                {updateNotice.kind === 'latest'
                  ? (locale === 'en-US' ? `Already on the latest version v${updateNotice.version}` : `当前已是最新版本 v${updateNotice.version}`)
                  : t('检查更新失败，请稍后再试。')}
              </div>
            ) : null}
            {provider?.kind === 'kimi-oauth' ? <a href="https://www.kimi.com/membership/pricing?from=farside" target="_blank" rel="noreferrer" style={{ display: 'block', marginTop: 10, fontSize: 10.5, color: 'var(--faint)' }}>查看官方套餐与升级 ↗</a> : null}
          </div>
        ) : null}
      </div>
    </nav>
  )
}
