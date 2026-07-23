import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Attachment, Session } from '@shared/types'
import type { GitChange } from '@shared/ipc'
import { useFarsideStore } from '../../lib/store'
import { usePreferences } from '../../lib/preferences'

interface SummarySource {
  id: string
  kind: 'attachment' | 'link'
  label: string
  value?: string
}

const rowStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 34,
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '0 3px',
  color: 'var(--dust)',
  textAlign: 'left',
  borderRadius: 6
}

const subActionStyle: React.CSSProperties = {
  padding: '5px 9px',
  border: '1px solid var(--line)',
  borderRadius: 6,
  background: 'var(--mare)',
  color: 'var(--dust)',
  fontSize: 10.5
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <span style={{ width: 18, height: 18, flexShrink: 0, display: 'grid', placeItems: 'center', color: 'var(--faint)' }}>
      {children}
    </span>
  )
}

function attachmentSource(attachment: Attachment): SummarySource {
  return {
    id: `attachment:${attachment.id}`,
    kind: 'attachment',
    label: attachment.name
  }
}

function linkLabel(value: string): string {
  try {
    const url = new URL(value)
    const path = url.pathname.replace(/\/$/, '')
    return `${url.hostname}${path}` || value
  } catch {
    return value
  }
}

function collectSources(session: Session, pending: Attachment[], draft: string): SummarySource[] {
  const sources: SummarySource[] = []
  const seen = new Set<string>()
  const add = (source: SummarySource) => {
    const key = source.kind === 'link' ? source.value : source.label
    if (!key || seen.has(key)) return
    seen.add(key)
    sources.push(source)
  }

  for (const attachment of pending) add(attachmentSource(attachment))
  for (const event of session.events) {
    if (event.kind === 'user') {
      for (const attachment of event.attachments ?? []) add(attachmentSource(attachment))
    }
    const text = event.kind === 'user' ? event.text : event.kind === 'message' ? event.markdown : ''
    for (const match of text.matchAll(/https?:\/\/[^\s<>()\]]+/g)) {
      const value = match[0].replace(/[.,;:!?]+$/, '')
      add({ id: `link:${value}`, kind: 'link', label: linkLabel(value), value })
    }
  }
  for (const match of draft.matchAll(/https?:\/\/[^\s<>()\]]+/g)) {
    const value = match[0].replace(/[.,;:!?]+$/, '')
    add({ id: `draft-link:${value}`, kind: 'link', label: linkLabel(value), value })
  }
  return sources
}

function safeBranch(value: string): string | null {
  const branch = value.trim()
  if (
    !branch ||
    !/^[A-Za-z0-9._/@-]+$/.test(branch) ||
    branch.startsWith('-') ||
    branch.startsWith('.') ||
    branch.endsWith('.') ||
    branch.endsWith('/') ||
    branch.endsWith('.lock') ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.includes('@{') ||
    branch.includes('/.')
  ) return null
  return branch
}

export function EnvironmentSummary({ session }: { session: Session }) {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
  const containerRef = useRef<HTMLDivElement>(null)
  const refreshingRef = useRef(false)
  const [open, setOpen] = useState(false)
  const [changes, setChanges] = useState<GitChange[]>([])
  const [branch, setBranch] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [gitError, setGitError] = useState<string | null>(null)
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const [gitActionsOpen, setGitActionsOpen] = useState(false)
  const [sourceActionsOpen, setSourceActionsOpen] = useState(false)
  const [showAllSources, setShowAllSources] = useState(false)
  const attachments = useFarsideStore((state) => state.attachments)
  const draft = useFarsideStore((state) => state.draft)
  const setDraft = useFarsideStore((state) => state.setDraft)
  const newProject = useFarsideStore((state) => state.newProject)
  const runInTerminal = useFarsideStore((state) => state.runInTerminal)
  const sources = useMemo(
    () => collectSources(session, attachments, draft),
    [attachments, draft, session]
  )
  const visibleSources = showAllSources ? sources : sources.slice(0, 4)
  const totals = useMemo(
    () => changes.reduce(
      (sum, change) => ({
        additions: sum.additions + change.additions,
        deletions: sum.deletions + change.deletions
      }),
      { additions: 0, deletions: 0 }
    ),
    [changes]
  )
  const toolRevision = session.events
    .filter((event) => event.kind === 'instrument')
    .map((event) => `${event.id}:${event.status}`)
    .join('|')

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  useEffect(() => {
    if (!open || !window.api?.agent) return
    let alive = true
    const refresh = async () => {
      if (refreshingRef.current) return
      refreshingRef.current = true
      setLoading(true)
      try {
        const result = await window.api?.agent.getGitChanges(session.id)
        if (!alive || !result) return
        if (result.ok) {
          setChanges(result.changes)
          setBranch(result.branch ?? null)
          setGitError(null)
        } else {
          setChanges([])
          setBranch(null)
          setGitError(result.error ?? (english ? 'Git status unavailable' : 'Git 状态不可用'))
        }
      } catch (reason) {
        if (alive) setGitError(reason instanceof Error ? reason.message : (english ? 'Git status unavailable' : 'Git 状态不可用'))
      } finally {
        refreshingRef.current = false
        if (alive) setLoading(false)
      }
    }
    void refresh()
    const interval = window.setInterval(refresh, 4_000)
    return () => {
      alive = false
      window.clearInterval(interval)
    }
  }, [english, open, session.id, toolRevision])

  const runCommand = (command: string) => {
    setOpen(false)
    runInTerminal(command)
  }

  const switchBranch = () => {
    const requested = window.prompt(english ? 'Branch to switch to' : '输入要切换到的分支')
    if (requested === null) return
    const target = safeBranch(requested)
    if (!target) {
      window.alert(english ? 'Invalid branch name.' : '分支名称无效。')
      return
    }
    runCommand(`git switch ${target}`)
  }

  const compareBranch = () => {
    const requested = window.prompt(english ? 'Branch to compare with' : '输入要比较的分支', branch === 'main' ? 'origin/main' : 'main')
    if (requested === null) return
    const target = safeBranch(requested)
    if (!target) {
      window.alert(english ? 'Invalid branch name.' : '分支名称无效。')
      return
    }
    runCommand(`git diff --stat ${target}...HEAD`)
  }

  const addLink = () => {
    const entered = window.prompt(english ? 'Add a source URL to the current prompt' : '输入要加入当前指令的来源链接')
    if (entered === null) return
    let value: string
    try {
      const url = new URL(entered.trim())
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
      value = url.href
    } catch {
      window.alert(english ? 'Enter a valid HTTP(S) URL.' : '请输入有效的 HTTP(S) 链接。')
      return
    }
    setDraft(`${draft.trimEnd()}${draft.trim() ? '\n' : ''}${value}`)
    setOpen(false)
    window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('textarea')?.focus(), 0)
  }

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={english ? 'Environment summary' : '环境摘要'}
        aria-expanded={open}
        title={english ? 'Environment summary' : '环境摘要'}
        style={{
          width: 28,
          height: 28,
          display: 'grid',
          placeItems: 'center',
          border: `1px solid ${open ? 'var(--line-hi)' : 'transparent'}`,
          borderRadius: 6,
          background: open ? 'var(--regolith)' : 'transparent',
          color: open ? 'var(--moonlight)' : 'var(--faint)',
          transition: 'background 150ms var(--ease-farside), border-color 150ms var(--ease-farside), color 150ms var(--ease-farside)'
        }}
      >
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
          <circle cx="4" cy="4" r="1.25" stroke="currentColor" />
          <circle cx="4" cy="11" r="1.25" stroke="currentColor" />
          <path d="M7.3 4h5.2M7.3 11h5.2" stroke="currentColor" strokeLinecap="round" />
        </svg>
      </button>

      {open ? (
        <section
          className="environment-summary"
          aria-label={english ? 'Environment information' : '环境信息'}
          style={{
            position: 'absolute',
            zIndex: 80,
            top: 36,
            right: -68,
            width: 326,
            maxHeight: 'min(620px, calc(100vh - 96px))',
            overflowY: 'auto',
            padding: '14px 15px 12px',
            border: '1px solid var(--line-hi)',
            borderRadius: 12,
            background: 'color-mix(in srgb, var(--regolith) 96%, var(--void))',
            boxShadow: '0 22px 64px rgba(0, 0, 0, .5)',
            color: 'var(--dust)'
          }}
        >
          <div style={{ minHeight: 28, display: 'flex', alignItems: 'center', color: 'var(--faint)', fontSize: 12 }}>
            <span>{english ? 'ENVIRONMENT' : '环境信息'}</span>
            <button
              onClick={() => {
                setOpen(false)
                newProject()
              }}
              aria-label={english ? 'Add environment' : '添加环境'}
              title={english ? 'Open another project' : '打开其他项目'}
              style={{ marginLeft: 'auto', width: 24, height: 24, display: 'grid', placeItems: 'center', color: 'var(--faint)', fontSize: 20 }}
            >
              +
            </button>
          </div>

          <button
            style={rowStyle}
            onClick={() => {
              useFarsideStore.setState({ missionOpen: true, missionTab: 'diff' })
              setOpen(false)
            }}
          >
            <Icon>
              <svg width="17" height="17" viewBox="0 0 17 17" fill="none"><rect x="2.5" y="2.5" width="12" height="12" rx="2.5" stroke="currentColor" /><path d="M6 6.5h5M6 9h5M6 11.5h3" stroke="currentColor" /></svg>
            </Icon>
            <span>{english ? 'Changes' : '改动'}</span>
            <span className="mono" style={{ marginLeft: 'auto', fontSize: 11 }}>
              {loading && !changes.length ? (
                <span style={{ color: 'var(--ghost)' }}>…</span>
              ) : (
                <>
                  <span style={{ color: 'var(--signal)' }}>+{totals.additions}</span>{' '}
                  <span style={{ color: 'var(--redshift)' }}>−{totals.deletions}</span>
                </>
              )}
            </span>
          </button>

          <button style={rowStyle} onClick={() => void window.api?.workspace.open(session.cwd)} title={session.cwd}>
            <Icon>
              <svg width="17" height="17" viewBox="0 0 17 17" fill="none"><path d="M2.5 4.5h12v8h-12zM1.5 14h14" stroke="currentColor" strokeLinejoin="round" /></svg>
            </Icon>
            <span>{english ? 'Local' : '本地'}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--ghost)' }}>↗</span>
          </button>

          <button style={rowStyle} onClick={() => setBranchMenuOpen((value) => !value)} aria-expanded={branchMenuOpen}>
            <Icon>
              <svg width="17" height="17" viewBox="0 0 17 17" fill="none"><circle cx="5" cy="3.5" r="1.7" stroke="currentColor" /><circle cx="5" cy="13.5" r="1.7" stroke="currentColor" /><circle cx="12.5" cy="5.5" r="1.7" stroke="currentColor" /><path d="M5 5.2v6.6M6.7 8.5h1.5a4.3 4.3 0 0 0 4.3-1.3" stroke="currentColor" /></svg>
            </Icon>
            <span className="mono" style={{ fontSize: 11.5 }}>{branch ?? (gitError ? (english ? 'Not a Git repository' : '非 Git 目录') : '—')}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--ghost)' }}>{branchMenuOpen ? '⌃' : '⌄'}</span>
          </button>
          {branchMenuOpen && branch ? (
            <div style={{ display: 'flex', gap: 6, padding: '2px 3px 7px 31px' }}>
              <button style={subActionStyle} onClick={() => runCommand('git branch --all')}>{english ? 'List branches' : '查看分支'}</button>
              <button style={subActionStyle} onClick={switchBranch}>{english ? 'Switch…' : '切换…'}</button>
            </div>
          ) : null}

          <button style={rowStyle} disabled={!branch} onClick={() => setGitActionsOpen((value) => !value)} aria-expanded={gitActionsOpen}>
            <Icon>
              <svg width="17" height="17" viewBox="0 0 17 17" fill="none"><circle cx="3" cy="8.5" r="1.5" stroke="currentColor" /><circle cx="14" cy="8.5" r="1.5" stroke="currentColor" /><path d="M4.5 8.5h8" stroke="currentColor" /></svg>
            </Icon>
            <span>{english ? 'Commit or push' : '提交或推送'}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--ghost)' }}>{gitActionsOpen ? '⌃' : '⌄'}</span>
          </button>
          {gitActionsOpen && branch ? (
            <div style={{ display: 'flex', gap: 6, padding: '2px 3px 7px 31px' }}>
              <button style={subActionStyle} onClick={() => runCommand('git add -A && git commit')}>{english ? 'Commit…' : '提交…'}</button>
              <button style={subActionStyle} onClick={() => runCommand('git push')}>{english ? 'Push' : '推送'}</button>
            </div>
          ) : null}

          <button style={rowStyle} disabled={!branch} onClick={compareBranch}>
            <Icon>
              <svg width="17" height="17" viewBox="0 0 17 17" fill="none"><path d="M3 12.5 12.5 3M7.5 3h5v5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </Icon>
            <span>{english ? 'Compare branch' : '比较分支'}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--ghost)' }}>↗</span>
          </button>

          {gitError ? (
            <div style={{ padding: '3px 3px 7px 31px', fontSize: 9.5, lineHeight: 1.45, color: 'var(--ghost)' }}>{gitError}</div>
          ) : null}

          <div style={{ height: 1, margin: '9px 0 10px', background: 'var(--line)' }} />

          <div style={{ minHeight: 28, display: 'flex', alignItems: 'center', color: 'var(--faint)', fontSize: 12 }}>
            <span>{english ? 'SOURCES' : '来源'}</span>
            <button
              onClick={() => setSourceActionsOpen((value) => !value)}
              aria-label={english ? 'Add source' : '添加来源'}
              aria-expanded={sourceActionsOpen}
              style={{ marginLeft: 'auto', width: 24, height: 24, display: 'grid', placeItems: 'center', color: 'var(--faint)', fontSize: 20 }}
            >
              +
            </button>
          </div>
          {sourceActionsOpen ? (
            <div style={{ display: 'flex', gap: 6, padding: '0 3px 7px' }}>
              <button
                style={subActionStyle}
                onClick={() => {
                  document.querySelector<HTMLButtonElement>('button[aria-label="添加附件"], button[aria-label="Add attachment"]')?.click()
                  setOpen(false)
                }}
              >
                {english ? 'Image / video' : '图片或视频'}
              </button>
              <button style={subActionStyle} onClick={addLink}>{english ? 'Link…' : '链接…'}</button>
            </div>
          ) : null}

          <div style={{ display: 'grid', gap: 1 }}>
            {visibleSources.map((source) => (
              <button
                key={source.id}
                disabled={!source.value}
                onClick={() => source.value && window.open(source.value, '_blank', 'noopener')}
                title={source.value ?? source.label}
                style={{ ...rowStyle, color: 'var(--faint)' }}
              >
                <Icon>
                  {source.kind === 'link' ? (
                    <svg width="17" height="17" viewBox="0 0 17 17" fill="none"><path d="M7 10 5.5 11.5a2.8 2.8 0 1 1-4-4L4 5a2.8 2.8 0 0 1 4 0M10 7l1.5-1.5a2.8 2.8 0 1 1 4 4L13 12a2.8 2.8 0 0 1-4 0M5.8 11.2l5.4-5.4" stroke="currentColor" strokeLinecap="round" /></svg>
                  ) : (
                    <svg width="17" height="17" viewBox="0 0 17 17" fill="none"><rect x="3" y="1.8" width="11" height="13.4" rx="1.8" stroke="currentColor" /><path d="M5.5 5h6M5.5 8h6M5.5 11h4" stroke="currentColor" /></svg>
                  )}
                </Icon>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{source.label}</span>
                {source.value ? <span style={{ marginLeft: 'auto', color: 'var(--ghost)' }}>↗</span> : null}
              </button>
            ))}
            {!sources.length ? (
              <div style={{ padding: '8px 3px 7px 31px', color: 'var(--ghost)', fontSize: 10.5 }}>
                {english ? 'Attachments and links used in this session appear here.' : '本会话使用过的附件和链接会显示在这里。'}
              </div>
            ) : null}
          </div>
          {sources.length > 4 ? (
            <button onClick={() => setShowAllSources((value) => !value)} style={{ ...rowStyle, color: 'var(--ghost)' }}>
              <Icon>
                <svg width="17" height="17" viewBox="0 0 17 17" fill="none"><circle cx="4" cy="11.5" r="1.5" stroke="currentColor" /><circle cx="8.5" cy="8.5" r="1.5" stroke="currentColor" /><circle cx="13" cy="5.5" r="1.5" stroke="currentColor" /><path d="m5.3 10.6 1.9-1.2M9.8 7.6l1.9-1.2" stroke="currentColor" /></svg>
              </Icon>
              <span>{showAllSources ? (english ? 'Show less' : '收起') : (english ? `View all (${sources.length})` : `查看全部（${sources.length}）`)}</span>
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
