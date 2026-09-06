import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SessionRuntimeStore } from '../src/main/services/session-runtime'

test('ensure 返回同一实例，get 对未知会话返回 undefined', () => {
  const store = new SessionRuntimeStore()
  assert.equal(store.get('s1'), undefined)
  const first = store.ensure('s1')
  assert.equal(store.ensure('s1'), first)
  assert.equal(store.get('s1'), first)
})

test('isActive / anyActiveRun 只反映 runActive 标记', () => {
  const store = new SessionRuntimeStore()
  assert.equal(store.anyActiveRun(), false)
  store.ensure('s1').runActive = true
  store.ensure('s2').runFailed = true
  assert.equal(store.isActive('s1'), true)
  assert.equal(store.isActive('s3'), false)
  assert.equal(store.anyActiveRun(), true)
  store.ensure('s1').runActive = false
  assert.equal(store.anyActiveRun(), false)
})

test('dropIfIdle：完全空闲才回收，runFailed 保持到下一次提交', () => {
  const store = new SessionRuntimeStore()
  // 模拟 markRunFailed：runActive 清掉，但 runFailed 必须保留条目。
  const failed = store.ensure('s1')
  failed.runActive = true
  failed.runFailed = false
  failed.runActive = false
  failed.runFailed = true
  store.dropIfIdle('s1')
  assert.equal(store.get('s1'), failed)

  // 模拟 prompt.completed：runActive 清掉且没有 runFailed → 条目回收。
  store.ensure('s2').runActive = false
  store.dropIfIdle('s2')
  assert.equal(store.get('s2'), undefined)
})

test('dropIfIdle：思考流、工具调用、子代理或定时器任一存在时保留条目', () => {
  const store = new SessionRuntimeStore()

  const thinking = store.ensure('a')
  thinking.thinking = { id: 't1', startedAt: 1 }
  store.dropIfIdle('a')
  assert.ok(store.get('a'))

  const tools = store.ensure('b')
  tools.activeToolCalls.add('call-1')
  store.dropIfIdle('b')
  assert.ok(store.get('b'))

  const subagents = store.ensure('c')
  subagents.subagents.set('agent-1', {
    id: 'agent-1',
    sessionId: 'c',
    at: 1,
    lastAt: 1,
    satelliteKind: 'coder',
    status: 'launching',
    task: '子代理任务',
    toolCount: 0,
    latestModelText: ''
  })
  store.dropIfIdle('c')
  assert.ok(store.get('c'))

  const settle = store.ensure('d')
  settle.settleTimer = setTimeout(() => {}, 60_000)
  store.dropIfIdle('d')
  assert.ok(store.get('d'))

  store.disposeAll()
  assert.equal(store.get('d'), undefined)
})

test('disposeAll 清空全部条目并清理定时器', () => {
  const store = new SessionRuntimeStore()
  const runtime = store.ensure('s1')
  runtime.runActive = true
  runtime.settleTimer = setTimeout(() => {}, 60_000)
  store.disposeAll()
  assert.equal(store.get('s1'), undefined)
  assert.equal(store.anyActiveRun(), false)
})
