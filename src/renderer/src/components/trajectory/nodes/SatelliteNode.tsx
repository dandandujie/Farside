import { useState } from 'react'
import type { SatelliteEvent, SatelliteStatus } from '@shared/types'
import { Chevron, SatelliteArc } from './markers'
import { usePreferences } from '../../../lib/preferences'

const STATUS_LABEL: Record<SatelliteStatus, string> = {
  launching: '入轨中',
  'in-orbit': '在轨',
  done: '已归位',
  failed: '信号丢失'
}

const STATUS_COLOR: Record<SatelliteStatus, string> = {
  launching: 'var(--dust)',
  'in-orbit': 'var(--dust)',
  done: 'var(--faint)',
  failed: 'var(--redshift)'
}

/**
 * Satellite：从主轨道分出的子代理。短弧线引出卫星节点；
 * 并行多颗时各自成节点纵向堆叠，状态独立；完成后给出 result 摘要。
 */
export function SatelliteNode({ event }: { event: SatelliteEvent }) {
  const { t } = usePreferences()
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'relative', paddingLeft: 4 }}>
      <SatelliteArc status={event.status} />
      <button
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left' }}
      >
        <Chevron open={open} />
        <span
          className="mono"
          style={{
            fontSize: 10.5,
            letterSpacing: '0.08em',
            color: 'var(--dust)',
            border: '1px solid var(--line)',
            borderRadius: 999,
            padding: '1px 8px'
          }}
        >
          {event.satelliteKind}
        </span>
        <span style={{ fontSize: 11, color: STATUS_COLOR[event.status], letterSpacing: '0.02em' }}>
          {t(STATUS_LABEL[event.status])}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 11.5,
            color: 'var(--faint)'
          }}
        >
          {event.task}
        </span>
      </button>
      {open ? (
        <div style={{ margin: '6px 0 0 17px', paddingLeft: 10, borderLeft: '1px solid var(--line)' }}>
          <div style={{ fontSize: 12.5, color: 'var(--dust)', lineHeight: 1.6 }}>{event.task}</div>
          {event.result ? (
            <div
              className="selectable"
              style={{ fontSize: 12.5, color: 'var(--moonlight)', marginTop: 4, lineHeight: 1.6, userSelect: 'text' }}
            >
              {event.result}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
