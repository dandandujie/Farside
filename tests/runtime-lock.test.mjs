import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  RUNTIME_TARGETS,
  getCurrentRuntime,
  validateRuntimeLock,
  versionOutputMatches
} from '../scripts/runtime-lock.mjs'

const source = JSON.parse(await readFile(new URL('../runtime.lock.json', import.meta.url), 'utf8'))

function copyLock() {
  return structuredClone(source)
}

test('唯一 current runtime 完整锁定六个平台', () => {
  const lock = validateRuntimeLock(copyLock())
  const { name, runtime } = getCurrentRuntime(lock)
  assert.equal(name, 'current')
  assert.equal(runtime.version, '0.27.0')
  assert.deepEqual(Object.keys(runtime.artifacts).sort(), [...RUNTIME_TARGETS].sort())
})

test('拒绝重新引入平行 runtime 通道或运行时切换', () => {
  const extra = copyLock()
  extra.channels = { official: structuredClone(extra.runtime) }
  assert.throws(() => validateRuntimeLock(extra), /不再支持平行通道/)
})

test('唯一 runtime 拒绝缺失平台、不安全 URL 与伪造校验值', () => {
  const missing = copyLock()
  delete missing.runtime.artifacts['linux-arm64']
  assert.throws(() => validateRuntimeLock(missing), /缺少目标/)

  const insecure = copyLock()
  insecure.runtime.artifacts['linux-arm64'].url = 'http://example.com/kimi-code-linux-arm64'
  assert.throws(() => validateRuntimeLock(insecure), /HTTPS URL/)

  const invalidHash = copyLock()
  invalidHash.runtime.artifacts['linux-arm64'].sha256 = '0'.repeat(63)
  assert.throws(() => validateRuntimeLock(invalidHash), /SHA-256/)
})

test('版本输出必须包含边界完整的锁定版本', () => {
  assert.equal(versionOutputMatches('kimi-code 0.27.0', '0.27.0'), true)
  assert.equal(versionOutputMatches('0.27.0-farside.1', '0.27.0-farside.1'), true)
  assert.equal(versionOutputMatches('kimi-code 0.27.01', '0.27.0'), false)
})
