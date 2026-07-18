import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DiscoveredSession } from '@shared/ipc'

/** CLI 数据根目录：~/.kimi-code */
function kimiRoot(): string {
  return join(homedir(), '.kimi-code')
}

/**
 * 会话索引的实际落盘位置有两个版本：
 * 新版在 ~/.kimi-code/session_index.jsonl，旧版约定在 sessions/ 子目录下。两个都试。
 */
async function readIndexText(): Promise<string | null> {
  const candidates = [
    join(kimiRoot(), 'session_index.jsonl'),
    join(kimiRoot(), 'sessions', 'session_index.jsonl')
  ]
  for (const path of candidates) {
    try {
      return await fs.readFile(path, 'utf8')
    } catch {
      // 试下一个候选路径
    }
  }
  return null
}

/** 尽力把任意形状的 jsonl 行归一成 DiscoveredSession；缺 id 则视为坏行返回 null */
function normalizeLine(raw: unknown): DiscoveredSession | null {
  if (typeof raw !== 'object' || raw === null) return null
  const line = raw as Record<string, unknown>
  const id = pickString(line, 'id', 'sessionId', 'session_id')
  if (!id) return null
  return {
    id,
    title: pickString(line, 'title', 'name') ?? '未命名会话',
    cwd: pickString(line, 'cwd', 'workDir', 'workdir') ?? '',
    updatedAt: pickTime(line, 'updatedAt', 'updated_at', 'mtime')
  }
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/** 兼容 Unix ms 数字与 ISO 字符串两种时间写法 */
function pickTime(obj: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Date.parse(value)
      if (!Number.isNaN(parsed)) return parsed
    }
  }
  return 0
}

/**
 * 用 state.json 补全标题与时间。定位优先级：
 * 索引行自带的 sessionDir → <workDirKey>/<sessionId>/state.json。
 * 读不到就保留索引行原值——索引已经够会话栏展示了。
 */
async function enrichFromState(
  line: Record<string, unknown>,
  session: DiscoveredSession
): Promise<void> {
  const sessionDir = pickString(line, 'sessionDir', 'session_dir')
  const workDirKey = pickString(line, 'workDirKey', 'work_dir_key')
  const statePath = sessionDir
    ? join(sessionDir, 'state.json')
    : workDirKey
      ? join(kimiRoot(), 'sessions', workDirKey, session.id, 'state.json')
      : null
  if (!statePath) return
  try {
    const text = await fs.readFile(statePath, 'utf8')
    const state = JSON.parse(text) as Record<string, unknown>
    const title = pickString(state, 'title', 'name')
    if (title) session.title = title
    const updatedAt = pickTime(state, 'updatedAt', 'updated_at')
    if (updatedAt > 0) session.updatedAt = updatedAt
    if (!session.cwd) session.cwd = pickString(state, 'cwd', 'workDir') ?? ''
  } catch {
    // state.json 缺失或损坏：跳过，索引行本身仍然有效
  }
}

/**
 * 发现本机 CLI 既有会话。
 * 目录不存在、索引损坏、单行 JSON 坏行——全部跳过或返回空数组，绝不抛出。
 */
export async function discoverSessions(): Promise<DiscoveredSession[]> {
  const text = await readIndexText()
  if (text === null) return []

  const sessions: DiscoveredSession[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue // 坏行跳过
    }
    const session = normalizeLine(parsed)
    if (!session) continue
    await enrichFromState(parsed as Record<string, unknown>, session)
    sessions.push(session)
  }

  // 最近活动的排前面，供会话栏直接合并
  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  return sessions
}
