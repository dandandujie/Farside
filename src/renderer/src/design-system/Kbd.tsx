import type { ReactNode } from 'react'

/** 键帽：hairline 边框 + 等宽小字，无彩色。 */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      className="mono"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 20,
        height: 20,
        padding: '0 5px',
        fontSize: 11,
        color: 'var(--dust)',
        background: 'var(--regolith)',
        border: '1px solid var(--line)',
        borderRadius: 6,
        lineHeight: 1
      }}
    >
      {children}
    </kbd>
  )
}
