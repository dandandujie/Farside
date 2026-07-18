import type { Session } from '@shared/types'
import { MODELS } from '@shared/types'

/** cwd 缩短：命中 home 前缀换成 ~，否则只保留末两段路径。 */
function shortenCwd(cwd: string): string {
  const norm = cwd.replace(/\\/g, '/')
  const home = /^(?:[A-Za-z]:)?\/(?:Users|home)\/[^/]+(\/.*)?$/.exec(norm)
  if (home) return `~${home[1] ?? ''}`
  const segs = norm.split('/').filter(Boolean)
  return segs.slice(-2).join('/')
}

/** SessionHeader：会话标题 + 模型 label + 缩短后的 cwd。 */
export function SessionHeader({ session }: { session: Session }) {
  const model = MODELS.find((m) => m.id === session.model)
  return (
    <div
      style={{
        flexShrink: 0,
        padding: '14px 24px 12px',
        borderBottom: '1px solid var(--line)',
        display: 'flex',
        alignItems: 'baseline',
        gap: 12
      }}
    >
      <h1
        style={{
          margin: 0,
          fontSize: 16,
          fontWeight: 500,
          color: 'var(--moonlight)',
          letterSpacing: '0.01em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0
        }}
      >
        {session.title}
      </h1>
      <span className="mono" style={{ fontSize: 11, color: 'var(--faint)', flexShrink: 0 }}>
        {model?.label ?? session.model}
      </span>
      <span style={{ flex: 1 }} />
      <span
        className="mono"
        title={session.cwd}
        style={{ fontSize: 11, color: 'var(--ghost)', flexShrink: 0, letterSpacing: '0.02em' }}
      >
        {shortenCwd(session.cwd)}
      </span>
    </div>
  )
}
