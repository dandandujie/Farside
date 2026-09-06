import { create } from 'zustand'
import type { AccountConfigureInput, AgentUpdate, AppUpdateInfo, WorkspaceInfo } from '@shared/ipc'
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
import { UNSUPPORTED_SLASH_COMMANDS } from '../components/composer/slashCommands'
import {
  composerPatch,
  composerPatchForSession,
  persistSessionComposer,
  readSessionComposer,
  type SessionComposerState
} from './composer-state'
import {
  MAX_QUEUE_PER_SESSION,
  clearPersistedPromptQueues,
  loadPersistedPromptQueues,
  persistPromptQueues,
  requeueFront,
  shiftQueue,
  type QueuedPrompt
} from './prompt-queue'
import { createSlashHandlers } from './slash-handlers'
import { MOCK_APPROVAL, MOCK_SESSIONS } from './mock'

export type { QueuedPrompt }

export type RailView = 'sessions' | 'goals' | 'settings'
export type MissionTab = 'diff' | 'telemetry' | 'files' | 'preview'

export interface PreviewDocument {
  title: string
  path?: string
  content: string
  kind: 'markdown' | 'html' | 'image' | 'text' | 'url'
  mime?: string
  encoding?: 'utf8' | 'base64'
}

export interface SessionError {
  message: string
  /** prompt=重发队列头；load=重载会话；session=仅可手动关闭 */
  kind: 'prompt' | 'load' | 'session'
}

interface FarsideState {
  sessions: Session[]
  activeSessionId: string | null
  /** 目标会话的历史正在从服务端补齐；此时空轨道不能误读为“没有消息”。 */
  sessionLoading: boolean
  initialized: boolean
  connected: boolean
  authReady: boolean | null
  /** Provider 未配置时的引导层；用户可选择“稍后再说”直接进入首页。 */
  onboardingDismissed: boolean
  dismissOnboarding(): void
  reopenOnboarding(): void
  /** 从命令面板/斜杠命令深链到设置页的分区；由 SettingsView 消费后清空。 */
  settingsRequest: { section: string; tab?: string; ts: number } | null
  openSettings(section: string, tab?: string): void
  account: AccountState | null
  refreshAccount(): Promise<void>
  logoutAccount(): Promise<void>
  configureAccount(input: AccountConfigureInput): Promise<boolean>
  lastError: string | null
  /** 归属于具体会话的错误；切换回该会话仍可见，与全局 lastError 互补。 */
  sessionErrors: Record<string, SessionError>
  setSessionError(sessionId: string, message: string, kind?: SessionError['kind']): void
  clearSessionError(sessionId: string): void
  retrySessionError(sessionId: string): void
  initialize(): Promise<void>
  setActiveSession(id: string): void
  newSession(prefill?: string): void
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
  terminalOpen: boolean
  terminalMounted: boolean
  toggleTerminal(): void
  openTerminal(): void
  runInTerminal(command: string): void
  consumeTerminalCommand(id: number): void
  sidebarOpen: boolean
  toggleSidebar(): void
  missionOpen: boolean
  toggleMission(): void
  missionTab: MissionTab
  setMissionTab(tab: MissionTab): void
  reviewFilePath: string | null
  reviewChanges(path?: string): void
  preview: PreviewDocument | null
  openPreview(preview: PreviewDocument): void
  closePreview(): void
  paletteOpen: boolean
  setPaletteOpen(open: boolean): void
  undoSelectorOpen: boolean
  setUndoSelectorOpen(open: boolean): void

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
  undoTurns(count: number): void
  undoLastTurn(): void
  editLastPrompt(): void
  sending: boolean
  send(fileRefs?: string[]): void
  promptQueues: Record<string, QueuedPrompt[]>
  queueDispatchPending: Record<string, string>
  updateQueuedPrompt(sessionId: string, id: string, text: string): void
  removeQueuedPrompt(sessionId: string, id: string): void
  clearPromptQueue(sessionId: string): void
  dispatchNextQueued(sessionId: string): void

  composerBySession: Record<string, SessionComposerState>

  approvalQueue: ApprovalRequest[]
  resolveApproval(
    id: string,
    decision?: ApprovalDecision,
    feedback?: string,
    selectedLabel?: string
  ): void
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

  /** 待展示的可用更新；手动检查与定时轮询共用。 */
  updateInfo: AppUpdateInfo | null
  /** 手动检查的结果提示（已是最新 / 检查失败），由触发方就地展示。 */
  updateNotice: { kind: 'latest' | 'failed'; version?: string } | null
  dismissedUpdateVersion: string | null
  checkUpdates(manual?: boolean): Promise<void>
  dismissUpdate(): void
  clearUpdateNotice(): void
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

function readOnboardingDismissed(): boolean {
  return localStorage.getItem('farside:onboarding-dismissed') === '1'
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

/**
 * 审批/提问到达时的注意力引导：窗口不在前台时发系统通知、闪任务栏并计 badge，
 * 让用户切在别的应用里也不会让 Agent 无限期干等。窗口聚焦时主进程侧直接忽略。
 */
function notifyAttention(
  kind: 'approval' | 'question',
  sessionId: string,
  detail: string
): void {
  const bridge = window.api?.attention
  if (!bridge || document.hasFocus()) return
  const state = useFarsideStore.getState()
  const pendingCount = Math.max(1, state.approvalQueue.length + state.questionQueue.length)
  const sessionTitle = state.sessions.find((session) => session.id === sessionId)?.title
  const english = localStorage.getItem('farside:locale') === 'en-US'
  const head = kind === 'approval'
    ? (english ? 'Approval needed' : '等待审批')
    : (english ? 'Waiting for your answer' : '等待你的回答')
  void bridge.notify({
    kind,
    title: sessionTitle ? `${sessionTitle} · Farside` : 'Farside',
    body: detail ? `${head} · ${detail}` : head,
    pendingCount
  })
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
  sessionLoading: false,
  initialized: false,
  connected: false,
  authReady: null,
  onboardingDismissed: readOnboardingDismissed(),
  dismissOnboarding: () => {
    localStorage.setItem('farside:onboarding-dismissed', '1')
    set({ onboardingDismissed: true })
  },
  reopenOnboarding: () => {
    localStorage.removeItem('farside:onboarding-dismissed')
    set({ onboardingDismissed: false })
  },
  settingsRequest: null,
  openSettings: (section, tab) => set({ view: 'settings', settingsRequest: { section, ...(tab ? { tab } : {}), ts: Date.now() } }),
  account: null,
  projects: [],
  pinnedSessionIds: readPreference('pinned-sessions'),
  pinnedProjectIds: readPreference('pinned-projects'),
  archivedProjectIds: readPreference('archived-projects'),
  composerBySession: {},
  lastError: null,
  sessionErrors: {},
  setSessionError: (sessionId, message, kind = 'session') =>
    set((state) => ({ sessionErrors: { ...state.sessionErrors, [sessionId]: { message, kind } } })),
  clearSessionError: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.sessionErrors)) return {}
      const sessionErrors = { ...state.sessionErrors }
      delete sessionErrors[sessionId]
      return { sessionErrors }
    }),
  retrySessionError: (sessionId) => {
    const error = get().sessionErrors[sessionId]
    if (!error) return
    if (error.kind === 'prompt') get().dispatchNextQueued(sessionId)
    else if (error.kind === 'load') get().setActiveSession(sessionId)
  },
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
        // 账户服务不可用 ≠ 未配置 Provider：保持 authReady 未知态，
        // 让 EmptyState 展示错误与“重新建立链路”，而不是弹出引导层。
        set({
          sessions: [],
          activeSessionId: null,
          approvalQueue: [],
          questionQueue: [],
          initialized: true,
          connected: false,
          authReady: null,
          account,
          quota: quotaFromAccount(account),
          lastError: accountResult.error ?? '账户服务暂不可用，请重试'
        })
        return
      }
      if (accountResult.ok && account && !account.configured) {
        // 未配置 Provider 只是“尚未登录”，不是错误：历史会话照常加载，
        // 引导层可跳过，用户随时可从设置或空状态页完成配置。
        set({
          initialized: true,
          connected: false,
          authReady: false,
          account,
          quota: quotaFromAccount(account),
          lastError: null
        })
      }
      const [result, workspaceResult] = await Promise.all([api.initialize(), bridge.workspace.list()])
      const activeSessions = result.sessions
        .filter((session) => !session.archived)
        .map((session) => resolveSessionProject(session, workspaceResult.workspaces))
      const initialSession = activeSessions[0]
      const initialComposer = initialSession
        ? readSessionComposer(initialSession.id, initialSession.model || account?.activeModel || 'kimi-k3')
        : null
      // 上次退出/崩溃时排队未发的指令：只恢复仍存在的会话（附件不持久化）。
      const restoredQueues = loadPersistedPromptQueues(new Set(activeSessions.map((session) => session.id)))
      set({
        sessions: activeSessions,
        activeSessionId: activeSessions[0]?.id ?? null,
        approvalQueue: result.approvals,
        questionQueue: result.questions,
        initialized: true,
        connected: result.ok,
        // 未配置 Provider 时保持 authReady=false 驱动引导层；服务端未上报时为未知态。
        authReady: account ? (account.configured && (result.authReady ?? true)) : (result.authReady ?? null),
        account,
        ...(initialComposer ?? { model: account?.activeModel ?? get().model }),
        composerBySession: initialSession && initialComposer ? { [initialSession.id]: initialComposer } : {},
        promptQueues: restoredQueues,
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
        // 初始化链路异常（服务未就绪等）不应被误读为“未配置 Provider”。
        authReady: visualPreview ? true : null,
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
      // 显式退出登录后重新展示引导层，方便直接切换 Provider。
      onboardingDismissed: false,
      sessions: [],
      activeSessionId: null,
      composerBySession: {},
      draft: '',
      attachments: [],
      projects: [],
      promptQueues: {},
      queueDispatchPending: {},
      terminalOpen: false,
      terminalMounted: false,
      pendingTerminalCommand: null,
      connected: false,
      lastError: null
    })
    clearPersistedPromptQueues()
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
    const hasApi = Boolean(window.api?.agent)
    set((state) => {
      const sessionErrors = { ...state.sessionErrors }
      delete sessionErrors[id]
      return {
        activeSessionId: id,
        lastError: null,
        sessionLoading: hasApi,
        sessionErrors,
        ...composer,
        composerBySession: { ...state.composerBySession, [id]: composer },
        sending: target?.phase !== 'new'
      }
    })
    const api = window.api?.agent
    if (!api) return
    void api.loadSession(id).then((result) => {
      const stillActive = get().activeSessionId === id
      if (!result.ok || !result.session) {
        if (stillActive) {
          set({ sessionLoading: false })
          get().setSessionError(id, result.error ?? '会话加载失败', 'load')
        }
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
        goal: state.activeSessionId === id ? result.goal ?? null : state.goal,
        // 用户在加载期间切走时，不能清掉新会话的加载态。
        ...(stillActive ? { sessionLoading: false } : {})
      }))
    })
  },
  newSession: (prefill?: string) => {
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
      if (prefill) set((current) => composerPatchForSession(current, session.id, { draft: prefill }))
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
        if (prefill) set((current) => composerPatchForSession(current, sessionId, { draft: prefill }))
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
        )
      }))
      get().setSessionError(id, result.error ?? '会话重命名失败')
    })
  },
  forkSession: (id) => {
    const sourceState = get()
    const api = window.api?.agent
    if (!api) return
    void api.forkSession(id).then((result) => {
      if (!result.ok || !result.session) {
        get().setSessionError(id, result.error ?? '会话分叉失败')
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
      if (!result.ok) get().setSessionError(id, result.error ?? '会话导出失败')
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
        set({ sessions: previous })
        get().setSessionError(id, result.error ?? '会话归档失败')
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
  terminalOpen: false,
  terminalMounted: false,
  toggleTerminal: () => set((state) => ({
    terminalOpen: !state.terminalOpen,
    terminalMounted: true
  })),
  openTerminal: () => set({ view: 'sessions', terminalOpen: true, terminalMounted: true }),
  runInTerminal: (command) => set({
    view: 'sessions',
    terminalOpen: true,
    terminalMounted: true,
    pendingTerminalCommand: { id: Date.now(), command }
  }),
  consumeTerminalCommand: (id) => set((state) => ({
    pendingTerminalCommand: state.pendingTerminalCommand?.id === id ? null : state.pendingTerminalCommand
  })),
  sidebarOpen: true,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  missionOpen: false,
  toggleMission: () => set((state) => ({ missionOpen: !state.missionOpen })),
  missionTab: 'telemetry',
  setMissionTab: (missionTab) => set({ missionTab }),
  reviewFilePath: null,
  reviewChanges: (reviewFilePath) => set({
    missionOpen: true,
    missionTab: 'diff',
    reviewFilePath: reviewFilePath ?? null
  }),
  preview: null,
  openPreview: (preview) => set({ preview, missionOpen: true, missionTab: 'preview' }),
  closePreview: () => set({ preview: null }),
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  undoSelectorOpen: false,
  setUndoSelectorOpen: (undoSelectorOpen) => set({ undoSelectorOpen }),

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
          get().setSessionError(sessionId, result.error ?? '权限模式同步失败')
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
    const sessionId = state.activeSessionId
    set({ sending: false })
    void window.api?.agent
      .runSessionAction({ sessionId, action: 'abort' })
      .then((result) => {
          if (!result.ok) get().setSessionError(sessionId, result.error ?? '任务中断失败')
      })
  },
  undoTurns: (count) => {
    const state = get()
    const sessionId = state.activeSessionId
    const active = state.sessions.find((session) => session.id === sessionId)
    const api = window.api?.agent
    if (
      !sessionId ||
      !api ||
      active?.phase !== 'new' ||
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > 100
    ) return
    set({ undoSelectorOpen: false })
    void (async () => {
      // 先回退会话轮次：这一步失败时文件与轨迹都保持原状，不会出现
      // “文件已回滚、轨迹却还在”的不可逆半完成状态。
      const result = await api.runSessionAction({ sessionId, action: 'undo', count })
      if (!result.ok) {
        get().setSessionError(sessionId, result.error ?? '请求回退失败')
        return
      }
      // 会话已回退，文件回滚失败时基线仍保留，自动重试一次。
      let fileResult = await api.resolveTurnChanges({ sessionId, action: 'undo', count })
      if (!fileResult.ok) {
        fileResult = await api.resolveTurnChanges({ sessionId, action: 'undo', count })
      }
      const loaded = await api.loadSession(sessionId)
      if (!loaded.ok || !loaded.session) {
        set({ lastError: loaded.error ?? '回退成功，但会话刷新失败' })
        return
      }
      set((current) => ({
        sessions: upsertSession(current.sessions, resolveSessionProject(loaded.session as Session, current.projects))
      }))
      if (!fileResult.ok) {
        get().setSessionError(sessionId, fileResult.error ?? '文件改动撤销失败；会话已回退，请通过 git 或「本轮改动」面板核对文件状态')
      }
    })()
  },
  undoLastTurn: () => get().undoTurns(1),
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
    void (async () => {
      // 与 undoTurns 相同的两段式顺序：先撤会话轮次（失败即原状），再回滚文件。
      const result = await api.runSessionAction({ sessionId, action: 'undo', count: 1 })
      if (!result.ok) {
        get().setSessionError(sessionId, result.error ?? '重新编辑上一轮失败')
        return
      }
      let fileResult = await api.resolveTurnChanges({ sessionId, action: 'undo', count: 1 })
      if (!fileResult.ok) {
        fileResult = await api.resolveTurnChanges({ sessionId, action: 'undo', count: 1 })
      }
      const loaded = await api.loadSession(sessionId)
      set((current) => ({
        ...(loaded.ok && loaded.session
          ? { sessions: upsertSession(current.sessions, resolveSessionProject(loaded.session as Session, current.projects)) }
          : {}),
        ...composerPatch(current, { draft: prompt.text })
      }))
      if (!loaded.ok) {
        get().setSessionError(sessionId, loaded.error ?? '上一轮已撤回，但会话刷新失败')
      } else if (!fileResult.ok) {
        get().setSessionError(sessionId, fileResult.error ?? '文件改动撤销失败；会话已回退，请通过 git 或「本轮改动」面板核对文件状态')
      }
    })()
  },
  sending: false,
  send: (fileRefs = []) => {
    const state = get()
    const text = state.draft.trim()
    if (!text && state.attachments.length === 0) return
    let promptText = text
    let goalObjective: string | undefined
    const command = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text)
    if (command) {
      const name = command[1]?.toLowerCase() ?? ''
      const arg = command[2]?.trim() ?? ''
      const handler = SLASH_HANDLERS[name]
      if (handler) {
        const outcome = handler(arg, { activeSessionId: state.activeSessionId })
        if (outcome.action === 'handled') return
        if (outcome.action === 'prompt') {
          promptText = outcome.text
          goalObjective = outcome.goalObjective
        }
        // pass：会话级命令在无活动会话等条件下按原文继续作为提示词上送。
      } else if (UNSUPPORTED_SLASH_COMMANDS.has(name)) {
        // 明确告知未支持，而不是把命令文本当作提示词静默上送给模型。
        get().setDraft('')
        set({ lastError: `/${name} 在 Farside 桌面端暂无对应入口，请改用设置页或命令面板（⌘K）。` })
        return
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
            ? {
                ...session,
                phase: 'waxing',
                lastOutcome: null,
                updatedAt: Date.now(),
                events: [...session.events, event]
              }
            : session
        )
      }))
      return
    }
    const queue = state.promptQueues[state.activeSessionId] ?? []
    if (queue.length >= MAX_QUEUE_PER_SESSION) {
      get().setSessionError(state.activeSessionId as string, `当前会话的等待队列已达 ${MAX_QUEUE_PER_SESSION} 条，请先处理或移除部分请求`)
      return
    }
    const queued: QueuedPrompt = {
      id: `queued-${crypto.randomUUID()}`,
      sessionId: state.activeSessionId,
      text: promptText,
      fileRefs,
      attachments: state.attachments,
      model: state.model,
      permissionMode: state.permissionMode,
      planMode: state.planMode,
      swarmMode: state.swarmMode,
      ...(goalObjective ? { goalObjective } : {}),
      createdAt: Date.now()
    }
    set((current) => ({
      ...composerPatchForSession(current, state.activeSessionId as string, { draft: '', attachments: [] }),
      lastError: null,
      promptQueues: {
        ...current.promptQueues,
        [state.activeSessionId as string]: [...(current.promptQueues[state.activeSessionId as string] ?? []), queued]
      }
    }))
    persistPromptQueues(get().promptQueues)
    queueMicrotask(() => get().dispatchNextQueued(queued.sessionId))
  },
  promptQueues: {},
  queueDispatchPending: {},
  updateQueuedPrompt: (sessionId, id, text) => {
    set((state) => ({
      promptQueues: {
        ...state.promptQueues,
        [sessionId]: (state.promptQueues[sessionId] ?? []).map((item) =>
          item.id === id ? { ...item, text } : item
        )
      }
    }))
    persistPromptQueues(get().promptQueues)
  },
  removeQueuedPrompt: (sessionId, id) => {
    set((state) => ({
      promptQueues: {
        ...state.promptQueues,
        [sessionId]: (state.promptQueues[sessionId] ?? []).filter((item) => item.id !== id)
      }
    }))
    persistPromptQueues(get().promptQueues)
  },
  clearPromptQueue: (sessionId) => {
    set((state) => ({ promptQueues: { ...state.promptQueues, [sessionId]: [] } }))
    persistPromptQueues(get().promptQueues)
  },
  dispatchNextQueued: (sessionId) => {
    const state = get()
    const session = state.sessions.find((item) => item.id === sessionId)
    const queued = state.promptQueues[sessionId]?.[0]
    const api = window.api?.agent
    if (
      !session ||
      session.phase !== 'new' ||
      !queued ||
      state.queueDispatchPending[sessionId] ||
      !api
    ) return
    const optimisticId = `user-local-${Date.now()}-${queued.id}`
    const optimisticEvent: TrajectoryEvent = {
      id: optimisticId,
      kind: 'user',
      at: Date.now(),
      text: queued.text,
      attachments: queued.attachments.length ? queued.attachments : undefined
    }
    set((current) => {
      const sessionErrors = { ...current.sessionErrors }
      delete sessionErrors[sessionId]
      const { queues } = shiftQueue(current.promptQueues, sessionId)
      return {
      sending: current.activeSessionId === sessionId ? true : current.sending,
      lastError: null,
      sessionErrors,
      promptQueues: queues,
      queueDispatchPending: {
        ...current.queueDispatchPending,
        [sessionId]: queued.id
      },
      sessions: current.sessions.map((item) =>
        item.id === sessionId
          ? {
              ...item,
              phase: 'waxing',
              lastOutcome: null,
              updatedAt: optimisticEvent.at,
              events: [...item.events, optimisticEvent]
            }
          : item
      )
      }
    })
    persistPromptQueues(get().promptQueues)
    void api
      .submitPrompt({
        sessionId,
        text: queued.text,
        fileRefs: queued.fileRefs,
        attachments: queued.attachments,
        model: queued.model,
        permissionMode: queued.permissionMode,
        planMode: queued.planMode,
        swarmMode: queued.swarmMode,
        goalObjective: queued.goalObjective
      })
      .then((result) => {
        if (result.ok) return
        get().setSessionError(sessionId, result.error ?? '指令发送失败', 'prompt')
        set((current) => ({
          sending: current.activeSessionId === sessionId ? false : current.sending,
          promptQueues: requeueFront(current.promptQueues, sessionId, queued),
          queueDispatchPending: Object.fromEntries(
            Object.entries(current.queueDispatchPending).filter(
              ([key, id]) => key !== sessionId || id !== queued.id
            )
          ),
          sessions: current.sessions.map((session) =>
            session.id === sessionId
              ? { ...session, phase: 'new', events: session.events.filter((event) => event.id !== optimisticId) }
              : session
          )
        }))
        persistPromptQueues(get().promptQueues)
      })
  },

  approvalQueue: [],
  resolveApproval: (id, decision = 'deny', feedback, selectedLabel) => {
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
        feedback,
        selectedLabel
      })
      .then((result) => {
        if (result.ok) {
          if (
            approval.planReview &&
            selectedLabel !== 'Revise' &&
            selectedLabel !== 'Reject'
          ) {
            set((state) => composerPatchForSession(state, approval.sessionId, { planMode: false }))
          }
          // 计划审批结束后回收自动打开的计划预览，避免面板停留在旧计划上。
          if (approval.planReview && selectedLabel !== 'Revise') {
            set((state) => (
              state.preview?.path === approval.planReview?.path ? { preview: null } : {}
            ))
          }
          return
        }
        set((state) => ({ approvalQueue: [approval, ...state.approvalQueue] }))
        get().setSessionError(approval.sessionId, result.error ?? '审批应答失败')
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
        set((state) => ({ questionQueue: [request, ...state.questionQueue] }))
        get().setSessionError(request.sessionId, result.error ?? '问题应答失败')
      })
  },

  goal: null,
  pauseGoal: () => {
    const state = get()
    if (!state.activeSessionId || !state.goal) return
    const sessionId = state.activeSessionId
    set({ goal: { ...state.goal, status: 'paused' } })
    void window.api?.agent
      .controlGoal({ sessionId: state.activeSessionId, control: 'pause' })
      .then((result) => {
        if (!result.ok) {
          set({ goal: state.goal })
          get().setSessionError(sessionId, result.error ?? '目标暂停失败')
        }
      })
  },
  resumeGoal: () => {
    const state = get()
    if (!state.activeSessionId || !state.goal) return
    const sessionId = state.activeSessionId
    set({ goal: { ...state.goal, status: 'active' } })
    void window.api?.agent
      .controlGoal({ sessionId: state.activeSessionId, control: 'resume' })
      .then((result) => {
        if (!result.ok) {
          set({ goal: state.goal })
          get().setSessionError(sessionId, result.error ?? '目标恢复失败')
        }
      })
  },
  cancelGoal: () => {
    const state = get()
    if (!state.activeSessionId || !state.goal) return
    const sessionId = state.activeSessionId
    set({ goal: null })
    void window.api?.agent
      .controlGoal({ sessionId: state.activeSessionId, control: 'cancel' })
      .then((result) => {
        if (!result.ok) {
          set({ goal: state.goal })
          get().setSessionError(sessionId, result.error ?? '目标取消失败')
        }
      })
  },

  quota: { weekUsedPct: 0, fiveHourUsedPct: 0, extraBalanceCny: null },
  booted: false,
  setBooted: () => set({ booted: true }),

  updateInfo: null,
  updateNotice: null,
  dismissedUpdateVersion: null,
  checkUpdates: async (manual = false) => {
    const api = window.api?.update
    if (!api || visualPreview) return
    const result = await api.check().catch(() => null)
    if (!result || result.error) {
      if (manual) set({ updateNotice: { kind: 'failed' } })
      return
    }
    if (result.updateAvailable) {
      // 手动检查时即使用户之前点过“稍后提醒”也重新展示弹窗
      if (manual || result.latestVersion !== get().dismissedUpdateVersion) {
        set({ updateInfo: result, updateNotice: null })
      }
      return
    }
    if (manual) set({ updateNotice: { kind: 'latest', version: result.currentVersion } })
  },
  dismissUpdate: () =>
    set((state) => ({
      dismissedUpdateVersion: state.updateInfo?.latestVersion ?? state.dismissedUpdateVersion,
      updateInfo: null
    })),
  clearUpdateNotice: () => set({ updateNotice: null }),

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
      set((state) => {
        const queueDispatchPending = { ...state.queueDispatchPending }
        if (update.patch.phase && update.patch.phase !== 'new') {
          delete queueDispatchPending[update.sessionId]
        }
        return {
          sessions: state.sessions.map((session) =>
            session.id === update.sessionId ? { ...session, ...update.patch } : session
          ),
          queueDispatchPending,
          sending:
            update.sessionId === state.activeSessionId && update.patch.phase
              ? update.patch.phase !== 'new'
              : state.sending
        }
      })
      if (update.patch.phase === 'new') {
        queueMicrotask(() => get().dispatchNextQueued(update.sessionId))
      }
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
      const isNew = !get().approvalQueue.some((item) => item.id === update.approval.id)
      set((state) => ({
        approvalQueue: state.approvalQueue.some((item) => item.id === update.approval.id)
          ? state.approvalQueue.map((item) =>
              item.id === update.approval.id ? update.approval : item
            )
          : [...state.approvalQueue, update.approval]
      }))
      if (isNew) {
        notifyAttention(
          'approval',
          update.approval.sessionId,
          update.approval.detail.split('\n')[0]?.slice(0, 80) ?? update.approval.tool
        )
      }
      return
    }
    if (update.kind === 'approval-resolved') {
      set((state) => ({
        approvalQueue: state.approvalQueue.filter((item) => item.id !== update.approvalId)
      }))
      return
    }
    if (update.kind === 'question-upsert') {
      const isNew = !get().questionQueue.some((item) => item.id === update.question.id)
      set((state) => ({
        questionQueue: state.questionQueue.some((item) => item.id === update.question.id)
          ? state.questionQueue.map((item) =>
              item.id === update.question.id ? update.question : item
            )
          : [...state.questionQueue, update.question]
      }))
      if (isNew) {
        notifyAttention(
          'question',
          update.question.sessionId,
          update.question.questions[0]?.question.slice(0, 80) ?? ''
        )
      }
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

/**
 * 斜杠命令注册表：实现在 lib/slash-handlers.ts（工厂 + 假 store 可直接单测）。
 * 新增命令在 createSlashHandlers 里加一个 handler，并同步 composer 的 SLASH_COMMANDS 清单。
 * 包装层把 zustand store 适配成工厂的松散结构视图。
 */
const SLASH_HANDLERS = createSlashHandlers({
  getState: () => useFarsideStore.getState(),
  setState: (partial) => {
    useFarsideStore.setState(partial as Parameters<typeof useFarsideStore.setState>[0])
  }
})

export function useActiveSession(): Session | null {
  return useFarsideStore(
    (state) => state.sessions.find((session) => session.id === state.activeSessionId) ?? null
  )
}
