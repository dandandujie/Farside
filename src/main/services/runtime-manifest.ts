import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export const SUPPORTED_RUNTIME_MANIFEST_SCHEMA = 1
export const SUPPORTED_KIMI_API_VERSION = 1
export const SUPPORTED_KIMI_WS_PROTOCOL_VERSION = 2

export interface RuntimeManifest {
  schemaVersion: 1
  channel: string
  kind: 'official' | 'custom'
  version: string
  upstreamVersion: string
  apiVersion: 1
  wsProtocolVersion: 2
  observedVersion: string
  target: string
  executable: string
  sha256: string
  lockedSha256: string | null
  source: string
  revision: string
  manifestUrl: string
  artifactUrl: string | null
  provenance: 'locked-download' | 'locked-copy' | 'local-copy'
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validHttpsUrl(value: unknown, nullable = false): value is string | null {
  if (nullable && value === null) return true
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash
  } catch {
    return false
  }
}

export function parseRuntimeManifest(
  value: unknown,
  expectedTarget: string,
  expectedExecutable: string
): RuntimeManifest {
  if (!isRecord(value)) throw new Error('runtime manifest 必须是对象')
  if (value.schemaVersion !== SUPPORTED_RUNTIME_MANIFEST_SCHEMA) {
    throw new Error(`不支持的 runtime manifest schema：${String(value.schemaVersion)}`)
  }
  if (typeof value.channel !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.channel)) {
    throw new Error('runtime manifest 通道无效')
  }
  if (value.kind !== 'official' && value.kind !== 'custom') throw new Error('runtime manifest 类型无效')
  if (typeof value.version !== 'string' || value.version.length === 0 || value.version.length > 128) {
    throw new Error('runtime manifest 版本无效')
  }
  if (typeof value.upstreamVersion !== 'string' || value.upstreamVersion.length === 0 || value.upstreamVersion.length > 128) {
    throw new Error('runtime manifest 上游版本无效')
  }
  if (value.apiVersion !== SUPPORTED_KIMI_API_VERSION) {
    throw new Error(`不支持的 Kimi Server API 版本：${String(value.apiVersion)}`)
  }
  if (value.wsProtocolVersion !== SUPPORTED_KIMI_WS_PROTOCOL_VERSION) {
    throw new Error(`不支持的 Kimi Server WebSocket 协议版本：${String(value.wsProtocolVersion)}`)
  }
  if (typeof value.observedVersion !== 'string' || value.observedVersion.length === 0 || value.observedVersion.length > 256) {
    throw new Error('runtime manifest 实测版本无效')
  }
  if (value.target !== expectedTarget) throw new Error(`runtime 目标不匹配：expected ${expectedTarget}, got ${String(value.target)}`)
  if (value.executable !== expectedExecutable || basename(value.executable as string) !== value.executable) {
    throw new Error('runtime 可执行文件名不匹配')
  }
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error('runtime SHA-256 无效')
  }
  if (value.lockedSha256 !== null && (typeof value.lockedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.lockedSha256))) {
    throw new Error('runtime 锁定 SHA-256 无效')
  }
  if (!validHttpsUrl(value.source) || !validHttpsUrl(value.manifestUrl)) {
    throw new Error('runtime 来源 URL 无效')
  }
  if (!validHttpsUrl(value.artifactUrl, true)) throw new Error('runtime 产物 URL 无效')
  if (typeof value.revision !== 'string' || value.revision.length === 0 || value.revision.length > 256) {
    throw new Error('runtime 来源 revision 无效')
  }
  if (value.provenance !== 'locked-download' && value.provenance !== 'locked-copy' && value.provenance !== 'local-copy') {
    throw new Error('runtime 产物来源无效')
  }
  if (value.provenance !== 'local-copy') {
    if (value.lockedSha256 !== value.sha256 || value.artifactUrl === null) {
      throw new Error('锁定 runtime 的校验信息不完整')
    }
  }
  return value as unknown as RuntimeManifest
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(path)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('error', reject)
    input.on('end', resolve)
  })
  return hash.digest('hex')
}

export async function readAndVerifyRuntimeManifest(
  command: string,
  expectedTarget: string,
  expectedExecutable: string
): Promise<RuntimeManifest> {
  const manifestPath = join(dirname(command), 'manifest.json')
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`无法读取随包 runtime manifest：${error instanceof Error ? error.message : String(error)}`)
  }
  const manifest = parseRuntimeManifest(raw, expectedTarget, expectedExecutable)
  const actualSha256 = await sha256File(command)
  if (actualSha256 !== manifest.sha256) {
    throw new Error(`随包 Kimi Code runtime 完整性校验失败：expected ${manifest.sha256}, got ${actualSha256}`)
  }
  return manifest
}
