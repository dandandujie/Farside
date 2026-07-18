import { CrescentLogo } from '../../design-system/CrescentLogo'
import { PrismLine } from '../../design-system/PrismLine'
import { useFarsideStore } from '../../lib/store'
import { AccountSetup } from '../settings/AccountSetup'
import { usePreferences } from '../../lib/preferences'

/** 首次启动账户设置：三种 Provider 都在此完成，不强制使用 OAuth。 */
export function Onboarding() {
  const { locale } = usePreferences()
  const authReady = useFarsideStore((state) => state.authReady)

  if (authReady !== false) return null

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
        style={{
          position: 'relative',
          width: 'min(760px, 100%)',
          overflow: 'hidden',
          border: '1px solid var(--line-hi)',
          borderRadius: 12,
          background: 'var(--mare)',
          boxShadow: '0 28px 80px rgba(0,0,0,0.55)'
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
            <span className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--faint)' }}>
              FIRST CONTACT · 01
            </span>
          </div>
          <h1 style={{ margin: '24px 0 7px', fontSize: 20, fontWeight: 500 }}>
            {locale === 'en-US' ? 'Choose your Kimi connection' : '选择你的 Kimi 链路'}
          </h1>
          <p style={{ margin: '0 0 18px', fontSize: 12.5, lineHeight: 1.7, color: 'var(--dust)' }}>
            {locale === 'en-US' ? 'Connect with Kimi OAuth, the Moonshot official API, or an OpenAI-compatible Kimi service. You can switch later in Settings.' : '可使用 Kimi 会员账户、Moonshot 官方 API，或 OpenAI 格式的第三方 Kimi 服务。之后仍可在设置中切换。'}
          </p>
          <AccountSetup />
        </div>
      </section>
    </div>
  )
}
