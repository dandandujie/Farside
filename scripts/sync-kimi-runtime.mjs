import { appendFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadRuntimeLock, RUNTIME_TARGETS, validateRuntimeLock } from './runtime-lock.mjs'

const REGISTRY_URL = 'https://registry.npmjs.org/@moonshot-ai%2Fkimi-code/latest'
const MAX_JSON_BYTES = 1024 * 1024
const mode = process.argv.includes('--write') ? 'write' : 'check'

async function fetchJson(url, label) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error(`${label} 请求失败（${response.status}）`)
  const declaredSize = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > MAX_JSON_BYTES) throw new Error(`${label} 响应体积异常`)
  if (!response.body) throw new Error(`${label} 响应为空`)
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_JSON_BYTES) {
        await reader.cancel()
        throw new Error(`${label} 响应体积异常`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8'))
}

function stableVersion(value, label) {
  if (typeof value !== 'string' || value.length > 64 || !/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`${label} 不是稳定版本号`)
  return value
}

function compareVersions(left, right) {
  const a = stableVersion(left, '左侧版本').split('.').map(BigInt)
  const b = stableVersion(right, '右侧版本').split('.').map(BigInt)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] < b[index]) return -1
    if (a[index] > b[index]) return 1
  }
  return 0
}

function officialChannelFromManifest(manifest, version, manifestUrl) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('官方 runtime manifest 必须是对象')
  if (manifest.version !== version) throw new Error(`npm 与 runtime manifest 版本不一致：${version} / ${String(manifest.version)}`)
  const expectedTag = `@moonshot-ai/kimi-code@${version}`
  if (manifest.tag !== expectedTag) throw new Error(`官方 runtime manifest tag 不匹配：${String(manifest.tag)}`)
  if (!manifest.platforms || typeof manifest.platforms !== 'object' || Array.isArray(manifest.platforms)) {
    throw new Error('官方 runtime manifest 缺少 platforms')
  }

  const artifacts = {}
  const baseUrl = new URL('.', manifestUrl)
  for (const target of RUNTIME_TARGETS) {
    const remote = manifest.platforms[target]
    if (!remote || typeof remote !== 'object' || Array.isArray(remote)) throw new Error(`官方 runtime manifest 缺少 ${target}`)
    if (typeof remote.filename !== 'string' || remote.filename.length === 0 || remote.filename.includes('/') || remote.filename.includes('\\')) {
      throw new Error(`官方 runtime manifest 的 ${target} 文件名无效`)
    }
    if (typeof remote.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(remote.checksum)) {
      throw new Error(`官方 runtime manifest 的 ${target} checksum 无效`)
    }
    artifacts[target] = {
      filename: remote.filename,
      url: new URL(remote.filename, baseUrl).href,
      sha256: remote.checksum
    }
  }
  const unexpected = Object.keys(manifest.platforms).filter((target) => !RUNTIME_TARGETS.includes(target))
  if (unexpected.length) throw new Error(`官方 runtime manifest 包含未知平台：${unexpected.join(', ')}`)

  return {
    enabled: true,
    kind: 'official',
    version,
    upstreamVersion: version,
    apiVersion: 1,
    wsProtocolVersion: 2,
    source: {
      repository: 'https://github.com/MoonshotAI/kimi-code',
      revision: expectedTag,
      license: 'MIT',
      manifestUrl
    },
    artifacts
  }
}

async function setOutputs(updated, version) {
  const output = process.env.GITHUB_OUTPUT
  if (!output) return
  await appendFile(output, `updated=${updated ? 'true' : 'false'}\nversion=${version}\n`)
}

const lockPath = resolve(process.cwd(), 'runtime.lock.json')
const lock = await loadRuntimeLock(lockPath)
const packageInfo = await fetchJson(REGISTRY_URL, 'npm latest')
const latestVersion = stableVersion(packageInfo?.version, 'npm latest.version')
const currentVersion = stableVersion(lock.channels.official?.version, 'runtime.lock official.version')
const comparison = compareVersions(latestVersion, currentVersion)
if (comparison < 0) throw new Error(`官方 latest ${latestVersion} 早于当前锁定版本 ${currentVersion}`)

const manifestUrl = `https://code.kimi.com/kimi-code/binaries/${latestVersion}/manifest.json`
const manifest = await fetchJson(manifestUrl, '官方 runtime manifest')
const official = officialChannelFromManifest(manifest, latestVersion, manifestUrl)

if (comparison === 0) {
  if (JSON.stringify(official) !== JSON.stringify(lock.channels.official)) {
    throw new Error(`官方 ${latestVersion} 的不可变清单与 runtime.lock.json 不一致，请人工审查`)
  }
  await setOutputs(false, latestVersion)
  console.log(`Kimi Code runtime 已是最新版本 ${latestVersion}`)
} else if (mode === 'write') {
  const updated = structuredClone(lock)
  updated.channels.official = official
  validateRuntimeLock(updated)
  await writeFile(lockPath, `${JSON.stringify(updated, null, 2)}\n`)
  await setOutputs(true, latestVersion)
  console.log(`Kimi Code runtime ${currentVersion} -> ${latestVersion}`)
} else {
  await setOutputs(true, latestVersion)
  console.error(`发现新的 Kimi Code runtime：${currentVersion} -> ${latestVersion}`)
  process.exitCode = 2
}
