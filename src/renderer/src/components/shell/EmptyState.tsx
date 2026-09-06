import { Starfield } from '../../design-system/Starfield'
import { MoonPhase } from '../../design-system/MoonPhase'
import type { MoonPhase as MoonPhaseValue } from '@shared/types'
import { PHASE_STATUS } from '../../lib/phaseLabels'
import { useFarsideStore } from '../../lib/store'
import { usePreferences } from '../../lib/preferences'

/** 月相图例：词表来自 lib/phaseLabels，作为月相语言的首次教学。 */
const PHASE_LEGEND: Array<{ phase: MoonPhaseValue }> = Object.keys(PHASE_STATUS)
  .map((phase) => ({ phase: phase as MoonPhaseValue }))

const EXAMPLE_PROMPTS: Array<{ zh: string; en: string }> = [
  {
    zh: '阅读这个项目的 README，总结项目结构并指出过时的内容。',
    en: "Read this project's README, summarize its structure, and flag outdated content."
  },
  {
    zh: '运行当前仓库的测试，修复失败项并解释原因。',
    en: 'Run the tests in this repo, fix the failures, and explain why they broke.'
  },
  {
    zh: '梳理本项目依赖，把有安全告警的升级到兼容的最新版本。',
    en: "Review this project's dependencies and upgrade the vulnerable ones to compatible latest versions."
  }
]

/** 无会话时的空状态：一道月弧 + 低密度星点 + 一句静候。 */
export function EmptyState() {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
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
            onClick={() => primary.action()}
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
              onClick={() => newSession()}
              style={{
                padding: '6px 12px',
                border: '1px solid var(--line)',
                borderRadius: 6,
                color: 'var(--faint)',
                background: 'transparent',
                fontSize: 12
              }}
            >
              {english ? 'New session' : '新建会话'}
            </button>
          ) : null}
        </div>
      ) : null}
      {initialized && !lastError ? (
        <div
          className="mono"
          style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center', opacity: 0.85 }}
        >
          {PHASE_LEGEND.map((item) => (
            <span key={item.phase} style={{ display: 'inline-flex', gap: 5, alignItems: 'center', fontSize: 10.5, color: 'var(--faint)' }}>
              <MoonPhase phase={item.phase} size={12} title={english ? PHASE_STATUS[item.phase].en : PHASE_STATUS[item.phase].zh} />
              {english ? PHASE_STATUS[item.phase].en : PHASE_STATUS[item.phase].zh}
            </span>
          ))}
        </div>
      ) : null}
      {initialized && !lastError ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, alignItems: 'center', maxWidth: 560 }}>
          {EXAMPLE_PROMPTS.map((example) => (
            <button
              key={example.zh}
              onClick={() => newSession(english ? example.en : example.zh)}
              style={{
                maxWidth: '100%',
                padding: '6px 13px',
                border: '1px solid var(--line)',
                borderRadius: 999,
                color: 'var(--dust)',
                background: 'color-mix(in srgb, var(--regolith) 55%, transparent)',
                fontSize: 12,
                textAlign: 'center'
              }}
            >
              {english ? example.en : example.zh}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
