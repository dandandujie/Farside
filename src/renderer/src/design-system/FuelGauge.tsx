interface FuelGaugeProps {
  /** 已用 token */
  used: number
  /** 总量，默认 1M */
  total?: number
  size?: number
  strokeWidth?: number
  /** 中心是否显示数字（迷你版可关） */
  showLabel?: boolean
  className?: string
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${Math.round(n / 1000)}K`
  return String(n)
}

/** 1M 上下文燃料环：细环 + 中心等宽数字；超过 80% 环色由 moonlight 转向 flare。 */
export function FuelGauge({
  used,
  total = 1_000_000,
  size = 120,
  strokeWidth = 3,
  showLabel = true,
  className
}: FuelGaugeProps) {
  const ratio = Math.min(1, Math.max(0, used / total))
  const hot = ratio > 0.8
  const r = (size - strokeWidth * 2) / 2
  const c = size / 2
  const circumference = 2 * Math.PI * r
  const color = hot ? 'var(--flare)' : 'var(--moonlight)'

  return (
    <div
      className={className}
      style={{ position: 'relative', width: size, height: size }}
      role="img"
      aria-label={`上下文已用 ${formatTokens(used)} / ${formatTokens(total)}`}
    >
      <svg width={size} height={size}>
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--line)" strokeWidth={strokeWidth} />
        <circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
          transform={`rotate(-90 ${c} ${c})`}
          style={{ transition: 'stroke-dashoffset 600ms var(--ease-farside), stroke 600ms var(--ease-farside)' }}
        />
      </svg>
      {showLabel ? (
        <div
          className="mono"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            lineHeight: 1.3
          }}
        >
          <span style={{ fontSize: size >= 100 ? 20 : 12.5, color: 'var(--moonlight)' }}>
            {formatTokens(used)}
          </span>
          <span style={{ fontSize: 11, color: 'var(--faint)', letterSpacing: '0.08em' }}>
            / {formatTokens(total)}
          </span>
        </div>
      ) : null}
    </div>
  )
}
