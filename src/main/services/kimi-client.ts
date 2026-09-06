import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { WebContents } from 'electron'
import WebSocket, { type RawData } from 'ws'
import {
  IPC,
  type AccountConfigureInput,
  type AccountProfileResult,
  type AccountResult,
  type ConfigurationManageInput,
  type AgentActionResult,
  type AgentApprovalInput,
  type AgentBootstrapResult,
  type AgentGoalControlInput,
  type AgentPromptInput,
  type AgentQuestionInput,
  type AgentSessionCreateInput,
  type AgentSessionActionInput,
  type AgentSessionProfileInput,
  type AgentSessionRenameInput,
  type AgentSessionResult,
  type AgentUpdate,
  type AuthFlowResult,
  type GitDiffResult,
  type GitChangesResult,
  type McpListResult,
  type SkillListResult,
  type TurnChangesResolveInput,
  type TurnChangesResult,
  type WorkspaceCollectionResult,
  type WorkspaceEntry,
  type WorkspaceListResult,
  type WorkspaceResult,
  type WorkspaceReadResult
} from '@shared/ipc'
import { TurnChangesService } from './turn-changes'
import { SessionRuntimeStore } from './session-runtime'
import {
  isAllowedApiBaseUrl,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_FILE_REFERENCE_COUNT,
  MAX_PROMPT_CHARS,
  MAX_TOTAL_ATTACHMENT_BYTES
} from '@shared/security'
import {
  toKimiServerModel,
  type AccountModelInfo,
  type AccountProfileStats,
  type AccountProviderInfo,
  type AccountState,
  type AccountUsage,
  type ApprovalRequest,
  type Attachment,
  type GoalState,
  type QuestionRequest,
  type SatelliteEvent,
  type Session,
  type TrajectoryEvent
} from '@shared/types'
import type { ServerService } from './server'
import { SUPPORTED_KIMI_WS_PROTOCOL_VERSION } from './runtime-manifest'
import { resolveOAuthLoginState } from './oauth-login-state'
import { sanitizeZipFileName } from '../security'
import {
  accountProviderKind,
  approvalFromRemote,
  attachmentFromBlock,
  compactActivity,
  decodedBase64Size,
  editableToolPaths,
  eventsFromMessages,
  exactCost,
  finiteNumber,
  fixedPointCny,
  friendlyRunError,
  PLAN_LABELS,
  pricingForModel,
  usageNumber,
  internalMessageLabel,
  isBoundedString,
  isRecord,
  localDateKey,
  parseWireProfile,
  type WireFileProfileStats,
  mapRemotePhase,
  profileReasoningLabel,
  providerLabel,
  questionFromRemote,
  readBoundedResponse,
  satelliteKind,
  sessionFromRemote,
  telemetryFromWire,
  textOf,
  tokenUsageTotal,
  usageWindow,
  walletCny,
  workspaceFromRemote,
  atOf,
  type ApiEnvelope,
  type AuthSummaryWire,
  type PersistedTelemetry,
  type RemoteApproval,
  type RemoteModel,
  type RemoteProvider,
  type RemoteQuestion,
  type RemoteSession,
  type RemoteWorkspace,
  type SubagentRuntime,
  type UnknownRecord
} from './wire-events'

const REQUEST_TIMEOUT_MS = 30_000
const EXPORT_TIMEOUT_MS = 120_000
const MAX_EXPORT_BYTES = 256 * 1024 * 1024
const MAX_WS_PAYLOAD_BYTES = 8 * 1024 * 1024
// 常规 REST 响应的安全上限；超出即视为服务端异常，防止畸形响应拖垮主进程。
const MAX_API_RESPONSE_BYTES = 64 * 1024 * 1024
const RECONNECT_BASE_DELAY_MS = 1_500
const RECONNECT_MAX_DELAY_MS = 30_000
// 心跳：静默 20s 起主动发协议层 ping，45s 仍无任何帧（含 pong）判定假死并重建。
const WS_HEARTBEAT_INTERVAL_MS = 20_000
const WS_IDLE_TIMEOUT_MS = 45_000
// snapshot 只回最近一页消息；逐页补齐时的安全上限，避免异常会话拖垮加载。
const MAX_HISTORY_PAGES = 100


/** Kimi Server REST + WebSocket 客户端。所有远端形状在主进程归一成 Farside 契约。 */
export class KimiClientService {
  private socket: WebSocket | null = null
  private sender: WebContents | null = null
  private subscriptions = new Set<string>()
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  private heartbeatTimer: NodeJS.Timeout | null = null
  private lastServerActivityAt = 0
  private streamFlushTimer: NodeJS.Timeout | null = null
  private pendingStreamUpdates = new Map<string, Extract<AgentUpdate, { kind: 'event-upsert' }>>()
  private approvalSyncs = new Map<string, Promise<void>>()
  private questionSyncs = new Map<string, Promise<void>>()
  private disposed = false
  private thinkingSequence = 0
  private readonly runtimes = new SessionRuntimeStore()
  private wirePaths = new Map<string, string>()
  /** wire.jsonl 个人资料统计缓存；mtime+size 未变化时直接复用解析结果。 */
  private profileCache = new Map<string, { mtimeMs: number; size: number; stats: WireFileProfileStats }>()
  private readonly turnChanges = new TurnChangesService()
  private managedIdentity: AccountProfileStats['identity']

  constructor(private readonly server: ServerService) {}

  /** 是否仍有运行中的 Agent 任务；窗口关闭守卫据此拦截静默中断。 */
  hasActiveWork(): boolean {
    return this.runtimes.anyActiveRun()
  }

  private bindTurnChanges(session: Session): Session {
    this.turnChanges.bindSession(session.id, session.cwd)
    return session
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const started = await this.server.start()
    if (!started.ok) throw new Error(started.error || 'Kimi Server 启动失败')
    const token = await this.server.token()
    if (!token) throw new Error('未找到 Kimi Server token')
    const res = await fetch(`${this.server.baseUrl()}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers
      }
    })
    const body = JSON.parse(
      (await readBoundedResponse(res, MAX_API_RESPONSE_BYTES)).toString('utf8')
    ) as ApiEnvelope<T>
    if (!res.ok || body.code !== 0) throw new Error(body.msg || `Kimi Server ${res.status}`)
    return body.data
  }

  private async readPersistedTelemetry(sessionId: string): Promise<PersistedTelemetry | null> {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null
    let wirePath = this.wirePaths.get(sessionId)
    if (!wirePath) {
      const root = process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code')
      const sessionRoot = join(root, 'sessions')
      const workspaces = await fs.readdir(sessionRoot, { withFileTypes: true }).catch(() => [])
      for (const workspace of workspaces) {
        if (!workspace.isDirectory()) continue
        const candidate = join(sessionRoot, workspace.name, sessionId, 'agents', 'main', 'wire.jsonl')
        try {
          await fs.access(candidate)
          wirePath = candidate
          this.wirePaths.set(sessionId, candidate)
          break
        } catch {
          // 继续检查下一个工作区。
        }
      }
    }
    if (!wirePath) return null
    const content = await fs.readFile(wirePath, 'utf8').catch(() => '')
    return content ? telemetryFromWire(content) : null
  }

  private async syncPersistedTelemetry(sessionId: string): Promise<void> {
    const telemetry = await this.readPersistedTelemetry(sessionId).catch(() => null)
    if (!telemetry) return
    this.emit({
      kind: 'session-patch',
      sessionId,
      patch: {
        contextTokens: telemetry.contextTokens,
        activeDurationMs: telemetry.activeDurationMs
      }
    })
    this.upsertEvent(sessionId, {
      id: `telemetry-history-${sessionId}`,
      kind: 'telemetry',
      at: telemetry.at,
      tokensPerSecond: telemetry.tokensPerSecond,
      contextTokens: telemetry.contextTokens,
      cost: telemetry.cost,
      inputTokens: telemetry.inputTokens,
      cachedInputTokens: telemetry.cachedInputTokens,
      outputTokens: telemetry.outputTokens,
      cacheHitRate: telemetry.cacheHitRate,
      estimatedCostCny: telemetry.estimatedCostCny,
      inputCostCny: telemetry.inputCostCny,
      cachedInputCostCny: telemetry.cachedInputCostCny,
      outputCostCny: telemetry.outputCostCny
    })
  }

  private emitNow(update: AgentUpdate): void {
    if (this.sender && !this.sender.isDestroyed()) this.sender.send(IPC.AgentUpdate, update)
  }

  private flushStreamUpdates(): void {
    if (this.streamFlushTimer) clearTimeout(this.streamFlushTimer)
    this.streamFlushTimer = null
    const updates = [...this.pendingStreamUpdates.values()]
    this.pendingStreamUpdates.clear()
    for (const update of updates) this.emitNow(update)
  }

  /**
   * 文本 delta 以一帧为窗口合并，避免每个 token 都触发一次 IPC 与整条轨迹重渲染。
   * 遇到工具、阶段或审批等离散事件时先 flush，保持事件先后顺序。
   */
  private emit(update: AgentUpdate): void {
    if (
      update.kind === 'event-upsert' &&
      update.appendText === true &&
      (update.event.kind === 'transmission' || update.event.kind === 'message')
    ) {
      const key = `${update.sessionId}:${update.event.id}`
      const existing = this.pendingStreamUpdates.get(key)
      if (
        existing?.event.kind === 'transmission' &&
        update.event.kind === 'transmission'
      ) {
        this.pendingStreamUpdates.set(key, {
          ...update,
          event: {
            ...update.event,
            at: existing.event.at,
            text: existing.event.text + update.event.text,
            durationMs: Math.max(existing.event.durationMs, update.event.durationMs)
          }
        })
      } else if (
        existing?.event.kind === 'message' &&
        update.event.kind === 'message'
      ) {
        this.pendingStreamUpdates.set(key, {
          ...update,
          event: {
            ...update.event,
            at: existing.event.at,
            markdown: existing.event.markdown + update.event.markdown
          }
        })
      } else {
        this.pendingStreamUpdates.set(key, update)
      }
      this.streamFlushTimer ??= setTimeout(() => this.flushStreamUpdates(), 32)
      return
    }
    this.flushStreamUpdates()
    this.emitNow(update)
  }

  private async fetchManagedUsage(): Promise<AccountUsage> {
    try {
      const root = process.env['KIMI_CODE_HOME'] || join(homedir(), '.kimi-code')
      const raw = JSON.parse(
        await fs.readFile(join(root, 'credentials', 'kimi-code.json'), 'utf8')
      ) as unknown
      if (!isRecord(raw) || typeof raw.access_token !== 'string' || !raw.access_token) {
        throw new Error('未找到可用的 Kimi OAuth 凭据')
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8_000)
      let response: Response
      try {
        const managedBase = (process.env['KIMI_CODE_BASE_URL'] || 'https://api.kimi.com/coding/v1').replace(/\/+$/, '')
        response = await fetch(`${managedBase}/usages`, {
          headers: { Authorization: `Bearer ${raw.access_token}`, Accept: 'application/json' },
          signal: controller.signal
        })
      } finally {
        clearTimeout(timer)
      }
      if (!response.ok) throw new Error(`官方用量接口返回 ${response.status}`)
      const payload = (await response.json()) as unknown
      if (!isRecord(payload)) throw new Error('官方用量响应格式无效')
      const user = isRecord(payload.user) ? payload.user : {}
      const membership = isRecord(user.membership) ? user.membership : {}
      const displayName = [user.displayName, user.display_name, user.nickname, user.name]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
      const username = [user.username, user.handle, user.userId, user.user_id, user.id]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
      if (displayName || username) {
        this.managedIdentity = {
          ...(displayName ? { displayName: displayName.trim() } : {}),
          ...(username ? { username: username.trim().replace(/^@/, '') } : {})
        }
      }
      const planCode = typeof membership.level === 'string' ? membership.level : undefined
      const rawLimits = Array.isArray(payload.limits) ? payload.limits : []
      const fiveHourItem = rawLimits.find((item) => {
        if (!isRecord(item) || !isRecord(item.window)) return false
        const duration = finiteNumber(item.window.duration)
        const unit = typeof item.window.timeUnit === 'string' ? item.window.timeUnit : ''
        return (
          (duration === 300 && unit.includes('MINUTE')) ||
          (duration === 5 && unit.includes('HOUR'))
        )
      })
      const fiveHour =
        isRecord(fiveHourItem) && isRecord(fiveHourItem.detail)
          ? usageWindow(fiveHourItem.detail)
          : undefined
      const booster = isRecord(payload.boosterWallet) ? payload.boosterWallet : null
      const balance = booster && isRecord(booster.balance) ? booster.balance : null
      const amountLeft = balance ? finiteNumber(balance.amountLeft) : null
      const currency =
        booster && isRecord(booster.monthlyChargeLimit) &&
        typeof booster.monthlyChargeLimit.currency === 'string'
          ? booster.monthlyChargeLimit.currency
          : booster && isRecord(booster.monthlyUsed) && typeof booster.monthlyUsed.currency === 'string'
            ? booster.monthlyUsed.currency
            : 'USD'
      return {
        planCode,
        planLabel: planCode ? (PLAN_LABELS[planCode] ?? planCode.replace(/^LEVEL_/, '')) : 'Kimi 会员',
        weekly: usageWindow(payload.usage),
        fiveHour,
        extraBalanceCny:
          amountLeft !== null && currency.toUpperCase() === 'CNY'
            ? fixedPointCny(amountLeft)
            : null,
        extraMonthlyUsedCny: walletCny(booster?.monthlyUsed, 'amount', 'amountUsed', 'used'),
        extraMonthlyLimitCny: walletCny(
          booster?.monthlyChargeLimit,
          'amount',
          'amountLimit',
          'limit'
        ),
        updatedAt: Date.now()
      }
    } catch (error) {
      return {
        planLabel: 'Kimi 会员',
        extraBalanceCny: null,
        updatedAt: Date.now(),
        error: error instanceof Error ? error.message : '订阅用量查询失败'
      }
    }
  }

  async getAccountProfile(): Promise<AccountProfileResult> {
    try {
      const root = process.env['KIMI_CODE_HOME'] || join(homedir(), '.kimi-code')
      const wireFiles: string[] = []
      const collectWireFiles = async (directory: string): Promise<void> => {
        let entries
        try {
          entries = await fs.readdir(directory, { withFileTypes: true })
        } catch {
          return
        }
        await Promise.all(entries.map(async (entry) => {
          const path = join(directory, entry.name)
          if (entry.isDirectory()) await collectWireFiles(path)
          else if (entry.isFile() && entry.name === 'wire.jsonl') wireFiles.push(path)
        }))
      }
      await collectWireFiles(join(root, 'sessions'))

      const daily = new Map<string, { tokens: number; tasks: number }>()
      const reasoning = new Map<string, number>()
      const skills = new Map<string, number>()
      const tools = new Map<string, number>()
      let totalTokens = 0
      let peakTaskTokens = 0
      let longestTaskDurationMs = 0
      let taskCount = 0
      let requestCount = 0
      let fastRequestCount = 0

      const seenFiles = new Set<string>()
      for (const file of wireFiles) {
        seenFiles.add(file)
        const stat = await fs.stat(file).catch(() => null)
        const cached = this.profileCache.get(file)
        let stats: WireFileProfileStats
        if (stat && cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          stats = cached.stats
        } else {
          const text = await fs.readFile(file, 'utf8').catch(() => '')
          stats = parseWireProfile(text)
          if (stat) this.profileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, stats })
        }
        for (const [key, value] of stats.daily) {
          const entry = daily.get(key) ?? { tokens: 0, tasks: 0 }
          entry.tokens += value.tokens
          entry.tasks += value.tasks
          daily.set(key, entry)
        }
        for (const [key, value] of stats.reasoning) reasoning.set(key, (reasoning.get(key) ?? 0) + value)
        for (const [key, value] of stats.skills) skills.set(key, (skills.get(key) ?? 0) + value)
        for (const [key, value] of stats.tools) tools.set(key, (tools.get(key) ?? 0) + value)
        totalTokens += stats.totalTokens
        peakTaskTokens = Math.max(peakTaskTokens, stats.peakTaskTokens)
        longestTaskDurationMs = Math.max(longestTaskDurationMs, stats.longestTaskDurationMs)
        taskCount += stats.taskCount
        requestCount += stats.requestCount
        fastRequestCount += stats.fastRequestCount
      }
      for (const file of this.profileCache.keys()) {
        if (!seenFiles.has(file)) this.profileCache.delete(file)
      }

      const activeDays = [...daily.entries()]
        .filter(([, value]) => value.tokens > 0 || value.tasks > 0)
        .map(([date]) => date)
        .sort()
      const activeSet = new Set(activeDays)
      let longestStreakDays = 0
      let runningStreak = 0
      let previousDay: number | null = null
      for (const day of activeDays) {
        // WHY: 用 UTC 日期序号比较，避免夏令时切换日并非恰好 24 小时而打断 streak。
        const timestamp = new Date(`${day}T00:00:00Z`).getTime()
        runningStreak = previousDay !== null && timestamp - previousDay === 86_400_000
          ? runningStreak + 1
          : 1
        longestStreakDays = Math.max(longestStreakDays, runningStreak)
        previousDay = timestamp
      }
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      let cursor = new Date(today)
      if (!activeSet.has(localDateKey(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1)
      let currentStreakDays = 0
      while (activeSet.has(localDateKey(cursor.getTime()))) {
        currentStreakDays += 1
        cursor.setDate(cursor.getDate() - 1)
      }

      const reasoningTop = [...reasoning.entries()].sort((a, b) => b[1] - a[1])[0]
      const reasoningTotal = [...reasoning.values()].reduce((sum, count) => sum + count, 0)
      const coreTools = new Set([
        'bash', 'edit', 'read', 'grep', 'todolist', 'readmediafile', 'write', 'fetchurl',
        'websearch', 'taskoutput', 'agent', 'glob', 'enterplanmode', 'exitplanmode',
        'skill', 'taskstop', 'tasklist'
      ])
      const topExtensions: AccountProfileStats['topExtensions'] = [
        ...[...skills.entries()].map(([name, count]) => ({ name, count, kind: 'skill' as const })),
        ...[...tools.entries()]
          .filter(([name]) => !coreTools.has(name.toLowerCase()))
          .map(([name, count]) => ({ name, count, kind: 'tool' as const }))
      ].sort((a, b) => b.count - a.count).slice(0, 5)

      let identity = this.managedIdentity
      try {
        const credential = JSON.parse(
          await fs.readFile(join(root, 'credentials', 'kimi-code.json'), 'utf8')
        ) as unknown
        if (isRecord(credential) && typeof credential.access_token === 'string') {
          const payload = credential.access_token.split('.')[1]
          if (payload) {
            const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown
            if (!identity && isRecord(claims) && typeof claims.user_id === 'string') {
              identity = { username: claims.user_id }
            }
          }
        }
      } catch {
        // API Key 和未登录用户没有 OAuth 身份；本机统计仍然可用。
      }

      const profile: AccountProfileStats = {
        ...(identity ? { identity } : {}),
        totalTokens,
        peakTaskTokens,
        longestTaskDurationMs,
        currentStreakDays,
        longestStreakDays,
        daily: [...daily.entries()]
          .map(([date, value]) => ({ date, ...value }))
          .sort((a, b) => a.date.localeCompare(b.date)),
        fastModePct: requestCount > 0 ? (fastRequestCount / requestCount) * 100 : 0,
        ...(reasoningTop && reasoningTotal > 0 ? {
          topReasoningEffort: {
            label: profileReasoningLabel(reasoningTop[0]),
            pct: (reasoningTop[1] / reasoningTotal) * 100
          }
        } : {}),
        exploredSkillCount: skills.size,
        skillUseCount: [...skills.values()].reduce((sum, count) => sum + count, 0),
        taskCount,
        topExtensions,
        updatedAt: Date.now()
      }
      return { ok: true, profile }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '个人资料统计读取失败'
      }
    }
  }

  /**
   * 把 /api/v1/auth 摘要投影为“链路是否就绪”。0.39 移除了现成的 `ready`
   * 字段后，按上游 AuthLegacyService 的原语义重推：
   * 至少 1 个 provider、默认模型可解析（models_ready）、managed 未被吊销。
   */
  private resolveAuthReady(summary: AuthSummaryWire | null | undefined): boolean {
    if (!summary) return false
    const providersCount = typeof summary.providers_count === 'number' ? summary.providers_count : 0
    return (
      providersCount >= 1 &&
      summary.models_ready === true &&
      summary.managed_provider?.status !== 'revoked'
    )
  }

  async getAccount(refreshUsage = false): Promise<AccountResult> {
    try {
      if (refreshUsage) {
        await this.request('/api/v1/providers:refresh_oauth', {
          method: 'POST',
          body: JSON.stringify({})
        }).catch(() => undefined)
      }
      const [auth, providerData, modelData, config] = await Promise.all([
        this.request<AuthSummaryWire>('/api/v1/auth'),
        this.request<{ items?: RemoteProvider[] }>('/api/v1/providers'),
        this.request<{ items?: RemoteModel[] }>('/api/v1/models'),
        this.request<{
          default_provider?: string
          default_model?: string
          models?: Record<string, unknown>
        }>('/api/v1/config')
      ])
      const remoteProviders = providerData.items ?? []
      const defaultModel = config.default_model
      const defaultModelConfig =
        defaultModel && config.models && isRecord(config.models[defaultModel])
          ? config.models[defaultModel]
          : null
      const activeProviderId =
        config.default_provider ||
        (defaultModelConfig && typeof defaultModelConfig.provider === 'string'
          ? defaultModelConfig.provider
          : remoteProviders.length === 1
            ? remoteProviders[0].id
            : undefined)
      const providers: AccountProviderInfo[] = remoteProviders.map((provider) => ({
        id: provider.id,
        kind: accountProviderKind(provider),
        label: providerLabel(provider),
        baseUrl: provider.base_url,
        defaultModel: provider.default_model,
        hasCredential:
          provider.has_api_key ||
          (provider.id === 'managed:kimi-code' && provider.status === 'connected'),
        status: provider.status,
        active: provider.id === activeProviderId
      }))
      const models: AccountModelInfo[] = (modelData.items ?? []).map((model) => ({
        id: model.model,
        providerId: model.provider,
        label: model.display_name || model.model,
        contextWindow: model.max_context_size,
        capabilities: model.capabilities ?? []
      }))
      const managedActive = activeProviderId === 'managed:kimi-code'
      const account: AccountState = {
        configured: this.resolveAuthReady(auth) && providers.some((provider) => provider.status === 'connected'),
        activeProviderId,
        activeModel: defaultModel,
        providers,
        models,
        ...(managedActive && refreshUsage ? { usage: await this.fetchManagedUsage() } : {})
      }
      return { ok: true, account }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '账户状态读取失败'
      }
    }
  }

  async configureAccount(input: AccountConfigureInput): Promise<AccountResult> {
    try {
      if (
        !input ||
        !['kimi-api', 'openai-compatible'].includes(input.kind) ||
        typeof input.apiKey !== 'string' ||
        typeof input.model !== 'string' ||
        typeof input.baseUrl !== 'string'
      ) {
        throw new Error('Provider 类型无效')
      }
      const apiKey = input.apiKey.trim()
      const model = input.model.trim()
      const rawBaseUrl = input.baseUrl.trim()
      if (!isAllowedApiBaseUrl(rawBaseUrl)) {
        throw new Error('Base URL 必须使用 HTTPS；仅本机回环地址可使用 HTTP，且不能包含凭据、查询或片段')
      }
      const url = new URL(rawBaseUrl)
      const contextWindow = finiteNumber(input.contextWindow) ?? 262_144
      if (!apiKey) throw new Error('API Key 不能为空')
      if (apiKey.length > 16_384) throw new Error('API Key 长度异常')
      if (!model) throw new Error('模型 ID 不能为空')
      if (model.length > 512) throw new Error('模型 ID 过长')
      if (contextWindow <= 0 || contextWindow > 10_000_000) throw new Error('上下文窗口必须在 1 到 10000000 之间')
      const baseUrl = url.toString().replace(/\/$/, '')
      const providerId = input.kind === 'kimi-api' ? 'farside:kimi-api' : 'farside:openai'
      const slug = model.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'model'
      const alias = `${providerId.replace(':', '-')}/${slug}`
      await this.request('/api/v1/config', {
        method: 'POST',
        body: JSON.stringify({
          providers: {
            [providerId]: {
              type: input.kind === 'kimi-api' ? 'kimi' : 'openai',
              base_url: baseUrl,
              api_key: apiKey
            }
          },
          models: {
            [alias]: {
              provider: providerId,
              model,
              max_context_size: contextWindow,
              capabilities: ['thinking', 'image_in', 'tool_use'],
              display_name: model
            }
          },
          default_provider: providerId,
          default_model: alias
        })
      })
      return this.getAccount(false)
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '账户配置保存失败'
      }
    }
  }

  private async listRemoteSessions(): Promise<RemoteSession[]> {
    const data = await this.request<{ items: RemoteSession[] }>(
      '/api/v1/sessions?page_size=100&include_archive=true'
    )
    return data.items ?? []
  }

  async listWorkspaces(): Promise<WorkspaceCollectionResult> {
    try {
      const data = await this.request<{ items?: RemoteWorkspace[] }>('/api/v1/workspaces')
      return { ok: true, workspaces: (data.items ?? []).map(workspaceFromRemote) }
    } catch (error) {
      return {
        ok: false,
        workspaces: [],
        error: error instanceof Error ? error.message : '项目列表读取失败'
      }
    }
  }

  async createWorkspace(root: string): Promise<WorkspaceResult> {
    try {
      if (!isBoundedString(root, 4_096)) throw new Error('项目路径无效')
      const remote = await this.request<RemoteWorkspace>('/api/v1/workspaces', {
        method: 'POST',
        body: JSON.stringify({ root })
      })
      return { ok: true, workspace: workspaceFromRemote(remote) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '项目添加失败' }
    }
  }

  async renameWorkspace(id: string, name: string): Promise<WorkspaceResult> {
    try {
      if (!isBoundedString(id, 512) || !isBoundedString(name, 512)) throw new Error('项目重命名参数无效')
      const remote = await this.request<RemoteWorkspace>(
        `/api/v1/workspaces/${encodeURIComponent(id)}`,
        { method: 'PATCH', body: JSON.stringify({ name }) }
      )
      return { ok: true, workspace: workspaceFromRemote(remote) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '项目重命名失败' }
    }
  }

  async removeWorkspace(id: string): Promise<AgentActionResult> {
    try {
      if (!isBoundedString(id, 512)) throw new Error('项目 ID 无效')
      await this.request(`/api/v1/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '项目移除失败' }
    }
  }

  private async listApprovals(sessionId: string): Promise<ApprovalRequest[]> {
    const data = await this.request<{ items: RemoteApproval[] }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/approvals?status=pending`
    )
    return (data.items ?? []).map(approvalFromRemote)
  }

  private async listQuestions(sessionId: string): Promise<QuestionRequest[]> {
    const data = await this.request<{ items: RemoteQuestion[] }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/questions?status=pending`
    )
    return (data.items ?? []).map(questionFromRemote)
  }

  async initialize(sender: WebContents): Promise<AgentBootstrapResult> {
    this.sender = sender
    try {
      const [remoteSessions, auth] = await Promise.all([
        this.listRemoteSessions(),
        this.request<AuthSummaryWire>('/api/v1/auth')
      ])
      const sessions = remoteSessions.map((item) => this.bindTurnChanges(sessionFromRemote(item)))
      for (const item of remoteSessions) {
        if (item.busy === true) this.runtimes.ensure(item.id).runActive = true
      }
      const approvals = (
        await Promise.all(
          remoteSessions
            .filter((item) => item.pending_interaction === 'approval')
            .map((item) => this.listApprovals(item.id))
        )
      ).flat()
      const questions = (
        await Promise.all(
          remoteSessions
            .filter((item) => item.pending_interaction === 'question')
            .map((item) => this.listQuestions(item.id))
        )
      ).flat()
      for (const session of sessions) this.subscriptions.add(session.id)
      await this.connect()
      let goal: GoalState | null = null
      if (sessions[0]) {
        const loaded = await this.loadSession(sessions[0].id)
        if (loaded.ok && loaded.session) {
          sessions[0] = loaded.session
          goal = loaded.goal ?? null
        }
      }
      return { ok: true, sessions, approvals, questions, goal, authReady: this.resolveAuthReady(auth) }
    } catch (error) {
      return {
        ok: false,
        sessions: [],
        approvals: [],
        questions: [],
        error: error instanceof Error ? error.message : '真实 Agent 链路初始化失败'
      }
    }
  }

  /** snapshot 只返回最近一页消息（has_more 标记还有更早的页），按 before_id 逐页补齐完整历史。 */
  private async fullMessages(sessionId: string, messages: unknown): Promise<unknown> {
    const items = isRecord(messages) && Array.isArray(messages.items)
      ? messages.items.filter(isRecord)
      : []
    if (!isRecord(messages) || messages.has_more !== true || !items.length) return { items }
    const idOf = (item: UnknownRecord): string | null =>
      typeof item.id === 'string' && item.id ? item.id : null
    const seen = new Set(items.map(idOf).filter((id): id is string => id !== null))
    let cursor = idOf(items[0])
    const older: UnknownRecord[] = []
    for (let page = 0; page < MAX_HISTORY_PAGES && cursor; page++) {
      const data = await this.request<{ items?: unknown; has_more?: boolean }>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages?before_id=${encodeURIComponent(cursor)}`
      )
      const pageItems = Array.isArray(data.items) ? data.items.filter(isRecord) : []
      if (!pageItems.length) break
      // messages 接口按时间倒序分页（最新在前），翻正后再按时间正序拼接，
      // 保证 eventsFromMessages 里 tool_use → tool_result 的配对顺序。
      const ascending = atOf(pageItems[0].created_at) <= atOf(pageItems[pageItems.length - 1].created_at)
        ? pageItems
        : [...pageItems].reverse()
      const pageCursor = idOf(ascending[0])
      const fresh: UnknownRecord[] = []
      for (const item of ascending) {
        const id = idOf(item)
        if (id && seen.has(id)) continue
        if (id) seen.add(id)
        fresh.push(item)
      }
      older.unshift(...fresh)
      // 游标不再前移说明服务端忽略了 before_id，停止避免空转。
      if (data.has_more !== true || !pageCursor || pageCursor === cursor) break
      cursor = pageCursor
    }
    return { items: [...older, ...items] }
  }

  async loadSession(sessionId: string): Promise<AgentSessionResult> {
    try {
      const [snapshot, goal, persistedTelemetry] = await Promise.all([
        this.request<{
          session: RemoteSession
          messages?: unknown
          pending_approvals?: RemoteApproval[]
          pending_questions?: RemoteQuestion[]
        }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/snapshot`),
        this.getGoal(sessionId),
        this.readPersistedTelemetry(sessionId)
      ])
      const events = eventsFromMessages(await this.fullMessages(sessionId, snapshot.messages))
      if (persistedTelemetry) {
        events.push({
          id: `telemetry-history-${sessionId}`,
          kind: 'telemetry',
          at: persistedTelemetry.at,
          tokensPerSecond: persistedTelemetry.tokensPerSecond,
          contextTokens: persistedTelemetry.contextTokens,
          cost: persistedTelemetry.cost,
          inputTokens: persistedTelemetry.inputTokens,
          cachedInputTokens: persistedTelemetry.cachedInputTokens,
          outputTokens: persistedTelemetry.outputTokens,
          cacheHitRate: persistedTelemetry.cacheHitRate,
          estimatedCostCny: persistedTelemetry.estimatedCostCny,
          inputCostCny: persistedTelemetry.inputCostCny,
          cachedInputCostCny: persistedTelemetry.cachedInputCostCny,
          outputCostCny: persistedTelemetry.outputCostCny
        })
      }
      const session = this.bindTurnChanges(sessionFromRemote(snapshot.session, events))
      if (persistedTelemetry) {
        session.contextTokens = persistedTelemetry.contextTokens
        session.activeDurationMs = persistedTelemetry.activeDurationMs
      }
      const approvals = (snapshot.pending_approvals ?? []).map(approvalFromRemote)
      const questions = (snapshot.pending_questions ?? []).map(questionFromRemote)
      this.subscribe(sessionId)
      return { ok: true, session, approvals, questions, goal }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '会话加载失败'
      }
    }
  }

  async createSession(input: AgentSessionCreateInput): Promise<AgentSessionResult> {
    try {
      if (
        !input ||
        !isBoundedString(input.model, 512) ||
        !['manual', 'auto', 'yolo'].includes(input.permissionMode) ||
        typeof input.planMode !== 'boolean' ||
        typeof input.swarmMode !== 'boolean' ||
        (input.cwd !== undefined && !isBoundedString(input.cwd, 4_096)) ||
        (input.title !== undefined && !isBoundedString(input.title, 1_024, true))
      ) {
        throw new Error('新建会话参数无效')
      }
      const remote = await this.request<RemoteSession>('/api/v1/sessions', {
        method: 'POST',
        body: JSON.stringify({
          title: input.title || '新会话',
          metadata: { cwd: input.cwd || process.cwd() },
          agent_config: {
            model: toKimiServerModel(input.model),
            permission_mode: input.permissionMode,
            plan_mode: input.planMode,
            swarm_mode: input.swarmMode
          }
        })
      })
      const session = this.bindTurnChanges(sessionFromRemote(remote))
      this.subscribe(session.id)
      return { ok: true, session, approvals: [] }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '新建会话失败'
      }
    }
  }

  async renameSession(input: AgentSessionRenameInput): Promise<AgentSessionResult> {
    try {
      if (!input || !isBoundedString(input.sessionId, 512) || !isBoundedString(input.title, 1_024)) {
        throw new Error('会话重命名参数无效')
      }
      const remote = await this.request<RemoteSession>(
        `/api/v1/sessions/${encodeURIComponent(input.sessionId)}:rename`,
        { method: 'POST', body: JSON.stringify({ title: input.title }) }
      )
      return { ok: true, session: this.bindTurnChanges(sessionFromRemote(remote)) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '会话重命名失败' }
    }
  }

  async forkSession(sessionId: string): Promise<AgentSessionResult> {
    try {
      const remote = await this.request<RemoteSession>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}:fork`,
        { method: 'POST', body: JSON.stringify({}) }
      )
      const session = this.bindTurnChanges(sessionFromRemote(remote))
      this.subscribe(session.id)
      return { ok: true, session }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '会话分叉失败' }
    }
  }

  async exportSession(sessionId: string): Promise<{ data: Buffer; fileName: string }> {
    const started = await this.server.start()
    if (!started.ok) throw new Error(started.error || 'Kimi Server 启动失败')
    const token = await this.server.token()
    if (!token) throw new Error('未找到 Kimi Server token')
    const res = await fetch(`${this.server.baseUrl()}/api/v1/sessions/${encodeURIComponent(sessionId)}/export`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS)
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as ApiEnvelope<unknown> | null
      throw new Error(body?.msg || `会话导出失败（${res.status}）`)
    }
    const disposition = res.headers.get('content-disposition') ?? ''
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
    const plain = /filename="?([^";]+)"?/i.exec(disposition)?.[1]
    const declaredSize = Number(res.headers.get('content-length'))
    if (Number.isFinite(declaredSize) && declaredSize > MAX_EXPORT_BYTES) {
      throw new Error('会话导出包超过 256 MiB，已拒绝载入内存')
    }
    let suggested = plain || ''
    if (encoded) {
      try {
        suggested = decodeURIComponent(encoded)
      } catch {
        suggested = encoded
      }
    }
    const data = await readBoundedResponse(res, MAX_EXPORT_BYTES)
    const fallback = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_') || 'kimi-session'
    return { data, fileName: sanitizeZipFileName(suggested, fallback) }
  }

  async runSessionAction(input: AgentSessionActionInput): Promise<AgentActionResult> {
    try {
      if (
        !input ||
        !isBoundedString(input.sessionId, 512) ||
        !['abort', 'compact', 'undo'].includes(input.action) ||
        (input.instruction !== undefined && !isBoundedString(input.instruction, MAX_PROMPT_CHARS, true)) ||
        (input.count !== undefined &&
          (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > 100))
      ) {
        throw new Error('会话动作参数无效')
      }
      const body =
        input.action === 'compact' && input.instruction
          ? { instruction: input.instruction }
          : input.action === 'undo'
            ? { count: input.count ?? 1 }
            : {}
      await this.request(
        `/api/v1/sessions/${encodeURIComponent(input.sessionId)}:${input.action}`,
        { method: 'POST', body: JSON.stringify(body) }
      )
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '会话动作执行失败'
      }
    }
  }

  async archiveSession(sessionId: string): Promise<AgentActionResult> {
    try {
      await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}:archive`, {
        method: 'POST',
        body: JSON.stringify({})
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '会话归档失败' }
    }
  }

  /**
   * 会话进行中切换权限模式等配置。profile 接口实测是整体替换 agent_config，
   * 缺字段会被清空（曾导致 model 被抹掉），所以这里强制带全量。
   */
  async updateSessionProfile(input: AgentSessionProfileInput): Promise<AgentActionResult> {
    try {
      if (
        !input ||
        !isBoundedString(input.sessionId, 512) ||
        !isBoundedString(input.model, 512) ||
        !['manual', 'auto', 'yolo'].includes(input.permissionMode) ||
        typeof input.planMode !== 'boolean' ||
        typeof input.swarmMode !== 'boolean'
      ) {
        throw new Error('会话配置参数无效')
      }
      await this.request(`/api/v1/sessions/${encodeURIComponent(input.sessionId)}/profile`, {
        method: 'POST',
        body: JSON.stringify({
          agent_config: {
            model: toKimiServerModel(input.model),
            permission_mode: input.permissionMode,
            plan_mode: input.planMode,
            swarm_mode: input.swarmMode
          }
        })
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '会话配置更新失败' }
    }
  }

  async submitPrompt(input: AgentPromptInput): Promise<AgentActionResult> {
    try {
      if (!input || typeof input.sessionId !== 'string' || !input.sessionId) throw new Error('会话 ID 无效')
      if (typeof input.text !== 'string' || input.text.length > MAX_PROMPT_CHARS) {
        throw new Error('提示词不能超过 200000 个字符')
      }
      if (!Array.isArray(input.fileRefs) || input.fileRefs.length > MAX_FILE_REFERENCE_COUNT) {
        throw new Error('引用文件数量超过上限')
      }
      if (input.fileRefs.some((path) => typeof path !== 'string' || path.length > 4_096)) {
        throw new Error('引用文件路径无效')
      }
      if (!Array.isArray(input.attachments) || input.attachments.length > MAX_ATTACHMENT_COUNT) {
        throw new Error(`附件数量不能超过 ${MAX_ATTACHMENT_COUNT} 个`)
      }
      if (typeof input.model !== 'string' || !input.model || input.model.length > 512) {
        throw new Error('模型 ID 无效')
      }
      if (
        input.goalObjective !== undefined &&
        (typeof input.goalObjective !== 'string' || input.goalObjective.length > MAX_PROMPT_CHARS)
      ) {
        throw new Error('目标文本过长')
      }
      let totalAttachmentBytes = 0
      for (const attachment of input.attachments) {
        if (!attachment || typeof attachment.dataBase64 !== 'string') throw new Error('附件缺少可发送数据')
        if (typeof attachment.name !== 'string' || attachment.name.length > 1_024) throw new Error('附件名称无效')
        if (!/^(?:image|video)\/[a-z0-9.+-]+$/i.test(attachment.mimeType)) throw new Error('附件媒体类型无效')
        const bytes = decodedBase64Size(attachment.dataBase64)
        if (bytes === null || bytes > MAX_ATTACHMENT_BYTES) throw new Error(`单个附件不能超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MiB`)
        totalAttachmentBytes += bytes
        if (totalAttachmentBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
          throw new Error(`附件总大小不能超过 ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024} MiB`)
        }
      }
      if (!['manual', 'auto', 'yolo'].includes(input.permissionMode)) throw new Error('权限模式无效')
      if (typeof input.planMode !== 'boolean' || typeof input.swarmMode !== 'boolean') {
        throw new Error('会话模式参数无效')
      }
      // 必须先订阅再提交，避免 prompt.submitted 比 POST 响应更早到达而丢失用户事件。
      this.subscribe(input.sessionId)
      const referenceText = input.fileRefs.length
        ? `\n\n引用文件：\n${input.fileRefs.map((path) => `@${path}`).join('\n')}`
        : ''
      const content: UnknownRecord[] = [{ type: 'text', text: `${input.text}${referenceText}` }]
      for (const attachment of input.attachments) {
        if (!attachment.dataBase64) throw new Error(`附件 ${attachment.name} 缺少可发送数据`)
        content.push({
          type: attachment.mimeType.startsWith('video/') ? 'video' : 'image',
          source: {
            kind: 'base64',
            media_type: attachment.mimeType,
            data: attachment.dataBase64
          }
        })
      }
      // WebSocket 的 prompt.submitted 可能早于或晚于 HTTP 响应；请求发出前先锁住
      // 本地运行态，避免夹在中间的 busy=false 误判完成。
      const runtime = this.runtimes.ensure(input.sessionId)
      runtime.runActive = true
      runtime.runFailed = false
      this.emit({
        kind: 'session-patch',
        sessionId: input.sessionId,
        patch: { phase: 'waxing', lastOutcome: null }
      })
      await this.request(`/api/v1/sessions/${encodeURIComponent(input.sessionId)}/prompts`, {
        method: 'POST',
        body: JSON.stringify({
          content,
          model: toKimiServerModel(input.model),
          permission_mode: input.permissionMode,
          plan_mode: input.planMode,
          swarm_mode: input.swarmMode,
          ...(input.goalObjective ? { goal_objective: input.goalObjective } : {})
        })
      })
      return { ok: true }
    } catch (error) {
      if (input && typeof input.sessionId === 'string') {
        const runtime = this.runtimes.get(input.sessionId)
        if (runtime) runtime.runActive = false
      }
      return { ok: false, error: error instanceof Error ? error.message : '指令发送失败' }
    }
  }

  async resolveApproval(input: AgentApprovalInput): Promise<AgentActionResult> {
    try {
      if (
        !input ||
        !isBoundedString(input.sessionId, 512) ||
        !isBoundedString(input.approvalId, 512) ||
        !['allow-once', 'allow-always', 'deny'].includes(input.decision) ||
        (input.feedback !== undefined && !isBoundedString(input.feedback, 4_000, true)) ||
        (input.selectedLabel !== undefined && !isBoundedString(input.selectedLabel, 512))
      ) {
        throw new Error('审批参数无效')
      }
      const decision = input.decision === 'deny' ? 'rejected' : 'approved'
      await this.request(
        `/api/v1/sessions/${encodeURIComponent(input.sessionId)}/approvals/${encodeURIComponent(input.approvalId)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            decision,
            ...(input.decision === 'allow-always' ? { scope: 'session' } : {}),
            ...(input.feedback ? { feedback: input.feedback } : {}),
            ...(input.selectedLabel ? { selected_label: input.selectedLabel } : {})
          })
        }
      )
      this.emit({
        kind: 'approval-resolved',
        sessionId: input.sessionId,
        approvalId: input.approvalId
      })
      return { ok: true }
    } catch (error) {
      // 审批已不在 pending（已超时或被别处处理）视为已解决，清掉卡片而不是报错。
      const message = error instanceof Error ? error.message : ''
      if (message.includes('expected "pending"')) {
        this.emit({
          kind: 'approval-resolved',
          sessionId: input.sessionId,
          approvalId: input.approvalId
        })
        return { ok: true }
      }
      return { ok: false, error: error instanceof Error ? error.message : '审批应答失败' }
    }
  }

  async controlGoal(input: AgentGoalControlInput): Promise<AgentActionResult> {
    try {
      if (
        !input ||
        !isBoundedString(input.sessionId, 512) ||
        !['pause', 'resume', 'cancel'].includes(input.control)
      ) {
        throw new Error('目标控制参数无效')
      }
      // profile 接口是整体替换 agent_config：先取当前全量配置，
      // 只追加 goal_control，避免清掉 model / permission 等字段。
      const current = await this.request<{ agent_config?: UnknownRecord }>(
        `/api/v1/sessions/${encodeURIComponent(input.sessionId)}/profile`
      )
      const agentConfig: UnknownRecord = {
        ...(isRecord(current.agent_config) ? current.agent_config : {}),
        goal_control: input.control
      }
      await this.request(`/api/v1/sessions/${encodeURIComponent(input.sessionId)}/profile`, {
        method: 'POST',
        body: JSON.stringify({ agent_config: agentConfig })
      })
      const goal = await this.getGoal(input.sessionId)
      this.emit({ kind: 'goal-updated', sessionId: input.sessionId, goal })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '目标状态更新失败' }
    }
  }

  async resolveQuestion(input: AgentQuestionInput): Promise<AgentActionResult> {
    try {
      if (
        !input ||
        !isBoundedString(input.sessionId, 512) ||
        !isBoundedString(input.questionRequestId, 512) ||
        !isRecord(input.answers) ||
        Object.keys(input.answers).length > 100
      ) {
        throw new Error('问题应答参数无效')
      }
      const answers = Object.fromEntries(
        Object.entries(input.answers).map(([id, answer]) => {
          if (!isBoundedString(id, 512) || !isRecord(answer)) throw new Error('问题答案无效')
          if (answer.kind === 'single' && isBoundedString(answer.optionId, 512)) {
            return [id, { kind: 'single', option_id: answer.optionId }]
          }
          if (
            answer.kind === 'multi' &&
            Array.isArray(answer.optionIds) &&
            answer.optionIds.length <= 100 &&
            answer.optionIds.every((optionId) => isBoundedString(optionId, 512))
          ) {
            return [id, { kind: 'multi', option_ids: answer.optionIds }]
          }
          if (answer.kind === 'other' && isBoundedString(answer.text, 4_000, true)) {
            return [id, { kind: 'other', text: answer.text }]
          }
          throw new Error('问题答案无效')
        })
      )
      await this.request(
        `/api/v1/sessions/${encodeURIComponent(input.sessionId)}/questions/${encodeURIComponent(input.questionRequestId)}`,
        { method: 'POST', body: JSON.stringify({ answers, method: 'click' }) }
      )
      this.emit({
        kind: 'question-resolved',
        sessionId: input.sessionId,
        questionRequestId: input.questionRequestId
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '问题应答失败' }
    }
  }

  private async getGoal(sessionId: string): Promise<GoalState | null> {
    const data = await this.request<UnknownRecord | null>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/goal`
    )
    return this.mapGoal(data)
  }

  async listWorkspace(
    sessionId: string,
    path = '.',
    depth = 4
  ): Promise<WorkspaceListResult> {
    try {
      const data = await this.request<{
        items: UnknownRecord[]
        children_by_path?: Record<string, UnknownRecord[]>
        truncated?: boolean
      }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/fs:list`, {
        method: 'POST',
        body: JSON.stringify({
          path,
          depth: Math.max(1, Math.min(depth, 8)),
          limit: 1_000,
          show_hidden: false,
          follow_gitignore: true,
          exclude_globs: ['node_modules/**', 'out/**', '.git/**']
        })
      })
      const childrenByPath = data.children_by_path ?? {}
      const convert = (item: UnknownRecord): WorkspaceEntry => {
        const entryPath = typeof item.path === 'string' ? item.path : ''
        const kind = item.kind === 'directory' ? 'directory' : 'file'
        const children = kind === 'directory' ? childrenByPath[entryPath] ?? [] : []
        return {
          path: entryPath,
          name: typeof item.name === 'string' ? item.name : basename(entryPath),
          kind,
          size: typeof item.size === 'number' ? item.size : undefined,
          modifiedAt: atOf(item.modified_at),
          children: children.length ? children.map(convert) : undefined
        }
      }
      const ignored = new Set(['node_modules', 'out', '.git'])
      return {
        ok: true,
        items: (data.items ?? []).filter((item) => !ignored.has(String(item.name))).map(convert),
        truncated: data.truncated
      }
    } catch (error) {
      return {
        ok: false,
        items: [],
        error: error instanceof Error ? error.message : '项目文件读取失败'
      }
    }
  }

  async searchWorkspace(sessionId: string, query: string): Promise<WorkspaceListResult> {
    try {
      const data = await this.request<{ items: UnknownRecord[]; truncated?: boolean }>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/fs:search`,
        {
          method: 'POST',
          body: JSON.stringify({
            query: query || '*',
            limit: 50,
            exclude_globs: ['node_modules/**', 'out/**', '.git/**']
          })
        }
      )
      return {
        ok: true,
        items: (data.items ?? []).map((item) => ({
          path: typeof item.path === 'string' ? item.path : '',
          name: typeof item.name === 'string' ? item.name : basename(String(item.path ?? '')),
          kind: item.kind === 'directory' ? 'directory' : 'file'
        })),
        truncated: data.truncated
      }
    } catch (error) {
      return {
        ok: false,
        items: [],
        error: error instanceof Error ? error.message : '文件搜索失败'
      }
    }
  }

  async readWorkspaceFile(sessionId: string, path: string): Promise<WorkspaceReadResult> {
    try {
      const data = await this.request<{
        path: string
        content: string
        encoding?: string
        mime?: string
        truncated?: boolean
      }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/fs:read`, {
        method: 'POST',
        body: JSON.stringify({ path, length: 1024 * 1024 })
      })
      const isImage = data.mime?.startsWith('image/') === true
      const encoding = data.encoding === 'base64' && isImage ? 'base64' : 'utf8'
      const content = data.encoding === 'base64' && !isImage
        ? Buffer.from(data.content, 'base64').toString('utf8')
        : data.content
      return {
        ok: true,
        path: data.path,
        content,
        mime: data.mime,
        encoding,
        truncated: data.truncated
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '文件读取失败'
      }
    }
  }

  async getGitChanges(sessionId: string): Promise<GitChangesResult> {
    try {
      const data = await this.request<{
        branch?: string
        entries?: UnknownRecord[] | UnknownRecord
      }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/fs:git_status`, {
        method: 'POST',
        body: JSON.stringify({})
      })
      const entries: UnknownRecord[] = Array.isArray(data.entries)
        ? data.entries.filter(isRecord)
        : isRecord(data.entries)
          ? Object.entries(data.entries).map(([path, status]) => ({ path, status }))
          : []
      const changes = entries
        .filter((entry) => typeof entry.path === 'string' && entry.path)
        .slice(0, 100)
        .map((entry) => {
          const path = typeof entry.path === 'string' ? entry.path : ''
          const remoteStatus = typeof entry.status === 'string' ? entry.status.toLowerCase() : 'modified'
          const status = /untracked|added|new/.test(remoteStatus)
            ? 'added'
            : /deleted|removed/.test(remoteStatus)
              ? 'deleted'
              : 'modified'
          return {
            path,
            status,
            additions: typeof entry.additions === 'number' ? entry.additions : 0,
            deletions: typeof entry.deletions === 'number' ? entry.deletions : 0
          }
        })
      return { ok: true, branch: data.branch, changes }
    } catch (error) {
      return {
        ok: false,
        changes: [],
        error: error instanceof Error ? error.message : 'Git 改动读取失败'
      }
    }
  }

  async getGitDiff(sessionId: string, path: string): Promise<GitDiffResult> {
    try {
      const result = await this.request<{ diff?: string }>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/fs:diff`,
        { method: 'POST', body: JSON.stringify({ path }) }
      )
      const diff = result.diff ?? ''
      return {
        ok: true,
        path,
        diff,
        additions: diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
        deletions: diff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length
      }
    } catch (error) {
      return {
        ok: false,
        path,
        additions: 0,
        deletions: 0,
        error: error instanceof Error ? error.message : '文件改动读取失败'
      }
    }
  }

  async getTurnChanges(sessionId: string): Promise<TurnChangesResult> {
    try {
      if (!isBoundedString(sessionId, 512)) throw new Error('会话 ID 无效')
      return await this.turnChanges.get(sessionId)
    } catch (error) {
      return {
        ok: false,
        changes: [],
        tracked: false,
        undoAvailable: false,
        error: error instanceof Error ? error.message : '本轮改动读取失败'
      }
    }
  }

  async resolveTurnChanges(input: TurnChangesResolveInput): Promise<TurnChangesResult> {
    try {
      if (
        !input ||
        !isBoundedString(input.sessionId, 512) ||
        !['undo', 'keep'].includes(input.action) ||
        (input.path !== undefined && !isBoundedString(input.path, 4_096)) ||
        (input.count !== undefined &&
          (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > 100))
      ) {
        throw new Error('本轮改动操作无效')
      }
      return await this.turnChanges.resolve(input.sessionId, input.action, input.path, input.count)
    } catch (error) {
      return {
        ok: false,
        changes: [],
        tracked: false,
        undoAvailable: false,
        error: error instanceof Error ? error.message : '本轮改动操作失败'
      }
    }
  }

  /**
   * 使用 Kimi Server 官方 Plugin REST 面（0.39+：POST /api/v1/plugins 与
   * /api/v1/plugins/{id}:enable|:disable|:remove），避免绕过插件校验与
   * managed 安装事务。0.31 的 /api/v2 pluginService RPC 从未开放过。
   */
  async managePlugin(
    input: Extract<ConfigurationManageInput, { kind: 'plugin' }>
  ): Promise<AgentActionResult> {
    try {
      if (!input || !['install', 'toggle', 'remove'].includes(input.action)) {
        throw new Error('Plugin 操作无效')
      }
      if (input.action === 'install') {
        if (!isBoundedString(input.source, 2_048)) throw new Error('Plugin 来源无效')
        await this.request('/api/v1/plugins', {
          method: 'POST',
          body: JSON.stringify({ source: input.source })
        })
      } else if (input.action === 'toggle') {
        if (!isBoundedString(input.id, 512) || typeof input.enabled !== 'boolean') {
          throw new Error('Plugin 状态参数无效')
        }
        await this.request(
          `/api/v1/plugins/${encodeURIComponent(input.id)}:${input.enabled ? 'enable' : 'disable'}`,
          { method: 'POST', body: JSON.stringify({}) }
        )
      } else {
        if (!isBoundedString(input.id, 512)) throw new Error('Plugin ID 无效')
        await this.request(`/api/v1/plugins/${encodeURIComponent(input.id)}:remove`, {
          method: 'POST',
          body: JSON.stringify({})
        })
      }
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Kimi Plugin 操作失败'
      }
    }
  }

  async listMcpServers(): Promise<McpListResult> {
    try {
      const data = await this.request<{ servers?: UnknownRecord[] }>('/api/v1/mcp/servers')
      return {
        ok: true,
        servers: (data.servers ?? []).map((server) => ({
          name:
            (typeof server.name === 'string' && server.name) ||
            (typeof server.id === 'string' && server.id) ||
            'mcp',
          status:
            (typeof server.status === 'string' && server.status) ||
            (server.enabled === false ? '已停用' : '已连接')
        }))
      }
    } catch (error) {
      return {
        ok: false,
        servers: [],
        error: error instanceof Error ? error.message : 'MCP 状态读取失败'
      }
    }
  }

  async listSkills(sessionId: string): Promise<SkillListResult> {
    try {
      const data = await this.request<{ items?: UnknownRecord[] }>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/skills`
      )
      return {
        ok: true,
        skills: (data.items ?? []).map((skill) => ({
          name: typeof skill.name === 'string' ? skill.name : 'skill',
          description: typeof skill.description === 'string' ? skill.description : '',
          path: typeof skill.path === 'string' ? skill.path : '',
          source: typeof skill.source === 'string' ? skill.source : 'unknown',
          type: typeof skill.type === 'string' ? skill.type : undefined,
          disabledForModel: skill.disable_model_invocation === true
        }))
      }
    } catch (error) {
      return {
        ok: false,
        skills: [],
        error: error instanceof Error ? error.message : 'Skill 列表读取失败'
      }
    }
  }

  async logoutAccount(): Promise<AccountResult> {
    try {
      await this.request('/api/v1/oauth/logout', { method: 'POST', body: JSON.stringify({}) })
      return this.getAccount(false)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '退出登录失败' }
    }
  }

  async startLogin(): Promise<AuthFlowResult> {
    try {
      const auth = await this.request<AuthSummaryWire>('/api/v1/auth')
      if (this.resolveAuthReady(auth)) {
        await this.activateManagedProvider()
        return { ok: true, ready: true, pending: false }
      }
      const data = await this.request<{
        status?: string
        verification_uri?: string
        verification_uri_complete?: string
        user_code?: string
      }>('/api/v1/oauth/login', { method: 'POST', body: JSON.stringify({}) })
      const state = resolveOAuthLoginState(data.status, false)
      if (state.ready) await this.activateManagedProvider()
      return {
        ok: !state.error,
        ready: state.ready,
        pending: state.pending,
        error: state.error,
        verificationUri: data.verification_uri_complete || data.verification_uri,
        userCode: data.user_code
      }
    } catch (error) {
      return {
        ok: false,
        ready: false,
        error: error instanceof Error ? error.message : '登录流程启动失败'
      }
    }
  }

  async pollLogin(): Promise<AuthFlowResult> {
    try {
      const [flowResult, authResult] = await Promise.allSettled([
        this.request<{ status?: string } | null>('/api/v1/oauth/login'),
        this.request<AuthSummaryWire>('/api/v1/auth')
      ])
      const authReady = authResult.status === 'fulfilled' && this.resolveAuthReady(authResult.value)
      const flowStatus = flowResult.status === 'fulfilled' ? flowResult.value?.status : undefined
      if (!authReady && flowResult.status === 'rejected') throw flowResult.reason
      const state = resolveOAuthLoginState(flowStatus, authReady)
      if (state.ready) await this.activateManagedProvider()
      return {
        ok: !state.error,
        ready: state.ready,
        pending: state.pending,
        error: state.error
      }
    } catch (error) {
      return {
        ok: false,
        ready: false,
        error: error instanceof Error ? error.message : '登录状态查询失败'
      }
    }
  }

  private async activateManagedProvider(): Promise<void> {
    const modelData = await this.request<{ items?: RemoteModel[] }>('/api/v1/models')
    const managedModels = (modelData.items ?? []).filter(
      (model) => model.provider === 'managed:kimi-code'
    )
    const selected =
      managedModels.find((model) => model.model === 'kimi-code/k3') ?? managedModels[0]
    if (!selected) throw new Error('Kimi OAuth 未返回可用模型')
    await this.request('/api/v1/config', {
      method: 'POST',
      body: JSON.stringify({
        default_provider: 'managed:kimi-code',
        default_model: selected.model
      })
    })
  }

  private subscribe(sessionId: string): void {
    const wasKnown = this.subscriptions.has(sessionId)
    this.subscriptions.add(sessionId)
    if (!wasKnown && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(
        JSON.stringify({
          type: 'subscribe',
          id: randomUUID(),
          payload: { session_ids: [sessionId] }
        })
      )
    }
  }

  private async connect(): Promise<void> {
    if (
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    ) {
      return
    }
    const token = await this.server.token()
    if (!token) throw new Error('未找到 Kimi Server token')
    this.disposed = false
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.server.webSocketUrl(), {
        headers: { Authorization: `Bearer ${token}` },
        handshakeTimeout: 10_000,
        maxPayload: MAX_WS_PAYLOAD_BYTES
      })
      this.socket = socket
      const helloId = randomUUID()
      let serverHello = false
      let helloAck = false
      let settled = false
      const timer = setTimeout(() => finish(new Error('Kimi Server WebSocket 握手超时')), 10_000)
      const fail = (error: Error): void => finish(error)
      const closeBeforeHandshake = (): void => finish(new Error('Kimi Server WebSocket 在握手完成前关闭'))
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.off('error', fail)
        socket.off('close', closeBeforeHandshake)
        socket.off('message', handshake)
        if (error) {
          socket.close()
          reject(error)
        } else {
          resolve()
        }
      }
      const handshake = (data: RawData): void => {
        let frame: UnknownRecord
        try {
          const parsed = JSON.parse(data.toString()) as unknown
          if (!isRecord(parsed)) return
          frame = parsed
        } catch {
          finish(new Error('Kimi Server WebSocket 返回无效 JSON'))
          return
        }
        if (frame.type === 'server_hello') {
          const payload = isRecord(frame.payload) ? frame.payload : null
          if (payload?.protocol_version !== SUPPORTED_KIMI_WS_PROTOCOL_VERSION) {
            finish(new Error(`Kimi Server WebSocket 协议不兼容：需要 ${SUPPORTED_KIMI_WS_PROTOCOL_VERSION}，实际为 ${String(payload?.protocol_version)}`))
            return
          }
          serverHello = true
        }
        if (frame.type === 'ack' && frame.id === helloId) {
          if (frame.code !== 0) {
            finish(new Error(typeof frame.msg === 'string' ? frame.msg : 'Kimi Server client_hello 被拒绝'))
            return
          }
          helloAck = true
        }
        if (serverHello && helloAck) finish()
      }
      socket.on('message', (data) => this.onMessage(data))
      socket.on('message', handshake)
      socket.once('error', fail)
      socket.once('close', closeBeforeHandshake)
      socket.once('open', () => {
        socket.send(
          JSON.stringify({
            type: 'client_hello',
            id: helloId,
            payload: {
              client_id: `farside-${randomUUID()}`,
              subscriptions: [...this.subscriptions]
            }
          })
        )
      })
      socket.on('error', (error) => {
        this.emit({ kind: 'connection', connected: false, error: error.message })
      })
      socket.on('pong', () => {
        this.lastServerActivityAt = Date.now()
      })
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer)
          this.heartbeatTimer = null
        }
        this.emit({ kind: 'connection', connected: false })
        this.scheduleReconnect()
      })
    })
    // 握手成功后重置退避；后续断线从基础间隔重新爬升。
    this.reconnectAttempts = 0
    this.lastServerActivityAt = Date.now()
    this.heartbeatTimer ??= setInterval(() => this.checkHeartbeat(), WS_HEARTBEAT_INTERVAL_MS)
    this.emit({ kind: 'connection', connected: true })
  }

  /** 静默链路的假死检测：先探测（协议层 ping），持续无回包才断开重连。 */
  private checkHeartbeat(): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    const idleMs = Date.now() - this.lastServerActivityAt
    if (idleMs > WS_IDLE_TIMEOUT_MS) {
      this.emit({ kind: 'connection', connected: false, error: '事件链路心跳超时，正在重连' })
      socket.terminate()
      return
    }
    if (idleMs > WS_HEARTBEAT_INTERVAL_MS) {
      try {
        socket.ping()
      } catch {
        // 发送失败交给 error/close 事件处理。
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer || !this.sender || this.sender.isDestroyed()) return
    // 指数退避：服务端长时间不可用时不再以固定 1.5s 空转。
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts)
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 10)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect().catch((error) => {
        this.emit({
          kind: 'connection',
          connected: false,
          error: error instanceof Error ? error.message : '事件链路重连失败'
        })
        this.scheduleReconnect()
      })
    }, delay)
  }

  private onMessage(data: RawData): void {
    this.lastServerActivityAt = Date.now()
    let frame: UnknownRecord
    try {
      const parsed = JSON.parse(data.toString()) as unknown
      if (!isRecord(parsed)) return
      frame = parsed
    } catch {
      return
    }
    if (frame.type === 'ping' && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(
        JSON.stringify({ type: 'pong', id: typeof frame.id === 'string' ? frame.id : randomUUID() })
      )
      return
    }
    const sessionId = typeof frame.session_id === 'string' ? frame.session_id : null
    const type = typeof frame.type === 'string' ? frame.type : null
    const payload = isRecord(frame.payload) ? frame.payload : null
    if (sessionId && type && payload && this.subscriptions.has(sessionId)) {
      this.handleSessionEvent(sessionId, type, payload)
    }
  }

  private upsertEvent(
    sessionId: string,
    event: TrajectoryEvent,
    appendText = false
  ): void {
    this.emit({ kind: 'event-upsert', sessionId, event, appendText })
  }

  private finishThinking(sessionId: string, at = Date.now()): void {
    const runtime = this.runtimes.get(sessionId)
    const active = runtime?.thinking
    if (!runtime || !active) return
    this.upsertEvent(sessionId, {
      id: active.id,
      kind: 'transmission',
      at: active.startedAt,
      text: '',
      durationMs: Math.max(1, at - active.startedAt)
    })
    runtime.thinking = null
    this.runtimes.dropIfIdle(sessionId)
  }

  private startToolCall(sessionId: string, toolCallId: string): void {
    this.runtimes.ensure(sessionId).activeToolCalls.add(toolCallId)
  }

  private finishToolCall(sessionId: string, toolCallId: string): boolean {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return false
    runtime.activeToolCalls.delete(toolCallId)
    if (runtime.activeToolCalls.size) return true
    this.runtimes.dropIfIdle(sessionId)
    return false
  }

  private hasActiveToolCalls(sessionId: string): boolean {
    return (this.runtimes.get(sessionId)?.activeToolCalls.size ?? 0) > 0
  }

  private clearSettleTimer(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId)
    if (runtime?.settleTimer) {
      clearTimeout(runtime.settleTimer)
      runtime.settleTimer = null
    }
    this.runtimes.dropIfIdle(sessionId)
  }

  private failActiveTools(sessionId: string, message: string): void {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return
    for (const toolCallId of runtime.activeToolCalls) {
      this.upsertEvent(sessionId, {
        id: `tool-${toolCallId}`,
        kind: 'instrument',
        at: Date.now(),
        tool: 'Tool',
        argsSummary: '',
        status: 'failed',
        output: message
      })
    }
    runtime.activeToolCalls.clear()
    this.runtimes.dropIfIdle(sessionId)
  }

  private markRunFailed(
    sessionId: string,
    message: string,
    status: 'failed' | 'aborted' | 'unconfirmed' = 'failed',
    code?: string
  ): void {
    const now = Date.now()
    this.clearSettleTimer(sessionId)
    this.finishThinking(sessionId, now)
    this.failActiveTools(sessionId, message)
    const runtime = this.runtimes.get(sessionId)
    if (runtime) runtime.runActive = false
    if (status !== 'aborted') this.runtimes.ensure(sessionId).runFailed = true
    this.settleActiveSubagents(
      sessionId,
      status === 'aborted' ? 'cancelled' : 'failed',
      message
    )
    this.emit({
      kind: 'session-patch',
      sessionId,
      patch: {
        phase: 'new',
        updatedAt: now,
        lastOutcome: { status, at: now, message, code }
      }
    })
  }

  private scheduleUnconfirmedCheck(sessionId: string): void {
    if (!this.runtimes.isActive(sessionId)) return
    this.clearSettleTimer(sessionId)
    const timer = setTimeout(() => {
      const scheduled = this.runtimes.get(sessionId)
      if (scheduled && scheduled.settleTimer === timer) scheduled.settleTimer = null
      void this.listRemoteSessions()
        .then((sessions) => {
          if (!this.runtimes.isActive(sessionId)) return
          const remote = sessions.find((session) => session.id === sessionId)
          if (remote?.busy === true) {
            this.emit({
              kind: 'session-patch',
              sessionId,
              patch: {
                phase: remote.pending_interaction ? 'full' : 'first-quarter'
              }
            })
            this.scheduleUnconfirmedCheck(sessionId)
            return
          }
          if (remote?.pending_interaction === 'approval') {
            this.emit({ kind: 'session-patch', sessionId, patch: { phase: 'full' } })
            void this.syncApprovals(sessionId, true)
            return
          }
          if (remote?.pending_interaction === 'question') {
            this.emit({ kind: 'session-patch', sessionId, patch: { phase: 'full' } })
            void this.syncQuestions(sessionId, true)
            return
          }
          this.markRunFailed(
            sessionId,
            '运行已停止，但服务端没有返回“已完成”信号。可能由额度耗尽、网络断开或服务异常引起；请检查账户用量后重试。',
            'unconfirmed'
          )
        })
        .catch((error) => {
          this.emit({
            kind: 'connection',
            connected: false,
            error: error instanceof Error ? error.message : '无法核对任务完成状态'
          })
          // 网络暂时不可用时继续保持“收尾中”，不能反向猜成已完成。
          this.scheduleUnconfirmedCheck(sessionId)
        })
    }, 4_000)
    this.runtimes.ensure(sessionId).settleTimer = timer
  }

  private subagentRuntime(sessionId: string, subagentId: string, at: number): SubagentRuntime {
    const bySession = this.runtimes.ensure(sessionId).subagents
    let state = bySession.get(subagentId)
    if (!state) {
      state = {
        id: subagentId,
        sessionId,
        at,
        lastAt: at,
        satelliteKind: 'coder',
        status: 'launching',
        task: '子代理任务',
        toolCount: 0,
        latestModelText: ''
      }
      bySession.set(subagentId, state)
    }
    return state
  }

  private emitSubagent(state: SubagentRuntime): void {
    this.upsertEvent(state.sessionId, {
      id: `subagent-${state.id}`,
      kind: 'satellite',
      at: state.at,
      satelliteKind: state.satelliteKind,
      status: state.status,
      task: state.task,
      parentToolCallId: state.parentToolCallId,
      swarmIndex: state.swarmIndex,
      runInBackground: state.runInBackground,
      startedAt: state.startedAt,
      durationMs: state.startedAt ? Math.max(1, state.lastAt - state.startedAt) : undefined,
      toolCount: state.toolCount,
      contextTokens: state.contextTokens,
      tokens: state.tokens,
      latestActivity: state.latestActivity,
      result: state.result
    })
  }

  /** 子代理自己的文本与工具活动只更新 Swarm 成员，不进入主 Agent 轨道。 */
  private handleSubagentActivity(
    sessionId: string,
    type: string,
    payload: UnknownRecord,
    now: number
  ): boolean {
    if (type.startsWith('subagent.')) return false
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : null
    if (!agentId || agentId === 'main') return false
    const state = this.runtimes.get(sessionId)?.subagents.get(agentId)
    // 未知子代理事件也不得伪装成主 Agent 消息或工具调用。
    if (!state) return true

    state.lastAt = now
    if ((type === 'assistant.delta' || type === 'thinking.delta') && typeof payload.delta === 'string') {
      state.latestModelText = `${state.latestModelText}${payload.delta}`.slice(-2_000)
      state.latestActivity = compactActivity(state.latestModelText)
    } else if (type === 'tool.call.started') {
      state.toolCount += 1
      const name = typeof payload.name === 'string' ? payload.name : 'Tool'
      const detail = compactActivity(payload.display ?? payload.args)
      state.latestActivity = detail ? `${name} · ${detail}` : name
    } else if (type === 'tool.progress') {
      state.latestActivity = compactActivity(payload.update) || state.latestActivity
    } else if (type === 'tool.result' && payload.isError === true) {
      state.latestActivity = compactActivity(payload.output) || '工具执行失败'
    } else if (type === 'agent.status.updated') {
      const usageRoot = isRecord(payload.usage) ? payload.usage : null
      const usage = usageRoot && isRecord(usageRoot.total)
        ? usageRoot.total
        : usageRoot && isRecord(usageRoot.currentTurn)
          ? usageRoot.currentTurn
          : usageRoot
      const tokens = tokenUsageTotal(usage)
      if (tokens !== undefined) state.tokens = Math.max(state.tokens ?? 0, tokens)
      const contextTokens = finiteNumber(payload.contextTokens)
      if (contextTokens !== null && contextTokens >= 0) {
        state.contextTokens = Math.max(state.contextTokens ?? 0, contextTokens)
      }
    }
    this.emitSubagent(state)
    return true
  }

  private settleActiveSubagents(
    sessionId: string,
    status: Extract<SatelliteEvent['status'], 'failed' | 'cancelled'>,
    result: string
  ): void {
    const states = this.runtimes.get(sessionId)?.subagents
    if (!states) return
    const now = Date.now()
    for (const state of states.values()) {
      if (['done', 'failed', 'cancelled'].includes(state.status)) continue
      state.status = status
      state.result = result
      state.latestActivity = result
      state.lastAt = now
      this.emitSubagent(state)
    }
  }

  private discardSettledSubagents(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId)
    if (!runtime) return
    for (const [subagentId, state] of runtime.subagents) {
      if (['done', 'failed', 'cancelled'].includes(state.status)) runtime.subagents.delete(subagentId)
    }
    if (!runtime.subagents.size) this.runtimes.dropIfIdle(sessionId)
  }

  private handleSessionEvent(sessionId: string, type: string, payload: UnknownRecord): void {
    const now = Date.now()
    if (type === 'tool.call.started') {
      this.turnChanges.capture(sessionId, editableToolPaths(payload))
    }
    if (this.handleSubagentActivity(sessionId, type, payload, now)) return
    if (type === 'prompt.submitted') {
      this.clearSettleTimer(sessionId)
      const runtime = this.runtimes.ensure(sessionId)
      runtime.runActive = true
      runtime.runFailed = false
      runtime.activeToolCalls.clear()
      this.discardSettledSubagents(sessionId)
      const content = Array.isArray(payload.content) ? payload.content : []
      const text = content
        .filter(isRecord)
        .filter((block) => block.type === 'text')
        .map((block) => (typeof block.text === 'string' ? block.text : ''))
        .join('\n')
      const attachments = content
        .filter(isRecord)
        .map(attachmentFromBlock)
        .filter((item): item is Attachment => item !== null)
      const internalLabel = internalMessageLabel(text)
      if (internalLabel) {
        this.upsertEvent(sessionId, {
          id: `system-${String(payload.userMessageId ?? payload.promptId ?? randomUUID())}`,
          kind: 'system',
          at: atOf(payload.createdAt),
          label: internalLabel,
          text
        })
      } else {
        this.turnChanges.begin(sessionId)
        this.upsertEvent(sessionId, {
          id: `user-${String(payload.userMessageId ?? payload.promptId ?? randomUUID())}`,
          kind: 'user',
          at: atOf(payload.createdAt),
          text,
          attachments: attachments.length ? attachments : undefined
        })
        this.emit({
          kind: 'session-patch',
          sessionId,
          patch: { phase: 'waxing', updatedAt: now, lastOutcome: null }
        })
      }
      return
    }
    if (type === 'turn.started') {
      this.clearSettleTimer(sessionId)
      this.runtimes.ensure(sessionId).runActive = true
      this.emit({
        kind: 'session-patch',
        sessionId,
        patch: { phase: 'first-quarter', lastOutcome: null }
      })
      return
    }
    if (type === 'thinking.delta' && typeof payload.delta === 'string') {
      const runtime = this.runtimes.ensure(sessionId)
      let activeThinking = runtime.thinking
      if (!activeThinking) {
        const startedAt = atOf(payload.createdAt)
        activeThinking = {
          id: `thinking-${String(payload.turnId ?? 'active')}-${++this.thinkingSequence}`,
          startedAt
        }
        runtime.thinking = activeThinking
      }
      this.upsertEvent(
        sessionId,
        {
          id: activeThinking.id,
          kind: 'transmission',
          at: activeThinking.startedAt,
          text: payload.delta,
          durationMs: Math.max(1, now - activeThinking.startedAt)
        },
        true
      )
      return
    }
    if (type === 'assistant.delta' && typeof payload.delta === 'string') {
      this.finishThinking(sessionId, now)
      this.upsertEvent(
        sessionId,
        {
          id: `message-${String(payload.turnId ?? 'active')}`,
          kind: 'message',
          at: now,
          markdown: payload.delta
        },
        true
      )
      return
    }
    if (type === 'tool.call.started') {
      this.finishThinking(sessionId, now)
      const toolCallId = String(payload.toolCallId ?? 'active')
      this.startToolCall(sessionId, toolCallId)
      this.upsertEvent(sessionId, {
        id: `tool-${toolCallId}`,
        kind: 'instrument',
        at: now,
        tool: typeof payload.name === 'string' ? payload.name : 'Tool',
        argsSummary: textOf(payload.display ?? payload.args, 500),
        status: 'running'
      })
      this.emit({ kind: 'session-patch', sessionId, patch: { phase: 'gibbous' } })
      return
    }
    if (type === 'tool.progress') {
      this.upsertEvent(sessionId, {
        id: `tool-${String(payload.toolCallId ?? 'active')}`,
        kind: 'instrument',
        at: now,
        tool: 'Tool',
        argsSummary: '',
        status: 'running',
        output: textOf(payload.update)
      })
      return
    }
    if (type === 'tool.result') {
      const toolCallId = String(payload.toolCallId ?? 'active')
      const toolsStillRunning = this.finishToolCall(sessionId, toolCallId)
      this.upsertEvent(sessionId, {
        id: `tool-${toolCallId}`,
        kind: 'instrument',
        at: now,
        tool: 'Tool',
        argsSummary: '',
        status: payload.isError === true ? 'failed' : 'done',
        output: textOf(payload.output)
      })
      if (!toolsStillRunning) {
        this.emit({ kind: 'session-patch', sessionId, patch: { phase: 'first-quarter' } })
      }
      return
    }
    if (type === 'subagent.spawned') {
      const subagentId = String(payload.subagentId ?? randomUUID())
      const state = this.subagentRuntime(sessionId, subagentId, now)
      state.satelliteKind = satelliteKind(payload.subagentName)
      state.status = 'launching'
      state.task = typeof payload.description === 'string' ? payload.description : '子代理任务'
      state.parentToolCallId = typeof payload.parentToolCallId === 'string'
        ? payload.parentToolCallId
        : undefined
      const swarmIndex = finiteNumber(payload.swarmIndex)
      state.swarmIndex = swarmIndex !== null && swarmIndex > 0 ? Math.floor(swarmIndex) : undefined
      state.runInBackground = payload.runInBackground === true
      state.lastAt = now
      this.emitSubagent(state)
      this.emit({ kind: 'session-patch', sessionId, patch: { phase: 'gibbous' } })
      return
    }
    if (
      type === 'subagent.started' ||
      type === 'subagent.suspended' ||
      type === 'subagent.completed' ||
      type === 'subagent.failed'
    ) {
      const subagentId = String(payload.subagentId ?? 'active')
      const state = this.subagentRuntime(sessionId, subagentId, now)
      state.lastAt = now
      if (type === 'subagent.started') {
        state.status = 'in-orbit'
        state.startedAt ??= now
        state.result = undefined
      } else if (type === 'subagent.suspended') {
        state.status = 'suspended'
        state.result = compactActivity(payload.reason) || '等待速率限制恢复'
        state.latestActivity = state.result
      } else if (type === 'subagent.completed') {
        state.status = 'done'
        state.result = textOf(payload.resultSummary)
        const tokens = tokenUsageTotal(payload.usage)
        if (tokens !== undefined) state.tokens = Math.max(state.tokens ?? 0, tokens)
        const contextTokens = finiteNumber(payload.contextTokens)
        if (contextTokens !== null && contextTokens >= 0) state.contextTokens = contextTokens
      } else {
        const error = textOf(payload.error)
        state.status = /abort|cancel|interrupt|手动终止|取消/i.test(error) ? 'cancelled' : 'failed'
        state.result = error
      }
      this.emitSubagent(state)
      return
    }
    if (type === 'event.session.work_changed') {
      const pending = payload.pending_interaction
      const busy = payload.busy === true
      if (!busy) this.finishThinking(sessionId, now)
      this.emit({
        kind: 'session-patch',
        sessionId,
        patch: {
          phase: pending === 'approval' || pending === 'question'
            ? 'full'
            : busy
              ? this.hasActiveToolCalls(sessionId) ? 'gibbous' : 'first-quarter'
              : this.runtimes.isActive(sessionId)
                ? 'waning'
                : 'new'
        }
      })
      if (pending === 'approval') void this.syncApprovals(sessionId, true)
      if (pending === 'question') void this.syncQuestions(sessionId, true)
      if (!pending && !busy) this.scheduleUnconfirmedCheck(sessionId)
      return
    }
    if (type === 'agent.status.updated') {
      const remotePhase = mapRemotePhase(payload.phase)
      const phase = remotePhase === 'first-quarter' && this.hasActiveToolCalls(sessionId)
        ? 'gibbous'
        : remotePhase
      this.emit({
        kind: 'session-patch',
        sessionId,
        patch: {
          ...(phase ? { phase } : {}),
          ...(typeof payload.contextTokens === 'number'
            ? { contextTokens: payload.contextTokens }
            : {})
        }
      })
      return
    }
    if (type === 'turn.step.completed') {
      this.finishThinking(sessionId, now)
      const usage = isRecord(payload.usage) ? payload.usage : {}
      const outputTokens =
        typeof usage.outputTokens === 'number'
          ? usage.outputTokens
          : typeof usage.output_tokens === 'number'
            ? usage.output_tokens
            : 0
      const duration =
        typeof payload.llmStreamDurationMs === 'number' ? payload.llmStreamDurationMs : 0
      const inputOther = usageNumber(usage, 'inputOther', 'input_other', 'inputTokens', 'input_tokens')
      const cachedInputTokens = usageNumber(usage, 'inputCacheRead', 'input_cache_read')
      const cacheCreation = usageNumber(usage, 'inputCacheCreation', 'input_cache_creation')
      const inputTokens = inputOther + cacheCreation
      const contextTokens =
        typeof usage.contextTokens === 'number'
          ? usage.contextTokens
          : typeof usage.context_tokens === 'number'
            ? usage.context_tokens
            : inputTokens + cachedInputTokens
      const cost = exactCost(payload, usage)
      const pricing = pricingForModel(payload.model ?? usage.model)
      const inputCostCny = pricing ? (inputTokens / 1_000_000) * pricing.input : undefined
      const cachedInputCostCny = pricing ? (cachedInputTokens / 1_000_000) * pricing.cachedInput : undefined
      const outputCostCny = pricing ? (outputTokens / 1_000_000) * pricing.output : undefined
      this.upsertEvent(sessionId, {
        id: `telemetry-${String(payload.turnId ?? 'turn')}-${String(payload.stepId ?? 'step')}`,
        kind: 'telemetry',
        at: now,
        tokensPerSecond: duration > 0 ? outputTokens / (duration / 1000) : 0,
        contextTokens,
        cost,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        cacheHitRate: inputTokens + cachedInputTokens > 0
          ? (cachedInputTokens / (inputTokens + cachedInputTokens)) * 100
          : 0,
        ...(pricing ? {
          estimatedCostCny: (inputCostCny ?? 0) + (cachedInputCostCny ?? 0) + (outputCostCny ?? 0),
          inputCostCny,
          cachedInputCostCny,
          outputCostCny
        } : {})
      })
      if (contextTokens > 0) {
        this.emit({ kind: 'session-patch', sessionId, patch: { contextTokens } })
      }
      return
    }
    if (type === 'session.meta.updated' && typeof payload.title === 'string') {
      this.emit({ kind: 'session-patch', sessionId, patch: { title: payload.title } })
      return
    }
    if (type === 'goal.updated') {
      this.emit({ kind: 'goal-updated', sessionId, goal: this.mapGoal(payload.snapshot) })
      return
    }
    if (type === 'turn.ended' || type === 'prompt.completed' || type === 'prompt.aborted') {
      this.finishThinking(sessionId, now)
      const runtime = this.runtimes.get(sessionId)
      if (runtime) runtime.activeToolCalls.clear()
      if (type === 'prompt.aborted') {
        this.markRunFailed(sessionId, '请求已由用户终止，未完成当前任务。', 'aborted')
        return
      } else if (
        type === 'turn.ended' &&
        typeof payload.reason === 'string' &&
        !['completed', 'end_turn', 'stop', 'success'].includes(payload.reason.toLowerCase())
      ) {
        const reason = compactActivity(payload.reason) || '主请求未完成'
        this.markRunFailed(sessionId, friendlyRunError(reason), 'failed', payload.reason)
        return
      }
      if (type === 'prompt.completed') {
        this.clearSettleTimer(sessionId)
        if (runtime) runtime.runActive = false
        if (!runtime?.runFailed) {
          this.emit({
            kind: 'session-patch',
            sessionId,
            patch: {
              phase: 'new',
              updatedAt: now,
              lastOutcome: { status: 'completed', at: now }
            }
          })
        }
        void this.syncPersistedTelemetry(sessionId)
        return
      }
      this.emit({
        kind: 'session-patch',
        sessionId,
        patch: { phase: 'waning', updatedAt: now }
      })
      this.scheduleUnconfirmedCheck(sessionId)
      return
    }
    if (type === 'error' || type === 'warning') {
      const rawMessage = textOf(payload.message ?? payload.error ?? payload.detail, 4_000)
      const code = typeof payload.code === 'string' ? payload.code : undefined
      const message = type === 'error' ? friendlyRunError(rawMessage, code) : rawMessage
      this.upsertEvent(sessionId, {
        id: `${type}-${String(payload.code ?? randomUUID())}-${now}`,
        kind: 'message',
        at: now,
        markdown: `**链路${type === 'error' ? '中断' : '警告'}**\n\n${message || '服务端未提供更多信息。'}`
      })
      if (type === 'error') this.markRunFailed(sessionId, message, 'failed', code)
    }
  }

  private mapGoal(value: unknown): GoalState | null {
    if (!isRecord(value) || typeof value.objective !== 'string') return null
    const status = value.status
    if (status === 'complete' || status === 'cancelled') return null
    return {
      objective: value.objective,
      status: status === 'paused' || status === 'blocked' ? status : 'active',
      startedAt:
        typeof value.wallClockMs === 'number'
          ? Date.now() - value.wallClockMs
          : atOf(value.started_at ?? value.startedAt),
      turns:
        typeof value.turnsUsed === 'number'
          ? value.turnsUsed
          : typeof value.turns === 'number'
            ? value.turns
            : 0,
      tokens:
        typeof value.tokensUsed === 'number'
          ? value.tokensUsed
          : typeof value.tokens === 'number'
            ? value.tokens
            : 0,
      blockedReason:
        (typeof value.terminalReason === 'string' && value.terminalReason) ||
        (typeof value.blocked_reason === 'string' ? value.blocked_reason : undefined)
    }
  }

  private async syncApprovals(sessionId: string, retry = false): Promise<void> {
    const inFlight = this.approvalSyncs.get(sessionId)
    if (inFlight) return inFlight
    const task = (async () => {
      try {
        const delays = retry ? [0, 80, 200, 500, 1_000, 2_000] : [0]
        for (const delay of delays) {
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
          let approvals = await this.listApprovals(sessionId)
          if (!approvals.length) {
            const snapshot = await this.request<{ pending_approvals?: RemoteApproval[] }>(
              `/api/v1/sessions/${encodeURIComponent(sessionId)}/snapshot`
            )
            approvals = (snapshot.pending_approvals ?? []).map(approvalFromRemote)
          }
          if (!approvals.length) continue
          for (const approval of approvals) {
            this.emit({ kind: 'approval-upsert', approval })
            this.upsertEvent(sessionId, {
              id: `approval-${approval.id}`,
              kind: 'approval',
              at: approval.requestedAt,
              approvalId: approval.id,
              tool: approval.tool,
              detail: approval.detail,
              diff: approval.diff
            })
          }
          return
        }
      } catch (error) {
        this.emit({
          kind: 'connection',
          connected: true,
          error: error instanceof Error ? error.message : '审批同步失败'
        })
      }
    })().finally(() => this.approvalSyncs.delete(sessionId))
    this.approvalSyncs.set(sessionId, task)
    return task
  }

  private async syncQuestions(sessionId: string, retry = false): Promise<void> {
    const inFlight = this.questionSyncs.get(sessionId)
    if (inFlight) return inFlight
    const task = (async () => {
      try {
        const delays = retry ? [0, 80, 200, 500, 1_000, 2_000] : [0]
        for (const delay of delays) {
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
          let questions = await this.listQuestions(sessionId)
          if (!questions.length) {
            const snapshot = await this.request<{ pending_questions?: RemoteQuestion[] }>(
              `/api/v1/sessions/${encodeURIComponent(sessionId)}/snapshot`
            )
            questions = (snapshot.pending_questions ?? []).map(questionFromRemote)
          }
          if (!questions.length) continue
          for (const question of questions) this.emit({ kind: 'question-upsert', question })
          return
        }
      } catch (error) {
        this.emit({
          kind: 'connection',
          connected: true,
          error: error instanceof Error ? error.message : '问题同步失败'
        })
      }
    })().finally(() => this.questionSyncs.delete(sessionId))
    this.questionSyncs.set(sessionId, task)
    return task
  }

  async reconnectBackend(): Promise<void> {
    this.disposed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.socket?.close()
    this.socket = null
    this.disposed = false
    await this.connect()
  }

  dispose(): void {
    this.disposed = true
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.streamFlushTimer) clearTimeout(this.streamFlushTimer)
    this.streamFlushTimer = null
    this.pendingStreamUpdates.clear()
    this.approvalSyncs.clear()
    this.questionSyncs.clear()
    this.runtimes.disposeAll()
    this.socket?.close()
    this.socket = null
    this.sender = null
    this.turnChanges.clear()
  }
}
