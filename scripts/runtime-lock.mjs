import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

export const RUNTIME_LOCK_SCHEMA_VERSION = 1
export const RUNTIME_TARGETS = Object.freeze([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64'
])

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`)
  }
  return value
}

function nonEmptyString(value, label, max = 256) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`${label} 必须是长度不超过 ${max} 的非空字符串`)
  }
  return value
}

function secureUrl(value, label, nullable = false) {
  if (nullable && value === null) return null
  nonEmptyString(value, label, 2_048)
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${label} 不是有效 URL`)
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} 必须是无凭据、无片段的 HTTPS URL`)
  }
  return value
}

function validateArtifact(value, target, label) {
  const artifact = record(value, label)
  const filename = nonEmptyString(artifact.filename, `${label}.filename`)
  if (basename(filename) !== filename || filename.includes('/') || filename.includes('\\') || filename === '.' || filename === '..') {
    throw new Error(`${label}.filename 必须是不含路径的文件名`)
  }
  const url = secureUrl(artifact.url, `${label}.url`)
  const parsedFilename = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
  if (parsedFilename !== filename) throw new Error(`${label}.url 与 filename 不一致`)
  if (typeof artifact.sha256 !== 'string' || !SHA256_PATTERN.test(artifact.sha256)) {
    throw new Error(`${label}.sha256 必须是小写 SHA-256`)
  }
  if (target.startsWith('win32-') !== filename.endsWith('.exe')) {
    throw new Error(`${label}.filename 与目标平台不匹配`)
  }
  return artifact
}

function validateChannel(value, name) {
  const channel = record(value, `channels.${name}`)
  if (typeof channel.enabled !== 'boolean') throw new Error(`channels.${name}.enabled 必须是布尔值`)
  if (channel.kind !== 'official' && channel.kind !== 'custom') {
    throw new Error(`channels.${name}.kind 必须是 official 或 custom`)
  }
  for (const field of ['version', 'upstreamVersion']) {
    if (typeof channel[field] !== 'string' || channel[field].length > 128 || !VERSION_PATTERN.test(channel[field])) {
      throw new Error(`channels.${name}.${field} 不是有效版本号`)
    }
  }
  if (channel.apiVersion !== 1) throw new Error(`channels.${name}.apiVersion 暂只支持 1`)
  if (channel.wsProtocolVersion !== 2) throw new Error(`channels.${name}.wsProtocolVersion 暂只支持 2`)

  const source = record(channel.source, `channels.${name}.source`)
  secureUrl(source.repository, `channels.${name}.source.repository`)
  if (source.revision !== null) nonEmptyString(source.revision, `channels.${name}.source.revision`)
  nonEmptyString(source.license, `channels.${name}.source.license`, 64)
  secureUrl(source.manifestUrl, `channels.${name}.source.manifestUrl`, true)

  const artifacts = record(channel.artifacts, `channels.${name}.artifacts`)
  const artifactTargets = Object.keys(artifacts)
  for (const target of artifactTargets) {
    if (!RUNTIME_TARGETS.includes(target)) throw new Error(`channels.${name}.artifacts 包含未知目标 ${target}`)
    validateArtifact(artifacts[target], target, `channels.${name}.artifacts.${target}`)
  }
  if (channel.enabled) {
    const missing = RUNTIME_TARGETS.filter((target) => !artifactTargets.includes(target))
    if (missing.length) throw new Error(`已启用通道 ${name} 缺少目标：${missing.join(', ')}`)
    if (source.revision === null || source.manifestUrl === null) {
      throw new Error(`已启用通道 ${name} 必须固定 revision 和 manifestUrl`)
    }
  }
  return channel
}

export function validateRuntimeLock(value) {
  const lock = record(value, 'runtime.lock.json')
  if (lock.schemaVersion !== RUNTIME_LOCK_SCHEMA_VERSION) {
    throw new Error(`不支持的 runtime lock schema：${String(lock.schemaVersion)}`)
  }
  const defaultChannel = nonEmptyString(lock.defaultChannel, 'defaultChannel', 64)
  const channels = record(lock.channels, 'channels')
  if (!Object.keys(channels).length) throw new Error('runtime lock 至少需要一个通道')
  for (const [name, channel] of Object.entries(channels)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error(`无效的运行时通道名：${name}`)
    validateChannel(channel, name)
  }
  if (!channels[defaultChannel]?.enabled) throw new Error(`默认运行时通道 ${defaultChannel} 不存在或未启用`)
  return lock
}

export async function loadRuntimeLock(path = resolve(process.cwd(), 'runtime.lock.json')) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`无法读取 runtime lock：${error instanceof Error ? error.message : String(error)}`)
  }
  return validateRuntimeLock(parsed)
}

export function selectRuntimeChannel(lock, requested) {
  const name = requested?.trim() || lock.defaultChannel
  const channel = lock.channels[name]
  if (!channel) throw new Error(`未知的运行时通道：${name}`)
  if (!channel.enabled) throw new Error(`运行时通道 ${name} 尚未发布完整的六平台产物，不能启用`)
  return { name, channel }
}

export function selectRuntimeArtifact(channel, target) {
  if (!RUNTIME_TARGETS.includes(target)) throw new Error(`不支持的运行时目标：${target}`)
  const artifact = channel.artifacts[target]
  if (!artifact) throw new Error(`运行时 ${channel.version} 没有 ${target} 产物`)
  return artifact
}

export function versionOutputMatches(output, expectedVersion) {
  const escaped = expectedVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^0-9A-Za-z.-])${escaped}(?:$|[^0-9A-Za-z.-])`).test(output.trim())
}
