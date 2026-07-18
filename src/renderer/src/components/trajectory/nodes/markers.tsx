import type { ReactNode } from 'react'
import type { SatelliteStatus } from '@shared/types'

/**
 * 轨道几何标记：全部用描边小图形表达节点类型，禁止彩色圆点。
 * 轨道容器 paddingLeft = 26，1px 轨道线位于节点内容左侧 -26px 处；
 * MarkerSlot 把 13px 宽的图形居中压到线上（fill 用 --void 遮住线，形成「节点」）。
 */

/** 标记槽：children 居中对齐轨道线。top 按节点首行高度微调。 */
export function MarkerSlot({ top = 4, children }: { top?: number; children: ReactNode }) {
  return (
    <span
      aria-hidden
      style={{
        position: 'absolute',
        left: -33,
        top,
        width: 13,
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none'
      }}
    >
      {children}
    </span>
  )
}

function MarkerSvg({ children }: { children: ReactNode }) {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" style={{ display: 'block' }}>
      {children}
    </svg>
  )
}

/** Transmission：菱形（信号）。 */
export function DiamondMarker() {
  return (
    <MarkerSvg>
      <path d="M6.5 2 11 6.5 6.5 11 2 6.5Z" fill="var(--void)" stroke="var(--line-hi)" strokeWidth="1" />
    </MarkerSvg>
  )
}

/** Instrument：方块（仪器）。 */
export function SquareMarker() {
  return (
    <MarkerSvg>
      <rect x="3" y="3" width="7" height="7" fill="var(--void)" stroke="var(--line-hi)" strokeWidth="1" />
    </MarkerSvg>
  )
}

/** Approval：三角（需要人）。 */
export function TriangleMarker() {
  return (
    <MarkerSvg>
      <path d="M6.5 2.5 11 10.5H2Z" fill="var(--void)" stroke="var(--line-hi)" strokeWidth="1" />
    </MarkerSvg>
  )
}

/** Message：一道横杠（回传正文）。 */
export function DashMarker() {
  return (
    <MarkerSvg>
      <rect x="1" y="4.5" width="11" height="4" fill="var(--void)" />
      <line x1="1.5" y1="6.5" x2="11.5" y2="6.5" stroke="var(--line-hi)" strokeWidth="1" />
    </MarkerSvg>
  )
}

/** Telemetry：更短的弱横杠（读数，低频）。 */
export function TickMarker() {
  return (
    <MarkerSvg>
      <rect x="3" y="5" width="7" height="3" fill="var(--void)" />
      <line x1="3.5" y1="6.5" x2="9.5" y2="6.5" stroke="var(--ghost)" strokeWidth="1" />
    </MarkerSvg>
  )
}

/** Ground：24px prism 竖线，正好覆盖在轨道线上（prism 仅允许 1px 细线）。 */
export function PrismTick() {
  return (
    <span
      aria-hidden
      style={{
        position: 'absolute',
        left: -26,
        top: 2,
        width: 1,
        height: 24,
        background: 'var(--prism)',
        opacity: 0.9,
        pointerEvents: 'none'
      }}
    />
  )
}

/** Satellite：从主轨道分出的一段短弧 + 弧端小圆（卫星本体）。launching 时小圆呼吸。 */
export function SatelliteArc({ status }: { status: SatelliteStatus }) {
  const breathing = status === 'launching'
  const stroke = status === 'done' ? 'var(--dust)' : status === 'failed' ? 'var(--ghost)' : 'var(--line-hi)'
  return (
    <svg
      aria-hidden
      width="24"
      height="16"
      viewBox="0 0 24 16"
      style={{ position: 'absolute', left: -26, top: 2, display: 'block', pointerEvents: 'none' }}
    >
      <path d="M0.5 0 Q0.5 10 10 10 H14" fill="none" stroke="var(--line-hi)" strokeWidth="1" />
      <circle
        cx="17.5"
        cy="10"
        r="2.6"
        fill="var(--void)"
        stroke={stroke}
        strokeWidth="1"
        style={breathing ? { animation: 'caret-breathe 1.2s var(--ease-farside) infinite' } : undefined}
      />
    </svg>
  )
}

/** 展开/收起用的小箭头（旋转 90°）。 */
export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="8"
      height="8"
      viewBox="0 0 8 8"
      aria-hidden
      style={{
        transform: open ? 'rotate(90deg)' : 'none',
        transition: 'transform 150ms var(--ease-farside)',
        flexShrink: 0
      }}
    >
      <path d="M1.5 1 6.5 4 1.5 7Z" fill="currentColor" />
    </svg>
  )
}
