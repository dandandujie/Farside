import { Starfield } from '../../design-system/Starfield'
import { useFarsideStore } from '../../lib/store'
import { usePreferences } from '../../lib/preferences'

/** 无会话时的空状态：一道月弧 + 低密度星点 + 一句静候。 */
export function EmptyState() {
  const { locale } = usePreferences()
  const initialized = useFarsideStore((state) => state.initialized)
  const lastError = useFarsideStore((state) => state.lastError)
  const initialize = useFarsideStore((state) => state.initialize)
  const newSession = useFarsideStore((state) => state.newSession)
  const missingCli = /CLI 未安装|not found|ENOENT|未检测到 kimi/i.test(lastError ?? '')

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
        style={{ fontSize: 11, color: 'var(--faint)', letterSpacing: '0.16em', textTransform: 'uppercase' }}
      >
        {lastError ? lastError : 'FARSIDE · Kimi Code Desktop'}
      </div>
      {initialized ? (
        <button
          onClick={() =>
            missingCli
              ? window.open('https://moonshotai.github.io/kimi-code/zh/guides/getting-started.html', '_blank', 'noopener')
              : lastError
                ? void initialize()
                : newSession()
          }
          style={{
            padding: '6px 12px',
            border: '1px solid var(--line-hi)',
            borderRadius: 6,
            color: 'var(--dust)',
            background: 'var(--regolith)',
            fontSize: 12
          }}
        >
          {missingCli ? (locale === 'en-US' ? 'View runtime guide' : '查看安装指引') : lastError ? (locale === 'en-US' ? 'Reconnect' : '重新建立链路') : (locale === 'en-US' ? 'Create task trajectory' : '新建任务轨道')}
        </button>
      ) : null}
    </div>
  )
}
