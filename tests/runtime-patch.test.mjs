import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  KIMI_UPSTREAM_REVISION,
  KIMI_PATCH_FILES,
  KIMI_UPSTREAM_VERSION,
  parseArgs
} from '../scripts/farside-runtime-patch.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(await (await import('node:fs/promises')).readFile(resolve(root, 'runtime.lock.json'), 'utf8'))
const patchScript = await readFile(resolve(root, 'scripts', 'farside-runtime-patch.mjs'), 'utf8')

test('runtime 补丁固定到已审计的 Kimi Code 0.29.2 基线', () => {
  assert.equal(KIMI_UPSTREAM_VERSION, '0.29.2')
  assert.equal(lock.runtime.upstreamVersion, '0.29.2')
  assert.equal(lock.runtime.source.revision, '8a45f10eddbb35c317047e82e567cdb59a220b4f')
  assert.equal(KIMI_UPSTREAM_REVISION, '8a45f10eddbb35c317047e82e567cdb59a220b4f')
})

test('0.29.2 已吸收历史 harness 补丁，当前队列为空', () => {
  assert.deepEqual(KIMI_PATCH_FILES, [])
})

test('runtime 补丁参数要求显式模式与源码目录', () => {
  assert.deepEqual(parseArgs(['--check', '.']), { mode: '--check', sourceDir: root })
  assert.throws(() => parseArgs(['--apply']), /用法/)
  assert.throws(() => parseArgs(['--unknown', '.']), /用法/)
  assert.match(patchScript, /'--ignore-space-change'/)
})
