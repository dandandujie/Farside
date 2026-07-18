import { useEffect, useMemo, useState } from 'react'
import type { GitChange } from '@shared/ipc'
import { SectionLabel } from '../../design-system/SectionLabel'
import { useActiveSession } from '../../lib/store'
import { usePreferences } from '../../lib/preferences'

// ── unified diff 逐行解析 ─────────────────────────────────────────
type DiffRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'add' | 'del' | 'ctx'; text: string; oldNo: number | null; newNo: number | null }

function parseDiff(diff: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldNo = 0
  let newNo = 0
  for (const line of diff.split('\n')) {
    // 文件头（--- / +++）不展示，路径已在左侧列表给出
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue
    if (line.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (m) {
        oldNo = Number(m[1])
        newNo = Number(m[2])
      }
      rows.push({ kind: 'hunk', text: line })
      continue
    }
    if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ })
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null })
    } else if (line.startsWith('\\')) {
      rows.push({ kind: 'hunk', text: line })
    } else {
      rows.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line, oldNo: oldNo++, newNo: newNo++ })
    }
  }
  return rows
}

const STATUS_LABEL: Record<string, string | null> = {
  added: '新增',
  modified: null,
  deleted: '删除'
}

function LineNo({ n }: { n: number | null }) {
  return (
    <span
      className="mono"
      style={{
        width: 30,
        flexShrink: 0,
        textAlign: 'right',
        paddingRight: 8,
        color: 'var(--ghost)',
        fontSize: 10.5
      }}
    >
      {n ?? ''}
    </span>
  )
}

/** 改动 tab：左侧文件列表（+/− 徽标），右侧完整 unified diff。两栏 1:2。 */
export function DiffTab() {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
  const active = useActiveSession()
  const [changes, setChanges] = useState<GitChange[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [branch, setBranch] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const toolRevision = active?.events
    .filter((event) => event.kind === 'instrument')
    .map((event) => `${event.id}:${event.status}`)
    .join('|') ?? ''

  useEffect(() => {
    setChanges([])
    setSelectedPath(null)
    setBranch(null)
    setLastUpdated(null)
  }, [active?.id])

  useEffect(() => {
    const agent = window.api?.agent
    if (!active || !agent) return
    let alive = true
    let refreshing = false
    const refresh = async () => {
      if (refreshing) return
      refreshing = true
      try {
        const result = await agent.getGitChanges(active.id)
        if (!alive) return
        if (result.ok) {
          setChanges((current) => result.changes.map((change) => {
            const previous = current.find((item) => item.path === change.path)
            return previous?.diff === undefined
              ? change
              : { ...change, diff: previous.diff, additions: previous.additions, deletions: previous.deletions }
          }))
          setSelectedPath((current) => current && result.changes.some((change) => change.path === current)
            ? current
            : result.changes[0]?.path ?? null)
          setBranch(result.branch ?? null)
          setError(null)
          setLastUpdated(Date.now())
        } else {
          setError(result.error ?? 'Git 改动读取失败')
        }
      } catch (reason) {
        if (alive) setError(reason instanceof Error ? reason.message : 'Git 改动读取失败')
      } finally {
        refreshing = false
      }
    }
    void refresh()
    const interval = window.setInterval(refresh, active.phase === 'new' ? 4_000 : 1_500)
    return () => {
      alive = false
      window.clearInterval(interval)
    }
  }, [active?.id, active?.phase, toolRevision])

  useEffect(() => {
    const agent = window.api?.agent
    if (!active || !selectedPath || !agent) return
    let alive = true
    setDiffLoading(true)
    void agent.getGitDiff(active.id, selectedPath)
      .then((result) => {
        if (!alive) return
        if (!result.ok) {
          setError(result.error ?? (english ? 'Failed to read file diff' : '文件改动读取失败'))
          return
        }
        setChanges((current) => current.map((change) => change.path === selectedPath
          ? { ...change, diff: result.diff ?? '', additions: result.additions, deletions: result.deletions }
          : change))
        setError(null)
      })
      .catch((reason) => {
        if (alive) setError(reason instanceof Error ? reason.message : (english ? 'Failed to read file diff' : '文件改动读取失败'))
      })
      .finally(() => { if (alive) setDiffLoading(false) })
    return () => { alive = false }
  }, [active?.id, selectedPath, toolRevision, english])

  const selected = changes.find((change) => change.path === selectedPath) ?? null
  const rows = useMemo(() => parseDiff(selected?.diff ?? ''), [selected?.diff])
  const totals = useMemo(
    () =>
      changes.reduce(
        (acc, c) => ({ add: acc.add + c.additions, del: acc.del + c.deletions }),
        { add: 0, del: 0 }
      ),
    [changes]
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 16px 10px', flexShrink: 0 }}>
        <SectionLabel>
          {english ? 'CHANGES' : '改动'} · {changes.length} {english ? 'files' : '个文件'} · +{totals.add} −{totals.del}
          {branch ? ` · ${branch}` : ''}
          {lastUpdated ? ` · LIVE ${new Date(lastUpdated).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : ''}
        </SectionLabel>
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* 文件列表（1 份宽） */}
        <div
          style={{
            flex: '1 1 0',
            minWidth: 0,
            overflowY: 'auto',
            padding: '0 8px 16px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 2
          }}
        >
          {changes.map((c) => {
            const activeRow = c.path === selected?.path
            return (
              <button
                key={c.path}
                className="mission-row"
                onClick={() => setSelectedPath(c.path)}
                style={{
                  textAlign: 'left',
                  padding: '6px 8px',
                  borderRadius: 6,
                  background: activeRow ? 'var(--crater)' : 'transparent',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2
                }}
              >
                <span
                  className="mono"
                  style={{
                    fontSize: 11.5,
                    color: activeRow ? 'var(--moonlight)' : 'var(--dust)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                  title={c.path}
                >
                  {c.path}
                </span>
                <span className="mono" style={{ fontSize: 10.5, letterSpacing: '0.02em' }}>
                  {c.additions > 0 ? (
                    <span style={{ color: 'var(--signal)' }}>+{c.additions} </span>
                  ) : null}
                  {c.deletions > 0 ? (
                    <span style={{ color: 'var(--redshift)' }}>−{c.deletions} </span>
                  ) : null}
                  {STATUS_LABEL[c.status] ? (
                    <span style={{ color: 'var(--faint)' }}>{english ? (c.status === 'added' ? 'added' : 'deleted') : STATUS_LABEL[c.status]}</span>
                  ) : null}
                </span>
              </button>
            )
          })}
          {error ? (
            <p style={{ margin: '6px 8px', fontSize: 11, color: 'var(--faint)', lineHeight: 1.6 }}>
              {error}
            </p>
          ) : null}
          {!error && changes.length === 0 ? (
            <p style={{ margin: '6px 8px', fontSize: 11, color: 'var(--faint)' }}>{english ? 'No workspace changes.' : '工作区没有改动。'}</p>
          ) : null}
        </div>
        {/* diff 视图（2 份宽），等宽、行号、增删行 5% 底色，灰阶不着色 */}
        <div
          className="selectable"
          style={{
            flex: '2 1 0',
            minWidth: 0,
            overflow: 'auto',
            borderLeft: '1px solid var(--line)',
            paddingBottom: 16
          }}
        >
          <div style={{ minWidth: 'max-content' }}>
            {diffLoading ? (
              <p style={{ margin: 0, padding: '8px 12px', fontSize: 11, color: 'var(--faint)' }}>
                {english ? 'Loading this file diff…' : '正在读取当前文件改动…'}
              </p>
            ) : null}
            {selected && !diffLoading && selected.diff === '' ? (
              <p style={{ margin: 0, padding: '8px 12px', fontSize: 11, color: 'var(--faint)' }}>
                {english ? 'No text diff is available for this file.' : '此文件没有可显示的文本 diff。'}
              </p>
            ) : null}
            {rows.map((row, i) => {
              if (row.kind === 'hunk') {
                return (
                  <div
                    key={i}
                    className="mono"
                    style={{
                      padding: '4px 10px',
                      fontSize: 10.5,
                      color: 'var(--faint)',
                      letterSpacing: '0.02em',
                      whiteSpace: 'pre'
                    }}
                  >
                    {row.text}
                  </div>
                )
              }
              const bg =
                row.kind === 'add'
                  ? 'rgba(127, 182, 158, 0.05)'
                  : row.kind === 'del'
                    ? 'rgba(224, 106, 106, 0.05)'
                    : 'transparent'
              const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '
              return (
                <div
                  key={i}
                  className="mono"
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    background: bg,
                    fontSize: 11,
                    lineHeight: 1.7,
                    whiteSpace: 'pre',
                    color: row.kind === 'ctx' ? 'var(--dust)' : 'var(--moonlight)'
                  }}
                >
                  <LineNo n={row.oldNo} />
                  <LineNo n={row.newNo} />
                  <span style={{ paddingRight: 12 }}>
                    <span style={{ color: 'var(--faint)' }}>{sign} </span>
                    {row.text}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
