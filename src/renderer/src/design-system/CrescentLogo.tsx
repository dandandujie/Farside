interface CrescentLogoProps {
  size?: number
  className?: string
}

/** Farside 字标图形：一弧月牙，几何、无彩色。 */
export function CrescentLogo({ size = 18, className }: CrescentLogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <path
        d="M 17.5 2.5 A 10 10 0 1 0 17.5 21.5 A 8 10 0 0 1 17.5 2.5 Z"
        fill="var(--moonlight)"
      />
    </svg>
  )
}
