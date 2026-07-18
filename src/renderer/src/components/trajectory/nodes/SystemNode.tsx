import { useState } from 'react'
import type { SystemEvent } from '@shared/types'
import { Chevron, MarkerSlot } from './markers'
import { usePreferences } from '../../../lib/preferences'

/** 内部上下文只占一行并默认折叠，避免伪装成用户请求。 */
export function SystemNode({ event }: { event: SystemEvent }) {
  const { t } = usePreferences()
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'relative' }}>
      <MarkerSlot top={5}>
        <span aria-hidden className="mono" style={{ fontSize: 8, color: 'var(--ghost)' }}>◇</span>
      </MarkerSlot>
      <button
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        style={{ display: 'inline-flex', minHeight: 22, alignItems: 'center', gap: 7, color: 'var(--faint)' }}
      >
        <Chevron open={open} />
        <span className="mono" style={{ fontSize: 10.5 }}>{t(event.label)}</span>
      </button>
      {open ? (
        <pre className="mono selectable" style={{ margin: '6px 0 0', padding: '9px 11px', maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', border: '1px solid var(--line)', borderRadius: 6, background: 'var(--mare)', color: 'var(--faint)', fontSize: 10.5, lineHeight: 1.6, userSelect: 'text' }}>
          {event.text}
        </pre>
      ) : null}
    </div>
  )
}
