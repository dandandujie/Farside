import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AccountState } from '../src/shared/types'
import { createSlashHandlers, type SlashStoreApi, type SlashStateView } from '../src/renderer/src/lib/slash-handlers'
import { SLASH_COMMANDS, UNSUPPORTED_SLASH_COMMANDS } from '../src/renderer/src/components/composer/slashCommands'

type FakeState = SlashStateView & { calls: string[]; draftValue?: string }

const fakeAccount: AccountState = {
  configured: true,
  activeProviderId: 'managed:kimi-code',
  activeModel: 'kimi-k3',
  providers: [],
  models: [{ id: 'kimi-k3' }, { id: 'kimi-for-coding' }]
} as unknown as AccountState

/** 最小假 store：记录 setState 调用与方法触发，不依赖 window/zustand。 */
function fakeStore(initial: Partial<SlashStateView> = {}): SlashStoreApi & { calls: string[]; state: FakeState } {
  const state: FakeState = {
    activeSessionId: 's1',
    swarmMode: false,
    model: 'kimi-k3',
    account: fakeAccount,
    sessions: [],
    promptQueues: {},
    view: 'sessions',
    sidebarOpen: true,
    paletteOpen: false,
    missionOpen: false,
    missionTab: 'telemetry',
    lastError: null,
    setDraft: (text) => { state.draftValue = text },
    newSession: () => { state.calls.push('newSession') },
    togglePlanMode: () => { state.calls.push('togglePlanMode') },
    setSwarmMode: (enabled) => { state.calls.push(`setSwarmMode:${enabled}`) },
    setPermissionMode: (mode) => { state.calls.push(`setPermissionMode:${mode}`) },
    setModel: (model) => { state.calls.push(`setModel:${model}`) },
    logoutAccount: () => Promise.resolve(),
    openSettings: (section) => { state.calls.push(`openSettings:${section}`) },
    forkSession: () => { state.calls.push('forkSession') },
    exportSession: () => { state.calls.push('exportSession') },
    renameSession: () => { state.calls.push('renameSession') },
    setActiveSession: () => { state.calls.push('setActiveSession') },
    undoLastTurn: () => { state.calls.push('undoLastTurn') },
    pauseGoal: () => { state.calls.push('pauseGoal') },
    resumeGoal: () => { state.calls.push('resumeGoal') },
    cancelGoal: () => { state.calls.push('cancelGoal') },
    calls: []
  }
  Object.assign(state, initial)
  return {
    getState: () => state,
    setState: (partial) => {
      Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
    },
    calls: state.calls,
    state
  }
}

test('注册表覆盖：SLASH_COMMANDS 每个命令都有 handler；同义命令不重复实现', () => {
  const handlers = createSlashHandlers(fakeStore())
  for (const command of SLASH_COMMANDS) {
    assert.ok(handlers[command.name], `缺少 /${command.name} 的 handler`)
  }
  // 同义命令由别名提供，与主命令共享同一函数
  assert.equal(handlers.usage, handlers.status)
  assert.equal(handlers.provider, handlers.login)
  assert.equal(handlers['update-config'], handlers['mcp-config'])
  assert.equal(handlers.export, handlers['export-md'])
  // 补全清单与显式不支持清单不相交
  for (const command of SLASH_COMMANDS) {
    assert.ok(!UNSUPPORTED_SLASH_COMMANDS.has(command.name), `/${command.name} 同时出现在两个清单`)
  }
})

test('条件语义：会话级命令在无活动会话时返回 pass，改为提示词继续上送', () => {
  const store = fakeStore({ activeSessionId: null })
  const handlers = createSlashHandlers(store)
  assert.equal(handlers.fork('', { activeSessionId: null }).action, 'pass')
  assert.equal(handlers.reload('', { activeSessionId: null }).action, 'pass')
  assert.equal(handlers.undo('', { activeSessionId: null }).action, 'pass')
})

test('设置导航：settings/mcp/login 打开对应设置分区并清空草稿', () => {
  const store = fakeStore()
  store.state.draftValue = '待清空'
  const handlers = createSlashHandlers(store)
  assert.equal(handlers.settings('', { activeSessionId: 's1' }).action, 'handled')
  assert.equal(store.state.view, 'settings')
  assert.equal(handlers.mcp('', { activeSessionId: 's1' }).action, 'handled')
  assert.equal(store.calls.at(-1), 'openSettings:extensions')
  assert.equal(handlers.login('', { activeSessionId: 's1' }).action, 'handled')
  assert.equal(store.calls.at(-1), 'openSettings:account')
  assert.equal(store.state.draftValue, '')
})

test('权限档位：合法值生效，非法值按原文上送（pass）', () => {
  const store = fakeStore()
  const handlers = createSlashHandlers(store)
  assert.equal(handlers.permission('auto', { activeSessionId: 's1' }).action, 'handled')
  assert.equal(store.calls.at(-1), 'setPermissionMode:auto')
  assert.equal(handlers.permission('sudo', { activeSessionId: 's1' }).action, 'pass')
})

test('模型切换：别名解析生效；未知模型报错而非静默生效', () => {
  const store = fakeStore()
  const handlers = createSlashHandlers(store)
  assert.equal(handlers.model('k3', { activeSessionId: 's1' }).action, 'handled')
  assert.equal(store.calls.at(-1), 'setModel:kimi-k3')
  const outcome = handlers.model('nonexistent-model', { activeSessionId: 's1' })
  assert.equal(outcome.action, 'handled')
  assert.match(store.state.lastError ?? '', /未知模型/)
})

test('swarm 开关：on/off 显式，无参取反', () => {
  const store = fakeStore({ swarmMode: false })
  const handlers = createSlashHandlers(store)
  handlers.swarm('', { activeSessionId: 's1' })
  assert.equal(store.calls.at(-1), 'setSwarmMode:true')
  handlers.swarm('off', { activeSessionId: 's1' })
  assert.equal(store.calls.at(-1), 'setSwarmMode:false')
  handlers.swarm('on', { activeSessionId: 's1' })
  assert.equal(store.calls.at(-1), 'setSwarmMode:true')
})

test('goal：pause/resume/cancel 直达，带目标时改写为提示词上送', () => {
  const store = fakeStore()
  const handlers = createSlashHandlers(store)
  assert.equal(handlers.goal('pause', { activeSessionId: 's1' }).action, 'handled')
  assert.equal(store.calls.at(-1), 'pauseGoal')
  const outcome = handlers.goal('连续重构存储层', { activeSessionId: 's1' })
  assert.deepEqual(outcome, { action: 'prompt', text: '连续重构存储层', goalObjective: '连续重构存储层' })
  assert.equal(handlers.goal('', { activeSessionId: 's1' }).action, 'handled')
  assert.equal(store.state.view, 'goals')
})
