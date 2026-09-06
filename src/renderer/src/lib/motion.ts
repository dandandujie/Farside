/**
 * 动效偏好工具：base.css 的全局 reduced-motion 块只覆盖 CSS 动画与过渡，
 * JS 发起的平滑滚动（scrollTo/scrollIntoView）需要调用方主动降级。
 */
export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth'
}
