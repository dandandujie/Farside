import type { GoalStatus } from '@shared/types'
import { useFarsideStore } from '../../lib/store'
import { usePreferences } from '../../lib/preferences'

const STATUS_LABEL: Record<GoalStatus, string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '受阻'
}

function BarButton({ label, onClick, danger = false }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 12,
        letterSpacing: '0.02em',
        padding: '3px 10px',
        borderRadius: 6,
        border: '1px solid var(--line)',
        color: danger ? 'var(--redshift)' : 'var(--dust)',
        flexShrink: 0,
        transition: 'background 150ms var(--ease-farside)'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--crater)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
    >
      {label}
    </button>
  )
}

/** GoalBar：会话头部下方的目标栏（/goal）。goal 为 null 时不渲染。 */
export function GoalBar() {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
  const goal = useFarsideStore((s) => s.goal)
  const pauseGoal = useFarsideStore((s) => s.pauseGoal)
  const resumeGoal = useFarsideStore((s) => s.resumeGoal)
  const cancelGoal = useFarsideStore((s) => s.cancelGoal)

  if (!goal) return null

  return (
    <div
      style={{
        flexShrink: 0,
        padding: '8px 24px',
        borderBottom: '1px solid var(--line)',
        background: 'var(--mare)',
        display: 'flex',
        alignItems: 'center',
        gap: 10
      }}
    >
      <span
        style={{
          fontSize: 11,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--faint)',
          flexShrink: 0
        }}
      >
        {english ? 'GOAL' : '目标'}
      </span>
      <span
        title={goal.objective}
        style={{
          fontSize: 12.5,
          color: 'var(--moonlight)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
          flex: 1
        }}
      >
        {goal.objective}
      </span>
      <span
        style={{
          fontSize: 11,
          letterSpacing: '0.02em',
          flexShrink: 0,
          color: goal.status === 'active' ? 'var(--dust)' : 'var(--flare)'
        }}
        title={goal.status === 'blocked' ? goal.blockedReason : undefined}
      >
        {english ? ({ active: 'Active', paused: 'Paused', blocked: 'Blocked' } as Record<GoalStatus, string>)[goal.status] : STATUS_LABEL[goal.status]}
        {goal.status === 'blocked' && goal.blockedReason ? ` · ${goal.blockedReason}` : ''}
      </span>
      <span className="mono" style={{ fontSize: 11, color: 'var(--faint)', flexShrink: 0 }}>
        {english ? `Turn ${goal.turns}` : `第 ${goal.turns} 轮`} · {goal.tokens.toLocaleString('en-US')} tok
      </span>
      {goal.status === 'active' ? (
        <BarButton label={english ? 'Pause' : '暂停'} onClick={pauseGoal} />
      ) : (
        <BarButton label={english ? 'Resume' : '继续'} onClick={resumeGoal} />
      )}
      <BarButton label={english ? 'Cancel' : '取消'} onClick={cancelGoal} danger />
    </div>
  )
}
