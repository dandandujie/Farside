import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  RUNTIME_TARGETS,
  selectRuntimeChannel,
  validateRuntimeLock,
  versionOutputMatches
} from '../scripts/runtime-lock.mjs'

const source = JSON.parse(await readFile(new URL('../runtime.lock.json', import.meta.url), 'utf8'))

function copyLock() {
  return structuredClone(source)
}

test('默认 runtime 通道完整锁定六个平台', () => {
  const lock = validateRuntimeLock(copyLock())
  const { name, channel } = selectRuntimeChannel(lock)
  assert.equal(name, 'official')
  assert.equal(channel.version, '0.27.0')
  assert.deepEqual(Object.keys(channel.artifacts).sort(), [...RUNTIME_TARGETS].sort())
})

test('未发布完整产物的自定义通道不能被选择', () => {
  const lock = validateRuntimeLock(copyLock())
  assert.throws(() => selectRuntimeChannel(lock, 'farside'), /尚未发布完整的六平台产物/)
})

test('启用通道拒绝缺失平台、不安全 URL 与伪造校验值', () => {
  const missing = copyLock()
  delete missing.channels.official.artifacts['linux-arm64']
  assert.throws(() => validateRuntimeLock(missing), /缺少目标/)

  const insecure = copyLock()
  insecure.channels.official.artifacts['linux-arm64'].url = 'http://example.com/kimi-code-linux-arm64'
  assert.throws(() => validateRuntimeLock(insecure), /HTTPS URL/)

  const invalidHash = copyLock()
  invalidHash.channels.official.artifacts['linux-arm64'].sha256 = '0'.repeat(63)
  assert.throws(() => validateRuntimeLock(invalidHash), /SHA-256/)
})

test('版本输出必须包含边界完整的锁定版本', () => {
  assert.equal(versionOutputMatches('kimi-code 0.27.0', '0.27.0'), true)
  assert.equal(versionOutputMatches('0.27.0-farside.1', '0.27.0-farside.1'), true)
  assert.equal(versionOutputMatches('kimi-code 0.27.01', '0.27.0'), false)
})
