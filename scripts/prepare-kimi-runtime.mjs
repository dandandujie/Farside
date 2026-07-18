import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, delimiter, join, resolve } from 'node:path'

const target = `${process.platform}-${process.arch}`
const executable = process.platform === 'win32' ? 'kimi.exe' : 'kimi'
const pathCandidates = (process.env.PATH || '')
  .split(delimiter)
  .filter(Boolean)
  .map((directory) => join(directory, executable))
const candidates = [
  process.env.FARSIDE_KIMI_BINARY,
  process.argv[2],
  process.platform === 'win32' ? join(homedir(), '.kimi-code', 'bin', 'kimi.exe') : join(homedir(), '.local', 'bin', 'kimi'),
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

if (!source) {
  throw new Error('未找到 Kimi Code runtime。请先运行官方安装器，或通过 FARSIDE_KIMI_BINARY 指定官方单文件可执行程序。')
}

const version = execFileSync(source, ['--version'], { encoding: 'utf8', windowsHide: true }).trim()
const bytes = await import('node:fs/promises').then(({ readFile }) => readFile(source))
const sha256 = createHash('sha256').update(bytes).digest('hex')
const directory = join(process.cwd(), 'resources', 'runtime', target)
const destination = join(directory, executable)
await mkdir(directory, { recursive: true })
await copyFile(source, destination)
await writeFile(join(directory, 'manifest.json'), `${JSON.stringify({
  name: 'Kimi Code CLI',
  version,
  target,
  executable: basename(destination),
  sha256,
  source: 'https://github.com/MoonshotAI/kimi-code'
}, null, 2)}\n`)
console.log(`Kimi Code ${version} -> ${destination}`)
console.log(`sha256 ${sha256}`)
