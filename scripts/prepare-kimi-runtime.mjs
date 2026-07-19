import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, delimiter, join, resolve } from 'node:path'

const target = `${process.platform}-${process.arch}`
const executable = process.platform === 'win32' ? 'kimi.exe' : 'kimi'
const pinnedVersion = '0.26.0'
const pinnedArtifacts = {
  'darwin-arm64': { filename: 'kimi-code-darwin-arm64', checksum: '7cbdd16ce908e68d055cad4a5563a7c84982774d64eebf1f8565ebe91384c64e' },
  'darwin-x64': { filename: 'kimi-code-darwin-x64', checksum: 'f86390a87b47b3bee9c8c0864b9d4c7faa93537b3173697f606eb94afdad107a' },
  'linux-arm64': { filename: 'kimi-code-linux-arm64', checksum: '9269d86c57fc6881ffb7a6298179693b890ef2cbef353bcf8bc95984b3b5d1c3' },
  'linux-x64': { filename: 'kimi-code-linux-x64', checksum: 'a481aef83e6b72573ecb4c571b28ad6736e44166c71856e27a3216ef3d1465d4' },
  'win32-arm64': { filename: 'kimi-code-win32-arm64.exe', checksum: '70e3ab899fa4bfa7cba23884f5624ed71528f4aa01b92984f01268351f4b5799' },
  'win32-x64': { filename: 'kimi-code-win32-x64.exe', checksum: '96b056f4560810f243731988a01c79844723fa2712c4d66337a92ef00cd6a1ed' }
}

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
for (const candidate of candidates) {
  try {
    if ((await stat(candidate)).isFile()) {
      source = candidate
      break
    }
  } catch {}
}

let bytes
let version
let sourceUrl = 'https://github.com/MoonshotAI/kimi-code'
if (source) {
  version = execFileSync(source, ['--version'], { encoding: 'utf8', windowsHide: true }).trim()
  bytes = await readFile(source)
} else if (process.env.FARSIDE_DOWNLOAD_KIMI_RUNTIME === '1') {
  const artifact = pinnedArtifacts[target]
  if (!artifact) throw new Error(`没有为 ${target} 固定 Kimi Code runtime`)
  sourceUrl = `https://code.kimi.com/kimi-code/binaries/${pinnedVersion}/${artifact.filename}`
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`Kimi Code runtime 下载失败（${response.status}）`)
  const declaredSize = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > 300 * 1024 * 1024) throw new Error('Kimi Code runtime 体积异常')
  bytes = await readBoundedResponse(response, 300 * 1024 * 1024)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== artifact.checksum) {
    throw new Error(`Kimi Code runtime SHA-256 不匹配：expected ${artifact.checksum}, got ${actual}`)
  }
  version = pinnedVersion
} else {
  throw new Error('未找到 Kimi Code runtime。请先运行官方安装器，或通过 FARSIDE_KIMI_BINARY 指定官方单文件可执行程序。')
}

const sha256 = createHash('sha256').update(bytes).digest('hex')
const directory = join(process.cwd(), 'resources', 'runtime', target)
const destination = join(directory, executable)
await mkdir(directory, { recursive: true })
if (source) await copyFile(source, destination)
else await writeFile(destination, bytes, { mode: 0o755 })
if (process.platform !== 'win32') await chmod(destination, 0o755)
await writeFile(join(directory, 'manifest.json'), `${JSON.stringify({
  name: 'Kimi Code CLI',
  version,
  target,
  executable: basename(destination),
  sha256,
  source: sourceUrl
}, null, 2)}\n`)
console.log(`Kimi Code ${version} -> ${destination}`)
console.log(`sha256 ${sha256}`)
