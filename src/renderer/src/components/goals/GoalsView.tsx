import { useEffect, useState } from 'react'
import type { GoalStatus, MoonPhase as Phase } from '@shared/types'
import { useFarsideStore } from '../../lib/store'
import { SectionLabel } from '../../design-system/SectionLabel'
import { MoonPhase } from '../../design-system/MoonPhase'
import { usePreferences } from '../../lib/preferences'

// 目标状态沿用月相语言：进行中 = 盈凸（执行），已暂停 = 朔（静止），受阻 = 满月（需要人）
const STATUS_LABEL: Record<GoalStatus, string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '受阻'
}
const STATUS_PHASE: Record<GoalStatus, Phase> = {
  active: 'gibbous',
  paused: 'new',
  blocked: 'full'
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 已运行时间：不足 1 小时显示 mm:ss，否则 h:mm:ss。 */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`
}

/** 每秒跳一次表；仅在目标进行中走时。 */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [ticking])
  return now
}

/** 操作按钮：hairline 边框 + 文字档；danger 用 redshift（红移）。 */
function ActionButton({
  children,
  onClick,
  danger
}: {
  children: string
  onClick(): void
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '5px 12px',
        fontSize: 12.5,
        color: danger ? 'var(--redshift)' : 'var(--dust)',
        border: `1px solid ${danger ? 'var(--redshift)' : 'var(--line)'}`,
        borderRadius: 6,
        opacity: danger ? 0.85 : 1,
        transition:
          'color 150ms var(--ease-farside), border-color 150ms var(--ease-farside), opacity 150ms var(--ease-farside)'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.opacity = '1'
        if (!danger) {
          e.currentTarget.style.color = 'var(--moonlight)'
          e.currentTarget.style.borderColor = 'var(--line-hi)'
        }
      }}
      onMouseLeave={(e) => {
        if (!danger) {
          e.currentTarget.style.color = 'var(--dust)'
          e.currentTarget.style.borderColor = 'var(--line)'
        } else {
          e.currentTarget.style.opacity = '0.85'
        }
      }}
    >
      {children}
    </button>
  )
}

/** 目标视图：当前目标来自 Kimi Server goal 快照。 */
export function GoalsView() {
  const { locale, t } = usePreferences()
  const english = locale === 'en-US'
  const goal = useFarsideStore((s) => s.goal)
  const pauseGoal = useFarsideStore((s) => s.pauseGoal)
  const resumeGoal = useFarsideStore((s) => s.resumeGoal)
  const cancelGoal = useFarsideStore((s) => s.cancelGoal)

  const now = useNow(goal?.status === 'active')

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 28, background: 'var(--void)' }}>
      <div style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 500, color: 'var(--moonlight)' }}>
            {t('目标')}
          </h1>
          <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--faint)' }}>
            {english ? '/goal autonomous mode: the Agent continues toward the objective until you stop it.' : '/goal 自主目标模式：探测器按既定目标持续运行，直到地面站叫停。'}
          </p>
        </div>

        <section>
          <SectionLabel>{english ? 'Current goal' : '当前目标'}</SectionLabel>
          {goal ? (
            <div
              style={{
                marginTop: 10,
                padding: '14px 16px',
                background: 'var(--regolith)',
                border: '1px solid var(--line)',
                borderRadius: 10,
                display: 'flex',
                flexDirection: 'column',
                gap: 12
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <MoonPhase phase={STATUS_PHASE[goal.status]} size={14} />
                <span style={{ fontSize: 12, color: 'var(--dust)', letterSpacing: '0.08em' }}>
                  {english ? ({ active: 'Active', paused: 'Paused', blocked: 'Blocked' } as Record<GoalStatus, string>)[goal.status] : STATUS_LABEL[goal.status]}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: 14, lineHeight: 1.65, color: 'var(--moonlight)' }}>
                {goal.objective}
              </p>
              {goal.status === 'blocked' && goal.blockedReason ? (
                <p style={{ margin: 0, fontSize: 12.5, color: 'var(--flare)' }}>
                  {english ? 'Blocked: ' : '受阻原因：'}{goal.blockedReason}
                </p>
              ) : null}
              <div
                className="mono"
                style={{ fontSize: 12, color: 'var(--faint)', letterSpacing: '0.04em' }}
              >
                {english ? 'Running' : '已运行'} {formatElapsed(now - goal.startedAt)} · {goal.turns} {english ? 'turns' : '轮'} ·{' '}
                {formatTokens(goal.tokens)} tok
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {goal.status === 'active' ? (
                  <ActionButton onClick={pauseGoal}>{english ? 'Pause' : '暂停'}</ActionButton>
                ) : (
                  <ActionButton onClick={resumeGoal}>{english ? 'Resume' : '继续'}</ActionButton>
                )}
                <ActionButton danger onClick={cancelGoal}>
                  {t('取消')}
                </ActionButton>
              </div>
            </div>
          ) : (
            <div
              style={{
                marginTop: 10,
                padding: '28px 16px',
                border: '1px dashed var(--line)',
                borderRadius: 10,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6
              }}
            >
              <span style={{ fontSize: 13, color: 'var(--dust)' }}>{english ? 'No active goal' : '当前没有进行中的目标'}</span>
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--faint)' }}>
                {english ? 'Use /goal in the composer to set an objective' : '在输入舱用 /goal 下达目标'}
              </span>
            </div>
          )}
        </section>

        <section>
          <SectionLabel>{english ? 'Goal queue' : '目标队列'}</SectionLabel>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--faint)', lineHeight: 1.6 }}>
            {english ? 'Kimi Server currently exposes one active goal. Set the next goal after it finishes.' : '当前 Kimi Server 仅暴露单一活动目标；后续目标可在当前目标结束后继续下达。'}
          </div>
        </section>
      </div>
    </div>
  )
}
