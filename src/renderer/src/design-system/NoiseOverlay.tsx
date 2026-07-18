const NOISE_SVG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")`

/** 全局噪点覆层：opacity ≤ 0.035，压掉纯色背景的死平。 */
export function NoiseOverlay() {
  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        pointerEvents: 'none',
        backgroundImage: NOISE_SVG,
        opacity: 0.035,
        mixBlendMode: 'overlay'
      }}
    />
  )
}
