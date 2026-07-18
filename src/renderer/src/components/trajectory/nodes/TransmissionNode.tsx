import { useEffect, useState } from 'react'
import type { TransmissionEvent } from '@shared/types'
import { Chevron, DiamondMarker, MarkerSlot } from './markers'
import { usePreferences } from '../../../lib/preferences'

/** Transmission：深空传回的信号。默认折叠成 `深空思考 · 12.4s`，展开后是等宽小字正文。 */
export function TransmissionNode({
  event,
  active = false,
  itemCount = 1,
  activeOffsetMs = 0
}: {
  event: TransmissionEvent
  active?: boolean
  itemCount?: number
  activeOffsetMs?: number
}) {
  const { t, locale } = usePreferences()
  const [open, setOpen] = useState(false)
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setClock(Date.now())
    const timer = window.setInterval(() => setClock(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [active])
  const durationMs = active
    ? Math.max(event.durationMs, activeOffsetMs + clock - event.at)
    : event.durationMs
  return (
    <div style={{ position: 'relative' }}>
      <MarkerSlot top={5}>
        <DiamondMarker />
      </MarkerSlot>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12.5,
          color: open ? 'var(--dust)' : 'var(--faint)',
          letterSpacing: '0.01em',
          transition: 'color 150ms var(--ease-farside)'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--dust)'
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.color = 'var(--faint)'
        }}
      >
        <Chevron open={open} />
        {t('深空思考')}
        {itemCount > 1 ? ` · ${itemCount}${locale === 'en-US' ? ' steps' : ' 段'}` : ''}
        {durationMs > 0 ? ` · ${durationMs < 100 ? '<0.1' : (durationMs / 1000).toFixed(1)}s` : ` · ${t('时长未知')}`}
      </button>
      {open ? (
        <pre
          className="mono selectable"
          style={{
            margin: '8px 0 0',
            padding: '10px 12px',
            fontSize: 12,
            lineHeight: 1.7,
            color: 'var(--dust)',
            background: 'var(--mare)',
            border: '1px solid var(--line)',
            borderRadius: 6,
            maxHeight: 240,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            scrollbarGutter: 'stable',
            whiteSpace: 'pre-wrap',
            userSelect: 'text'
          }}
        >
          {event.text}
        </pre>
      ) : null}
    </div>
  )
}
