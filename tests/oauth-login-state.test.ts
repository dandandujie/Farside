import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveOAuthLoginState } from '../src/main/services/oauth-login-state'

test('已有有效凭据时忽略已结束的旧设备码流程', () => {
  assert.deepEqual(resolveOAuthLoginState('cancelled', true), {
    ready: true,
    pending: false
  })
})

test('只有 pending 设备码流程继续轮询', () => {
  assert.deepEqual(resolveOAuthLoginState('pending', false), {
    ready: false,
    pending: true
  })
})

test('过期、取消和缺失流程终止轮询并要求重新登录', () => {
  for (const status of ['expired', 'cancelled', undefined]) {
    const state = resolveOAuthLoginState(status, false)
    assert.equal(state.ready, false)
    assert.equal(state.pending, false)
    assert.match(state.error ?? '', /重新登录/)
  }
})
