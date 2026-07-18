import { useState } from 'react'
import type { InstrumentEvent, InstrumentStatus } from '@shared/types'
import { MoonPhase } from '../../../design-system/MoonPhase'
import { Chevron, MarkerSlot, SquareMarker } from './markers'
import { usePreferences } from '../../../lib/preferences'

const STATUS_LABEL: Record<InstrumentStatus, string> = {
  running: '运行中',
  done: '完成',
  failed: '失败'
}

/** 状态字：纯文字表达，不用彩色圆点；仅「失败」用 redshift 文字（危险色）。 */
function StatusWord({ status, durationMs }: { status: InstrumentStatus; durationMs?: number }) {
  const { t } = usePreferences()
  const suffix = durationMs != null && status !== 'running' ? ` · ${(durationMs / 1000).toFixed(1)}s` : ''
  return (
    <span
      className="mono"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        flexShrink: 0,
        color: status === 'failed' ? 'var(--redshift)' : 'var(--dust)'
      }}
    >
      {status === 'running' ? (
        <span
          aria-hidden
          style={{ display: 'inline-flex', animation: 'caret-breathe 1.6s var(--ease-farside) infinite' }}
        >
          <MoonPhase phase="gibbous" size={13} active />
        </span>
      ) : null}
      {t(STATUS_LABEL[status])}
      {suffix}
    </span>
  )
}

/**
 * Instrument：仪器读数卡片。
 * 工具名 + 状态保持单行；参数与输出默认完全隐藏，用户主动展开后才呈现。
 */
export function InstrumentNode({ event }: { event: InstrumentEvent }) {
  const { t } = usePreferences()
  const [expanded, setExpanded] = useState(false)

  return (
    <div style={{ position: 'relative' }}>
      <MarkerSlot top={11}>
        <SquareMarker />
      </MarkerSlot>
      <div
        style={{
          padding: '1px 0'
        }}
      >
        <button
          data-instrument-toggle
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', minHeight: 24 }}
        >
          <Chevron open={expanded} />
          <span className="mono" style={{ fontSize: 12, color: 'var(--dust)', flexShrink: 0 }}>
            {event.tool}
          </span>
          <span
            className="mono"
            title={event.argsSummary}
            style={{
              fontSize: 10.5,
              color: 'var(--faint)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
              minWidth: 0,
              textAlign: 'left'
            }}
          >
            {expanded ? t('调用详情') : event.argsSummary || t('查看调用详情')}
          </span>
          <StatusWord status={event.status} durationMs={event.durationMs} />
        </button>
        {expanded ? (
          <div
            style={{
              maxHeight: 188,
              overflowY: 'auto',
              overscrollBehavior: 'contain',
              scrollbarGutter: 'stable',
              margin: '3px 0 4px 15px',
              borderLeft: '1px solid var(--line)',
              padding: '5px 9px'
            }}
          >
            {event.argsSummary ? (
              <div className="mono selectable" style={{ marginBottom: event.output ? 8 : 0, fontSize: 11, lineHeight: 1.6, color: 'var(--faint)', userSelect: 'text', whiteSpace: 'pre-wrap' }}>
                {event.argsSummary}
              </div>
            ) : null}
            {event.output ? (
            <pre
              className="mono selectable"
              style={{
                margin: 0,
                fontSize: 11.5,
                lineHeight: 1.6,
                color: 'var(--dust)',
                whiteSpace: 'pre-wrap',
                userSelect: 'text',
                overflowY: 'visible'
              }}
            >
              {event.output}
            </pre>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
