import { useMemo } from 'react'

interface StarfieldProps {
  /** 星点数量，保持低密度 */
  count?: number
  className?: string
}

/** 极低密度星点（确定性伪随机，避免每次渲染跳动）。仅用于空状态/启动页。 */
export function Starfield({ count = 42, className }: StarfieldProps) {
  const stars = useMemo(() => {
    // 简单 LCG，保证星位稳定
    let seed = 20260718
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    return Array.from({ length: count }, (_, i) => ({
      key: i,
      x: rand() * 100,
      y: rand() * 100,
      r: rand() * 0.7 + 0.3,
      o: rand() * 0.35 + 0.1
    }))
  }, [count])

  return (
    <svg
      aria-hidden
      className={className}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      preserveAspectRatio="none"
      viewBox="0 0 100 100"
    >
      {stars.map((s) => (
        <circle key={s.key} cx={s.x} cy={s.y} r={s.r * 0.12} fill="var(--dust)" opacity={s.o} />
      ))}
    </svg>
  )
}
