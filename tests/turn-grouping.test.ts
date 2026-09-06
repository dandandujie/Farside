import assert from 'node:assert/strict'
import { test } from 'node:test'

import { groupNarrative, groupTurns, reconcileTurns } from '../src/renderer/src/lib/turns'
import { PHASE_STATUS, PHASE_STATUS_PROSE } from '../src/renderer/src/lib/phaseLabels'
import type {
  GroundEvent,
  InstrumentEvent,
  MessageEvent,
  SatelliteEvent,
  TelemetryEvent,
  TrajectoryEvent,
  TransmissionEvent
} from '../src/shared/types'

const ground = (id: string, text = '指令'): GroundEvent => ({ id, kind: 'user', at: 1_000, text })
const thinking = (id: string): TransmissionEvent => ({ id, kind: 'transmission', at: 1_050, text: '想', durationMs: 900 })
const instrument = (id: string, status: InstrumentEvent['status'] = 'done'): InstrumentEvent => ({
  id, kind: 'instrument', at: 1_100, tool: 'bash', argsSummary: 'ls', status
})
const telemetry = (id: string): TelemetryEvent => ({ id, kind: 'telemetry', at: 1_150, tokensPerSecond: 10, contextTokens: 100 })
const message = (id: string, markdown = '答案'): MessageEvent => ({ id, kind: 'message', at: 1_200, markdown })
const satellite = (id: string, parentToolCallId?: string): SatelliteEvent => ({
  id, kind: 'satellite', at: 1_120, satelliteKind: 'coder', status: 'in-orbit', task: '子任务', parentToolCallId
})

test('groupTurns：首条用户消息前的非用户事件归入序章 Turn', () => {
  const turns = groupTurns([thinking('t0'), ground('u1'), message('m1')])
  assert.equal(turns.length, 2)
  assert.equal(turns[0].id, 'session-preamble')
  assert.equal(turns[0].hasUser, false)
  assert.deepEqual(turns[0].events.map((event) => event.id), ['t0'])
  assert.equal(turns[1].id, 'u1')
  assert.equal(turns[1].hasUser, true)
  assert.deepEqual(turns[1].events.map((event) => event.id), ['u1', 'm1'])
})

test('groupTurns：每条用户消息开启新 Turn，系统事件不切 Turn', () => {
  const system: TrajectoryEvent = { id: 's1', kind: 'system', at: 1_010, label: '环境上下文', text: 'cwd' }
  const turns = groupTurns([ground('u1'), message('m1'), system, ground('u2'), message('m2')])
  assert.equal(turns.length, 2)
  assert.deepEqual(turns.map((turn) => turn.id), ['u1', 'u2'])
  assert.deepEqual(turns[0].events.map((event) => event.id), ['u1', 'm1', 's1'])
})

test('reconcileTurns：全部事件未变时复用 previous 数组本身', () => {
  const events = [ground('u1'), message('m1')]
  const previous = groupTurns(events)
  const next = groupTurns([...events])
  assert.notEqual(next, previous)
  assert.equal(reconcileTurns(previous, next), previous)
})

test('reconcileTurns：仅最后一个 Turn 变化时，已完成 Turn 保持旧引用（流式 memo 生效）', () => {
  const u1 = ground('u1')
  const m1 = message('m1')
  const u2 = ground('u2')
  const previous = groupTurns([u1, m1, u2, message('m2')])
  const next = groupTurns([u1, m1, u2, message('m2-updated')])
  const reconciled = reconcileTurns(previous, next)
  assert.notEqual(reconciled, next)
  assert.equal(reconciled[0], previous[0])
  assert.notEqual(reconciled[1], previous[1])
})

test('reconcileTurns：追加新 Turn 时旧 Turn 仍按 id 复用', () => {
  const e1 = ground('u1')
  const e2 = message('m1')
  const previous = groupTurns([e1, e2])
  const next = groupTurns([e1, e2, ground('u2')])
  const reconciled = reconcileTurns(previous, next)
  assert.equal(reconciled[0], previous[0])
  assert.equal(reconciled[1].id, 'u2')
})

const narrativeIds = (items: ReturnType<typeof groupNarrative>): string[] =>
  items.map((item) => (item.kind === 'event' ? item.event.id : item.id))

test('groupNarrative：边界之间的工具/思考/遥测成组，遥测只保留最新一条', () => {
  const items = groupNarrative([
    thinking('t1'), instrument('i1'), telemetry('tel1'), telemetry('tel2'), message('m1'), instrument('i2')
  ])
  assert.deepEqual(narrativeIds(items), [
    'thinking-batch-t1', 'activity-i1', 'telemetry-batch-tel1', 'm1', 'activity-i2'
  ])
  const telemetryItem = items[2]
  assert.ok(telemetryItem.kind === 'telemetry')
  assert.equal(telemetryItem.event.id, 'tel2')
  const thinkingItem = items[0]
  assert.ok(thinkingItem.kind === 'thinking')
  assert.equal(thinkingItem.events.length, 1)
})

test('groupNarrative：子代理按 parentToolCallId 聚组，无主工具的单独成组', () => {
  const items = groupNarrative([
    satellite('s1', 'call-1'), satellite('s2', 'call-1'), satellite('s3')
  ])
  assert.deepEqual(narrativeIds(items), ['swarm-s1', 'swarm-s3'])
  const firstSwarm = items[0]
  assert.ok(firstSwarm.kind === 'swarm')
  assert.deepEqual(firstSwarm.events.map((event) => event.id), ['s1', 's2'])
})

test('月相词表：紧凑词与散文层键位一致，双语齐备', () => {
  const compactKeys = Object.keys(PHASE_STATUS).sort()
  const proseKeys = Object.keys(PHASE_STATUS_PROSE).sort()
  assert.deepEqual(compactKeys, proseKeys)
  for (const key of compactKeys) {
    const compact = PHASE_STATUS[key as keyof typeof PHASE_STATUS]
    const prose = PHASE_STATUS_PROSE[key as keyof typeof PHASE_STATUS_PROSE]
    assert.ok(compact.zh && compact.en, `PHASE_STATUS.${key} 缺双语词条`)
    assert.ok(prose.zh && prose.en, `PHASE_STATUS_PROSE.${key} 缺双语词条`)
  }
})
