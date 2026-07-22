import { create } from 'zustand'
import type { AccountConfigureInput, AgentUpdate, WorkspaceInfo } from '@shared/ipc'
import type {
  AccountState,
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  GoalState,
  ModelId,
  PermissionMode,
  QuestionAnswer,
  QuestionRequest,
  QuotaInfo,
  Session,
  TrajectoryEvent
} from '@shared/types'
import { MODELS } from '@shared/types'
import { MOCK_APPROVAL, MOCK_SESSIONS } from './mock'

export type RailView = 'sessions' | 'terminal' | 'goals' | 'settings'
export type MissionTab = 'diff' | 'telemetry' | 'files' | 'preview'

export interface PreviewDocument {
  title: string
  path?: string
  content: string
  kind: 'markdown' | 'html' | 'image' | 'text' | 'url'
  mime?: string
  encoding?: 'utf8' | 'base64'
}

interface FarsideState {
  sessions: Session[]
  activeSessionId: string | null
  initialized: boolean
  connected: boolean
  authReady: boolean | null
  account: AccountState | null
  refreshAccount(): Promise<void>
  logoutAccount(): Promise<void>
  configureAccount(input: AccountConfigureInput): Promise<boolean>
  lastError: string | null
  initialize(): Promise<void>
  setActiveSession(id: string): void
  newSession(): void
  renameSession(id: string, title: string): void
  forkSession(id: string): void
  exportSession(id: string): void
  archiveSession(id: string): void
  togglePinSession(id: string): void
  pinnedSessionIds: string[]

  projects: WorkspaceInfo[]
  newProject(): void
  renameProject(id: string, name: string): void
  openProject(root: string): void
  removeProject(id: string, root: string): void
  togglePinProject(id: string): void
  toggleArchiveProject(id: string): void
  pinnedProjectIds: string[]
  archivedProjectIds: string[]

  view: RailView
  setView(view: RailView): void
  pendingTerminalCommand: { id: number; command: string } | null
  runInTerminal(command: string): void
  consumeTerminalCommand(id: number): void
  sidebarOpen: boolean
  toggleSidebar(): void
  missionOpen: boolean
  toggleMission(): void
  missionTab: MissionTab
  setMissionTab(tab: MissionTab): void
  preview: PreviewDocument | null
  openPreview(preview: PreviewDocument): void
  closePreview(): void
  paletteOpen: boolean
  setPaletteOpen(open: boolean): void

  draft: string
  setDraft(text: string): void
  attachments: Attachment[]
  addAttachment(a: Attachment): void
  removeAttachment(id: string): void
  clearAttachments(): void
  model: ModelId
  setModel(m: ModelId): void
  permissionMode: PermissionMode
  setPermissionMode(m: PermissionMode): void
  cyclePermissionMode(): void
  planMode: boolean
  togglePlanMode(): void
  swarmMode: boolean
  setSwarmMode(enabled: boolean): void
  abortCurrent(): void
  undoLastTurn(): void
  editLastPrompt(): void
  sending: boolean
  send(fileRefs?: string[]): void

  composerBySession: Record<string, SessionComposerState>

  approvalQueue: ApprovalRequest[]
  resolveApproval(id: string, decision?: ApprovalDecision, feedback?: string): void
  questionQueue: QuestionRequest[]
  resolveQuestion(id: string, answers: Record<string, QuestionAnswer>): void

  goal: GoalState | null
  pauseGoal(): void
  resumeGoal(): void
  cancelGoal(): void

  quota: QuotaInfo
  booted: boolean
  setBooted(): void
  applyAgentUpdate(update: AgentUpdate): void
}

interface SessionComposerState {
  draft: string
  attachments: Attachment[]
  model: ModelId
  permissionMode: PermissionMode
  planMode: boolean
  swarmMode: boolean
}

let removeAgentListener: (() => void) | null = null
const visualPreview = new URLSearchParams(window.location.search).has('shot')

function readPreference(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(`farside:${key}`) || '[]') as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function togglePreference(key: string, values: string[], id: string): string[] {
  const next = values.includes(id) ? values.filter((value) => value !== id) : [...values, id]
  localStorage.setItem(`farside:${key}`, JSON.stringify(next))
  return next
}

function readSessionComposer(sessionId: string, fallbackModel: ModelId): SessionComposerState {
  const fallback: SessionComposerState = {
    draft: '',
    attachments: [],
    model: fallbackModel,
    permissionMode: 'manual',
    planMode: false,
    swarmMode: false
  }
  try {
    const raw = JSON.parse(localStorage.getItem(`farside:session-composer:${sessionId}`) || 'null') as Partial<SessionComposerState> | null
    if (!raw) return fallback
    return {
      ...fallback,
      draft: typeof raw.draft === 'string' ? raw.draft : '',
      model: typeof raw.model === 'string' && raw.model ? raw.model : fallbackModel,
      permissionMode: ['manual', 'auto', 'yolo'].includes(raw.permissionMode ?? '') ? raw.permissionMode as PermissionMode : 'manual',
      planMode: raw.planMode === true,
      swarmMode: raw.swarmMode === true
    }
  } catch {
    return fallback
  }
}

function persistSessionComposer(sessionId: string, composer: SessionComposerState): void {
  try {
    // 附件二进制只保留在当前进程内，避免把图片写入 localStorage。
    localStorage.setItem(`farside:session-composer:${sessionId}`, JSON.stringify({
      draft: composer.draft,
      model: composer.model,
      permissionMode: composer.permissionMode,
      planMode: composer.planMode,
      swarmMode: composer.swarmMode
    }))
  } catch {
    // localStorage 不可用时仍保留内存态。
  }
}

function composerPatch(
  state: FarsideState,
  patch: Partial<SessionComposerState>
): Partial<FarsideState> {
  const id = state.activeSessionId
  if (!id) return patch
  return composerPatchForSession(state, id, patch)
}

function composerPatchForSession(
  state: FarsideState,
  id: string,
  patch: Partial<SessionComposerState>
): Partial<FarsideState> {
  const current: SessionComposerState = state.composerBySession[id]
    ? state.composerBySession[id]
    : {
        ...readSessionComposer(id, state.sessions.find((session) => session.id === id)?.model ?? state.model),
        ...(state.activeSessionId === id ? {
          draft: state.draft,
          attachments: state.attachments,
          model: state.model,
          permissionMode: state.permissionMode,
          planMode: state.planMode,
          swarmMode: state.swarmMode
        } : {})
      }
  const next = { ...current, ...patch }
  persistSessionComposer(id, next)
  return {
    ...(state.activeSessionId === id ? patch : {}),
    composerBySession: { ...state.composerBySession, [id]: next }
  }
}

function mockProjects(): WorkspaceInfo[] {
  return [...new Map(MOCK_SESSIONS.map((session) => [session.cwd, session])).values()].map((session, index) => ({
    id: `mock-workspace-${index + 1}`,
    root: session.cwd,
    name: session.project,
    isGitRepo: true,
    branch: 'main',
    createdAt: session.updatedAt,
    lastOpenedAt: session.updatedAt,
    sessionCount: MOCK_SESSIONS.filter((item) => item.cwd === session.cwd).length
  }))
}

function quotaFromAccount(account: AccountState | null): QuotaInfo {
  return {
    weekUsedPct: account?.usage?.weekly?.usedPct ?? 0,
    fiveHourUsedPct: account?.usage?.fiveHour?.usedPct ?? 0,
    extraBalanceCny: account?.usage?.extraBalanceCny ?? null
  }
}

function mergeEvent(
  existing: TrajectoryEvent | undefined,
  incoming: TrajectoryEvent,
  appendText: boolean
): TrajectoryEvent {
  if (!existing || existing.kind !== incoming.kind) return incoming
  if (appendText && existing.kind === 'transmission' && incoming.kind === 'transmission') {
    return {
      ...existing,
      ...incoming,
      at: existing.at,
      text: existing.text + incoming.text,
      durationMs: Math.max(existing.durationMs, incoming.durationMs)
    }
  }
  if (appendText && existing.kind === 'message' && incoming.kind === 'message') {
    return { ...existing, ...incoming, at: existing.at, markdown: existing.markdown + incoming.markdown }
  }
  if (existing.kind === 'instrument' && incoming.kind === 'instrument') {
    return {
      ...existing,
      ...incoming,
      at: existing.at,
      tool: incoming.tool === 'Tool' ? existing.tool : incoming.tool,
      argsSummary: incoming.argsSummary || existing.argsSummary,
      output: incoming.output ?? existing.output
    }
  }
  if (existing.kind === 'transmission' && incoming.kind === 'transmission') {
    return {
      ...existing,
      ...incoming,
      at: existing.at,
      text: incoming.text || existing.text,
      durationMs: Math.max(existing.durationMs, incoming.durationMs)
    }
  }
  if (existing.kind === 'satellite' && incoming.kind === 'satellite') {
    return {
      ...existing,
      ...incoming,
      at: existing.at,
      satelliteKind:
        incoming.satelliteKind === 'coder' ? existing.satelliteKind : incoming.satelliteKind,
      task: incoming.task === '子代理任务' ? existing.task : incoming.task,
      startedAt: incoming.startedAt ?? existing.startedAt,
      durationMs: Math.max(existing.durationMs ?? 0, incoming.durationMs ?? 0) || undefined,
      toolCount: Math.max(existing.toolCount ?? 0, incoming.toolCount ?? 0),
      contextTokens: Math.max(existing.contextTokens ?? 0, incoming.contextTokens ?? 0) || undefined,
      tokens: Math.max(existing.tokens ?? 0, incoming.tokens ?? 0) || undefined,
      latestActivity: incoming.latestActivity || existing.latestActivity,
      result: incoming.result ?? (incoming.status === 'in-orbit' ? undefined : existing.result)
    }
  }
  return { ...existing, ...incoming, at: existing.at } as TrajectoryEvent
}

function upsertSession(list: Session[], session: Session): Session[] {
  const exists = list.some((item) => item.id === session.id)
  const next = exists ? list.map((item) => (item.id === session.id ? session : item)) : [session, ...list]
  return next.sort((a, b) => b.updatedAt - a.updatedAt)
}

function resolveSessionProject(session: Session, projects: WorkspaceInfo[]): Session {
  const project = projects.find((item) => item.id === session.workspaceId || item.root === session.cwd)
  return project ? { ...session, project: project.name } : session
}

export const useFarsideStore = create<FarsideState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  initialized: false,
  connected: false,
  authReady: null,
  account: null,
  projects: [],
  pinnedSessionIds: readPreference('pinned-sessions'),
  pinnedProjectIds: readPreference('pinned-projects'),
  archivedProjectIds: readPreference('archived-projects'),
  composerBySession: {},
  lastError: null,
  initialize: async () => {
    const bridge = window.api
    const api = bridge?.agent
    // 纯浏览器预览没有 preload：保留样板间，方便视觉走查，不伪装成真实链路。
    if (!api || visualPreview) {
      const previewSession = MOCK_SESSIONS[0]
      const previewComposer = previewSession
        ? readSessionComposer(previewSession.id, previewSession.model)
        : readSessionComposer('preview', 'kimi-k3')
      set({
        sessions: MOCK_SESSIONS,
        activeSessionId: MOCK_SESSIONS[0]?.id ?? null,
        approvalQueue: [MOCK_APPROVAL],
        questionQueue: [],
        initialized: true,
        connected: false,
        authReady: true,
        account: {
          configured: true,
          activeProviderId: 'managed:kimi-code',
          activeModel: 'kimi-k3',
          providers: [
            {
              id: 'managed:kimi-code',
              kind: 'kimi-oauth',
              label: 'Kimi OAuth',
              hasCredential: true,
              status: 'connected',
              active: true
            }
          ],
          models: MODELS.map((model) => ({
            id: model.id,
            providerId: 'managed:kimi-code',
            label: model.label,
            contextWindow: model.contextWindow,
            capabilities: []
          })),
          usage: {
            planCode: 'LEVEL_INTERMEDIATE',
            planLabel: 'Allegretto',
            weekly: { usedPct: 37, remainingPct: 63, resetAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
            fiveHour: { usedPct: 22, remainingPct: 78, resetAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
            extraBalanceCny: null,
            updatedAt: Date.now()
          }
        },
        quota: { weekUsedPct: 37, fiveHourUsedPct: 22, extraBalanceCny: null },
        projects: mockProjects(),
        ...previewComposer,
        composerBySession: previewSession ? { [previewSession.id]: previewComposer } : {}
      })
      return
    }
    if (!removeAgentListener) {
      removeAgentListener = api.onUpdate((update) => get().applyAgentUpdate(update))
    }
    try {
      const accountResult = await bridge.account.get()
      const account = accountResult.account ?? null
      if (!accountResult.ok) {
        set({
          sessions: [],
          activeSessionId: null,
          approvalQueue: [],
          questionQueue: [],
          initialized: true,
          connected: false,
          authReady: false,
          account,
          quota: quotaFromAccount(account),
          lastError: accountResult.error ?? '账户服务暂不可用，请重试'
        })
        return
      }
      if (accountResult.ok && account && !account.configured) {
        set({
          sessions: [],
          activeSessionId: null,
          approvalQueue: [],
          questionQueue: [],
          initialized: true,
          connected: false,
          authReady: false,
          account,
          quota: quotaFromAccount(account),
          lastError: null
        })
        return
      }
      const [result, workspaceResult] = await Promise.all([api.initialize(), bridge.workspace.list()])
      const activeSessions = result.sessions
        .filter((session) => !session.archived)
        .map((session) => resolveSessionProject(session, workspaceResult.workspaces))
      const initialSession = activeSessions[0]
      const initialComposer = initialSession
        ? readSessionComposer(initialSession.id, initialSession.model || account?.activeModel || 'kimi-k3')
        : null
      set({
        sessions: activeSessions,
        activeSessionId: activeSessions[0]?.id ?? null,
        approvalQueue: result.approvals,
        questionQueue: result.questions,
        initialized: true,
        connected: result.ok,
        authReady: account?.configured ?? result.authReady ?? null,
        account,
        ...(initialComposer ?? { model: account?.activeModel ?? get().model }),
        composerBySession: initialSession && initialComposer ? { [initialSession.id]: initialComposer } : {},
        quota: quotaFromAccount(account),
        lastError: result.error ?? null,
        goal: result.goal ?? null,
        projects: workspaceResult.workspaces
      })
      if (account?.activeProviderId === 'managed:kimi-code') void get().refreshAccount()
    } catch (error) {
      set({
        sessions: visualPreview ? MOCK_SESSIONS : [],
        activeSessionId: visualPreview ? (MOCK_SESSIONS[0]?.id ?? null) : null,
        approvalQueue: visualPreview ? [MOCK_APPROVAL] : [],
        initialized: true,
        connected: false,
        authReady: visualPreview ? true : false,
        lastError: visualPreview
          ? null
          : error instanceof Error
            ? error.message
            : '真实 Agent 链路初始化失败'
      })
    }
  },
  refreshAccount: async () => {
    const result = await window.api?.account.refresh()
    if (!result?.ok || !result.account) {
      set({ lastError: result?.error ?? '账户状态刷新失败' })
      return
    }
    set({
      account: result.account,
      authReady: result.account.configured,
      ...(!get().activeSessionId && result.account.activeModel ? { model: result.account.activeModel } : {}),
      quota: quotaFromAccount(result.account),
      lastError: null
    })
  },
  logoutAccount: async () => {
    const result = await window.api?.account.logout()
    if (!result?.ok) {
      set({ lastError: result?.error ?? '退出登录失败' })
      return
    }
    set({
      account: result.account ?? null,
      authReady: false,
      sessions: [],
      activeSessionId: null,
      composerBySession: {},
      draft: '',
      attachments: [],
      projects: [],
      connected: false,
      lastError: null
    })
  },
  configureAccount: async (input) => {
    const result = await window.api?.account.configure(input)
    if (!result?.ok || !result.account?.configured) {
      set({ lastError: result?.error ?? 'Provider 未能建立连接，请检查地址、密钥与模型 ID' })
      return false
    }
    set({
      account: result.account,
      authReady: result.account.configured,
      ...(!get().activeSessionId && result.account.activeModel ? { model: result.account.activeModel } : {}),
      quota: quotaFromAccount(result.account),
      lastError: null
    })
    await get().initialize()
    return true
  },
  setActiveSession: (id) => {
    const state = get()
    const target = state.sessions.find((session) => session.id === id)
    const composer = state.composerBySession[id] ?? readSessionComposer(id, target?.model ?? state.model)
    set({
      activeSessionId: id,
      lastError: null,
      ...composer,
      composerBySession: { ...state.composerBySession, [id]: composer },
      sending: target?.phase !== 'new'
    })
    const api = window.api?.agent
    if (!api) return
    void api.loadSession(id).then((result) => {
      if (!result.ok || !result.session) {
        if (get().activeSessionId === id) set({ lastError: result.error ?? '会话加载失败' })
        return
      }
      set((state) => ({
        sessions: upsertSession(state.sessions, resolveSessionProject(result.session as Session, state.projects)),
        approvalQueue: [
          ...state.approvalQueue.filter((item) => item.sessionId !== id),
          ...(result.approvals ?? [])
        ],
        questionQueue: [
          ...state.questionQueue.filter((item) => item.sessionId !== id),
          ...(result.questions ?? [])
        ],
        goal: state.activeSessionId === id ? result.goal ?? null : state.goal
      }))
    })
  },
  newSession: () => {
    const state = get()
    const cwd = state.sessions.find((item) => item.id === state.activeSessionId)?.cwd
    const api = window.api?.agent
    if (!api) {
      const session: Session = {
        id: `session-${Date.now()}`,
        title: '新会话',
        project: 'farside',
        cwd: cwd || '',
        phase: 'new',
        model: state.model,
        updatedAt: Date.now(),
        contextTokens: 0,
        events: []
      }
      const composer: SessionComposerState = {
        draft: '', attachments: [], model: state.model, permissionMode: state.permissionMode,
        planMode: state.planMode, swarmMode: state.swarmMode
      }
      persistSessionComposer(session.id, composer)
      set((current) => ({
        sessions: [session, ...current.sessions],
        activeSessionId: session.id,
        composerBySession: { ...current.composerBySession, [session.id]: composer },
        ...composer,
        sending: false
      }))
      return
    }
    void api
      .createSession({
        cwd,
        title: '新会话',
        model: state.model,
        permissionMode: state.permissionMode,
        planMode: state.planMode,
        swarmMode: state.swarmMode
      })
      .then((result) => {
        if (!result.ok || !result.session) {
          set({ lastError: result.error ?? '新建会话失败' })
          return
        }
        const sessionId = result.session.id
        const composer: SessionComposerState = {
          draft: '', attachments: [], model: state.model, permissionMode: state.permissionMode,
          planMode: state.planMode, swarmMode: state.swarmMode
        }
        persistSessionComposer(sessionId, composer)
        set((current) => ({
          sessions: upsertSession(current.sessions, resolveSessionProject(result.session as Session, current.projects)),
          activeSessionId: sessionId,
          composerBySession: { ...current.composerBySession, [sessionId]: composer },
          ...composer,
          sending: false,
          lastError: null
        }))
      })
  },
  renameSession: (id, title) => {
    const previous = get().sessions.find((item) => item.id === id)?.title
    set((state) => ({
      sessions: state.sessions.map((item) => (item.id === id ? { ...item, title } : item))
    }))
    const api = window.api?.agent
    if (!api) return
    void api.renameSession({ sessionId: id, title }).then((result) => {
      if (result.ok) return
      set((state) => ({
        sessions: state.sessions.map((item) =>
          item.id === id && previous ? { ...item, title: previous } : item
        ),
        lastError: result.error ?? '会话重命名失败'
      }))
    })
  },
  forkSession: (id) => {
    const sourceState = get()
    const api = window.api?.agent
    if (!api) return
    void api.forkSession(id).then((result) => {
      if (!result.ok || !result.session) {
        set({ lastError: result.error ?? '会话分叉失败' })
        return
      }
      const sessionId = result.session.id
      const composer: SessionComposerState = {
        draft: '', attachments: [], model: sourceState.model, permissionMode: sourceState.permissionMode,
        planMode: sourceState.planMode, swarmMode: sourceState.swarmMode
      }
      persistSessionComposer(sessionId, composer)
      set((state) => ({
        sessions: upsertSession(state.sessions, resolveSessionProject(result.session as Session, state.projects)),
        activeSessionId: sessionId,
        composerBySession: { ...state.composerBySession, [sessionId]: composer },
        ...composer,
        sending: false,
        lastError: null
      }))
    })
  },
  exportSession: (id) => {
    const api = window.api?.agent
    if (!api) return
    void api.exportSession(id).then((result) => {
      if (!result.ok) set({ lastError: result.error ?? '会话导出失败' })
    })
  },
  archiveSession: (id) => {
    const previous = get().sessions
    const previousActive = get().activeSessionId
    const next = previous.filter((session) => session.id !== id)
    const nextActive = previousActive === id ? next[0]?.id ?? null : previousActive
    set({
      sessions: next,
      activeSessionId: nextActive
    })
    if (previousActive === id && nextActive) get().setActiveSession(nextActive)
    if (previousActive === id && !nextActive) set({ draft: '', attachments: [], sending: false })
    void window.api?.agent.archiveSession(id).then((result) => {
      if (!result.ok) {
        set({ sessions: previous, lastError: result.error ?? '会话归档失败' })
        if (previousActive) get().setActiveSession(previousActive)
      }
    })
  },
  togglePinSession: (id) => set((state) => ({
    pinnedSessionIds: togglePreference('pinned-sessions', state.pinnedSessionIds, id)
  })),
  newProject: () => {
    const bridge = window.api
    if (!bridge) return
    void bridge.workspace.create().then(async (result) => {
      if (!result.ok || !result.workspace) {
        if (result.error) set({ lastError: result.error })
        return
      }
      const workspace = result.workspace
      set((state) => ({
        projects: state.projects.some((item) => item.id === workspace.id)
          ? state.projects.map((item) => item.id === workspace.id ? workspace : item)
          : [workspace, ...state.projects],
        lastError: null
      }))
      const state = get()
      const created = await bridge.agent.createSession({
        cwd: workspace.root,
        title: '新会话',
        model: state.model,
        permissionMode: state.permissionMode,
        planMode: state.planMode,
        swarmMode: state.swarmMode
      })
      if (!created.ok || !created.session) {
        set({ lastError: created.error ?? '项目已添加，但首个会话创建失败' })
        return
      }
      const sessionId = created.session.id
      const composer: SessionComposerState = {
        draft: '', attachments: [], model: state.model, permissionMode: state.permissionMode,
        planMode: state.planMode, swarmMode: state.swarmMode
      }
      persistSessionComposer(sessionId, composer)
      set((current) => ({
        sessions: upsertSession(current.sessions, resolveSessionProject(created.session as Session, current.projects)),
        activeSessionId: sessionId,
        composerBySession: { ...current.composerBySession, [sessionId]: composer },
        ...composer,
        sending: false
      }))
    })
  },
  renameProject: (id, name) => {
    const target = get().projects.find((project) => project.id === id)
    const previous = target?.name
    set((state) => ({
      projects: state.projects.map((project) => project.id === id ? { ...project, name } : project),
      sessions: state.sessions.map((session) => session.workspaceId === id || session.cwd === target?.root ? { ...session, project: name } : session)
    }))
    void window.api?.workspace.rename({ id, name }).then((result) => {
      if (result.ok && result.workspace) {
        set((state) => ({ projects: state.projects.map((project) => project.id === id ? result.workspace as WorkspaceInfo : project) }))
      } else if (!result.ok) {
        set((state) => ({
          projects: state.projects.map((project) => project.id === id && previous ? { ...project, name: previous } : project),
          lastError: result.error ?? '项目重命名失败'
        }))
      }
    })
  },
  openProject: (root) => {
    void window.api?.workspace.open(root).then((result) => {
      if (!result.ok) set({ lastError: result.error ?? '无法在资源管理器中打开项目' })
    })
  },
  removeProject: (id, root) => {
    const previous = get().projects
    const previousSessions = get().sessions
    const previousActive = get().activeSessionId
    const remainingSessions = previousSessions.filter((session) => session.workspaceId !== id && session.cwd !== root)
    set((state) => ({
      projects: state.projects.filter((project) => project.id !== id),
      sessions: remainingSessions,
      activeSessionId: remainingSessions.some((session) => session.id === state.activeSessionId)
        ? state.activeSessionId
        : remainingSessions[0]?.id ?? null
    }))
    const activeRemoved = !remainingSessions.some((session) => session.id === previousActive)
    const nextActive = remainingSessions[0]?.id ?? null
    if (activeRemoved && nextActive) get().setActiveSession(nextActive)
    if (activeRemoved && !nextActive) set({ draft: '', attachments: [], sending: false })
    void window.api?.workspace.remove({ id, root }).then((result) => {
      if (!result.ok) {
        set({ projects: previous, sessions: previousSessions, activeSessionId: previousActive, lastError: result.error ?? '项目移除失败' })
        if (previousActive) get().setActiveSession(previousActive)
      }
    })
  },
  togglePinProject: (id) => set((state) => ({
    pinnedProjectIds: togglePreference('pinned-projects', state.pinnedProjectIds, id)
  })),
  toggleArchiveProject: (id) => set((state) => ({
    archivedProjectIds: togglePreference('archived-projects', state.archivedProjectIds, id)
  })),

  view: 'sessions',
  setView: (view) => set({ view }),
  pendingTerminalCommand: null,
  runInTerminal: (command) => set({
    view: 'terminal',
    pendingTerminalCommand: { id: Date.now(), command }
  }),
  consumeTerminalCommand: (id) => set((state) => ({
    pendingTerminalCommand: state.pendingTerminalCommand?.id === id ? null : state.pendingTerminalCommand
  })),
  sidebarOpen: true,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  missionOpen: true,
  toggleMission: () => set((state) => ({ missionOpen: !state.missionOpen })),
  missionTab: 'telemetry',
  setMissionTab: (missionTab) => set({ missionTab }),
  preview: null,
  openPreview: (preview) => set({ preview, missionOpen: true, missionTab: 'preview' }),
  closePreview: () => set({ preview: null }),
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),

  draft: '',
  setDraft: (draft) => set((state) => composerPatch(state, { draft })),
  attachments: [],
  addAttachment: (attachment) =>
    set((state) => composerPatch(state, { attachments: [...state.attachments, attachment] })),
  removeAttachment: (id) =>
    set((state) => composerPatch(state, { attachments: state.attachments.filter((item) => item.id !== id) })),
  clearAttachments: () => set((state) => composerPatch(state, { attachments: [] })),
  model: 'kimi-k3',
  setModel: (model) => set((state) => composerPatch(state, { model })),
  permissionMode: 'manual',
  setPermissionMode: (permissionMode) => {
    set((state) => composerPatch(state, { permissionMode }))
    const state = get()
    const sessionId = state.activeSessionId
    const api = window.api?.agent
    if (!sessionId || !api || visualPreview) return
    // 本地切换只是草稿态；必须同步到服务端才会对正在进行的会话生效。
    void api
      .updateSessionProfile({
        sessionId,
        model: state.model,
        permissionMode,
        planMode: state.planMode,
        swarmMode: state.swarmMode
      })
      .then((result) => {
        if (!result.ok) {
          set({ lastError: result.error ?? '权限模式同步失败' })
          return
        }
        // 切到自动/放开后，已经挂起的审批服务端不会自动放行，逐条批准以解挂当前轮。
        if (permissionMode === 'manual') return
        for (const approval of get().approvalQueue.filter((item) => item.sessionId === sessionId)) {
          get().resolveApproval(approval.id, 'allow-once')
        }
      })
  },
  cyclePermissionMode: () => {
    const order: PermissionMode[] = ['manual', 'auto', 'yolo']
    const next = order[(order.indexOf(get().permissionMode) + 1) % order.length]
    get().setPermissionMode(next)
  },
  planMode: false,
  togglePlanMode: () => set((state) => composerPatch(state, { planMode: !state.planMode })),
  swarmMode: false,
  setSwarmMode: (swarmMode) => set((state) => composerPatch(state, { swarmMode })),
  abortCurrent: () => {
    const state = get()
    const active = state.sessions.find((session) => session.id === state.activeSessionId)
    if (!state.activeSessionId || active?.phase === 'new') return
    set({ sending: false })
    void window.api?.agent
      .runSessionAction({ sessionId: state.activeSessionId, action: 'abort' })
      .then((result) => {
          if (!result.ok) set({ lastError: result.error ?? '任务中断失败' })
      })
  },
  undoLastTurn: () => {
    const state = get()
    const sessionId = state.activeSessionId
    const active = state.sessions.find((session) => session.id === sessionId)
    const api = window.api?.agent
    if (!sessionId || !api || active?.phase !== 'new') return
    void api.runSessionAction({ sessionId, action: 'undo' }).then(async (result) => {
      if (!result.ok) {
        set({ lastError: result.error ?? '撤回上一轮失败' })
        return
      }
      const loaded = await api.loadSession(sessionId)
      if (!loaded.ok || !loaded.session) {
        set({ lastError: loaded.error ?? '撤回成功，但会话刷新失败' })
        return
      }
      set((current) => ({
        sessions: upsertSession(current.sessions, resolveSessionProject(loaded.session as Session, current.projects)),
        lastError: null
      }))
    })
  },
  editLastPrompt: () => {
    const state = get()
    const sessionId = state.activeSessionId
    const active = state.sessions.find((session) => session.id === sessionId)
    const prompt = [...(active?.events ?? [])].reverse().find((event) => event.kind === 'user')
    const api = window.api?.agent
    if (!sessionId || !active || active.phase !== 'new' || !prompt || prompt.kind !== 'user') return
    if (!api) {
      get().setDraft(prompt.text)
      return
    }
    void api.runSessionAction({ sessionId, action: 'undo' }).then(async (result) => {
      if (!result.ok) {
        set({ lastError: result.error ?? '重新编辑上一轮失败' })
        return
      }
      const loaded = await api.loadSession(sessionId)
      set((current) => ({
        ...(loaded.ok && loaded.session
          ? { sessions: upsertSession(current.sessions, resolveSessionProject(loaded.session as Session, current.projects)) }
          : {}),
        ...composerPatch(current, { draft: prompt.text }),
        lastError: loaded.ok ? null : loaded.error ?? '上一轮已撤回，但会话刷新失败'
      }))
    })
  },
  sending: false,
  send: (fileRefs = []) => {
    const state = get()
    const text = state.draft.trim()
    if ((!text && state.attachments.length === 0) || state.sending) return
    let promptText = text
    let goalObjective: string | undefined
    const command = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text)
    if (command) {
      const name = command[1]?.toLowerCase() ?? ''
      const arg = command[2]?.trim() ?? ''
      if (name === 'new') {
        get().setDraft('')
        get().newSession()
        return
      }
      if (name === 'settings') {
        get().setDraft('')
        set({ view: 'settings' })
        return
      }
      if (name === 'sessions') {
        get().setDraft('')
        set({ view: 'sessions', sidebarOpen: true })
        return
      }
      if (name === 'plan') {
        get().setDraft('')
        get().togglePlanMode()
        return
      }
      if (name === 'swarm') {
        const enabled = arg === 'on' ? true : arg === 'off' ? false : !state.swarmMode
        get().setDraft('')
        get().setSwarmMode(enabled)
        return
      }
      if (name === 'auto' || name === 'yolo') {
        get().setDraft('')
        get().setPermissionMode(name)
        return
      }
      if (name === 'permission' && ['manual', 'auto', 'yolo'].includes(arg)) {
        get().setDraft('')
        get().setPermissionMode(arg as PermissionMode)
        return
      }
      if (name === 'model') {
        const picked =
          arg === 'k3' || arg === 'kimi-k3'
            ? 'kimi-k3'
            : arg.includes('highspeed')
              ? 'kimi-for-coding-highspeed'
              : arg as ModelId || null
        if (picked) {
          get().setDraft('')
          get().setModel(picked)
        }
        return
      }
      if (name === 'exit') {
        void window.api?.window.close()
        return
      }
      if (name === 'help') {
        get().setDraft('')
        set({ paletteOpen: true })
        return
      }
      if (name === 'status' || name === 'usage') {
        get().setDraft('')
        set({ missionOpen: true, missionTab: 'telemetry' })
        return
      }
      if (name === 'mcp') {
        get().setDraft('')
        set({ view: 'settings' })
        return
      }
      if (state.activeSessionId && name === 'fork') {
        get().setDraft('')
        get().forkSession(state.activeSessionId)
        return
      }
      if (state.activeSessionId && (name === 'export-md' || name === 'export')) {
        get().setDraft('')
        get().exportSession(state.activeSessionId)
        return
      }
      if (state.activeSessionId && name === 'title' && arg) {
        get().setDraft('')
        get().renameSession(state.activeSessionId, arg)
        return
      }
      if (state.activeSessionId && name === 'reload') {
        get().setDraft('')
        get().setActiveSession(state.activeSessionId)
        return
      }
      if (state.activeSessionId && (name === 'compact' || name === 'undo')) {
        get().setDraft('')
        if (name === 'undo') {
          get().undoLastTurn()
          return
        }
        void window.api?.agent
          .runSessionAction({
            sessionId: state.activeSessionId,
            action: 'compact',
            instruction: arg || undefined
          })
          .then((result) => {
            if (!result.ok) set({ lastError: result.error ?? `/${name} 执行失败` })
          })
        return
      }
      if (name === 'goal') {
        if (arg === 'pause') {
          get().setDraft('')
          get().pauseGoal()
          return
        }
        if (arg === 'resume') {
          get().setDraft('')
          get().resumeGoal()
          return
        }
        if (arg === 'cancel') {
          get().setDraft('')
          get().cancelGoal()
          return
        }
        if (!arg) {
          get().setDraft('')
          set({ view: 'goals' })
          return
        }
        goalObjective = arg
        promptText = arg
      }
    }
    if (!state.activeSessionId) return
    const api = window.api?.agent
    if (!api) {
      const event: TrajectoryEvent = {
        id: `user-${Date.now()}`,
        kind: 'user',
        at: Date.now(),
        text: promptText,
        attachments: state.attachments.length ? state.attachments : undefined
      }
      set((current) => ({
        ...composerPatchForSession(current, state.activeSessionId as string, { draft: '', attachments: [] }),
        sessions: current.sessions.map((session) =>
          session.id === current.activeSessionId
            ? { ...session, phase: 'waxing', updatedAt: Date.now(), events: [...session.events, event] }
            : session
        )
      }))
      return
    }
    const attachments = state.attachments
    const optimisticId = `user-local-${Date.now()}`
    const optimisticEvent: TrajectoryEvent = {
      id: optimisticId,
      kind: 'user',
      at: Date.now(),
      text: promptText,
      attachments: attachments.length ? attachments : undefined
    }
    set((current) => ({
      ...composerPatchForSession(current, state.activeSessionId as string, { draft: '', attachments: [] }),
      sending: true,
      lastError: null,
      sessions: current.sessions.map((session) =>
        session.id === state.activeSessionId
          ? {
              ...session,
              phase: 'waxing',
              updatedAt: optimisticEvent.at,
              events: [...session.events, optimisticEvent]
            }
          : session
      )
    }))
    void api
      .submitPrompt({
        sessionId: state.activeSessionId,
        text: promptText,
        fileRefs,
        attachments,
        model: state.model,
        permissionMode: state.permissionMode,
        planMode: state.planMode,
        swarmMode: state.swarmMode,
        goalObjective
      })
      .then((result) => {
        if (result.ok) return
        set((current) => ({
          ...composerPatchForSession(current, state.activeSessionId as string, { draft: text, attachments }),
          sending: current.activeSessionId === state.activeSessionId ? false : current.sending,
          lastError: result.error ?? '指令发送失败',
          sessions: current.sessions.map((session) =>
            session.id === state.activeSessionId
              ? { ...session, phase: 'new', events: session.events.filter((event) => event.id !== optimisticId) }
              : session
          )
        }))
      })
  },

  approvalQueue: [],
  resolveApproval: (id, decision = 'deny', feedback) => {
    const approval = get().approvalQueue.find((item) => item.id === id)
    if (!approval) return
    const api = window.api?.agent
    set((state) => ({ approvalQueue: state.approvalQueue.filter((item) => item.id !== id) }))
    if (!api || visualPreview) return
    void api
      .resolveApproval({
        sessionId: approval.sessionId,
        approvalId: id,
        decision,
        feedback
      })
      .then((result) => {
        if (result.ok) return
        set((state) => ({
          approvalQueue: [approval, ...state.approvalQueue],
          lastError: result.error ?? '审批应答失败'
        }))
      })
  },
  questionQueue: [],
  resolveQuestion: (id, answers) => {
    const request = get().questionQueue.find((item) => item.id === id)
    if (!request) return
    set((state) => ({ questionQueue: state.questionQueue.filter((item) => item.id !== id) }))
    const api = window.api?.agent
    if (!api) return
    void api
      .resolveQuestion({
        sessionId: request.sessionId,
        questionRequestId: request.id,
        answers
      })
      .then((result) => {
        if (result.ok) return
        set((state) => ({
          questionQueue: [request, ...state.questionQueue],
          lastError: result.error ?? '问题应答失败'
        }))
      })
  },

  goal: null,
  pauseGoal: () => {
    const state = get()
    if (!state.activeSessionId || !state.goal) return
    set({ goal: { ...state.goal, status: 'paused' } })
    void window.api?.agent
      .controlGoal({ sessionId: state.activeSessionId, control: 'pause' })
      .then((result) => {
        if (!result.ok) set({ goal: state.goal, lastError: result.error ?? '目标暂停失败' })
      })
  },
  resumeGoal: () => {
    const state = get()
    if (!state.activeSessionId || !state.goal) return
    set({ goal: { ...state.goal, status: 'active' } })
    void window.api?.agent
      .controlGoal({ sessionId: state.activeSessionId, control: 'resume' })
      .then((result) => {
        if (!result.ok) set({ goal: state.goal, lastError: result.error ?? '目标恢复失败' })
      })
  },
  cancelGoal: () => {
    const state = get()
    if (!state.activeSessionId || !state.goal) return
    set({ goal: null })
    void window.api?.agent
      .controlGoal({ sessionId: state.activeSessionId, control: 'cancel' })
      .then((result) => {
        if (!result.ok) set({ goal: state.goal, lastError: result.error ?? '目标取消失败' })
      })
  },

  quota: { weekUsedPct: 0, fiveHourUsedPct: 0, extraBalanceCny: null },
  booted: false,
  setBooted: () => set({ booted: true }),

  applyAgentUpdate: (update) => {
    if (update.kind === 'connection') {
      set({ connected: update.connected, lastError: update.error ?? null })
      return
    }
    if (update.kind === 'session-upsert') {
      set((state) => ({ sessions: upsertSession(state.sessions, resolveSessionProject(update.session, state.projects)) }))
      return
    }
    if (update.kind === 'session-patch') {
      set((state) => ({
        sessions: state.sessions.map((session) =>
          session.id === update.sessionId ? { ...session, ...update.patch } : session
        ),
        sending:
          update.sessionId === state.activeSessionId && update.patch.phase
            ? update.patch.phase !== 'new'
            : state.sending
      }))
      return
    }
    if (update.kind === 'event-upsert') {
      set((state) => ({
        sessions: state.sessions.map((session) => {
          if (session.id !== update.sessionId) return session
          const index = session.events.findIndex((event) => event.id === update.event.id)
          if (index < 0) {
            if (update.event.kind === 'user') {
              const incoming = update.event
              let optimisticIndex = -1
              for (let candidateIndex = session.events.length - 1; candidateIndex >= 0; candidateIndex--) {
                const event = session.events[candidateIndex]
                if (
                  event?.kind === 'user' &&
                  event.id.startsWith('user-local-') &&
                  Math.abs(event.at - incoming.at) < 60_000 &&
                  (event.text === incoming.text || incoming.text.startsWith(`${event.text}\n\n引用文件：`))
                ) {
                  optimisticIndex = candidateIndex
                  break
                }
              }
              if (optimisticIndex >= 0) {
                const events = [...session.events]
                const optimistic = events[optimisticIndex]
                events[optimisticIndex] = optimistic.kind === 'user'
                  ? { ...update.event, attachments: update.event.attachments ?? optimistic.attachments }
                  : update.event
                return { ...session, events }
              }
            }
            return { ...session, events: [...session.events, update.event] }
          }
          const events = [...session.events]
          events[index] = mergeEvent(events[index], update.event, update.appendText === true)
          return { ...session, events }
        })
      }))
      return
    }
    if (update.kind === 'approval-upsert') {
      set((state) => ({
        approvalQueue: state.approvalQueue.some((item) => item.id === update.approval.id)
          ? state.approvalQueue.map((item) =>
              item.id === update.approval.id ? update.approval : item
            )
          : [...state.approvalQueue, update.approval]
      }))
      return
    }
    if (update.kind === 'approval-resolved') {
      set((state) => ({
        approvalQueue: state.approvalQueue.filter((item) => item.id !== update.approvalId)
      }))
      return
    }
    if (update.kind === 'question-upsert') {
      set((state) => ({
        questionQueue: state.questionQueue.some((item) => item.id === update.question.id)
          ? state.questionQueue.map((item) =>
              item.id === update.question.id ? update.question : item
            )
          : [...state.questionQueue, update.question]
      }))
      return
    }
    if (update.kind === 'question-resolved') {
      set((state) => ({
        questionQueue: state.questionQueue.filter(
          (item) => item.id !== update.questionRequestId
        )
      }))
      return
    }
    if (update.kind === 'goal-updated' && update.sessionId === get().activeSessionId) {
      set({ goal: update.goal })
    }
  }
}))

export function useActiveSession(): Session | null {
  return useFarsideStore(
    (state) => state.sessions.find((session) => session.id === state.activeSessionId) ?? null
  )
}
