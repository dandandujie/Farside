import type { Attachment, ModelId, PermissionMode } from '@shared/types'

/**
 * Prompt 队列的纯函数层与持久化，自 store.ts 抽出。
 * 队列状态本体仍住在 store；这里只做记录变换、序列化校验与 localStorage 读写。
 * 附件二进制有意不持久化：恢复后附件清空，纯附件无文本的条目直接丢弃。
 */

export interface QueuedPrompt {
  id: string
  sessionId: string
  text: string
  fileRefs: string[]
  attachments: Attachment[]
  model: ModelId
  permissionMode: PermissionMode
  planMode: boolean
  swarmMode: boolean
  goalObjective?: string
  createdAt: number
}

export const MAX_QUEUE_PER_SESSION = 20
const MAX_QUEUED_TEXT = 100_000
const QUEUES_KEY = 'farside:prompt-queues'
const MAX_PERSISTED_SESSIONS = 50

const PERMISSION_MODES: PermissionMode[] = ['manual', 'auto', 'yolo']

/** 失败回队：把条目放回队头，保持其它会话队列引用不变。 */
export function requeueFront(
  queues: Record<string, QueuedPrompt[]>,
  sessionId: string,
  item: QueuedPrompt
): Record<string, QueuedPrompt[]> {
  return { ...queues, [sessionId]: [item, ...(queues[sessionId] ?? [])] }
}

/** 摘掉队头；空数组不出现在结果里，避免无谓的会话键堆积。 */
export function shiftQueue(
  queues: Record<string, QueuedPrompt[]>,
  sessionId: string
): { queues: Record<string, QueuedPrompt[]>; head: QueuedPrompt | null } {
  const queue = queues[sessionId] ?? []
  const head = queue[0] ?? null
  if (!head) return { queues, head: null }
  const rest = queue.slice(1)
  const next = { ...queues }
  if (rest.length) next[sessionId] = rest
  else delete next[sessionId]
  return { queues: next, head }
}

/** 只持久化轻量字段；超过 20 条按上限截断，与会话级上限一致。 */
export function serializePromptQueues(queues: Record<string, QueuedPrompt[]>): string {
  const payload: Record<string, unknown[]> = {}
  const sessionIds = Object.keys(queues).slice(0, MAX_PERSISTED_SESSIONS)
  for (const sessionId of sessionIds) {
    const entries = (queues[sessionId] ?? []).slice(0, MAX_QUEUE_PER_SESSION).map((item) => ({
      id: item.id,
      sessionId: item.sessionId,
      // 附件二进制不落盘；纯附件无文本的条目恢复后不成立，直接丢弃。
      text: typeof item.text === 'string' ? item.text.slice(0, MAX_QUEUED_TEXT) : '',
      fileRefs: Array.isArray(item.fileRefs) ? item.fileRefs.filter((ref) => typeof ref === 'string') : [],
      model: item.model,
      permissionMode: item.permissionMode,
      planMode: item.planMode === true,
      swarmMode: item.swarmMode === true,
      goalObjective: typeof item.goalObjective === 'string' ? item.goalObjective : undefined,
      createdAt: item.createdAt
    })).filter((item) => item.text.trim().length > 0 || item.fileRefs.length > 0)
    if (entries.length) payload[sessionId] = entries
  }
  return JSON.stringify(payload)
}

export function parsePromptQueues(
  raw: string | null,
  validSessionIds: ReadonlySet<string>
): Record<string, QueuedPrompt[]> {
  if (!raw) return {}
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof payload !== 'object' || payload === null) return {}
  const queues: Record<string, QueuedPrompt[]> = {}
  for (const [sessionId, entries] of Object.entries(payload as Record<string, unknown>)) {
    if (!validSessionIds.has(sessionId) || !Array.isArray(entries)) continue
    const parsed: QueuedPrompt[] = []
    for (const entry of entries.slice(0, MAX_QUEUE_PER_SESSION)) {
      if (typeof entry !== 'object' || entry === null) continue
      const item = entry as Partial<QueuedPrompt> & Record<string, unknown>
      const text = typeof item.text === 'string' ? item.text.slice(0, MAX_QUEUED_TEXT) : ''
      const fileRefs = Array.isArray(item.fileRefs)
        ? item.fileRefs.filter((ref): ref is string => typeof ref === 'string')
        : []
      if (!text.trim() && fileRefs.length === 0) continue
      parsed.push({
        id: typeof item.id === 'string' && item.id ? item.id : `queued-restored-${crypto.randomUUID()}`,
        sessionId,
        text,
        fileRefs,
        // 附件不持久化：恢复后的队列条目不再带附件。
        attachments: [],
        model: typeof item.model === 'string' && item.model ? item.model : 'kimi-k3',
        permissionMode: PERMISSION_MODES.includes(item.permissionMode ?? 'manual')
          ? item.permissionMode as PermissionMode
          : 'manual',
        planMode: item.planMode === true,
        swarmMode: item.swarmMode === true,
        ...(typeof item.goalObjective === 'string' ? { goalObjective: item.goalObjective } : {}),
        createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now()
      })
    }
    if (parsed.length) queues[sessionId] = parsed
  }
  return queues
}

export function persistPromptQueues(queues: Record<string, QueuedPrompt[]>): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(QUEUES_KEY, serializePromptQueues(queues))
  } catch {
    // localStorage 不可用时队列仍保留内存态。
  }
}

export function loadPersistedPromptQueues(
  validSessionIds: ReadonlySet<string>
): Record<string, QueuedPrompt[]> {
  if (typeof localStorage === 'undefined' || validSessionIds.size === 0) return {}
  try {
    return parsePromptQueues(localStorage.getItem(QUEUES_KEY), validSessionIds)
  } catch {
    return {}
  }
}

export function clearPersistedPromptQueues(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(QUEUES_KEY)
  } catch {
    // 忽略存储异常
  }
}
