import { useEffect, useMemo, useState } from 'react'
import type { GitChange } from '@shared/ipc'
import type { TrajectoryEvent } from '@shared/types'
import { useFarsideStore } from '../../lib/store'
import { usePreferences } from '../../lib/preferences'

const EDIT_TOOL = /(?:edit|write|patch|create|delete|remove|move|rename)/i

function fallbackChanges(events: TrajectoryEvent[]): GitChange[] {
  const byPath = new Map<string, GitChange>()
  for (const event of events) {
    if (event.kind !== 'instrument' || !EDIT_TOOL.test(event.tool)) continue
    const paths = new Set<string>()
    for (const match of event.argsSummary.matchAll(/^\*{3} (?:Add|Update|Delete) File:\s*(.+)$/gm)) paths.add(match[1].trim())
    for (const match of event.argsSummary.matchAll(/\b(?:Edit|WriteFile|CreateFile|DeleteFile)\(([^,\n)]+)/g)) paths.add(match[1].trim())
    for (const match of event.argsSummary.matchAll(/((?:src|app|apps|packages|scripts|test|tests|docs)[\\/][^\s,;)]+\.[A-Za-z0-9]+)/g)) paths.add(match[1])
    const stats = /\+(\d+)\s+[−-](\d+)/.exec(event.argsSummary)
    for (const path of paths) {
      byPath.set(path.replaceAll('\\', '/'), {
        path: path.replaceAll('\\', '/'),
        status: /delete|remove/i.test(event.tool) ? 'Deleted' : /create|write/i.test(event.tool) ? 'Added' : 'Modified',
        additions: Number(stats?.[1] ?? 0),
        deletions: Number(stats?.[2] ?? 0)
      })
    }
  }
  return [...byPath.values()]
}

export function TurnChangesCard({
  sessionId,
  events
}: {
  sessionId: string
  events: TrajectoryEvent[]
}) {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
  const undoLastTurn = useFarsideStore((state) => state.undoLastTurn)
  const reviewChanges = useFarsideStore((state) => state.reviewChanges)
  const [changes, setChanges] = useState<GitChange[]>([])
  const [available, setAvailable] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const inferred = useMemo(() => fallbackChanges(events), [events])

  useEffect(() => {
    let alive = true
    const agent = window.api?.agent
    if (!agent) {
      setChanges(inferred)
      setAvailable(true)
      setLoading(false)
      return
    }
    void agent.getTurnChanges(sessionId)
      .then((result) => {
        if (!alive) return
        if (result.ok) {
          setChanges(result.changes)
          setAvailable(result.tracked)
          setError(null)
        } else {
          setChanges(inferred)
          setError(result.error ?? (english ? 'Unable to read turn changes' : '无法读取本轮改动'))
        }
      })
      .catch((reason) => {
        if (!alive) return
        setChanges(inferred)
        setError(reason instanceof Error ? reason.message : (english ? 'Unable to read turn changes' : '无法读取本轮改动'))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [english, inferred, sessionId])

  const totals = changes.reduce(
    (sum, change) => ({
      additions: sum.additions + change.additions,
      deletions: sum.deletions + change.deletions
    }),
    { additions: 0, deletions: 0 }
  )
  const visible = expanded ? changes : changes.slice(0, 3)
  const remaining = Math.max(0, changes.length - visible.length)

  if (!loading && !available) return null

  return (
    <section
      className="turn-changes-card"
      style={{
        marginTop: 16,
        overflow: 'hidden',
        border: '1px solid var(--line)',
        borderRadius: 10,
        background: 'color-mix(in srgb, var(--regolith) 72%, transparent)'
      }}
    >
      <div style={{ minHeight: 66, display: 'flex', alignItems: 'center', gap: 12, padding: '10px 13px' }}>
        <span
          aria-hidden
          style={{
            width: 38,
            height: 38,
            flexShrink: 0,
            display: 'grid',
            placeItems: 'center',
            borderRadius: 9,
            background: 'var(--mare)',
            color: 'var(--dust)'
          }}
        >
          <svg width="19" height="19" viewBox="0 0 19 19" fill="none">
            <rect x="3" y="2.5" width="13" height="14" rx="2.5" stroke="currentColor" />
            <path d="M6.5 6.5h6M6.5 9.5h6M9.5 4v5" stroke="currentColor" strokeLinecap="round" />
          </svg>
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, color: 'var(--moonlight)' }}>
            {loading
              ? (english ? 'Reading file changes…' : '正在读取文件改动…')
              : changes.length
                ? (english ? `Edited ${changes.length} ${changes.length === 1 ? 'file' : 'files'}` : `已编辑 ${changes.length} 个文件`)
                : (english ? 'No file changes in this turn' : '本轮未修改文件')}
          </div>
          {!loading && changes.length ? (
            <div className="mono" style={{ marginTop: 3, fontSize: 11 }}>
              <span style={{ color: 'var(--signal)' }}>+{totals.additions}</span>{' '}
              <span style={{ color: 'var(--redshift)' }}>−{totals.deletions}</span>
            </div>
          ) : null}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            onClick={() => {
              const confirmed = window.confirm(
                english
                  ? 'Undo the last AI turn and restore files changed during that turn?'
                  : '撤销上一轮 AI 执行，并恢复该轮修改过的文件？'
              )
              if (confirmed) undoLastTurn()
            }}
            style={{ padding: '6px 8px', color: 'var(--dust)', fontSize: 11.5 }}
          >
            {english ? 'Undo' : '撤销'} ↶
          </button>
          <button
            disabled={!changes.length}
            onClick={() => reviewChanges()}
            style={{
              padding: '6px 10px',
              border: '1px solid var(--line-hi)',
              borderRadius: 7,
              color: changes.length ? 'var(--moonlight)' : 'var(--ghost)',
              fontSize: 11.5
            }}
          >
            {english ? 'Review' : '审核'}
          </button>
        </div>
      </div>

      {changes.length ? (
        <div style={{ borderTop: '1px solid var(--line)', padding: '5px 13px 8px' }}>
          {visible.map((change) => (
            <button
              key={change.path}
              onClick={() => reviewChanges(change.path)}
              title={change.path}
              style={{
                width: '100%',
                minHeight: 32,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                color: 'var(--faint)',
                textAlign: 'left'
              }}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5 }}>
                {change.path}
              </span>
              <span className="mono" style={{ flexShrink: 0, fontSize: 10.5 }}>
                <span style={{ color: 'var(--signal)' }}>+{change.additions}</span>{' '}
                <span style={{ color: 'var(--redshift)' }}>−{change.deletions}</span>
              </span>
            </button>
          ))}
          {changes.length > 3 ? (
            <button
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              style={{ minHeight: 28, display: 'flex', alignItems: 'center', gap: 7, color: 'var(--dust)', fontSize: 11.5 }}
            >
              {expanded
                ? (english ? 'Show less' : '收起')
                : (english ? `Show ${remaining} more ${remaining === 1 ? 'file' : 'files'}` : `再显示 ${remaining} 个文件`)}
              <span aria-hidden>{expanded ? '⌃' : '⌄'}</span>
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? <div style={{ padding: '0 13px 9px', color: 'var(--redshift)', fontSize: 10 }}>{error}</div> : null}
    </section>
  )
}
