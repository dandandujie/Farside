import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface KimiServerEndpoint {
  host: '127.0.0.1' | 'localhost' | '::1'
  port: number
  entry?: string
  serverId?: string
  pid?: number
  startedAt?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只接受回环地址，避免被篡改的 lock 文件把 bearer token 带到外部主机。 */
export function parseKimiServerLock(value: unknown): KimiServerEndpoint | null {
  if (!isRecord(value)) return null
  const host = value.host ?? '127.0.0.1'
  const port = value.port
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return null
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535) return null
  const entry = typeof value.entry === 'string' && value.entry.length <= 4_096
    ? value.entry
    : undefined
  const pid = Number.isInteger(value.pid) && (value.pid as number) > 0
    ? value.pid as number
    : undefined
  return { host, port: port as number, ...(entry ? { entry } : {}), ...(pid ? { pid } : {}) }
}

/** 解析 Kimi Code 0.28+ 的多实例注册文件。 */
export function parseKimiServerInstance(value: unknown): KimiServerEndpoint | null {
  if (!isRecord(value)) return null
  const endpoint = parseKimiServerLock(value)
  const serverId = value.server_id
  const pid = value.pid
  const startedAt = value.started_at
  if (!endpoint) return null
  if (typeof serverId !== 'string' || serverId.length < 1 || serverId.length > 128) return null
  if (!Number.isInteger(pid) || (pid as number) < 1) return null
  if (!Number.isFinite(startedAt) || (startedAt as number) < 0) return null
  return {
    ...endpoint,
    serverId,
    pid: pid as number,
    startedAt: startedAt as number
  }
}

export function kimiServerOrigin(endpoint: KimiServerEndpoint): string {
  const host = endpoint.host === '::1' ? '[::1]' : endpoint.host
  return `http://${host}:${endpoint.port}`
}

/** 升级时只自动替换由旧版 Farside 随包 runtime 启动的 daemon。 */
export function isFarsideRuntimeEndpoint(endpoint: KimiServerEndpoint): boolean {
  if (!endpoint.entry) return false
  const normalized = endpoint.entry.replace(/\\/g, '/').toLowerCase()
  return normalized.includes('farside') && normalized.includes('/resources/runtime/')
}

/**
 * 读取 Kimi Code 0.28+ 多实例注册表。非法、非回环和写入中的文件会被忽略；
 * 返回顺序与官方 CLI 一致，最早启动的实例在前。
 */
export async function readKimiServerInstances(): Promise<KimiServerEndpoint[]> {
  const root = process.env['KIMI_CODE_HOME'] || join(homedir(), '.kimi-code')
  try {
    const directory = join(root, 'server', 'instances')
    const names = await fs.readdir(directory)
    const endpoints = await Promise.all(names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        try {
          const raw = await fs.readFile(join(directory, name), 'utf8')
          return parseKimiServerInstance(JSON.parse(raw) as unknown)
        } catch {
          return null
        }
      }))
    return endpoints
      .filter((endpoint): endpoint is KimiServerEndpoint => endpoint !== null)
      .sort((left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0))
  } catch {
    return []
  }
}

/**
 * 0.28+ 优先从实例注册表发现实际端口；旧 Runtime 则回退到单实例 lock。
 * 指定 serverId 时只返回该实例，避免多实例环境误连。
 */
export async function readKimiServerEndpoint(serverId?: string): Promise<KimiServerEndpoint | null> {
  const instances = await readKimiServerInstances()
  if (serverId) return instances.find((instance) => instance.serverId === serverId) ?? null
  if (instances.length > 0) return instances[0]

  const root = process.env['KIMI_CODE_HOME'] || join(homedir(), '.kimi-code')
  try {
    const raw = await fs.readFile(join(root, 'server', 'lock'), 'utf8')
    return parseKimiServerLock(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}
