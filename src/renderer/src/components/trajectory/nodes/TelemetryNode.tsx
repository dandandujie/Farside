import type { TelemetryEvent } from '@shared/types'
import { MarkerSlot, TickMarker } from './markers'

/** Telemetry：一行等宽小字读数条，数字 tabular-nums（.mono 已带）。 */
export function TelemetryNode({ event }: { event: TelemetryEvent }) {
  return (
    <div style={{ position: 'relative' }}>
      <MarkerSlot top={3}>
        <TickMarker />
      </MarkerSlot>
      <span
        className="mono selectable"
        style={{ fontSize: 11, color: 'var(--faint)', letterSpacing: '0.04em', userSelect: 'text' }}
      >
        {event.tokensPerSecond > 0 ? event.tokensPerSecond.toFixed(1) : '—'} tok/s · {Math.round(event.contextTokens / 1000)}K/1M
        {event.estimatedCostCny !== undefined
          ? ` · API 估算 ¥${event.estimatedCostCny.toFixed(2)}`
          : event.cost === undefined ? '' : ` · $${event.cost.toFixed(4)}`}
      </span>
    </div>
  )
}
