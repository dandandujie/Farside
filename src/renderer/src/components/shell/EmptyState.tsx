import { Starfield } from '../../design-system/Starfield'
import { useFarsideStore } from '../../lib/store'
import { usePreferences } from '../../lib/preferences'

/** 无会话时的空状态：一道月弧 + 低密度星点 + 一句静候。 */
export function EmptyState() {
  const { locale } = usePreferences()
  const initialized = useFarsideStore((state) => state.initialized)
  const lastError = useFarsideStore((state) => state.lastError)
  const authReady = useFarsideStore((state) => state.authReady)
  const onboardingDismissed = useFarsideStore((state) => state.onboardingDismissed)
  const initialize = useFarsideStore((state) => state.initialize)
  const newSession = useFarsideStore((state) => state.newSession)
  const reopenOnboarding = useFarsideStore((state) => state.reopenOnboarding)
  const missingCli = /CLI 未安装|not found|ENOENT|未检测到 kimi/i.test(lastError ?? '')
  const unconfigured = authReady === false

  const primary = unconfigured && !onboardingDismissed
    ? { label: locale === 'en-US' ? 'Connect a Kimi provider' : '连接 Kimi 链路', action: reopenOnboarding }
    : missingCli
      ? {
          label: locale === 'en-US' ? 'View runtime guide' : '查看安装指引',
          action: () => window.open('https://moonshotai.github.io/kimi-code/zh/guides/getting-started.html', '_blank', 'noopener')
        }
      : lastError
        ? { label: locale === 'en-US' ? 'Reconnect' : '重新建立链路', action: () => void initialize() }
        : { label: locale === 'en-US' ? 'Create task trajectory' : '新建任务轨道', action: newSession }

  return (
    <div
      style={{
        position: 'relative',
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 18,
        background: 'var(--void)',
        overflow: 'hidden'
      }}
    >
      <Starfield count={46} />
      <svg width="72" height="72" viewBox="0 0 72 72" aria-hidden style={{ opacity: 0.85 }}>
        <path
          d="M 52 10 A 30 30 0 1 0 52 62 A 24 30 0 0 1 52 10 Z"
          fill="none"
          stroke="var(--line-hi)"
          strokeWidth="1.2"
        />
      </svg>
      <div
        style={{
          fontFamily: 'var(--font-poetic)',
          fontSize: 28,
          color: 'var(--dust)',
          letterSpacing: '0.08em'
        }}
      >
        {!initialized ? (locale === 'en-US' ? 'Establishing link.' : '正在建立链路。') : lastError ? (locale === 'en-US' ? 'Signal lost.' : '信号丢失。') : (locale === 'en-US' ? 'The farside awaits.' : '月背静候。')}
      </div>
      <div
        className="mono"
        style={{ fontSize: 11, color: 'var(--faint)', letterSpacing: '0.16em', textTransform: 'uppercase', maxWidth: '80%', textAlign: 'center' }}
      >
        {lastError ? lastError : unconfigured ? (locale === 'en-US' ? 'NO PROVIDER CONFIGURED · OPTIONAL' : '尚未配置 Kimi 链路 · 可稍后在设置中完成') : 'FARSIDE · Kimi Code Desktop'}
      </div>
      {initialized ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button
            onClick={primary.action}
            style={{
              padding: '6px 12px',
              border: '1px solid var(--line-hi)',
              borderRadius: 6,
              color: 'var(--dust)',
              background: 'var(--regolith)',
              fontSize: 12
            }}
          >
            {primary.label}
          </button>
          {/* 配置或错误不应吞掉“新建会话”这个主路径 */}
          {initialized && (primary.action !== newSession) ? (
            <button
              onClick={newSession}
              style={{
                padding: '6px 12px',
                border: '1px solid var(--line)',
                borderRadius: 6,
                color: 'var(--faint)',
                background: 'transparent',
                fontSize: 12
              }}
            >
              {locale === 'en-US' ? 'New session' : '新建会话'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
