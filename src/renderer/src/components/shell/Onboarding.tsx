import { useEffect, useRef } from 'react'
import { CrescentLogo } from '../../design-system/CrescentLogo'
import { PrismLine } from '../../design-system/PrismLine'
import { useFarsideStore } from '../../lib/store'
import { AccountSetup } from '../settings/AccountSetup'
import { usePreferences } from '../../lib/preferences'

/**
 * Provider 引导层：仅在“未配置任何链路且用户未选择稍后处理”时展示。
 * 配置不是进入首页的前提——用户可以跳过，稍后在设置中完成。
 */
export function Onboarding() {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
  const authReady = useFarsideStore((state) => state.authReady)
  const onboardingDismissed = useFarsideStore((state) => state.onboardingDismissed)
  const dismissOnboarding = useFarsideStore((state) => state.dismissOnboarding)
  const dialogRef = useRef<HTMLDivElement>(null)
  const visible = authReady === false && !onboardingDismissed

  // Esc 等价"暂不配置"；遮罩出现时把初始焦点交给对话框本体，屏幕阅读器可即时播报。
  useEffect(() => {
    if (!visible) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismissOnboarding()
    }
    document.addEventListener('keydown', onKeyDown)
    const timer = window.setTimeout(() => dialogRef.current?.focus(), 0)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.clearTimeout(timer)
    }
  }, [visible, dismissOnboarding])

  if (!visible) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 90,
        display: 'grid',
        placeItems: 'center',
        overflowY: 'auto',
        background: 'color-mix(in srgb, var(--void) 95%, transparent)',
        padding: 24
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={english ? 'Connect a Kimi provider' : '连接你的 Kimi 链路'}
        tabIndex={-1}
        style={{
          position: 'relative',
          width: 'min(760px, 100%)',
          overflow: 'hidden',
          border: '1px solid var(--line-hi)',
          borderRadius: 12,
          background: 'var(--mare)',
          boxShadow: '0 28px 80px rgba(0,0,0,0.55)',
          outline: 'none'
        }}
      >
        <PrismLine />
        <div style={{ padding: '26px 28px 28px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <CrescentLogo size={24} />
            <span
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 700,
                letterSpacing: '0.22em',
                color: 'var(--moonlight)'
              }}
            >
              FARSIDE
            </span>
            <button
              type="button"
              onClick={dismissOnboarding}
              style={{
                marginLeft: 'auto',
                fontSize: 11.5,
                color: 'var(--dust)',
                border: '1px solid var(--line)',
                borderRadius: 6,
                padding: '5px 11px'
              }}
            >
              {english ? 'Skip for now' : '暂不配置，直接进入'}
            </button>
            <span className="mono" style={{ fontSize: 10, color: 'var(--faint)' }}>
              FIRST CONTACT · 01
            </span>
          </div>
          <h1 style={{ margin: '24px 0 7px', fontSize: 20, fontWeight: 500 }}>
            {english ? 'Connect a Kimi provider' : '连接你的 Kimi 链路'}
          </h1>
          <p style={{ margin: '0 0 18px', fontSize: 12.5, lineHeight: 1.7, color: 'var(--dust)' }}>
            {english
              ? 'Sign in with Kimi OAuth, the Moonshot official API, or an OpenAI-compatible Kimi service. This step is optional — you can also configure it later in Settings.'
              : '可使用 Kimi 会员账户、Moonshot 官方 API，或 OpenAI 格式的第三方 Kimi 服务。此步骤可以跳过，之后随时能在设置中完成。'}
          </p>
          <AccountSetup />
        </div>
      </section>
    </div>
  )
}
