import type { ReactNode } from 'react'

/** 区块标签：11px 大写、+0.08em、faint。 */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--faint)',
        lineHeight: 1.5
      }}
    >
      {children}
    </div>
  )
}
