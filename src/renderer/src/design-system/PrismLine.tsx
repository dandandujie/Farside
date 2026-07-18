interface PrismLineProps {
  direction?: 'horizontal' | 'vertical'
  /** 0–1，默认 0.9；prism 只允许细线，绝不加粗 */
  opacity?: number
  className?: string
}

/** 1px 光谱渐变 hairline —— 全 App 唯一的彩色元素。 */
export function PrismLine({ direction = 'horizontal', opacity = 0.9, className }: PrismLineProps) {
  const base: React.CSSProperties = {
    background: 'var(--prism)',
    opacity,
    flexShrink: 0
  }
  const size: React.CSSProperties =
    direction === 'horizontal' ? { height: 1, width: '100%' } : { width: 1, alignSelf: 'stretch' }
  return <div aria-hidden style={{ ...base, ...size }} className={className} />
}
