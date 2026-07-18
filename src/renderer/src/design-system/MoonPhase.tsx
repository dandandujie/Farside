import type { CSSProperties } from 'react'
import type { MoonPhase as Phase } from '@shared/types'

interface MoonPhaseProps {
  phase: Phase
  /** 直径 px */
  size?: number
  className?: string
  title?: string
  /** 工作态显示旋转轨道与月光呼吸，月相本身仍表示真实阶段。 */
  active?: boolean
}

/**
 * 月相：暗盘 + 一道被照亮的区域（path d 过渡 600ms）。
 * 亮区 path 统一为「外缘半圆弧 +  terminator 椭圆弧」两条弧，
 * 六种月相仅半径/扫掠方向不同，因此可用 CSS d 属性平滑过渡。
 */
export function MoonPhase({ phase, size = 16, className, title, active = false }: MoonPhaseProps) {
  const r = 10
  const c = 12 // viewBox 24x24 的中心
  const top = `${c} ${c - r}`
  const bottom = `${c} ${c + r}`

  // [terminator 半径系数, 外缘弧 sweep(T→B), terminator 弧 sweep(B→T)]
  const table: Record<Phase, [number, 0 | 1, 0 | 1]> = {
    new: [0.001, 1, 0],
    waxing: [0.62, 1, 0],
    'first-quarter': [0.001, 1, 0],
    gibbous: [0.62, 1, 1],
    full: [1, 1, 1],
    waning: [0.62, 0, 1]
  }
  const [k, limbSweep, termSweep] = table[phase]
  const d = `M ${top} A ${r} ${r} 0 0 ${limbSweep} ${bottom} A ${(r * k).toFixed(3)} ${r} 0 0 ${termSweep} ${top} Z`

  const style = {
    d: `path("${d}")`,
    transition: 'd 600ms cubic-bezier(0.22, 1, 0.36, 1)'
  } as CSSProperties

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={[className, active ? 'moon-phase--active' : ''].filter(Boolean).join(' ')}
      role="img"
      aria-label={title ?? phase}
      style={{ overflow: 'visible', flexShrink: 0 }}
    >
      {title ? <title>{title}</title> : null}
      {active ? <circle className="moon-phase__orbit" cx={c} cy={c} r="11.5" fill="none" stroke="var(--moonlight)" strokeWidth="0.8" strokeDasharray="4 5" /> : null}
      {/* 暗盘：朔月也可见的一圈轮廓 */}
      <circle cx={c} cy={c} r={r} fill="var(--crater)" stroke="var(--dust)" strokeWidth="1.15" />
      <path style={style} fill={phase === 'new' ? 'transparent' : 'var(--moonlight)'} />
      {phase === 'new' ? <circle cx={c} cy={c} r="1.5" fill="var(--faint)" /> : null}
    </svg>
  )
}
