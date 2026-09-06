import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  composerPatchForSession,
  readSessionComposer,
  type ComposerHostState,
  type KeyValueStorage,
  type SessionComposerState
} from '../src/renderer/src/lib/composer-state'

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: (key) => { map.delete(key) },
    dump: () => Object.fromEntries(map)
  }
}

function hostState(overrides: Partial<ComposerHostState> = {}): ComposerHostState {
  return {
    activeSessionId: 's1',
    sessions: [{ id: 's1', model: 'kimi-for-coding' }],
    composerBySession: {},
    draft: '',
    attachments: [],
    model: 'kimi-k3',
    permissionMode: 'manual',
    planMode: false,
    swarmMode: false,
    ...overrides
  }
}

test('readSessionComposer：缺失、损坏、字段非法时逐字段回退', () => {
  const storage = memoryStorage({
    'farside:session-composer:broken': '{not json',
    'farside:session-composer:partial': JSON.stringify({ draft: '草稿', permissionMode: 'yolo-ish' }),
    'farside:session-composer:ok': JSON.stringify({ draft: '好', model: 'kimi-for-coding', permissionMode: 'auto', planMode: true, swarmMode: true })
  })
  assert.deepEqual(readSessionComposer('missing', 'kimi-k3', storage), {
    draft: '', attachments: [], model: 'kimi-k3', permissionMode: 'manual', planMode: false, swarmMode: false
  })
  assert.equal(readSessionComposer('broken', 'kimi-k3', storage).draft, '')
  const partial = readSessionComposer('partial', 'kimi-k3', storage)
  assert.equal(partial.draft, '草稿')
  assert.equal(partial.permissionMode, 'manual')
  assert.equal(partial.model, 'kimi-k3')
  const ok = readSessionComposer('ok', 'kimi-k3', storage)
  assert.equal(ok.draft, '好')
  assert.equal(ok.model, 'kimi-for-coding')
  assert.equal(ok.permissionMode, 'auto')
  assert.equal(ok.planMode, true)
  assert.equal(ok.swarmMode, true)
})

test('composerPatchForSession：活动会话同时更新顶层与 per-session 副本并落盘', () => {
  const storage = memoryStorage()
  const state = hostState({ draft: '旧草稿' })
  const patch = composerPatchForSession(state, 's1', { draft: '新草稿', planMode: true }, storage)
  assert.equal(patch.draft, '新草稿')
  const composer = patch.composerBySession?.['s1']
  assert.ok(composer)
  assert.equal(composer.draft, '新草稿')
  assert.equal(composer.planMode, true)
  // 持久化剥离附件字段
  const persisted = JSON.parse(storage.dump()['farside:session-composer:s1']) as Record<string, unknown>
  assert.equal(persisted.draft, '新草稿')
  assert.ok(!('attachments' in persisted))
})

test('composerPatchForSession：非活动会话只更新 per-session 副本，不污染顶层草稿', () => {
  const storage = memoryStorage()
  const state = hostState({
    draft: '当前会话草稿',
    sessions: [
      { id: 's1', model: 'kimi-for-coding' },
      { id: 's2', model: 'kimi-for-coding-highspeed' }
    ]
  })
  const patch = composerPatchForSession(state, 's2', { draft: '后台会话草稿' }, storage)
  assert.equal(patch.draft, undefined)
  assert.equal(patch.composerBySession?.['s2']?.draft, '后台会话草稿')
  // fallback model 取目标会话的 model 而不是当前全局 model
  assert.equal(patch.composerBySession?.['s2']?.model, 'kimi-for-coding-highspeed')
  assert.ok(storage.dump()['farside:session-composer:s2'])
})

test('composerPatchForSession：无存储副本时回填当前活动会话的内存态', () => {
  const storage = memoryStorage()
  const existing: SessionComposerState = {
    draft: '已存在副本', attachments: [], model: 'kimi-k3', permissionMode: 'auto', planMode: false, swarmMode: false
  }
  const state = hostState({
    activeSessionId: 's1',
    composerBySession: { s1: existing }
  })
  const patch = composerPatchForSession(state, 's1', { draft: '覆盖' }, storage)
  // 已有副本时不读 localStorage 也不回填内存态，只应用增量
  assert.equal(patch.composerBySession?.['s1']?.draft, '覆盖')
  assert.equal(patch.composerBySession?.['s1']?.permissionMode, 'auto')
  assert.ok(storage.dump()['farside:session-composer:s1'])
})
