import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  MAX_QUEUE_PER_SESSION,
  parsePromptQueues,
  requeueFront,
  serializePromptQueues,
  shiftQueue,
  type QueuedPrompt
} from '../src/renderer/src/lib/prompt-queue'

const queued = (overrides: Partial<QueuedPrompt> = {}): QueuedPrompt => ({
  id: 'q1',
  sessionId: 's1',
  text: '修复登录 bug',
  fileRefs: [],
  attachments: [{ id: 'a1', name: 'shot.png', mimeType: 'image/png', size: 10, vision: true }],
  model: 'kimi-k3',
  permissionMode: 'manual',
  planMode: false,
  swarmMode: false,
  createdAt: 1_000,
  ...overrides
})

test('shiftQueue：摘掉队头；队列清空时删除会话键', () => {
  const queues = { s1: [queued({ id: 'q1' }), queued({ id: 'q2' })], s2: [queued({ id: 'q3', sessionId: 's2' })] }
  const first = shiftQueue(queues, 's1')
  assert.equal(first.head?.id, 'q1')
  assert.deepEqual(first.queues['s1'].map((item) => item.id), ['q2'])
  assert.ok('s1' in first.queues)
  const second = shiftQueue(first.queues, 's1')
  assert.equal(second.head?.id, 'q2')
  const third = shiftQueue(second.queues, 's1')
  assert.equal(third.head, null)
  assert.ok(!('s1' in third.queues))
  assert.ok('s2' in third.queues)
})

test('requeueFront：失败回队放回队头，不共享旧数组引用', () => {
  const original = [queued({ id: 'q2' })]
  const next = requeueFront({ s1: original }, 's1', queued({ id: 'q1' }))
  assert.deepEqual(next['s1'].map((item) => item.id), ['q1', 'q2'])
  assert.notEqual(next['s1'], original)
})

test('serialize → parse 往返：附件剥离，文本与模式保留', () => {
  const serialized = serializePromptQueues({
    s1: [queued({ fileRefs: ['src/a.ts'] })]
  })
  const restored = parsePromptQueues(serialized, new Set(['s1']))
  assert.equal(restored['s1']?.length, 1)
  const item = restored['s1'][0]
  assert.equal(item.text, '修复登录 bug')
  assert.deepEqual(item.fileRefs, ['src/a.ts'])
  assert.deepEqual(item.attachments, [])
  assert.equal(item.model, 'kimi-k3')
  assert.equal(item.permissionMode, 'manual')
})

test('parsePromptQueues：丢弃不存在的会话、损坏 JSON、纯附件与畸形条目', () => {
  const serialized = JSON.stringify({
    ghost: [{ id: 'x', text: '幽灵会话', fileRefs: [] }],
    empty: [{ id: 'y', text: '   ', fileRefs: [] }],
    malformed: [{ text: 42 }],
    s1: [{ id: 'z', text: '有效', fileRefs: [], model: 'kimi-k3', permissionMode: 'auto', createdAt: 1 }]
  })
  const restored = parsePromptQueues(serialized, new Set(['s1']))
  assert.deepEqual(Object.keys(restored), ['s1'])
  assert.equal(restored['s1'][0].id, 'z')
  assert.equal(restored['s1'][0].permissionMode, 'auto')
  assert.deepEqual(parsePromptQueues('{broken', new Set(['s1'])), {})
  assert.deepEqual(parsePromptQueues(null, new Set(['s1'])), {})
})

test('serializePromptQueues：会话级上限截断到 MAX_QUEUE_PER_SESSION', () => {
  const many = Array.from({ length: MAX_QUEUE_PER_SESSION + 5 }, (_, index) =>
    queued({ id: `q${index}`, attachments: [] })
  )
  const restored = parsePromptQueues(serializePromptQueues({ s1: many }), new Set(['s1']))
  assert.equal(restored['s1']?.length, MAX_QUEUE_PER_SESSION)
})
