import { useEffect, useState } from 'react'

export function usePersistentWidth(key: string, initial: number, min: number, max: number) {
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(`farside:width:${key}`))
    return Number.isFinite(saved) ? Math.min(max, Math.max(min, saved)) : initial
  })

  useEffect(() => {
    localStorage.setItem(`farside:width:${key}`, String(width))
  }, [key, width])

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
