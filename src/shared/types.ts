/**
 * Farside — 共享类型定义
 * 主进程 / preload / 渲染进程三端共用。二期不应改动本文件的对外形状。
 */

// ── 月相：Agent 状态的唯一可视化语言 ──────────────────────────────
export type MoonPhase =
  | 'new' // 朔 = 空闲 idle
  | 'waxing' // 峨眉月 = 排队/接收输入 queued
  | 'first-quarter' // 上弦 = 思考中 thinking
  | 'gibbous' // 盈凸 = 执行工具 acting
  | 'full' // 满月 = 等待批准 awaiting-approval
  | 'waning' // 残月 = 收尾 wrapping

export type AgentState =
  | 'idle'
  | 'queued'
  | 'thinking'
  | 'acting'
  | 'awaiting-approval'
  | 'wrapping'

export const AGENT_STATE_TO_PHASE: Record<AgentState, MoonPhase> = {
  idle: 'new',
  queued: 'waxing',
  thinking: 'first-quarter',
  acting: 'gibbous',
  'awaiting-approval': 'full',
  wrapping: 'waning'
}

// ── 轨道事件（TrajectoryEvent）────────────────────────────────────
interface TrajectoryEventBase {
  id: string
  /** Unix ms */
  at: number
}

/** 地面站发出的指令（用户消息，纯排版，无气泡） */
export interface GroundEvent extends TrajectoryEventBase {
  kind: 'user'
  text: string
  attachments?: Attachment[]
}

/** Kimi 注入的运行上下文；不是用户请求，不得创建用户 Turn。 */
export interface SystemEvent extends TrajectoryEventBase {
  kind: 'system'
  label: string
  text: string
}

/** 深空传回的信号（思考流，可折叠，等宽字体） */
export interface TransmissionEvent extends TrajectoryEventBase {
  kind: 'transmission'
  text: string
  durationMs: number
}

export type InstrumentStatus = 'running' | 'done' | 'failed'

/** 仪器读数（工具调用） */
export interface InstrumentEvent extends TrajectoryEventBase {
  kind: 'instrument'
  tool: string
  /** 参数摘要，单行展示 */
  argsSummary: string
  status: InstrumentStatus
  /** 结果预览（截断后的纯文本） */
  output?: string
  durationMs?: number
}

export type SatelliteKind = 'coder' | 'explore' | 'plan'
export type SatelliteStatus = 'launching' | 'in-orbit' | 'done' | 'failed'

/** 卫星（子代理，从主轨道分出的并行节点） */
export interface SatelliteEvent extends TrajectoryEventBase {
  kind: 'satellite'
  satelliteKind: SatelliteKind
  status: SatelliteStatus
  task: string
  /** 完成后的结论摘要 */
  result?: string
}

/** 权限请求（等待地面站确认） */
export interface ApprovalEvent extends TrajectoryEventBase {
  kind: 'approval'
  approvalId: string
  tool: string
  detail: string
  diff?: string
}

/** 探测器回传的消息（agent 回复，markdown） */
export interface MessageEvent extends TrajectoryEventBase {
  kind: 'message'
  markdown: string
}

/** 遥测读数 */
export interface TelemetryEvent extends TrajectoryEventBase {
  kind: 'telemetry'
  tokensPerSecond: number
  contextTokens: number
  /** 美元；Provider 未提供精确计费时不设置，不能用 0 冒充已计算。 */
  cost?: number
  /** 未命中缓存的输入（包含缓存创建），跨会话 usage.record 累计。 */
  inputTokens?: number
  /** 命中缓存的输入。 */
  cachedInputTokens?: number
  outputTokens?: number
  cacheHitRate?: number
  /** 按 Kimi 开放平台公开 API 单价估算，单位人民币；订阅账户也展示。 */
  estimatedCostCny?: number
  inputCostCny?: number
  cachedInputCostCny?: number
  outputCostCny?: number
}

export type TrajectoryEvent =
  | GroundEvent
  | SystemEvent
  | TransmissionEvent
  | InstrumentEvent
  | SatelliteEvent
  | ApprovalEvent
  | MessageEvent
  | TelemetryEvent

// ── 会话 ──────────────────────────────────────────────────────────
export interface Session {
  id: string
  /** Kimi Server 注册工作区 ID。旧会话可能没有。 */
  workspaceId?: string
  title: string
  /** 所属项目名（Sessions 栏按此分组） */
  project: string
  cwd: string
  phase: MoonPhase
  model: ModelId
  /** Unix ms */
  updatedAt: number
  contextTokens: number
  /** 实际请求执行时间之和，不包含会话闲置时间。 */
  activeDurationMs?: number
  events: TrajectoryEvent[]
  archived?: boolean
}

// ── 模型（ID 与官方 CLI 一致）──────────────────────────────────────
export type BuiltinModelId = 'kimi-k3' | 'kimi-for-coding' | 'kimi-for-coding-highspeed'
/** Provider 可声明任意模型别名；内置模型仍保留字面量补全。 */
export type ModelId = BuiltinModelId | (string & {})

export interface ModelInfo {
  id: ModelId
  label: string
  contextWindow: number
  multimodal: boolean
  /** 模型选择器副标题 */
  note: string
}

export const MODELS: ModelInfo[] = [
  {
    id: 'kimi-k3',
    label: 'Kimi K3',
    contextWindow: 1_000_000,
    multimodal: true,
    note: '2.8T MoE · 常开思考 · 原生多模态 · 1M 上下文'
  },
  {
    id: 'kimi-for-coding',
    label: 'K2.7 Code',
    contextWindow: 262_144,
    multimodal: true,
    note: '编程特化 · 256K 上下文'
  },
  {
    id: 'kimi-for-coding-highspeed',
    label: 'K2.7 Code 高速档',
    contextWindow: 262_144,
    multimodal: true,
    note: '5–6× 速度 · 配额消耗约 3×'
  }
]

/** Farside 的稳定模型 ID → Kimi Server 当前使用的完整模型名。 */
export const KIMI_SERVER_MODEL_IDS: Record<BuiltinModelId, string> = {
  'kimi-k3': 'kimi-code/k3',
  'kimi-for-coding': 'kimi-code/kimi-for-coding',
  'kimi-for-coding-highspeed': 'kimi-code/kimi-for-coding-highspeed'
}

export function fromKimiServerModel(model: string | undefined): ModelId {
  const matched = (Object.entries(KIMI_SERVER_MODEL_IDS) as [ModelId, string][]).find(
    ([id, serverId]) => model === id || model === serverId
  )
  return matched?.[0] ?? model ?? 'kimi-k3'
}

export function toKimiServerModel(model: ModelId): string {
  return KIMI_SERVER_MODEL_IDS[model as BuiltinModelId] ?? model
}

// ── 审批（与官方 CLI 三档一致；Plan 是独立开关，不是权限档）─────────
export type PermissionMode = 'manual' | 'auto' | 'yolo'

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  manual: '逐项批准',
  auto: '自动',
  yolo: '放开'
}

export interface ApprovalRequest {
  id: string
  sessionId: string
  tool: string
  /** 工具参数的完整展示文本 */
  detail: string
  /** unified diff（审批卡必须能完整展示，不做小窗） */
  diff?: string
  requestedAt: number
}

export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny'

// ── Agent 提问（Kimi Server pending_questions）────────────────────
export interface QuestionOption {
  id: string
  label: string
  description?: string
}

export interface AgentQuestion {
  id: string
  question: string
  header?: string
  body?: string
  options: QuestionOption[]
  multiSelect: boolean
  allowOther: boolean
}

export interface QuestionRequest {
  id: string
  sessionId: string
  questions: AgentQuestion[]
  requestedAt: number
}

export type QuestionAnswer =
  | { kind: 'single'; optionId: string }
  | { kind: 'multi'; optionIds: string[] }
  | { kind: 'other'; text: string }

// ── 目标（对应 CLI 的 /goal 自主目标模式）─────────────────────────
export type GoalStatus = 'active' | 'paused' | 'blocked'

export interface GoalState {
  objective: string
  status: GoalStatus
  /** Unix ms */
  startedAt: number
  turns: number
  tokens: number
  blockedReason?: string
}

// ── 配额（会员：7 天周期 + 5 小时滚动窗口 + Extra Usage）────────────
export interface QuotaInfo {
  /** 7 天周期配额已用百分比 0–100 */
  weekUsedPct: number
  /** 5 小时滚动窗口已用百分比 0–100 */
  fiveHourUsedPct: number
  /** Extra Usage 余额（人民币元），null = 未开通 */
  extraBalanceCny: number | null
}

// ── 账户 / Provider ──────────────────────────────────────────────
export type AccountProviderKind = 'kimi-oauth' | 'kimi-api' | 'openai-compatible'

export interface AccountModelInfo {
  id: ModelId
  providerId: string
  label: string
  contextWindow: number
  capabilities: string[]
}

export interface AccountProviderInfo {
  id: string
  kind: AccountProviderKind
  label: string
  baseUrl?: string
  defaultModel?: string
  hasCredential: boolean
  status: 'connected' | 'error' | 'unconfigured'
  active: boolean
}

export interface UsageWindow {
  usedPct: number
  remainingPct: number
  resetAt?: string
}

export interface AccountUsage {
  planCode?: string
  planLabel: string
  weekly?: UsageWindow
  fiveHour?: UsageWindow
  extraBalanceCny: number | null
  updatedAt: number
  error?: string
}

export interface AccountState {
  configured: boolean
  activeProviderId?: string
  activeModel?: ModelId
  providers: AccountProviderInfo[]
  models: AccountModelInfo[]
  usage?: AccountUsage
}

// ── 附件（K3 原生多模态）───────────────────────────────────────────
export interface Attachment {
  id: string
  name: string
  mimeType: string
  /** 字节 */
  size: number
  /** 图片/视频附件标注 vision */
  vision: boolean
  /** 仅在发送前短暂保存在渲染进程；主进程不会持久化。 */
  dataBase64?: string
}
