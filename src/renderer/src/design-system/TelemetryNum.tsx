import type { ReactNode } from 'react'

interface TelemetryNumProps {
  label: string
  value: ReactNode
  unit?: string
  className?: string
}

/** 遥测读数：tabular-nums 大数字 + 大写小标签（+0.08em）。 */
export function TelemetryNum({ label, value, unit, className }: TelemetryNumProps) {
  return (
    <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span
        style={{
          fontSize: 11,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--faint)'
        }}
      >
        {label}
      </span>
      <span className="mono" style={{ fontSize: 20, color: 'var(--moonlight)', lineHeight: 1.3 }}>
        {value}
        {unit ? (
          <span style={{ fontSize: 12.5, color: 'var(--dust)', marginLeft: 4 }}>{unit}</span>
        ) : null}
      </span>
    </div>
  )
}
