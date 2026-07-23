import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compareUrl,
  compareVersions,
  renderAuditReport,
  upstreamTag
} from '../scripts/check-kimi-upstream.mjs'

test('上游版本检查只比较稳定版本', () => {
  assert.equal(compareVersions('0.28.0', '0.27.9'), 1)
  assert.equal(compareVersions('0.27.0', '0.27.0'), 0)
  assert.equal(compareVersions('0.26.9', '0.27.0'), -1)
  assert.throws(() => compareVersions('0.28.0-beta.1', '0.27.0'), /稳定版本号/)
})

test('差异审查固定源码比较并禁止直接搬运 release', () => {
  assert.equal(upstreamTag('0.28.0'), '@moonshot-ai/kimi-code@0.28.0')
  assert.match(compareUrl('0.27.0', '0.28.0'), /MoonshotAI\/kimi-code\/compare/)
  const report = renderAuditReport('0.27.0', '0.28.0')
  assert.match(report, /禁止直接下载新官方 release/)
  assert.match(report, /协议 smoke/)
  assert.match(report, /唯一 runtime/)
})
