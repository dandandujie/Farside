import { chmod, copyFile, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, delimiter, join, resolve } from 'node:path'
import {
  loadRuntimeLock,
  selectRuntimeArtifact,
  selectRuntimeChannel,
  versionOutputMatches
} from './runtime-lock.mjs'

const MAX_RUNTIME_BYTES = 300 * 1024 * 1024
const target = `${process.platform}-${process.arch}`
const executable = process.platform === 'win32' ? 'kimi.exe' : 'kimi'
const lock = await loadRuntimeLock()
const { name: channelName, channel } = selectRuntimeChannel(lock, process.env.FARSIDE_RUNTIME_CHANNEL)
const artifact = selectRuntimeArtifact(channel, target)
const downloadLockedRuntime = process.env.FARSIDE_DOWNLOAD_KIMI_RUNTIME === '1'

async function readBoundedResponse(response, maxBytes) {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error('Kimi Code runtime 体积异常')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}

function assertRuntimeVersion(command) {
  const output = execFileSync(command, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000
  }).trim()
  if (!versionOutputMatches(output, channel.version)) {
    throw new Error(`运行时版本不匹配：通道 ${channelName} 固定 ${channel.version}，实际为 ${output || '空输出'}`)
  }
  return output
}

const pathCandidates = (process.env.PATH || '')
  .split(delimiter)
  .filter(Boolean)
  .map((directory) => join(directory, executable))
const candidates = [
  process.env.FARSIDE_KIMI_BINARY,
  process.argv[2],
  join(homedir(), '.kimi-code', 'bin', executable),
  process.platform === 'win32' ? undefined : join(homedir(), '.local', 'bin', executable),
  ...pathCandidates
].filter(Boolean).map((value) => resolve(value))

let source
if (!downloadLockedRuntime) {
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) {
        source = candidate
        break
      }
    } catch {}
  }
}

let bytes
let provenance
if (downloadLockedRuntime) {
  const response = await fetch(artifact.url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`Kimi Code runtime 下载失败（${response.status}）`)
  const declaredSize = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RUNTIME_BYTES) {
    throw new Error('Kimi Code runtime 体积异常')
  }
  bytes = await readBoundedResponse(response, MAX_RUNTIME_BYTES)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== artifact.sha256) {
    throw new Error(`Kimi Code runtime SHA-256 不匹配：expected ${artifact.sha256}, got ${actual}`)
  }
  provenance = 'locked-download'
} else if (source) {
  assertRuntimeVersion(source)
  bytes = await readFile(source)
  if (bytes.byteLength > MAX_RUNTIME_BYTES) throw new Error('Kimi Code runtime 体积异常')
  provenance = createHash('sha256').update(bytes).digest('hex') === artifact.sha256 ? 'locked-copy' : 'local-copy'
} else {
  throw new Error('未找到 Kimi Code runtime。请先运行官方安装器、通过 FARSIDE_KIMI_BINARY 指定可执行程序，或设置 FARSIDE_DOWNLOAD_KIMI_RUNTIME=1 下载锁定产物。')
}

const sha256 = createHash('sha256').update(bytes).digest('hex')
const runtimeRoot = resolve(process.env.FARSIDE_RUNTIME_OUTPUT_DIR?.trim() || join(process.cwd(), 'resources', 'runtime'))
const directory = join(runtimeRoot, target)
const destination = join(directory, executable)
const staging = join(directory, process.platform === 'win32' ? `.kimi-${process.pid}.exe` : `.kimi-${process.pid}`)
await mkdir(directory, { recursive: true })

try {
  await writeFile(staging, bytes, { mode: 0o755 })
  if (process.platform !== 'win32') await chmod(staging, 0o755)
  const observedVersion = assertRuntimeVersion(staging)
  await copyFile(staging, destination)
  if (process.platform !== 'win32') await chmod(destination, 0o755)
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    name: 'Kimi Code CLI',
    channel: channelName,
    kind: channel.kind,
    version: channel.version,
    upstreamVersion: channel.upstreamVersion,
    apiVersion: channel.apiVersion,
    wsProtocolVersion: channel.wsProtocolVersion,
    observedVersion,
    target,
    executable: basename(destination),
    sha256,
    lockedSha256: provenance === 'local-copy' ? null : artifact.sha256,
    source: channel.source.repository,
    revision: channel.source.revision,
    manifestUrl: channel.source.manifestUrl,
    artifactUrl: provenance === 'local-copy' ? null : artifact.url,
    provenance
  }, null, 2)}\n`)
} finally {
  await unlink(staging).catch(() => {})
}

console.log(`Kimi Code ${channel.version} (${channelName}) -> ${destination}`)
console.log(`sha256 ${sha256}`)
