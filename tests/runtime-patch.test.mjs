import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  KIMI_UPSTREAM_REVISION,
  KIMI_PATCH_FILES,
  KIMI_UPSTREAM_VERSION,
  patchState,
  parseArgs
} from '../scripts/farside-runtime-patch.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(await (await import('node:fs/promises')).readFile(resolve(root, 'runtime.lock.json'), 'utf8'))
const patchScript = await readFile(resolve(root, 'scripts', 'farside-runtime-patch.mjs'), 'utf8')

test('runtime 补丁固定到已审计的 Kimi Code 0.31.1 候选基线', () => {
  assert.equal(KIMI_UPSTREAM_VERSION, '0.31.1')
  assert.equal(lock.runtime.upstreamVersion, '0.29.2')
  assert.equal(lock.runtime.source.revision, '8a45f10eddbb35c317047e82e567cdb59a220b4f')
  assert.equal(KIMI_UPSTREAM_REVISION, '6b56c11697771fe596099b38bafae539820309a4')
})

test('0.31.1 继续包含历史 harness 适配，候选队列为空', () => {
  assert.deepEqual(KIMI_PATCH_FILES, [])
  assert.equal(patchState(root), 'clean')
  assert.match(patchScript, /patchPaths\.length === 0/)
  assert.match(patchScript, /无需重放 Farside 补丁/)
})

test('runtime 补丁参数要求显式模式与源码目录', () => {
  assert.deepEqual(parseArgs(['--check', '.']), { mode: '--check', sourceDir: root })
  assert.throws(() => parseArgs(['--apply']), /用法/)
  assert.throws(() => parseArgs(['--unknown', '.']), /用法/)
  assert.match(patchScript, /'--ignore-space-change'/)
})
