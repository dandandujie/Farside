import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

export const RUNTIME_LOCK_SCHEMA_VERSION = 2
export const RUNTIME_CHANNEL_NAME = 'current'
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

function validateRuntime(value) {
  const runtime = record(value, 'runtime')
  if (runtime.enabled !== true) throw new Error('唯一 runtime 必须启用')
  if (runtime.kind !== 'official' && runtime.kind !== 'custom') {
    throw new Error('runtime.kind 必须是 official 或 custom')
  }
  for (const field of ['version', 'upstreamVersion']) {
    if (typeof runtime[field] !== 'string' || runtime[field].length > 128 || !VERSION_PATTERN.test(runtime[field])) {
      throw new Error(`runtime.${field} 不是有效版本号`)
    }
  }
  if (runtime.apiVersion !== 1) throw new Error('runtime.apiVersion 暂只支持 1')
  if (runtime.wsProtocolVersion !== 2) throw new Error('runtime.wsProtocolVersion 暂只支持 2')

  const source = record(runtime.source, 'runtime.source')
  secureUrl(source.repository, 'runtime.source.repository')
  if (source.revision !== null) nonEmptyString(source.revision, 'runtime.source.revision')
  nonEmptyString(source.license, 'runtime.source.license', 64)
  secureUrl(source.manifestUrl, 'runtime.source.manifestUrl', true)

  const artifacts = record(runtime.artifacts, 'runtime.artifacts')
  const artifactTargets = Object.keys(artifacts)
  for (const target of artifactTargets) {
    if (!RUNTIME_TARGETS.includes(target)) throw new Error(`runtime.artifacts 包含未知目标 ${target}`)
    validateArtifact(artifacts[target], target, `runtime.artifacts.${target}`)
  }
  const missing = RUNTIME_TARGETS.filter((target) => !artifactTargets.includes(target))
  if (missing.length) throw new Error(`唯一 runtime 缺少目标：${missing.join(', ')}`)
  if (source.revision === null || source.manifestUrl === null) {
    throw new Error('唯一 runtime 必须固定 revision 和 manifestUrl')
  }
  return runtime
}

export function validateRuntimeLock(value) {
  const lock = record(value, 'runtime.lock.json')
  if (lock.schemaVersion !== RUNTIME_LOCK_SCHEMA_VERSION) {
    throw new Error(`不支持的 runtime lock schema：${String(lock.schemaVersion)}`)
  }
  validateRuntime(lock.runtime)
  if ('channels' in lock || 'defaultChannel' in lock) {
    throw new Error('runtime lock 不再支持平行通道字段')
  }
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

export function getCurrentRuntime(lock) {
  return { name: RUNTIME_CHANNEL_NAME, runtime: lock.runtime }
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
