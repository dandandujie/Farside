import { lstatSync, readFileSync, realpathSync, statSync, promises as fs } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { GitChange, TurnChangesResult } from '@shared/ipc'

interface BaselineEntry {
  path: string
  absolutePath: string
  existedBefore: boolean
  content: Buffer
}

interface TurnBaseline {
  root: string
  entries: Map<string, BaselineEntry>
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function nearestExisting(path: string, floor: string): string {
  let current = path
  while (isInside(floor, current)) {
    try {
      lstatSync(current)
      return current
    } catch {
      if (current === floor) break
      current = dirname(current)
    }
  }
  throw new Error('文件路径不存在于会话工作区')
}

function containedPath(root: string, requested: string): { absolutePath: string; relativePath: string } {
  const rootPath = resolve(root)
  const absolutePath = resolve(rootPath, requested)
  if (!isInside(rootPath, absolutePath)) throw new Error('文件路径越过会话工作区边界')
  const realRoot = realpathSync(rootPath)
  const realAncestor = realpathSync(nearestExisting(absolutePath, rootPath))
  if (!isInside(realRoot, realAncestor)) throw new Error('文件路径通过符号链接越过会话工作区边界')
  return {
    absolutePath,
    relativePath: relative(rootPath, absolutePath).split(sep).join('/')
  }
}

function lines(content: Buffer): string[] {
  if (!content.length) return []
  return content.toString('utf8').replaceAll('\r\n', '\n').split('\n')
}

function lineStats(before: Buffer, after: Buffer): { additions: number; deletions: number } {
  const oldLines = lines(before)
  const newLines = lines(after)
  const oldCounts = new Map<string, number>()
  const newCounts = new Map<string, number>()
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1)
  for (const line of newLines) newCounts.set(line, (newCounts.get(line) ?? 0) + 1)
  let additions = 0
  let deletions = 0
  for (const [line, count] of newCounts) {
    additions += Math.max(0, count - (oldCounts.get(line) ?? 0))
  }
  for (const [line, count] of oldCounts) {
    deletions += Math.max(0, count - (newCounts.get(line) ?? 0))
  }
  return {
    additions,
    deletions
  }
}

async function currentContent(path: string): Promise<Buffer | null> {
  try {
    const stat = await fs.stat(path)
    return stat.isFile() ? await fs.readFile(path) : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * 与 Kimi VS Code BaselineManager 相同的核心语义：首次写入前捕获原文件，
 * 完成后只统计/恢复本轮 Agent 实际触碰过的路径。
 */
export class TurnChangesService {
  private readonly sessions = new Map<string, TurnBaseline[]>()
  private readonly roots = new Map<string, string>()

  bindSession(sessionId: string, root: string): void {
    const normalized = resolve(root)
    if (this.roots.get(sessionId) !== normalized) {
      this.sessions.delete(sessionId)
      this.roots.set(sessionId, normalized)
    }
  }

  begin(sessionId: string): void {
    const root = this.roots.get(sessionId)
    if (!root) return
    const baselines = this.sessions.get(sessionId) ?? []
    baselines.push({ root, entries: new Map() })
    if (baselines.length > 50) baselines.shift()
    this.sessions.set(sessionId, baselines)
  }

  capture(sessionId: string, paths: string[]): void {
    const baseline = this.sessions.get(sessionId)?.at(-1)
    if (!baseline) return
    for (const requested of paths) {
      const key = requested.replaceAll('\\', '/')
      if (!key || baseline.entries.has(key)) continue
      try {
        const resolved = containedPath(baseline.root, requested)
        let before: Buffer | null = null
        try {
          const stat = statSync(resolved.absolutePath)
          if (!stat.isFile()) continue
          before = readFileSync(resolved.absolutePath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        baseline.entries.set(key, {
          path: resolved.relativePath,
          absolutePath: resolved.absolutePath,
          existedBefore: before !== null,
          content: before ?? Buffer.alloc(0)
        })
      } catch {
        // 工具参数可能不是文件路径；无效或越界目标不进入可撤销基线。
      }
    }
  }

  async get(sessionId: string): Promise<TurnChangesResult> {
    const baseline = this.sessions.get(sessionId)?.at(-1)
    if (!baseline) return { ok: true, changes: [], tracked: false, undoAvailable: false }
    const changes: GitChange[] = []
    for (const entry of baseline.entries.values()) {
      const after = await currentContent(entry.absolutePath)
      if (after === null) {
        if (entry.existedBefore) {
          changes.push({
            path: entry.path,
            status: 'Deleted',
            additions: 0,
            deletions: lines(entry.content).length
          })
        }
        continue
      }
      if (!entry.existedBefore) {
        changes.push({
          path: entry.path,
          status: 'Added',
          additions: lines(after).length,
          deletions: 0
        })
        continue
      }
      if (Buffer.compare(entry.content, after) !== 0) {
        const stats = lineStats(entry.content, after)
        changes.push({
          path: entry.path,
          status: 'Modified',
          additions: stats.additions,
          deletions: stats.deletions
        })
      }
    }
    return {
      ok: true,
      changes: changes.sort((a, b) => a.path.localeCompare(b.path)),
      tracked: true,
      undoAvailable: baseline.entries.size > 0
    }
  }

  async resolve(
    sessionId: string,
    action: 'undo' | 'keep',
    path?: string,
    count = 1
  ): Promise<TurnChangesResult> {
    const baselines = this.sessions.get(sessionId)
    if (!baselines?.length) return { ok: true, changes: [], tracked: false, undoAvailable: false }
    const selectedBaselines =
      action === 'undo' && !path ? baselines.slice(-Math.min(count, baselines.length)).reverse() : [baselines.at(-1)!]

    for (const baseline of selectedBaselines) {
      const selected = [...baseline.entries.entries()].filter(([, entry]) => !path || entry.path === path)
      for (const [key, entry] of selected) {
        if (action === 'undo') {
          const checked = containedPath(baseline.root, entry.path)
          if (checked.absolutePath !== entry.absolutePath) throw new Error('文件路径在执行期间发生变化')
          if (entry.existedBefore) {
            await fs.mkdir(dirname(entry.absolutePath), { recursive: true })
            await fs.writeFile(entry.absolutePath, entry.content)
          } else {
            await fs.rm(entry.absolutePath, { force: true })
          }
        }
        baseline.entries.delete(key)
      }
      if (!path) baselines.splice(baselines.indexOf(baseline), 1)
    }
    if (!baselines.length) this.sessions.delete(sessionId)
    return this.get(sessionId)
  }

  clear(): void {
    this.sessions.clear()
    this.roots.clear()
  }
}
