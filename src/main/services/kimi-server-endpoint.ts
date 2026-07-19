import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface KimiServerEndpoint {
  host: '127.0.0.1' | 'localhost' | '::1'
  port: number
  entry?: string
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
  return { host, port: port as number, ...(entry ? { entry } : {}) }
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

/** 官方 daemon 可能因端口占用或复用已有实例而忽略首选端口，实际地址以 lock 为准。 */
export async function readKimiServerEndpoint(): Promise<KimiServerEndpoint | null> {
  const root = process.env['KIMI_CODE_HOME'] || join(homedir(), '.kimi-code')
  try {
    const raw = await fs.readFile(join(root, 'server', 'lock'), 'utf8')
    return parseKimiServerLock(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}
