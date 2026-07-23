import { execFileSync } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const KIMI_UPSTREAM_VERSION = '0.28.0'
export const KIMI_UPSTREAM_REVISION = 'a05228c67122c8233dc87226ce0ca7414780b680'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const KIMI_PATCH_FILES = [
  '0001-tool-result-token-budget.patch',
  '0002-rest-harness-controls.patch',
  '0003-progressive-builtin-tools.patch'
]

const patchPaths = KIMI_PATCH_FILES.map((file) =>
  resolve(root, 'patches', 'kimi-code', KIMI_UPSTREAM_VERSION, file)
)

function usage() {
  throw new Error(
    '用法：node scripts/farside-runtime-patch.mjs <--check|--apply> <Kimi Code 源码目录>'
  )
}

export function parseArgs(argv) {
  const [mode, sourceArg, ...extra] = argv
  if (!['--check', '--apply'].includes(mode) || !sourceArg || extra.length) usage()
  return { mode, sourceDir: resolve(sourceArg) }
}

function git(sourceDir, args) {
  return execFileSync('git', args, {
    cwd: sourceDir,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function patchState(sourceDir) {
  try {
    git(sourceDir, ['apply', '--check', ...patchPaths])
    return 'clean'
  } catch {}
  try {
    git(sourceDir, ['apply', '--reverse', '--check', ...patchPaths.toReversed()])
    return 'applied'
  } catch {
    return 'conflict'
  }
}

export async function run(argv) {
  const { mode, sourceDir } = parseArgs(argv)
  await access(resolve(sourceDir, 'package.json'))
  await Promise.all(patchPaths.map((patchPath) => access(patchPath)))

  const revision = git(sourceDir, ['rev-parse', 'HEAD'])
  if (revision !== KIMI_UPSTREAM_REVISION) {
    throw new Error(
      `Kimi Code 源码版本不匹配：需要 ${KIMI_UPSTREAM_REVISION}（${KIMI_UPSTREAM_VERSION}），实际 ${revision}`
    )
  }

  const state = patchState(sourceDir)
  if (state === 'conflict') {
    throw new Error('补丁既不能正向应用，也不能反向校验；源码目录可能包含冲突改动')
  }
  if (mode === '--apply' && state === 'clean') {
    git(sourceDir, ['apply', ...patchPaths])
    process.stdout.write(`已应用 ${patchPaths.length} 个 Farside harness 补丁\n`)
    return
  }
  process.stdout.write(
    state === 'applied'
      ? 'Farside harness 补丁已应用，校验通过\n'
      : 'Farside harness 补丁可干净应用，校验通过\n'
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
