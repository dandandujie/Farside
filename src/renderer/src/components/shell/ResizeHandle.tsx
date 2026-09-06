import { useCallback, useEffect, useState } from 'react'

/**
 * 可拖动面板的持久宽度。max 之外再做一档"窗口感知"钳制：主内容区至少保留
 * 420px，避免会话栏（最大 480）与 Mission Panel（最大 760）同时拖宽后把
 * 主区压成 0 宽。窗口缩小时按需收窄已保存的宽度。
 */
export function usePersistentWidth(key: string, initial: number, min: number, max: number) {
  const clampToWindow = useCallback(
    (value: number) => {
      const roomMax = Math.max(min, window.innerWidth - 476)
      return Math.min(max, roomMax, Math.max(min, value))
    },
    [min, max]
  )
  const [width, setWidth] = useState(() => {
    const raw = localStorage.getItem(`farside:width:${key}`)
    // 键不存在时 Number(null) === 0 会把首次宽度错压到 min；只有存过合法值才采用。
    if (raw === null) return initial
    const saved = Number(raw)
    return Number.isFinite(saved) && saved > 0 ? clampToWindow(saved) : initial
  })

  useEffect(() => {
    localStorage.setItem(`farside:width:${key}`, String(width))
  }, [key, width])

  // 窗口变窄时收窄面板，保证主内容区始终可见。
  useEffect(() => {
    const onResize = () => setWidth((current) => clampToWindow(current))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clampToWindow])

  return [width, (next: number) => setWidth(Math.min(max, Math.max(min, next)))] as const
}

export function ResizeHandle({
  edge,
  onDrag
}: {
  edge: 'left' | 'right'
  onDrag(deltaX: number): void
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(event) => {
        event.preventDefault()
        const startX = event.clientX
        const move = (moveEvent: PointerEvent) => {
          onDrag(moveEvent.clientX - startX)
        }
        const stop = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', stop)
          document.body.style.cursor = ''
          document.body.style.userSelect = ''
        }
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', stop, { once: true })
      }}
      style={{
        position: 'absolute',
        zIndex: 20,
        top: 0,
        bottom: 0,
        [edge]: -3,
        width: 7,
        cursor: 'col-resize'
      }}
      onPointerEnter={(event) => { event.currentTarget.style.background = 'color-mix(in srgb, var(--moonlight) 16%, transparent)' }}
      onPointerLeave={(event) => { event.currentTarget.style.background = 'transparent' }}
    />
  )
}
