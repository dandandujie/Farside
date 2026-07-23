import { useMemo, useState, type ReactNode } from 'react'
import type { WorkspaceInfo } from '@shared/ipc'
import type { Session } from '@shared/types'
import type { MoonPhase as MoonPhaseValue } from '@shared/types'
import { useFarsideStore } from '../../lib/store'
import { MoonPhase } from '../../design-system/MoonPhase'
import { SectionLabel } from '../../design-system/SectionLabel'
import { PrismLine } from '../../design-system/PrismLine'
import { ResizeHandle, usePersistentWidth } from '../shell/ResizeHandle'
import { usePreferences } from '../../lib/preferences'

function relativeTime(at: number, english: boolean): string {
  const minutes = Math.floor((Date.now() - at) / 60_000)
  if (minutes < 1) return english ? 'just now' : '刚刚'
  if (minutes < 60) return english ? `${minutes}m ago` : `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? (english ? `${hours}h ago` : `${hours} 小时前`) : (english ? `${Math.floor(hours / 24)}d ago` : `${Math.floor(hours / 24)} 天前`)
}

function sessionStatus(phase: MoonPhaseValue, english: boolean): { label: string; active: boolean } {
  const labels: Record<MoonPhaseValue, [string, string]> = {
    new: ['已完成', 'Completed'],
    waxing: ['已接收', 'Queued'],
    'first-quarter': ['思考中', 'Thinking'],
    gibbous: ['执行中', 'Running'],
    full: ['等待确认', 'Awaiting approval'],
    waning: ['收尾中', 'Wrapping up']
  }
  return { label: labels[phase][english ? 1 : 0], active: phase !== 'new' }
}

function projectRootLabel(root: string): string {
  const parts = root.replaceAll('\\', '/').split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}

function Menu({ children }: { children: ReactNode }) {
  return (
    <div
      onClick={(event) => event.stopPropagation()}
      style={{
        position: 'absolute',
        zIndex: 50,
        top: 'calc(100% - 2px)',
        right: 7,
        minWidth: 138,
        padding: 5,
        border: '1px solid var(--line-hi)',
        borderRadius: 8,
        background: 'var(--regolith)',
        boxShadow: '0 12px 34px rgba(0,0,0,.35)'
      }}
    >
      {children}
    </div>
  )
}

function MenuItem({ label, danger, onClick }: { label: string; danger?: boolean; onClick(): void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        padding: '6px 9px',
        borderRadius: 5,
        textAlign: 'left',
        fontSize: 11.5,
        color: danger ? 'var(--redshift)' : 'var(--dust)'
      }}
      onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--crater)' }}
      onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent' }}
    >
      {label}
    </button>
  )
}

function ProjectHeader({
  project,
  count,
  pinned,
  archived,
  menuOpen,
  setMenuOpen,
  renaming,
  renameDraft,
  setRenameDraft,
  commitRename
}: {
  project: WorkspaceInfo
  count: number
  pinned: boolean
  archived: boolean
  menuOpen: boolean
  setMenuOpen(open: boolean): void
  renaming: boolean
  renameDraft: string
  setRenameDraft(value: string): void
  commitRename(): void
}) {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
  const renameProject = useFarsideStore((state) => state.renameProject)
  const openProject = useFarsideStore((state) => state.openProject)
  const removeProject = useFarsideStore((state) => state.removeProject)
  const togglePinProject = useFarsideStore((state) => state.togglePinProject)
  const toggleArchiveProject = useFarsideStore((state) => state.toggleArchiveProject)
  return (
    <div className="project-header" data-archived={archived || undefined}>
      {renaming ? (
        <input
          autoFocus
          value={renameDraft}
          onChange={(event) => setRenameDraft(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitRename()
            if (event.key === 'Escape') renameProject(project.id, project.name)
          }}
          style={{ flex: 1, minWidth: 0, padding: '3px 5px', border: '1px solid var(--line-hi)', borderRadius: 5, background: 'var(--crater)', color: 'var(--moonlight)', fontSize: 12.5 }}
        />
      ) : (
        <span title={project.root} style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="project-header__name">
              {pinned ? '◆ ' : ''}{project.name}
            </span>
            <span className="project-header__count mono">
              {count}
            </span>
          </span>
          <span className="project-header__root mono">
            {projectRootLabel(project.root)}
          </span>
        </span>
      )}
      <button aria-label={`${project.name} 项目操作`} onClick={() => setMenuOpen(!menuOpen)} style={{ width: 24, height: 22, color: 'var(--faint)', fontSize: 15 }}>···</button>
      {menuOpen ? (
        <Menu>
          <MenuItem label={pinned ? (english ? 'Unpin project' : '取消置顶') : (english ? 'Pin project' : '置顶项目')} onClick={() => { togglePinProject(project.id); setMenuOpen(false) }} />
          <MenuItem label={english ? 'Open in Explorer' : '在资源管理器中打开'} onClick={() => { openProject(project.root); setMenuOpen(false) }} />
          <MenuItem label={english ? 'Rename project' : '重命名项目'} onClick={() => { setRenameDraft(project.name); setMenuOpen(false) }} />
          <MenuItem label={archived ? (english ? 'Unarchive' : '移出归档') : (english ? 'Archive project' : '归档项目')} onClick={() => { toggleArchiveProject(project.id); setMenuOpen(false) }} />
          <MenuItem danger label={english ? 'Remove from Farside' : '从 Farside 移除'} onClick={() => {
            setMenuOpen(false)
            if (window.confirm(`从 Farside 移除“${project.name}”？磁盘文件不会被删除。`)) removeProject(project.id, project.root)
          }} />
        </Menu>
      ) : null}
    </div>
  )
}

/** 项目/会话轨道：项目与会话各自提供置顶、归档和管理动作。 */
export function SessionList() {
  const { locale, t } = usePreferences()
  const english = locale === 'en-US'
  const sessions = useFarsideStore((state) => state.sessions)
  const projects = useFarsideStore((state) => state.projects)
  const activeId = useFarsideStore((state) => state.activeSessionId)
  const pinnedSessions = useFarsideStore((state) => state.pinnedSessionIds)
  const pinnedProjects = useFarsideStore((state) => state.pinnedProjectIds)
  const archivedProjects = useFarsideStore((state) => state.archivedProjectIds)
  const setActive = useFarsideStore((state) => state.setActiveSession)
  const setView = useFarsideStore((state) => state.setView)
  const newProject = useFarsideStore((state) => state.newProject)
  const renameSession = useFarsideStore((state) => state.renameSession)
  const forkSession = useFarsideStore((state) => state.forkSession)
  const exportSession = useFarsideStore((state) => state.exportSession)
  const archiveSession = useFarsideStore((state) => state.archiveSession)
  const togglePinSession = useFarsideStore((state) => state.togglePinSession)
  const [width, setWidth] = usePersistentWidth('sessions', 252, 210, 480)
  const [query, setQuery] = useState('')
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [renamingSession, setRenamingSession] = useState<string | null>(null)
  const [renamingProject, setRenamingProject] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    return projects
      .map((project) => ({
        project,
        sessions: sessions
          .filter((session) => !session.archived && (session.workspaceId === project.id || session.cwd === project.root))
          .filter((session) => !q || session.title.toLowerCase().includes(q) || project.name.toLowerCase().includes(q))
          .sort((a, b) => Number(pinnedSessions.includes(b.id)) - Number(pinnedSessions.includes(a.id)) || b.updatedAt - a.updatedAt)
      }))
      .filter(({ project, sessions }) => sessions.length > 0 || !q || project.name.toLowerCase().includes(q))
      .sort((a, b) => Number(pinnedProjects.includes(b.project.id)) - Number(pinnedProjects.includes(a.project.id)) || b.project.lastOpenedAt - a.project.lastOpenedAt)
  }, [projects, sessions, query, pinnedProjects, pinnedSessions])

  const renderSession = (session: Session) => {
    const active = session.id === activeId
    const renaming = session.id === renamingSession
    const status = sessionStatus(session.phase, english)
    return (
      <div
        key={session.id}
        role="button"
        tabIndex={0}
        onClick={() => { if (!renaming) { setActive(session.id); setView('sessions') } }}
        onKeyDown={(event) => { if (!renaming && (event.key === 'Enter' || event.key === ' ')) setActive(session.id) }}
        style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: 9, padding: '7px 9px 7px 14px', cursor: 'pointer', background: active ? 'var(--regolith)' : 'transparent' }}
        onMouseEnter={(event) => { if (!active) event.currentTarget.style.background = 'var(--crater)' }}
        onMouseLeave={(event) => { if (!active) event.currentTarget.style.background = 'transparent' }}
      >
        {active ? <span aria-hidden style={{ position: 'absolute', inset: '0 auto 0 0' }}><PrismLine direction="vertical" /></span> : null}
        <span
          title={status.label}
          style={{ width: 24, height: 24, marginTop: 1, display: 'grid', placeItems: 'center', flexShrink: 0, borderRadius: '50%', background: status.active ? 'color-mix(in srgb, var(--moonlight) 7%, transparent)' : 'transparent' }}
        >
          <MoonPhase phase={session.phase} size={18} title={status.label} active={status.active} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          {renaming ? (
            <input
              autoFocus
              value={renameDraft}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => setRenameDraft(event.target.value)}
              onBlur={() => { if (renameDraft.trim()) renameSession(session.id, renameDraft.trim()); setRenamingSession(null) }}
              onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setRenamingSession(null) }}
              style={{ width: '100%', padding: '2px 4px', border: '1px solid var(--line-hi)', borderRadius: 5, background: 'var(--crater)', color: 'var(--moonlight)', fontSize: 12 }}
            />
          ) : <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5, color: active ? 'var(--moonlight)' : 'var(--dust)' }}>{pinnedSessions.includes(session.id) ? '◆ ' : ''}{session.title}</span>}
          <span className="mono" style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2, fontSize: 10.5, color: 'var(--faint)' }}>
            <span>{relativeTime(session.updatedAt, english)} · {session.contextTokens >= 1000 ? `${Math.round(session.contextTokens / 1000)}K` : session.contextTokens} tok</span>
            <span style={{ marginLeft: 'auto', color: status.active ? 'var(--moonlight)' : 'var(--faint)' }}>{status.label}</span>
          </span>
        </span>
        {!renaming ? <button aria-label="会话操作" onClick={(event) => { event.stopPropagation(); setOpenMenu(openMenu === `s:${session.id}` ? null : `s:${session.id}`) }} style={{ width: 22, height: 20, color: 'var(--faint)', fontSize: 14 }}>···</button> : null}
        {openMenu === `s:${session.id}` ? (
          <Menu>
            <MenuItem label={pinnedSessions.includes(session.id) ? (english ? 'Unpin' : '取消置顶') : (english ? 'Pin session' : '置顶会话')} onClick={() => { togglePinSession(session.id); setOpenMenu(null) }} />
            <MenuItem label={t('重命名')} onClick={() => { setRenameDraft(session.title); setRenamingSession(session.id); setOpenMenu(null) }} />
            <MenuItem label={english ? 'Fork session' : '分叉会话'} onClick={() => { forkSession(session.id); setOpenMenu(null) }} />
            <MenuItem label={english ? 'Export session' : '导出会话'} onClick={() => { exportSession(session.id); setOpenMenu(null) }} />
            <MenuItem danger label={english ? 'Archive session' : '归档会话'} onClick={() => { archiveSession(session.id); setOpenMenu(null) }} />
          </Menu>
        ) : null}
      </div>
    )
  }

  const visible = groups.filter(({ project }) => !archivedProjects.includes(project.id))
  const archived = groups.filter(({ project }) => archivedProjects.includes(project.id))

  return (
    <aside style={{ width, position: 'relative', flexShrink: 0, display: 'flex', flexDirection: 'column', background: 'var(--mare)', borderRight: '1px solid var(--line)', minHeight: 0 }}>
      <ResizeHandle edge="right" onDrag={(delta) => setWidth(width + delta)} />
      <div style={{ padding: '12px 13px 9px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <SectionLabel>Sessions · 任务轨道</SectionLabel>
          <button onClick={newProject} style={{ flexShrink: 0, whiteSpace: 'nowrap', padding: '3px 8px', border: '1px solid var(--line)', borderRadius: 6, color: 'var(--dust)', fontSize: 11 }}>＋ {t('新项目')}</button>
        </div>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索项目或会话…')} spellCheck={false} style={{ width: '100%', marginTop: 8, padding: '5px 8px', border: '1px solid var(--line)', borderRadius: 6, background: 'var(--regolith)', color: 'var(--moonlight)', fontSize: 12 }} />
      </div>
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 12 }}>
        {!visible.length && !archived.length ? <p style={{ padding: '8px 14px', color: 'var(--faint)', fontSize: 12 }}>{english ? 'No matching projects or sessions.' : '没有匹配的项目或会话。'}</p> : null}
        {visible.map(({ project, sessions: list }) => (
          <section key={project.id} style={{ marginBottom: 5 }}>
            <ProjectHeader
              project={project}
              count={list.length}
              pinned={pinnedProjects.includes(project.id)}
              archived={false}
              menuOpen={openMenu === `p:${project.id}`}
              setMenuOpen={(open) => setOpenMenu(open ? `p:${project.id}` : null)}
              renaming={renamingProject === project.id}
              renameDraft={renameDraft}
              setRenameDraft={(value) => { setRenameDraft(value); if (renamingProject !== project.id) setRenamingProject(project.id) }}
              commitRename={() => { if (renameDraft.trim()) useFarsideStore.getState().renameProject(project.id, renameDraft.trim()); setRenamingProject(null) }}
            />
            {list.map(renderSession)}
          </section>
        ))}
        {archived.length ? (
          <section style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
            <div className="mono" style={{ padding: '3px 13px 7px', fontSize: 10, color: 'var(--ghost)', letterSpacing: '0.08em' }}>{english ? 'ARCHIVED PROJECTS' : '已归档项目'} · {archived.length}</div>
            {archived.map(({ project, sessions: list }) => (
              <ProjectHeader
                key={project.id}
                project={project}
                count={list.length}
                pinned={false}
                archived
                menuOpen={openMenu === `p:${project.id}`}
                setMenuOpen={(open) => setOpenMenu(open ? `p:${project.id}` : null)}
                renaming={renamingProject === project.id}
                renameDraft={renameDraft}
                setRenameDraft={(value) => { setRenameDraft(value); if (renamingProject !== project.id) setRenamingProject(project.id) }}
                commitRename={() => { if (renameDraft.trim()) useFarsideStore.getState().renameProject(project.id, renameDraft.trim()); setRenamingProject(null) }}
              />
            ))}
          </section>
        ) : null}
      </div>
    </aside>
  )
}
