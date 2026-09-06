import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { WorkspaceInfo } from '@shared/ipc'
import type {
  AccountProviderInfo,
  ApprovalRequest,
  Attachment,
  MoonPhase,
  AccountUsage,
  QuestionRequest,
  SatelliteEvent,
  Session,
  TrajectoryEvent
} from '@shared/types'
// WHY: npm test 把本文件编译成 CommonJS 直跑 Node，@shared 别名只在
// electron-vite 打包时解析；运行时依赖必须走相对路径，类型导入可以保留别名。
import { MAX_ATTACHMENT_BYTES } from '../../shared/security'
import { fromKimiServerModel } from '../../shared/types'

/**
 * Kimi wire → Farside 契约的归一化层。
 * 本文件只允许纯函数与数据形状：不发请求、不持有状态、不依赖 Electron，
 * 以便在测试中直接对上游协议形状做单测。
 */

export interface ApiEnvelope<T> {
  code: number
  msg: string
  data: T
}

export interface RemoteSession {
  id: string
  workspace_id?: string
  archived?: boolean
  title?: string
  created_at?: unknown
  updated_at?: unknown
  busy?: boolean
  pending_interaction?: string
  metadata?: { cwd?: string }
  agent_config?: { model?: string }
  usage?: {
    context_tokens?: number
    total_cost_usd?: number
  }
}

export interface RemoteWorkspace {
  id: string
  root: string
  name?: string
  is_git_repo?: boolean
  branch?: string
  created_at?: unknown
  last_opened_at?: unknown
  session_count?: number
}

export interface RemoteApproval {
  approval_id: string
  session_id: string
  tool_name: string
  action?: string
  tool_input_display?: unknown
  created_at?: unknown
}

export interface RemoteQuestion {
  question_id: string
  session_id: string
  questions: Array<{
    id: string
    question: string
    header?: string
    body?: string
    options: Array<{ id: string; label: string; description?: string }>
    multi_select?: boolean
    allow_other?: boolean
  }>
  created_at?: unknown
}

export interface RemoteProvider {
  id: string
  type: string
  base_url?: string
  default_model?: string
  has_api_key: boolean
  status: 'connected' | 'error' | 'unconfigured'
  models?: string[]
}

/**
 * GET /api/v1/auth 摘要。0.39 起移除了 `ready` 字段，改为
 * `{ models_ready, providers_count, managed_provider }`（见上游
 * app/authLegacy/authLegacy.ts 的 authSummarySchema）。
 */
export interface AuthSummaryWire {
  ready?: boolean
  models_ready?: boolean
  providers_count?: number
  managed_provider?: { name?: string; status?: string } | null
}

export interface RemoteModel {
  provider: string
  model: string
  display_name?: string
  max_context_size: number
  capabilities?: string[]
}

export type UnknownRecord = Record<string, unknown>

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

export function decodedBase64Size(value: string): number | null {
  if (!value || value.length > Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 4) return null
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return Math.floor(value.length * 3 / 4) - padding
}

export function isBoundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0)
}

export async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error(`响应体超过 ${Math.floor(maxBytes / 1024 / 1024)} MiB`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}

export function textOf(value: unknown, max = 4_000): string {
  if (typeof value === 'string') return value.slice(0, max)
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2).slice(0, max)
  } catch {
    return String(value).slice(0, max)
  }
}

export function atOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now()
}

export function timestampOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return null
}

export function projectOf(cwd: string): string {
  const normalized = cwd.replace(/\\/g, '/').replace(/\/$/, '')
  return basename(normalized) || 'workspace'
}

export function phaseOf(session: RemoteSession): MoonPhase {
  if (session.pending_interaction === 'approval' || session.pending_interaction === 'question') {
    return 'full'
  }
  return session.busy ? 'first-quarter' : 'new'
}

export function mapRemotePhase(value: unknown): MoonPhase | null {
  if (typeof value !== 'string') return null
  if (['idle', 'ready', 'completed'].includes(value)) return 'new'
  if (['queued', 'receiving'].includes(value)) return 'waxing'
  if (['thinking', 'reasoning'].includes(value)) return 'first-quarter'
  if (['acting', 'tool', 'working', 'running'].includes(value)) return 'gibbous'
  if (['approval', 'question', 'waiting'].includes(value)) return 'full'
  if (['wrapping', 'finishing'].includes(value)) return 'waning'
  return null
}

export function sessionFromRemote(remote: RemoteSession, events: TrajectoryEvent[] = []): Session {
  const cwd = remote.metadata?.cwd ?? ''
  return {
    id: remote.id,
    workspaceId: remote.workspace_id,
    title: remote.title?.trim() || '未命名会话',
    project: projectOf(cwd),
    cwd,
    phase: phaseOf(remote),
    model: fromKimiServerModel(remote.agent_config?.model),
    updatedAt: atOf(remote.updated_at ?? remote.created_at),
    contextTokens: remote.usage?.context_tokens ?? 0,
    events,
    archived: remote.archived === true
  }
}

export interface PersistedTelemetry {
  contextTokens: number
  tokensPerSecond: number
  activeDurationMs: number
  cost?: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  cacheHitRate: number
  estimatedCostCny?: number
  inputCostCny?: number
  cachedInputCostCny?: number
  outputCostCny?: number
  at: number
}

export interface SubagentRuntime {
  id: string
  sessionId: string
  at: number
  lastAt: number
  satelliteKind: SatelliteEvent['satelliteKind']
  status: SatelliteEvent['status']
  task: string
  parentToolCallId?: string
  swarmIndex?: number
  runInBackground?: boolean
  startedAt?: number
  toolCount: number
  contextTokens?: number
  tokens?: number
  latestActivity?: string
  latestModelText: string
  result?: string
}

export interface TokenPricing {
  cachedInput: number
  input: number
  output: number
}

/** 官方开放平台 2026-07-19 公布的人民币/百万 tokens 单价。 */
export function pricingForModel(model: unknown): TokenPricing | null {
  const id = typeof model === 'string' ? model.toLowerCase() : ''
  if (id.includes('highspeed')) return { cachedInput: 2.6, input: 13, output: 54 }
  if (id.includes('kimi-for-coding') || id.includes('k2.7-code') || id.includes('k27')) {
    return { cachedInput: 1.3, input: 6.5, output: 27 }
  }
  if (id.includes('k3')) return { cachedInput: 2, input: 20, output: 100 }
  return null
}

export function usageNumber(usage: UnknownRecord, ...keys: string[]): number {
  for (const key of keys) {
    const value = finiteNumber(usage[key])
    if (value !== null && value >= 0) return value
  }
  return 0
}

export function tokenUsageTotal(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  const groups = [
    ['inputOther', 'input_other'],
    ['output', 'output_tokens'],
    ['inputCacheRead', 'input_cache_read'],
    ['inputCacheCreation', 'input_cache_creation']
  ]
  let seen = false
  let total = 0
  for (const keys of groups) {
    for (const key of keys) {
      const amount = finiteNumber(value[key])
      if (amount === null || amount < 0) continue
      total += amount
      seen = true
      break
    }
  }
  return seen ? total : undefined
}

export function compactActivity(value: unknown): string {
  const candidate = isRecord(value)
    ? value.text ?? value.message ?? value.delta ?? value.output ?? value
    : value
  return textOf(candidate, 2_000).replace(/\s+/g, ' ').trim().slice(-320)
}

export function exactCost(record: UnknownRecord, usage: UnknownRecord): number | undefined {
  for (const source of [usage, record]) {
    for (const key of ['totalCostUsd', 'total_cost_usd', 'costUsd', 'cost_usd']) {
      const value = finiteNumber(source[key])
      if (value !== null && value > 0) return value
    }
  }
  return undefined
}

export function telemetryFromWire(text: string): PersistedTelemetry | null {
  let latestContext = 0
  let totalOutput = 0
  let totalInput = 0
  let totalCachedInput = 0
  let activeDurationMs = 0
  let pendingRequestAt: number | null = null
  let latestAt = 0
  let cost: number | undefined
  let usageRecords = 0
  let inputCostCny = 0
  let cachedInputCostCny = 0
  let outputCostCny = 0
  let pricedRecords = 0

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let record: UnknownRecord
    try {
      const parsed = JSON.parse(line) as unknown
      if (!isRecord(parsed)) continue
      record = parsed
    } catch {
      continue
    }
    const type = typeof record.type === 'string' ? record.type : ''
    const at = timestampOf(record.time ?? record.at ?? record.created_at)
    if (type === 'llm.request') {
      pendingRequestAt = at
      continue
    }
    if (type !== 'usage.record' || !isRecord(record.usage)) continue
    const usage = record.usage
    const output = usageNumber(usage, 'output', 'outputTokens', 'output_tokens')
    const inputOther = usageNumber(usage, 'inputOther', 'input_other', 'inputTokens', 'input_tokens')
    const cacheRead = usageNumber(usage, 'inputCacheRead', 'input_cache_read')
    const cacheCreation = usageNumber(usage, 'inputCacheCreation', 'input_cache_creation')
    const uncachedInput = inputOther + cacheCreation
    latestContext = inputOther + cacheRead + cacheCreation
    totalInput += uncachedInput
    totalCachedInput += cacheRead
    totalOutput += output
    usageRecords += 1
    if (at !== null) {
      latestAt = Math.max(latestAt, at)
      if (pendingRequestAt !== null && at >= pendingRequestAt) {
        activeDurationMs += at - pendingRequestAt
      }
    }
    pendingRequestAt = null
    cost = exactCost(record, usage) ?? cost
    const pricing = pricingForModel(record.model ?? usage.model)
    if (pricing) {
      pricedRecords += 1
      inputCostCny += (uncachedInput / 1_000_000) * pricing.input
      cachedInputCostCny += (cacheRead / 1_000_000) * pricing.cachedInput
      outputCostCny += (output / 1_000_000) * pricing.output
    }
  }

  if (usageRecords === 0) return null
  return {
    contextTokens: latestContext,
    tokensPerSecond: activeDurationMs > 0 ? totalOutput / (activeDurationMs / 1000) : 0,
    activeDurationMs,
    cost,
    inputTokens: totalInput,
    cachedInputTokens: totalCachedInput,
    outputTokens: totalOutput,
    cacheHitRate: totalInput + totalCachedInput > 0
      ? (totalCachedInput / (totalInput + totalCachedInput)) * 100
      : 0,
    ...(pricedRecords > 0 ? {
      estimatedCostCny: inputCostCny + cachedInputCostCny + outputCostCny,
      inputCostCny,
      cachedInputCostCny,
      outputCostCny
    } : {}),
    at: latestAt || Date.now()
  }
}

export function workspaceFromRemote(remote: RemoteWorkspace): WorkspaceInfo {
  return {
    id: remote.id,
    root: remote.root,
    name: remote.name?.trim() || projectOf(remote.root),
    isGitRepo: remote.is_git_repo === true,
    branch: remote.branch,
    createdAt: atOf(remote.created_at),
    lastOpenedAt: atOf(remote.last_opened_at),
    sessionCount: remote.session_count ?? 0
  }
}

export function attachmentFromBlock(block: UnknownRecord, index: number): Attachment | null {
  const type = typeof block.type === 'string' ? block.type : ''
  if (!['image', 'video', 'file'].includes(type)) return null
  const source = isRecord(block.source) ? block.source : null
  const mimeType =
    (typeof block.media_type === 'string' && block.media_type) ||
    (source && typeof source.media_type === 'string' && source.media_type) ||
    (type === 'video' ? 'video/*' : type === 'image' ? 'image/*' : 'application/octet-stream')
  return {
    id: `history-attachment-${index}`,
    name: typeof block.name === 'string' && block.name ? block.name : `${type}-${index + 1}`,
    mimeType,
    size: typeof block.size === 'number' ? block.size : 0,
    vision: type === 'image' || type === 'video'
  }
}

export const INTERNAL_MESSAGE_ENVELOPES: Array<[RegExp, string]> = [
  [/^<system-reminder(?:\s|>)/i, '系统提醒'],
  [/^<notification(?:\s|>)/i, '运行时通知'],
  [/^<environment_context(?:\s|>)/i, '环境上下文'],
  [/^<permissions instructions(?:\s|>)/i, '权限上下文'],
  [/^<app-context(?:\s|>)/i, 'App 上下文'],
  [/^<collaboration_mode(?:\s|>)/i, '协作上下文'],
  [/^<(?:apps|plugins|skills)_instructions(?:\s|>)/i, '能力上下文'],
  [/^<recommended_plugins(?:\s|>)/i, '插件推荐'],
  [/^(?:skill|plugin|mcp|app) tool loaded instructions for this request\b/i, '能力上下文'],
  [/^<kimi-(?:skill|plugin|mcp|app)-loaded(?:\s|>)/i, '能力上下文'],
  [/^<(?:skill|plugin|mcp|app)-loaded(?:\s|>)/i, '能力上下文'],
  [/^#\s*AGENTS\.md instructions\b/i, '项目指令']
]

export function internalMessageLabel(text: string): string | null {
  const trimmed = text.trimStart()
  const direct = INTERNAL_MESSAGE_ENVELOPES.find(([pattern]) => pattern.test(trimmed))?.[1]
  if (direct) return direct
  const prefix = trimmed.slice(0, 512)
  if (/^[^\r\n]{0,160}loaded instructions for this request\b/i.test(prefix)) return '能力上下文'
  if (/<kimi-(?:skill|plugin|mcp|app)-loaded(?:\s|>)/i.test(prefix)) return '能力上下文'
  return null
}

export function durationOf(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  return 0
}

export function eventsFromMessages(messages: unknown): TrajectoryEvent[] {
  const items = isRecord(messages) && Array.isArray(messages.items) ? messages.items : []
  const events: TrajectoryEvent[] = []
  const tools = new Map<string, number>()

  for (const rawMessage of items) {
    if (!isRecord(rawMessage)) continue
    const messageId = typeof rawMessage.id === 'string' ? rawMessage.id : randomUUID()
    const role = typeof rawMessage.role === 'string' ? rawMessage.role : 'assistant'
    const at = atOf(rawMessage.created_at)
    const updatedAt = timestampOf(rawMessage.updated_at)
    const messageDuration = updatedAt !== null && updatedAt > at ? updatedAt - at : 0
    const blocks = Array.isArray(rawMessage.content) ? rawMessage.content : []
    const records = blocks.filter(isRecord)
    const textParts = records
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
    const attachments = records
      .map(attachmentFromBlock)
      .filter((item): item is Attachment => item !== null)

    // Kimi 会把技能、权限和运行环境作为 user role 注入；它们不是用户请求。
    // user 消息按整条归类，assistant 消息则必须逐 block 保序，才能还原“文字—工具—文字”。
    if (role === 'user') {
      if (textParts.length) {
        const text = textParts.join('\n')
        const internalLabel = internalMessageLabel(text)
        events.push(internalLabel
          ? { id: `system-${messageId}`, kind: 'system', at, label: internalLabel, text }
          : {
              id: `user-${messageId}`,
              kind: 'user',
              at,
              text,
              attachments: attachments.length ? attachments : undefined
            })
      }
      continue
    }

    records.forEach((rawBlock, index) => {
      const type = rawBlock.type
      if (type === 'text' && typeof rawBlock.text === 'string' && rawBlock.text) {
        events.push({
          id: `message-${messageId}-${index}`,
          kind: 'message',
          at,
          markdown: rawBlock.text
        })
      } else if (type === 'thinking' && typeof rawBlock.thinking === 'string' && rawBlock.thinking) {
        events.push({
          id: `thinking-${messageId}-${index}`,
          kind: 'transmission',
          at,
          text: rawBlock.thinking,
          durationMs: durationOf(
            rawBlock.duration_ms,
            rawBlock.durationMs,
            rawMessage.thinking_duration_ms,
            rawMessage.thinkingDurationMs,
            messageDuration
          )
        })
      } else if (type === 'tool_use') {
        const callId = typeof rawBlock.tool_call_id === 'string' ? rawBlock.tool_call_id : randomUUID()
        tools.set(callId, events.length)
        events.push({
          id: `tool-${callId}`,
          kind: 'instrument',
          at,
          tool: typeof rawBlock.tool_name === 'string' ? rawBlock.tool_name : 'Tool',
          argsSummary: textOf(rawBlock.input, 500),
          status: 'running'
        })
      } else if (type === 'tool_result') {
        const callId = typeof rawBlock.tool_call_id === 'string' ? rawBlock.tool_call_id : ''
        const eventIndex = tools.get(callId)
        const event = eventIndex === undefined ? null : events[eventIndex]
        if (eventIndex !== undefined && event?.kind === 'instrument') {
          events[eventIndex] = {
            ...event,
            status: rawBlock.is_error === true ? 'failed' : 'done',
            output: textOf(rawBlock.output)
          }
        }
      }
    })
  }
  const sorted = events.sort((a, b) => a.at - b.at)
  return sorted.map((event, index) => {
    if (event.kind !== 'transmission' || event.durationMs > 0) return event
    const next = sorted.slice(index + 1).find((candidate) => candidate.kind === 'user' || candidate.at > event.at)
    const inferred = next && next.kind !== 'user' ? next.at - event.at : 0
    return inferred > 0 && inferred <= 10 * 60_000 ? { ...event, durationMs: inferred } : event
  })
}

export function approvalFromRemote(remote: RemoteApproval): ApprovalRequest {
  const display = isRecord(remote.tool_input_display) ? remote.tool_input_display : null
  const rawOptions = display && Array.isArray(display.options) ? display.options : []
  const planReview =
    display?.kind === 'plan_review' &&
    typeof display.plan === 'string' &&
    display.plan.trim()
      ? {
          plan: display.plan,
          ...(typeof display.path === 'string' && display.path ? { path: display.path } : {}),
          options: rawOptions
            .filter(isRecord)
            .filter((option) => typeof option.label === 'string' && option.label)
            .slice(0, 3)
            .map((option) => ({
              label: String(option.label),
              ...(typeof option.description === 'string' && option.description
                ? { description: option.description }
                : {})
            }))
        }
      : undefined
  return {
    id: remote.approval_id,
    sessionId: remote.session_id,
    tool: remote.tool_name,
    detail: textOf(remote.tool_input_display || remote.action || remote.tool_name),
    ...(planReview ? { planReview } : {}),
    requestedAt: atOf(remote.created_at)
  }
}

export function questionFromRemote(remote: RemoteQuestion): QuestionRequest {
  return {
    id: remote.question_id,
    sessionId: remote.session_id,
    requestedAt: atOf(remote.created_at),
    questions: remote.questions.map((question) => ({
      id: question.id,
      question: question.question,
      header: question.header,
      body: question.body,
      options: question.options,
      multiSelect: question.multi_select === true,
      allowOther: question.allow_other === true
    }))
  }
}

export function satelliteKind(name: unknown): 'coder' | 'explore' | 'plan' {
  const value = typeof name === 'string' ? name.toLowerCase() : ''
  if (value.includes('explore')) return 'explore'
  if (value.includes('plan')) return 'plan'
  return 'coder'
}

export function editableToolPaths(payload: UnknownRecord): string[] {
  const name = typeof payload.name === 'string' ? payload.name : ''
  if (!/(?:edit|write|patch|create|delete|remove|move|rename)/i.test(name)) return []
  const paths = new Set<string>()
  const add = (value: string) => {
    const cleaned = value.trim().replace(/^["'`]|["'`]$/g, '')
    if (cleaned && cleaned.length <= 4_096 && !cleaned.includes('\0')) paths.add(cleaned)
  }
  const visit = (value: unknown, key = '') => {
    if (typeof value === 'string') {
      if (/(?:^|_)(?:path|file|filename|target)$/i.test(key) || /(?:path|filePath|file_path)$/i.test(key)) add(value)
      for (const match of value.matchAll(/^\*{3} (?:Add|Update|Delete) File:\s*(.+)$/gm)) add(match[1])
      for (const match of value.matchAll(/^(?:---|\+\+\+) [ab]\/(.+)$/gm)) add(match[1])
      for (const match of value.matchAll(/\b(?:Edit|WriteFile|CreateFile|DeleteFile)\(([^,\n)]+)/g)) add(match[1])
      if (/^\s*[{[]/.test(value)) {
        try {
          visit(JSON.parse(value))
        } catch {
          // 工具 display 不一定是 JSON，继续使用已识别的文本路径。
        }
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (isRecord(value)) {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey)
    }
  }
  visit(payload.args)
  visit(payload.display)
  return [...paths]
}

export function accountProviderKind(provider: RemoteProvider): AccountProviderInfo['kind'] {
  if (provider.id === 'managed:kimi-code') return 'kimi-oauth'
  return provider.type === 'kimi' ? 'kimi-api' : 'openai-compatible'
}

export function providerLabel(provider: RemoteProvider): string {
  if (provider.id === 'managed:kimi-code') return 'Kimi OAuth'
  if (provider.type === 'kimi') return 'Kimi 官方 API'
  return 'OpenAI 兼容服务'
}

export const PLAN_LABELS: Record<string, string> = {
  LEVEL_FREE: 'Adagio',
  LEVEL_BASIC: 'Moderato',
  LEVEL_BEGINNER: 'Moderato',
  LEVEL_INTERMEDIATE: 'Allegretto',
  LEVEL_ADVANCED: 'Allegro',
  LEVEL_PROFESSIONAL: 'Vivace'
}

export function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(number) ? number : null
}

export function localDateKey(timestamp: number): string {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function profileReasoningLabel(value: string): string {
  return {
    max: '极高',
    high: '高',
    medium: '中',
    low: '低',
    minimal: '最低',
    on: '开启'
  }[value.toLowerCase()] ?? value
}

export function usageWindow(value: unknown): AccountUsage['weekly'] {
  if (!isRecord(value)) return undefined
  const limit = finiteNumber(value.limit)
  const usedValue = finiteNumber(value.used)
  const remainingValue = finiteNumber(value.remaining)
  if (limit === null || limit <= 0) return undefined
  const used = usedValue ?? Math.max(0, limit - (remainingValue ?? limit))
  const usedPct = Math.max(0, Math.min(100, Math.round((used / limit) * 100)))
  const resetAt =
    (typeof value.resetTime === 'string' && value.resetTime) ||
    (typeof value.resetAt === 'string' && value.resetAt) ||
    (typeof value.reset_time === 'string' && value.reset_time) ||
    (typeof value.reset_at === 'string' && value.reset_at) ||
    undefined
  return { usedPct, remainingPct: 100 - usedPct, resetAt }
}

export function fixedPointCny(value: number): number {
  const cents = value / 1_000_000
  return (cents > 0 && cents < 1 ? 1 : Math.round(cents)) / 100
}

export function walletAmount(value: unknown, ...keys: string[]): number | null {
  if (!isRecord(value)) return null
  for (const key of keys) {
    const amount = finiteNumber(value[key])
    if (amount !== null) return amount
  }
  return null
}

export function walletCurrency(value: unknown): string | null {
  return isRecord(value) && typeof value.currency === 'string'
    ? value.currency.toUpperCase()
    : null
}

export function walletCny(value: unknown, ...keys: string[]): number | null {
  const amount = walletAmount(value, ...keys)
  if (amount === null || walletCurrency(value) !== 'CNY') return null
  return fixedPointCny(amount)
}

export function friendlyRunError(message: string, code?: string): string {
  const haystack = `${code ?? ''} ${message}`.toLowerCase()
  if (/quota|额度|balance|余额|insufficient|resource_exhausted|payment/.test(haystack)) {
    return `额度不足，本轮执行已中断。请在“设置 → 账户”检查 5 小时、周限额或额度加油包。${message ? `\n\n服务端信息：${message}` : ''}`
  }
  if (/rate.?limit|too many requests|限流|频率/.test(haystack)) {
    return `请求触发限流，本轮尚未完成。请等待额度窗口恢复后重试。${message ? `\n\n服务端信息：${message}` : ''}`
  }
  if (/unauth|forbidden|401|403|登录|token|credential/.test(haystack)) {
    return `登录凭据已失效或无权调用，本轮执行已中断。请刷新账户或重新登录。${message ? `\n\n服务端信息：${message}` : ''}`
  }
  return message || '模型或服务链路异常终止，未生成可信的完成信号。'
}

export interface WireFileProfileStats {
  daily: Map<string, { tokens: number; tasks: number }>
  reasoning: Map<string, number>
  skills: Map<string, number>
  tools: Map<string, number>
  totalTokens: number
  peakTaskTokens: number
  longestTaskDurationMs: number
  taskCount: number
  requestCount: number
  fastRequestCount: number
}

function increment(map: Map<string, number>, key: string): void {
  if (key) map.set(key, (map.get(key) ?? 0) + 1)
}

/**
 * 解析单个 wire.jsonl 的个人资料统计。结果只依赖文件内容本身，
 * 调用方按 mtime 缓存后跨文件聚合，避免每次打开设置页全量重扫。
 */
export function parseWireProfile(text: string): WireFileProfileStats {
  const stats: WireFileProfileStats = {
    daily: new Map(),
    reasoning: new Map(),
    skills: new Map(),
    tools: new Map(),
    totalTokens: 0,
    peakTaskTokens: 0,
    longestTaskDurationMs: 0,
    taskCount: 0,
    requestCount: 0,
    fastRequestCount: 0
  }
  let taskTokens = 0
  let taskDurationMs = 0
  let pendingRequestAt: number | null = null
  let hasTask = false
  const finalizeTask = (): void => {
    stats.peakTaskTokens = Math.max(stats.peakTaskTokens, taskTokens)
    stats.longestTaskDurationMs = Math.max(stats.longestTaskDurationMs, taskDurationMs)
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let record: UnknownRecord
    try {
      const parsed = JSON.parse(line) as unknown
      if (!isRecord(parsed)) continue
      record = parsed
    } catch {
      continue
    }
    const type = typeof record.type === 'string' ? record.type : ''
    const at = timestampOf(record.time ?? record.at ?? record.created_at)
    if (type === 'turn.prompt') {
      if (hasTask) finalizeTask()
      hasTask = true
      taskTokens = 0
      taskDurationMs = 0
      pendingRequestAt = null
      stats.taskCount += 1
      if (at !== null) {
        const key = localDateKey(at)
        const value = stats.daily.get(key) ?? { tokens: 0, tasks: 0 }
        value.tasks += 1
        stats.daily.set(key, value)
      }
      continue
    }
    if (type === 'llm.request') {
      pendingRequestAt = at
      stats.requestCount += 1
      const model = typeof record.model === 'string' ? record.model.toLowerCase() : ''
      const alias = typeof record.modelAlias === 'string' ? record.modelAlias.toLowerCase() : ''
      if (/highspeed|fast/.test(`${model} ${alias}`)) stats.fastRequestCount += 1
      if (typeof record.thinkingEffort === 'string') increment(stats.reasoning, record.thinkingEffort)
      continue
    }
    if (type === 'usage.record' && isRecord(record.usage)) {
      const tokens = tokenUsageTotal(record.usage) ?? 0
      stats.totalTokens += tokens
      taskTokens += tokens
      if (at !== null) {
        const key = localDateKey(at)
        const value = stats.daily.get(key) ?? { tokens: 0, tasks: 0 }
        value.tokens += tokens
        stats.daily.set(key, value)
        if (pendingRequestAt !== null && at >= pendingRequestAt) {
          taskDurationMs += at - pendingRequestAt
        }
      }
      pendingRequestAt = null
      continue
    }
    if (type === 'context.append_loop_event' && isRecord(record.event)) {
      const event = record.event
      if (event.type !== 'tool.call' || typeof event.name !== 'string') continue
      const toolName = event.name.trim()
      increment(stats.tools, toolName)
      if (toolName.toLowerCase() === 'skill' && isRecord(event.args)) {
        const skill = typeof event.args.skill === 'string'
          ? event.args.skill
          : typeof event.args.name === 'string'
            ? event.args.name
            : ''
        increment(stats.skills, skill.replace(/^\$/, '').trim())
      }
    }
  }
  if (hasTask || taskTokens > 0) finalizeTask()
  return stats
}
