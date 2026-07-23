import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { WebContents } from 'electron'
import WebSocket, { type RawData } from 'ws'
import {
  IPC,
  type AccountConfigureInput,
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
  type WorkspaceInfo,
  type WorkspaceListResult,
  type WorkspaceResult,
  type WorkspaceReadResult
} from '@shared/ipc'
import { TurnChangesService } from './turn-changes'
import {
  isAllowedApiBaseUrl,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_FILE_REFERENCE_COUNT,
  MAX_PROMPT_CHARS,
  MAX_TOTAL_ATTACHMENT_BYTES
} from '@shared/security'
import {
  fromKimiServerModel,
  toKimiServerModel,
  type AccountModelInfo,
  type AccountProviderInfo,
  type AccountState,
  type AccountUsage,
  type ApprovalRequest,
  type Attachment,
  type GoalState,
  type MoonPhase,
  type QuestionRequest,
  type SatelliteEvent,
  type Session,
  type TrajectoryEvent
} from '@shared/types'
import { readKimiServerToken, type ServerService } from './server'
import { SUPPORTED_KIMI_WS_PROTOCOL_VERSION } from './runtime-manifest'
import { resolveOAuthLoginState } from './oauth-login-state'
import { sanitizeZipFileName } from '../security'

const REQUEST_TIMEOUT_MS = 30_000
const EXPORT_TIMEOUT_MS = 120_000
const MAX_EXPORT_BYTES = 256 * 1024 * 1024
const MAX_WS_PAYLOAD_BYTES = 8 * 1024 * 1024
// snapshot 只回最近一页消息；逐页补齐时的安全上限，避免异常会话拖垮加载。
const MAX_HISTORY_PAGES = 100

interface ApiEnvelope<T> {
  code: number
  msg: string
  data: T
}

interface RemoteSession {
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

interface RemoteWorkspace {
  id: string
  root: string
  name?: string
  is_git_repo?: boolean
  branch?: string
  created_at?: unknown
  last_opened_at?: unknown
  session_count?: number
}

interface RemoteApproval {
  approval_id: string
  session_id: string
  tool_name: string
  action?: string
  tool_input_display?: unknown
  created_at?: unknown
}

interface RemoteQuestion {
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

interface RemoteProvider {
  id: string
  type: string
  base_url?: string
  default_model?: string
  has_api_key: boolean
  status: 'connected' | 'error' | 'unconfigured'
  models?: string[]
}

interface RemoteModel {
  provider: string
  model: string
  display_name?: string
  max_context_size: number
  capabilities?: string[]
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

function decodedBase64Size(value: string): number | null {
  if (!value || value.length > Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 4) return null
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return Math.floor(value.length * 3 / 4) - padding
}

function isBoundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0)
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
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

function textOf(value: unknown, max = 4_000): string {
  if (typeof value === 'string') return value.slice(0, max)
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2).slice(0, max)
  } catch {
    return String(value).slice(0, max)
  }
}

function atOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now()
}

function timestampOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return null
}

function projectOf(cwd: string): string {
  const normalized = cwd.replace(/\\/g, '/').replace(/\/$/, '')
  return basename(normalized) || 'workspace'
}

function phaseOf(session: RemoteSession): MoonPhase {
  if (session.pending_interaction === 'approval' || session.pending_interaction === 'question') {
    return 'full'
  }
  return session.busy ? 'first-quarter' : 'new'
}

function mapRemotePhase(value: unknown): MoonPhase | null {
  if (typeof value !== 'string') return null
  if (['idle', 'ready', 'completed'].includes(value)) return 'new'
  if (['queued', 'receiving'].includes(value)) return 'waxing'
  if (['thinking', 'reasoning'].includes(value)) return 'first-quarter'
  if (['acting', 'tool', 'working', 'running'].includes(value)) return 'gibbous'
  if (['approval', 'question', 'waiting'].includes(value)) return 'full'
  if (['wrapping', 'finishing'].includes(value)) return 'waning'
  return null
}

function sessionFromRemote(remote: RemoteSession, events: TrajectoryEvent[] = []): Session {
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

interface PersistedTelemetry {
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

interface SubagentRuntime {
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

interface TokenPricing {
  cachedInput: number
  input: number
  output: number
}

/** 官方开放平台 2026-07-19 公布的人民币/百万 tokens 单价。 */
function pricingForModel(model: unknown): TokenPricing | null {
  const id = typeof model === 'string' ? model.toLowerCase() : ''
  if (id.includes('highspeed')) return { cachedInput: 2.6, input: 13, output: 54 }
  if (id.includes('kimi-for-coding') || id.includes('k2.7-code') || id.includes('k27')) {
    return { cachedInput: 1.3, input: 6.5, output: 27 }
  }
  if (id.includes('k3')) return { cachedInput: 2, input: 20, output: 100 }
  return null
}

function usageNumber(usage: UnknownRecord, ...keys: string[]): number {
  for (const key of keys) {
    const value = finiteNumber(usage[key])
    if (value !== null && value >= 0) return value
  }
  return 0
}

function tokenUsageTotal(value: unknown): number | undefined {
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

function compactActivity(value: unknown): string {
  const candidate = isRecord(value)
    ? value.text ?? value.message ?? value.delta ?? value.output ?? value
    : value
  return textOf(candidate, 2_000).replace(/\s+/g, ' ').trim().slice(-320)
}

function exactCost(record: UnknownRecord, usage: UnknownRecord): number | undefined {
  for (const source of [usage, record]) {
    for (const key of ['totalCostUsd', 'total_cost_usd', 'costUsd', 'cost_usd']) {
      const value = finiteNumber(source[key])
      if (value !== null && value > 0) return value
    }
  }
  return undefined
}

function telemetryFromWire(text: string): PersistedTelemetry | null {
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

function workspaceFromRemote(remote: RemoteWorkspace): WorkspaceInfo {
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

function attachmentFromBlock(block: UnknownRecord, index: number): Attachment | null {
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

const INTERNAL_MESSAGE_ENVELOPES: Array<[RegExp, string]> = [
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

function internalMessageLabel(text: string): string | null {
  const trimmed = text.trimStart()
  const direct = INTERNAL_MESSAGE_ENVELOPES.find(([pattern]) => pattern.test(trimmed))?.[1]
  if (direct) return direct
  const prefix = trimmed.slice(0, 512)
  if (/^[^\r\n]{0,160}loaded instructions for this request\b/i.test(prefix)) return '能力上下文'
  if (/<kimi-(?:skill|plugin|mcp|app)-loaded(?:\s|>)/i.test(prefix)) return '能力上下文'
  return null
}

function durationOf(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  return 0
}

function eventsFromMessages(messages: unknown): TrajectoryEvent[] {
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

function approvalFromRemote(remote: RemoteApproval): ApprovalRequest {
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

function questionFromRemote(remote: RemoteQuestion): QuestionRequest {
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

function satelliteKind(name: unknown): 'coder' | 'explore' | 'plan' {
  const value = typeof name === 'string' ? name.toLowerCase() : ''
  if (value.includes('explore')) return 'explore'
  if (value.includes('plan')) return 'plan'
  return 'coder'
}

function editableToolPaths(payload: UnknownRecord): string[] {
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

function accountProviderKind(provider: RemoteProvider): AccountProviderInfo['kind'] {
  if (provider.id === 'managed:kimi-code') return 'kimi-oauth'
  return provider.type === 'kimi' ? 'kimi-api' : 'openai-compatible'
}

function providerLabel(provider: RemoteProvider): string {
  if (provider.id === 'managed:kimi-code') return 'Kimi OAuth'
  if (provider.type === 'kimi') return 'Kimi 官方 API'
  return 'OpenAI 兼容服务'
}

const PLAN_LABELS: Record<string, string> = {
  LEVEL_FREE: 'Adagio',
  LEVEL_BASIC: 'Moderato',
  LEVEL_BEGINNER: 'Moderato',
  LEVEL_INTERMEDIATE: 'Allegretto',
  LEVEL_ADVANCED: 'Allegro',
  LEVEL_PROFESSIONAL: 'Vivace'
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(number) ? number : null
}

function usageWindow(value: unknown): AccountUsage['weekly'] {
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

function fixedPointCny(value: number): number {
  const cents = value / 1_000_000
  return (cents > 0 && cents < 1 ? 1 : Math.round(cents)) / 100
}

/** Kimi Server REST + WebSocket 客户端。所有远端形状在主进程归一成 Farside 契约。 */
export class KimiClientService {
  private socket: WebSocket | null = null
  private sender: WebContents | null = null
  private subscriptions = new Set<string>()
  private reconnectTimer: NodeJS.Timeout | null = null
  private streamFlushTimer: NodeJS.Timeout | null = null
  private pendingStreamUpdates = new Map<string, Extract<AgentUpdate, { kind: 'event-upsert' }>>()
  private approvalSyncs = new Map<string, Promise<void>>()
  private questionSyncs = new Map<string, Promise<void>>()
  private disposed = false
  private thinking = new Map<string, { id: string; startedAt: number }>()
  private thinkingSequence = 0
  private activeToolCalls = new Map<string, Set<string>>()
  private subagents = new Map<string, Map<string, SubagentRuntime>>()
  private wirePaths = new Map<string, string>()
  private readonly turnChanges = new TurnChangesService()

  constructor(private readonly server: ServerService) {}

  private bindTurnChanges(session: Session): Session {
    this.turnChanges.bindSession(session.id, session.cwd)
    return session
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const started = await this.server.start()
    if (!started.ok) throw new Error(started.error || 'Kimi Server 启动失败')
    const token = await readKimiServerToken()
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
    const body = (await res.json()) as ApiEnvelope<T>
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

  async getAccount(refreshUsage = false): Promise<AccountResult> {
    try {
      if (refreshUsage) {
        await this.request('/api/v1/providers:refresh_oauth', {
          method: 'POST',
          body: JSON.stringify({})
        }).catch(() => undefined)
      }
      const [auth, providerData, modelData, config] = await Promise.all([
        this.request<{ ready?: boolean }>('/api/v1/auth'),
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
        configured: auth.ready === true && providers.some((provider) => provider.status === 'connected'),
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
        this.request<{ ready?: boolean }>('/api/v1/auth')
      ])
      const sessions = remoteSessions.map((item) => this.bindTurnChanges(sessionFromRemote(item)))
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
      return { ok: true, sessions, approvals, questions, goal, authReady: auth.ready === true }
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
    const token = await readKimiServerToken()
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
      await this.request(`/api/v1/sessions/${encodeURIComponent(input.sessionId)}/profile`, {
        method: 'POST',
        body: JSON.stringify({ agent_config: { goal_control: input.control } })
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

  /** 使用 Kimi Server v2 的官方 PluginService，避免绕过插件校验与 managed 安装事务。 */
  async managePlugin(
    input: Extract<ConfigurationManageInput, { kind: 'plugin' }>
  ): Promise<AgentActionResult> {
    try {
      if (!input || !['install', 'toggle', 'remove'].includes(input.action)) {
        throw new Error('Plugin 操作无效')
      }
      if (input.action === 'install') {
        if (!isBoundedString(input.source, 2_048)) throw new Error('Plugin 来源无效')
        await this.request('/api/v2/pluginService/installPlugin', {
          method: 'POST',
          body: JSON.stringify({ source: input.source })
        })
      } else if (input.action === 'toggle') {
        if (!isBoundedString(input.id, 512) || typeof input.enabled !== 'boolean') {
          throw new Error('Plugin 状态参数无效')
        }
        await this.request('/api/v2/pluginService/setPluginEnabled', {
          method: 'POST',
          body: JSON.stringify({ id: input.id, enabled: input.enabled })
        })
      } else {
        if (!isBoundedString(input.id, 512)) throw new Error('Plugin ID 无效')
        await this.request('/api/v2/pluginService/removePlugin', {
          method: 'POST',
          body: JSON.stringify({ id: input.id })
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

  /** config.toml 写入后立即要求 Kimi Core 重载，不必等待 Server 重启。 */
  async reloadRuntimeConfiguration(): Promise<AgentActionResult> {
    try {
      await this.request('/api/v2/configService/reload', { method: 'POST' })
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Kimi 配置热加载失败'
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
      const auth = await this.request<{ ready?: boolean }>('/api/v1/auth')
      if (auth.ready === true) {
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
        this.request<{ ready?: boolean }>('/api/v1/auth')
      ])
      const authReady = authResult.status === 'fulfilled' && authResult.value.ready === true
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
    const token = await readKimiServerToken()
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
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null
        this.emit({ kind: 'connection', connected: false })
        this.scheduleReconnect()
      })
    })
    this.emit({ kind: 'connection', connected: true })
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer || !this.sender || this.sender.isDestroyed()) return
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
    }, 1_500)
  }

  private onMessage(data: RawData): void {
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
    const active = this.thinking.get(sessionId)
    if (!active) return
    this.upsertEvent(sessionId, {
      id: active.id,
      kind: 'transmission',
      at: active.startedAt,
      text: '',
      durationMs: Math.max(1, at - active.startedAt)
    })
    this.thinking.delete(sessionId)
  }

  private startToolCall(sessionId: string, toolCallId: string): void {
    const active = this.activeToolCalls.get(sessionId) ?? new Set<string>()
    active.add(toolCallId)
    this.activeToolCalls.set(sessionId, active)
  }

  private finishToolCall(sessionId: string, toolCallId: string): boolean {
    const active = this.activeToolCalls.get(sessionId)
    if (!active) return false
    active.delete(toolCallId)
    if (active.size) return true
    this.activeToolCalls.delete(sessionId)
    return false
  }

  private hasActiveToolCalls(sessionId: string): boolean {
    return (this.activeToolCalls.get(sessionId)?.size ?? 0) > 0
  }

  private subagentRuntime(sessionId: string, subagentId: string, at: number): SubagentRuntime {
    let bySession = this.subagents.get(sessionId)
    if (!bySession) {
      bySession = new Map()
      this.subagents.set(sessionId, bySession)
    }
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
    const state = this.subagents.get(sessionId)?.get(agentId)
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
    const states = this.subagents.get(sessionId)
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
    const states = this.subagents.get(sessionId)
    if (!states) return
    for (const [subagentId, state] of states) {
      if (['done', 'failed', 'cancelled'].includes(state.status)) states.delete(subagentId)
    }
    if (!states.size) this.subagents.delete(sessionId)
  }

  private handleSessionEvent(sessionId: string, type: string, payload: UnknownRecord): void {
    const now = Date.now()
    if (type === 'tool.call.started') {
      this.turnChanges.capture(sessionId, editableToolPaths(payload))
    }
    if (this.handleSubagentActivity(sessionId, type, payload, now)) return
    if (type === 'prompt.submitted') {
      this.activeToolCalls.delete(sessionId)
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
        this.emit({ kind: 'session-patch', sessionId, patch: { phase: 'waxing', updatedAt: now } })
      }
      return
    }
    if (type === 'turn.started') {
      this.emit({ kind: 'session-patch', sessionId, patch: { phase: 'first-quarter' } })
      return
    }
    if (type === 'thinking.delta' && typeof payload.delta === 'string') {
      let activeThinking = this.thinking.get(sessionId)
      if (!activeThinking) {
        const startedAt = atOf(payload.createdAt)
        activeThinking = {
          id: `thinking-${String(payload.turnId ?? 'active')}-${++this.thinkingSequence}`,
          startedAt
        }
        this.thinking.set(sessionId, activeThinking)
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
              : 'new'
        }
      })
      if (pending === 'approval') void this.syncApprovals(sessionId)
      if (pending === 'question') void this.syncQuestions(sessionId)
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
      this.activeToolCalls.delete(sessionId)
      if (type === 'prompt.aborted') {
        this.settleActiveSubagents(sessionId, 'cancelled', '主请求已终止')
      } else if (
        type === 'turn.ended' &&
        typeof payload.reason === 'string' &&
        payload.reason !== 'completed'
      ) {
        const reason = compactActivity(payload.reason) || '主请求未完成'
        this.settleActiveSubagents(sessionId, 'failed', reason)
      }
      this.emit({
        kind: 'session-patch',
        sessionId,
        patch: { phase: type === 'turn.ended' ? 'waning' : 'new', updatedAt: now }
      })
      if (type === 'prompt.completed') void this.syncPersistedTelemetry(sessionId)
      return
    }
    if ((type === 'error' || type === 'warning') && typeof payload.message === 'string') {
      this.upsertEvent(sessionId, {
        id: `${type}-${String(payload.code ?? randomUUID())}-${now}`,
        kind: 'message',
        at: now,
        markdown: `**链路${type === 'error' ? '中断' : '警告'}** · ${payload.message}`
      })
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

  private async syncApprovals(sessionId: string): Promise<void> {
    const inFlight = this.approvalSyncs.get(sessionId)
    if (inFlight) return inFlight
    const task = (async () => {
      try {
        for (const delay of [0, 80, 200, 500, 1_000, 2_000]) {
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

  private async syncQuestions(sessionId: string): Promise<void> {
    const inFlight = this.questionSyncs.get(sessionId)
    if (inFlight) return inFlight
    const task = (async () => {
      try {
        for (const delay of [0, 80, 200, 500, 1_000, 2_000]) {
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

  dispose(): void {
    this.disposed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.streamFlushTimer) clearTimeout(this.streamFlushTimer)
    this.streamFlushTimer = null
    this.pendingStreamUpdates.clear()
    this.approvalSyncs.clear()
    this.questionSyncs.clear()
    this.socket?.close()
    this.socket = null
    this.sender = null
    this.turnChanges.clear()
  }
}
