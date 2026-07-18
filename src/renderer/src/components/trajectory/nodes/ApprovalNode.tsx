import type { ApprovalEvent } from '@shared/types'
import { useFarsideStore } from '../../../lib/store'
import { PrismLine } from '../../../design-system/PrismLine'
import { MarkerSlot, TriangleMarker } from './markers'
import { usePreferences } from '../../../lib/preferences'

/**
 * Approval（时间线内）：一张「等待地面站确认」的窄卡，只展示状态。
 * 完整参数与 diff 由 Composer 上方的审批卡（approvalQueue overlay）承担；
 * 点击本节点把焦点移过去（依赖审批卡根节点带 data-approval-card 属性）。
 */
export function ApprovalNode({ event }: { event: ApprovalEvent }) {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
  const pending = useFarsideStore((s) => s.approvalQueue.some((a) => a.id === event.approvalId))

  const focusCard = () => {
    const el = document.querySelector<HTMLElement>('[data-approval-card]')
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    el.querySelector('button')?.focus()
  }

  return (
    <div style={{ position: 'relative' }}>
      <MarkerSlot top={10}>
        <TriangleMarker />
      </MarkerSlot>
      <button
        onClick={focusCard}
        disabled={!pending}
        title={pending ? (english ? 'Focus approval card' : '聚焦到审批卡') : event.detail}
        style={{
          display: 'block',
          width: '100%',
          maxWidth: 440,
          textAlign: 'left',
          background: 'var(--regolith)',
          border: '1px solid var(--line)',
          borderRadius: 6,
          overflow: 'hidden',
          cursor: pending ? 'pointer' : 'default',
          opacity: pending ? 1 : 0.72,
          transition: 'border-color 150ms var(--ease-farside)'
        }}
        onMouseEnter={(e) => {
          if (pending) e.currentTarget.style.borderColor = 'var(--line-hi)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = 'var(--line)'
        }}
      >
        {pending ? <PrismLine /> : null}
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '8px 12px' }}>
          <span
            style={{
              fontSize: 11,
              letterSpacing: '0.08em',
              color: pending ? 'var(--dust)' : 'var(--faint)',
              flexShrink: 0
            }}
          >
            {pending ? (english ? 'Waiting for approval' : '等待地面站确认') : (english ? 'Approved' : '已确认')}
          </span>
          <span className="mono" style={{ fontSize: 12, color: 'var(--moonlight)' }}>
            {event.tool}
          </span>
          <span style={{ flex: 1 }} />
          {pending ? (
            <span style={{ fontSize: 11, color: 'var(--faint)', flexShrink: 0 }}>{english ? 'Review →' : '前往审批 →'}</span>
          ) : null}
        </span>
      </button>
    </div>
  )
}
