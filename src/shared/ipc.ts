import type {
  AccountProviderKind,
  AccountState,
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  GoalState,
  ModelId,
  PermissionMode,
  QuestionAnswer,
  QuestionRequest,
  Session,
  TrajectoryEvent
} from './types'

/**
 * Farside — IPC 通道契约
 * 通道名常量 + invoke/handle 签名。preload 实现 FarsideApi，渲染端经 window.api 调用。
 * 二期新增通道时：在此追加常量与签名，不要改动既有通道。
 */

// ── 通道名 ────────────────────────────────────────────────────────
export const IPC = {
  AppGetInfo: 'app:get-info',
  AppCheckUpdate: 'app:check-update',
  AppOpenUpdate: 'app:open-update',
  AppDownloadUpdate: 'app:download-update',
  AppUpdateProgress: 'app:update-progress',
  WindowMinimize: 'window:minimize',
  WindowToggleMaximize: 'window:toggle-maximize',
  WindowClose: 'window:close',
  WindowIsMaximized: 'window:is-maximized',
  CliDetect: 'cli:detect',
  // ── 二期追加：会话发现 / PTY / kimi server ──
  SessionsDiscover: 'sessions:discover',
  PtyCreate: 'pty:create',
  PtyWrite: 'pty:write',
  PtyResize: 'pty:resize',
  PtyKill: 'pty:kill',
  /** 事件通道（主进程 webContents.send，非 invoke），不进入 IpcInvokeMap */
  PtyData: 'pty:data',
  ServerStatus: 'server:status',
  ServerStart: 'server:start',
  ServerStop: 'server:stop',
  AgentInitialize: 'agent:initialize',
  AgentSessionLoad: 'agent:session-load',
  AgentSessionCreate: 'agent:session-create',
  AgentSessionRename: 'agent:session-rename',
  AgentSessionFork: 'agent:session-fork',
  AgentSessionExport: 'agent:session-export',
  AgentSessionArchive: 'agent:session-archive',
  AgentSessionAction: 'agent:session-action',
  AgentSessionProfile: 'agent:session-profile',
  AgentPromptSubmit: 'agent:prompt-submit',
  AgentApprovalResolve: 'agent:approval-resolve',
  AgentGoalControl: 'agent:goal-control',
  AgentQuestionResolve: 'agent:question-resolve',
  AgentWorkspaceList: 'agent:workspace-list',
  AgentWorkspaceSearch: 'agent:workspace-search',
  AgentWorkspaceRead: 'agent:workspace-read',
  AgentGitChanges: 'agent:git-changes',
  AgentGitDiff: 'agent:git-diff',
  AgentTurnChanges: 'agent:turn-changes',
  AgentTurnChangesResolve: 'agent:turn-changes-resolve',
  AgentMcpList: 'agent:mcp-list',
  AgentSkillList: 'agent:skill-list',
  AgentAuthStart: 'agent:auth-start',
  AgentAuthPoll: 'agent:auth-poll',
  AccountGet: 'account:get',
  AccountConfigure: 'account:configure',
  AccountRefresh: 'account:refresh',
  AccountLogout: 'account:logout',
  WorkspaceList: 'workspace:list',
  WorkspaceCreate: 'workspace:create',
  WorkspaceRename: 'workspace:rename',
  WorkspaceRemove: 'workspace:remove',
  WorkspaceOpen: 'workspace:open',
  ConfigurationGet: 'configuration:get',
  ConfigurationSave: 'configuration:save',
  ConfigurationOpen: 'configuration:open',
  ConfigurationManage: 'configuration:manage',
  ConfigurationChanged: 'configuration:changed',
  /** Kimi Server 增量事件，经主进程归一化后推送给渲染进程。 */
  AgentUpdate: 'agent:update'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

// ── 负载类型 ──────────────────────────────────────────────────────
export interface AppInfo {
  appVersion: string
  electronVersion: string
  platform: NodeJS.Platform
  arch: string
}

/** GitHub Release 更新检查结果。Release 内容只作为纯文本展示。 */
export interface AppUpdateInfo {
  updateAvailable: boolean
  currentVersion: string
  latestVersion?: string
  releaseName?: string
  releaseNotes?: string
  publishedAt?: string
  assetName?: string
}

export interface CliStatus {
  /** Kimi Code runtime 是否可执行（优先使用 Farside 随附版本）。 */
  installed: boolean
  /** `kimi --version` 的输出（已 trim） */
  version?: string
  /** 登录态：true/false 已确认，null = 无法判定（未安装或命令不支持） */
  loggedIn: boolean | null
  /** true = 来自 Farside 安装包；false/undefined = 系统 PATH。 */
  bundled?: boolean
  /** 探测失败时的简述（用于优雅降级展示） */
  error?: string
}

// ── 二期追加：负载类型 ────────────────────────────────────────────

/** 从 ~/.kimi-code/sessions 发现的既有 CLI 会话（供会话栏未来合并） */
export interface DiscoveredSession {
  id: string
  title: string
  cwd: string
  /** Unix ms；无法解析时回退为 0 */
  updatedAt: number
}

export type PtyBackend = 'node-pty' | 'pipe'

export type PtyCreateResult =
  | { ok: true; id: string; backend: PtyBackend; shell: string }
  | { ok: false; error: string }

/** pty:data 事件负载（按 id 路由到对应终端实例） */
export interface PtyDataPayload {
  id: string
  data: string
}

/** kimi server 默认端口（loopback） */
export const KIMI_SERVER_PORT = 58627

export interface ServerStatus {
  /** kimi CLI 是否可用（未安装时一切服务操作都降级） */
  available: boolean
  /** 服务是否在运行（本 App 管理的子进程存活，或端口上已有实例应答） */
  running: boolean
  /** 运行中的实例是否由本 App spawn */
  managedByApp: boolean
  port: number
  /** 失败简述，优雅降级展示 */
  error?: string
}

export interface ServerActionResult {
  ok: boolean
  /** kimi CLI 不可用时为 false，渲染端据此隐藏服务操作入口 */
  available: boolean
  error?: string
}

// ── 真实 Agent 链路 ──────────────────────────────────────────────

export interface AgentBootstrapResult {
  ok: boolean
  sessions: Session[]
  approvals: ApprovalRequest[]
  questions: QuestionRequest[]
  goal?: GoalState | null
  authReady?: boolean
  error?: string
}

export interface AgentSessionResult {
  ok: boolean
  session?: Session
  approvals?: ApprovalRequest[]
  questions?: QuestionRequest[]
  goal?: GoalState | null
  error?: string
}

export interface AgentSessionCreateInput {
  cwd?: string
  title?: string
  model: ModelId
  permissionMode: PermissionMode
  planMode: boolean
  swarmMode: boolean
}

export interface AgentSessionRenameInput {
  sessionId: string
  title: string
}

export interface AgentSessionActionInput {
  sessionId: string
  action: 'abort' | 'compact' | 'undo'
  instruction?: string
  count?: number
}

/** 会话进行中更新完整 agent_config；profile 接口是整体替换，必须带全量字段。 */
export interface AgentSessionProfileInput {
  sessionId: string
  model: ModelId
  permissionMode: PermissionMode
  planMode: boolean
  swarmMode: boolean
}

export interface AgentPromptInput {
  sessionId: string
  text: string
  fileRefs: string[]
  attachments: Attachment[]
  model: ModelId
  permissionMode: PermissionMode
  planMode: boolean
  swarmMode: boolean
  goalObjective?: string
}

export interface AgentGoalControlInput {
  sessionId: string
  control: 'pause' | 'resume' | 'cancel'
}

export interface AgentQuestionInput {
  sessionId: string
  questionRequestId: string
  answers: Record<string, QuestionAnswer>
}

export interface AgentApprovalInput {
  sessionId: string
  approvalId: string
  decision: ApprovalDecision
  feedback?: string
  selectedLabel?: string
}

export interface AgentActionResult {
  ok: boolean
  error?: string
}

export interface WorkspaceEntry {
  path: string
  name: string
  kind: 'file' | 'directory'
  size?: number
  modifiedAt?: number
  children?: WorkspaceEntry[]
}

export interface WorkspaceListResult extends AgentActionResult {
  items: WorkspaceEntry[]
  truncated?: boolean
}

export interface WorkspaceReadResult extends AgentActionResult {
  path?: string
  content?: string
  mime?: string
  encoding?: 'utf8' | 'base64'
  truncated?: boolean
}

export interface WorkspaceInfo {
  id: string
  root: string
  name: string
  isGitRepo: boolean
  branch?: string
  createdAt: number
  lastOpenedAt: number
  sessionCount: number
}

export interface WorkspaceResult extends AgentActionResult {
  workspace?: WorkspaceInfo
}

export interface WorkspaceCollectionResult extends AgentActionResult {
  workspaces: WorkspaceInfo[]
}

export interface WorkspaceRenameInput {
  id: string
  name: string
}

export interface WorkspaceTargetInput {
  id: string
  root: string
}

export interface GitChange {
  path: string
  status: string
  additions: number
  deletions: number
  diff?: string
}

export interface GitChangesResult extends AgentActionResult {
  branch?: string
  changes: GitChange[]
}

export interface GitDiffResult extends AgentActionResult {
  path?: string
  diff?: string
  additions: number
  deletions: number
}

export interface TurnChangesResult extends AgentActionResult {
  changes: GitChange[]
  tracked: boolean
  undoAvailable: boolean
}

export interface TurnChangesResolveInput {
  sessionId: string
  action: 'undo' | 'keep'
  path?: string
  count?: number
}

export interface McpServerInfo {
  name: string
  status: string
}

export interface McpListResult extends AgentActionResult {
  servers: McpServerInfo[]
}

export interface SkillInfo {
  name: string
  description: string
  path: string
  source: string
  type?: string
  disabledForModel?: boolean
  /** 由 Kimi 用户目录托管，可在 Farside 中编辑或移除。 */
  managed?: boolean
}

export interface SkillListResult extends AgentActionResult {
  skills: SkillInfo[]
}

export interface PluginInfo {
  id: string
  name: string
  version?: string
  description?: string
  enabled: boolean
  source?: string
  root?: string
}

export type ConfigurationTarget = 'config' | 'mcp' | 'instructions'

export interface ConfigurationSnapshot {
  configToml: string
  mcpJson: string
  agentsMarkdown: string
  plugins: PluginInfo[]
  userSkills: SkillInfo[]
  paths: Record<ConfigurationTarget | 'skills' | 'plugins', string>
  updatedAt: number
}

export interface ConfigurationResult extends AgentActionResult {
  snapshot?: ConfigurationSnapshot
}

export interface ConfigurationSaveInput {
  target: ConfigurationTarget
  content: string
}

export type ConfigurationManageInput =
  | { kind: 'skill'; action: 'create'; name: string; description: string }
  | { kind: 'skill'; action: 'install'; source: string }
  | { kind: 'skill'; action: 'toggle'; path: string; enabled: boolean }
  | { kind: 'skill'; action: 'remove'; path: string }
  | { kind: 'plugin'; action: 'install'; source: string }
  | { kind: 'plugin'; action: 'toggle'; id: string; enabled: boolean }
  | { kind: 'plugin'; action: 'remove'; id: string }

export interface AuthFlowResult extends AgentActionResult {
  ready: boolean
  pending?: boolean
  verificationUri?: string
  userCode?: string
}

export interface AccountConfigureInput {
  kind: Exclude<AccountProviderKind, 'kimi-oauth'>
  apiKey: string
  baseUrl: string
  model: string
  contextWindow?: number
}

export interface AccountResult extends AgentActionResult {
  account?: AccountState
}

export type AgentUpdate =
  | { kind: 'session-upsert'; session: Session }
  | { kind: 'session-patch'; sessionId: string; patch: Partial<Session> }
  | { kind: 'event-upsert'; sessionId: string; event: TrajectoryEvent; appendText?: boolean }
  | { kind: 'approval-upsert'; approval: ApprovalRequest }
  | { kind: 'approval-resolved'; sessionId: string; approvalId: string }
  | { kind: 'question-upsert'; question: QuestionRequest }
  | { kind: 'question-resolved'; sessionId: string; questionRequestId: string }
  | { kind: 'goal-updated'; sessionId: string; goal: GoalState | null }
  | { kind: 'connection'; connected: boolean; error?: string }

// ── invoke/handle 签名表 ──────────────────────────────────────────
export interface IpcInvokeMap {
  [IPC.AppGetInfo]: { args: []; result: AppInfo }
  [IPC.AppCheckUpdate]: { args: []; result: AppUpdateInfo }
  [IPC.AppOpenUpdate]: { args: []; result: AgentActionResult }
  [IPC.AppDownloadUpdate]: { args: []; result: AgentActionResult }
  [IPC.WindowMinimize]: { args: []; result: void }
  [IPC.WindowToggleMaximize]: { args: []; result: boolean }
  [IPC.WindowClose]: { args: []; result: void }
  [IPC.WindowIsMaximized]: { args: []; result: boolean }
  [IPC.CliDetect]: { args: []; result: CliStatus }
  // ── 二期追加 ──
  [IPC.SessionsDiscover]: { args: []; result: DiscoveredSession[] }
  [IPC.PtyCreate]: { args: [cwd?: string]; result: PtyCreateResult }
  [IPC.PtyWrite]: { args: [id: string, data: string]; result: void }
  [IPC.PtyResize]: { args: [id: string, cols: number, rows: number]; result: void }
  [IPC.PtyKill]: { args: [id: string]; result: void }
  [IPC.ServerStatus]: { args: []; result: ServerStatus }
  [IPC.ServerStart]: { args: []; result: ServerActionResult }
  [IPC.ServerStop]: { args: []; result: ServerActionResult }
  [IPC.AgentInitialize]: { args: []; result: AgentBootstrapResult }
  [IPC.AgentSessionLoad]: { args: [sessionId: string]; result: AgentSessionResult }
  [IPC.AgentSessionCreate]: { args: [input: AgentSessionCreateInput]; result: AgentSessionResult }
  [IPC.AgentSessionRename]: { args: [input: AgentSessionRenameInput]; result: AgentSessionResult }
  [IPC.AgentSessionFork]: { args: [sessionId: string]; result: AgentSessionResult }
  [IPC.AgentSessionExport]: { args: [sessionId: string]; result: AgentActionResult }
  [IPC.AgentSessionArchive]: { args: [sessionId: string]; result: AgentActionResult }
  [IPC.AgentSessionAction]: { args: [input: AgentSessionActionInput]; result: AgentActionResult }
  [IPC.AgentSessionProfile]: { args: [input: AgentSessionProfileInput]; result: AgentActionResult }
  [IPC.AgentPromptSubmit]: { args: [input: AgentPromptInput]; result: AgentActionResult }
  [IPC.AgentApprovalResolve]: { args: [input: AgentApprovalInput]; result: AgentActionResult }
  [IPC.AgentGoalControl]: { args: [input: AgentGoalControlInput]; result: AgentActionResult }
  [IPC.AgentQuestionResolve]: { args: [input: AgentQuestionInput]; result: AgentActionResult }
  [IPC.AgentWorkspaceList]: {
    args: [sessionId: string, path?: string, depth?: number]
    result: WorkspaceListResult
  }
  [IPC.AgentWorkspaceSearch]: {
    args: [sessionId: string, query: string]
    result: WorkspaceListResult
  }
  [IPC.AgentWorkspaceRead]: {
    args: [sessionId: string, path: string]
    result: WorkspaceReadResult
  }
  [IPC.AgentGitChanges]: { args: [sessionId: string]; result: GitChangesResult }
  [IPC.AgentGitDiff]: { args: [sessionId: string, path: string]; result: GitDiffResult }
  [IPC.AgentMcpList]: { args: []; result: McpListResult }
  [IPC.AgentSkillList]: { args: [sessionId: string]; result: SkillListResult }
  [IPC.AgentAuthStart]: { args: []; result: AuthFlowResult }
  [IPC.AgentAuthPoll]: { args: []; result: AuthFlowResult }
  [IPC.AccountGet]: { args: []; result: AccountResult }
  [IPC.AccountConfigure]: { args: [input: AccountConfigureInput]; result: AccountResult }
  [IPC.AccountRefresh]: { args: []; result: AccountResult }
  [IPC.AccountLogout]: { args: []; result: AccountResult }
  [IPC.WorkspaceList]: { args: []; result: WorkspaceCollectionResult }
  [IPC.WorkspaceCreate]: { args: []; result: WorkspaceResult }
  [IPC.WorkspaceRename]: { args: [input: WorkspaceRenameInput]; result: WorkspaceResult }
  [IPC.WorkspaceRemove]: { args: [input: WorkspaceTargetInput]; result: AgentActionResult }
  [IPC.WorkspaceOpen]: { args: [root: string]; result: AgentActionResult }
  [IPC.ConfigurationGet]: { args: []; result: ConfigurationResult }
  [IPC.ConfigurationSave]: { args: [input: ConfigurationSaveInput]; result: ConfigurationResult }
  [IPC.ConfigurationOpen]: { args: [target: keyof ConfigurationSnapshot['paths']]; result: AgentActionResult }
  [IPC.ConfigurationManage]: { args: [input: ConfigurationManageInput]; result: ConfigurationResult }
}

// ── preload 暴露给渲染端的 API 形状 ────────────────────────────────
export interface FarsideApi {
  getAppInfo(): Promise<AppInfo>
  update: {
    check(): Promise<AppUpdateInfo>
    /** 打开主进程最近一次校验过的安装包或 Release 页面。 */
    open(): Promise<AgentActionResult>
    /** 应用内直接下载最近一次校验过的安装包并自动打开。 */
    download(): Promise<AgentActionResult>
    /** 订阅下载进度（字节）；返回取消订阅函数。 */
    onProgress(cb: (received: number, total: number) => void): () => void
  }
  detectCli(): Promise<CliStatus>
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<boolean>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
  }
  /** 发现本机 CLI 既有会话；目录不存在或全部解析失败时返回空数组 */
  discoverSessions(): Promise<DiscoveredSession[]>
  pty: {
    /** 创建一个终端会话；任何降级/失败都体现在返回值里，不会抛错 */
    create(cwd?: string): Promise<PtyCreateResult>
    write(id: string, data: string): Promise<void>
    /** pipe 降级后端无 resize 能力时为主进程空操作 */
    resize(id: string, cols: number, rows: number): Promise<void>
    kill(id: string): Promise<void>
    /** 订阅 pty:data；返回取消订阅函数 */
    onData(id: string, cb: (data: string) => void): () => void
  }
  server: {
    status(): Promise<ServerStatus>
    start(): Promise<ServerActionResult>
    stop(): Promise<ServerActionResult>
  }
  account: {
    get(): Promise<AccountResult>
    configure(input: AccountConfigureInput): Promise<AccountResult>
    refresh(): Promise<AccountResult>
    logout(): Promise<AccountResult>
  }
  workspace: {
    list(): Promise<WorkspaceCollectionResult>
    create(): Promise<WorkspaceResult>
    rename(input: WorkspaceRenameInput): Promise<WorkspaceResult>
    remove(input: WorkspaceTargetInput): Promise<AgentActionResult>
    open(root: string): Promise<AgentActionResult>
  }
  configuration: {
    get(): Promise<ConfigurationResult>
    save(input: ConfigurationSaveInput): Promise<ConfigurationResult>
    open(target: keyof ConfigurationSnapshot['paths']): Promise<AgentActionResult>
    manage(input: ConfigurationManageInput): Promise<ConfigurationResult>
    /** 订阅 config.toml、mcp.json、AGENTS.md 与扩展目录的磁盘变更。 */
    onChanged(cb: (snapshot: ConfigurationSnapshot) => void): () => void
  }
  agent: {
    initialize(): Promise<AgentBootstrapResult>
    loadSession(sessionId: string): Promise<AgentSessionResult>
    createSession(input: AgentSessionCreateInput): Promise<AgentSessionResult>
    renameSession(input: AgentSessionRenameInput): Promise<AgentSessionResult>
    forkSession(sessionId: string): Promise<AgentSessionResult>
    exportSession(sessionId: string): Promise<AgentActionResult>
    archiveSession(sessionId: string): Promise<AgentActionResult>
    runSessionAction(input: AgentSessionActionInput): Promise<AgentActionResult>
    updateSessionProfile(input: AgentSessionProfileInput): Promise<AgentActionResult>
    submitPrompt(input: AgentPromptInput): Promise<AgentActionResult>
    resolveApproval(input: AgentApprovalInput): Promise<AgentActionResult>
    controlGoal(input: AgentGoalControlInput): Promise<AgentActionResult>
    resolveQuestion(input: AgentQuestionInput): Promise<AgentActionResult>
    listWorkspace(sessionId: string, path?: string, depth?: number): Promise<WorkspaceListResult>
    searchWorkspace(sessionId: string, query: string): Promise<WorkspaceListResult>
    readWorkspaceFile(sessionId: string, path: string): Promise<WorkspaceReadResult>
    getGitChanges(sessionId: string): Promise<GitChangesResult>
    getGitDiff(sessionId: string, path: string): Promise<GitDiffResult>
    getTurnChanges(sessionId: string): Promise<TurnChangesResult>
    resolveTurnChanges(input: TurnChangesResolveInput): Promise<TurnChangesResult>
    listMcpServers(): Promise<McpListResult>
    listSkills(sessionId: string): Promise<SkillListResult>
    startLogin(): Promise<AuthFlowResult>
    pollLogin(): Promise<AuthFlowResult>
    onUpdate(cb: (update: AgentUpdate) => void): () => void
  }
}
