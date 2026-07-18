import { useEffect, useState } from 'react'
import { MoonPhase } from '../../design-system/MoonPhase'
import type { MoonPhase as Phase } from '@shared/types'
import { usePreferences } from '../../lib/preferences'

const PHASE_SEQUENCE: Phase[] = ['new', 'waxing', 'first-quarter', 'gibbous', 'full']
const STEP_MS = 220
const HOLD_MS = 1200
// DESIGN.md：界面反馈动效 120–180ms
const FADE_MS = 180

/** 启动画面：黑底，月牙由朔到盈，1.2s 后淡出。 */
export function BootSplash({ onDone }: { onDone(): void }) {
  const { locale } = usePreferences()
  const [step, setStep] = useState(0)
  const [fading, setFading] = useState(false)

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = []
    PHASE_SEQUENCE.forEach((_, i) => {
      timers.push(setTimeout(() => setStep(i), i * STEP_MS))
    })
    timers.push(setTimeout(() => setFading(true), HOLD_MS))
    timers.push(setTimeout(onDone, HOLD_MS + FADE_MS))
    return () => timers.forEach(clearTimeout)
  }, [onDone])

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 22,
        background: 'var(--void)',
        opacity: fading ? 0 : 1,
        transition: `opacity ${FADE_MS}ms var(--ease-farside)`,
        pointerEvents: 'none'
      }}
    >
      <MoonPhase phase={PHASE_SEQUENCE[step]} size={44} />
      <div
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 700,
          fontSize: 16,
          letterSpacing: '0.32em',
          color: 'var(--moonlight)',
          paddingLeft: '0.32em' // 光学居中
        }}
      >
        FARSIDE
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--faint)', letterSpacing: '0.08em' }}>
        {locale === 'en-US' ? 'Establishing link…' : '正在建立链路…'}
      </div>
    </div>
  )
}
