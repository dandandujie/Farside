import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  approvalFromRemote,
  decodedBase64Size,
  editableToolPaths,
  eventsFromMessages,
  friendlyRunError,
  internalMessageLabel,
  isBoundedString,
  mapRemotePhase,
  parseWireProfile,
  sessionFromRemote,
  telemetryFromWire,
  workspaceFromRemote
} from '../src/main/services/wire-events'

test('运行时注入消息归类为 system 事件，普通用户文本保持 user 身份', () => {
  assert.equal(internalMessageLabel('<system-reminder>请勿外传</system-reminder>'), '系统提醒')
  assert.equal(internalMessageLabel('<notification>后台任务完成</notification>'), '运行时通知')
  assert.equal(internalMessageLabel('# AGENTS.md instructions\n内容'), '项目指令')
  assert.equal(internalMessageLabel('Skill tool loaded instructions for this request. Follow them.'), '能力上下文')
  assert.equal(internalMessageLabel('帮我修复构建错误'), null)
})

test('eventsFromMessages 按 block 保序还原 user/思考/工具/答复，并配对工具结果', () => {
  const events = eventsFromMessages({
    items: [
      {
        id: 'm1',
        role: 'user',
        created_at: '2026-09-01T10:00:00Z',
        content: [{ type: 'text', text: '跑一下测试' }]
      },
      {
        id: 'm2',
        role: 'assistant',
        created_at: '2026-09-01T10:00:05Z',
        content: [
          { type: 'thinking', thinking: '先看测试脚本', duration_ms: 1200 },
          { type: 'tool_use', tool_call_id: 'call-1', tool_name: 'Bash', input: { command: 'npm test' } },
          { type: 'tool_result', tool_call_id: 'call-1', is_error: false, output: 'all green' },
          { type: 'text', text: '测试全部通过。' }
        ]
      }
    ]
  })
  const kinds = events.map((event) => event.kind)
  assert.deepEqual(kinds, ['user', 'transmission', 'instrument', 'message'])
  const tool = events[2]
  assert.equal(tool.kind === 'instrument' && tool.tool, 'Bash')
  assert.equal(tool.kind === 'instrument' && tool.status, 'done')
  assert.equal(tool.kind === 'instrument' && tool.output, 'all green')
  const user = events[0]
  assert.equal(user.kind === 'user' && user.text, '跑一下测试')
})

test('eventsFromMessages 把 system-reminder 归为折叠内部事件而非用户请求', () => {
  const events = eventsFromMessages({
    items: [
      {
        id: 'm1',
        role: 'user',
        created_at: 1_000,
        content: [{ type: 'text', text: '<environment_context>cwd=/tmp</environment_context>' }]
      }
    ]
  })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'system')
})

test('sessionFromRemote 补齐标题/项目/月相缺省值', () => {
  const idle = sessionFromRemote({ id: 's1', metadata: { cwd: '/tmp/demo' } })
  assert.equal(idle.title, '未命名会话')
  assert.equal(idle.project, 'demo')
  assert.equal(idle.phase, 'new')

  const waiting = sessionFromRemote({ id: 's2', pending_interaction: 'approval' })
  assert.equal(waiting.phase, 'full')

  const busy = sessionFromRemote({ id: 's3', busy: true })
  assert.equal(busy.phase, 'first-quarter')
})

test('mapRemotePhase 覆盖上游状态词表，未知状态返回 null', () => {
  assert.equal(mapRemotePhase('thinking'), 'first-quarter')
  assert.equal(mapRemotePhase('acting'), 'gibbous')
  assert.equal(mapRemotePhase('approval'), 'full')
  assert.equal(mapRemotePhase('wrapping'), 'waning')
  assert.equal(mapRemotePhase('queued'), 'waxing')
  assert.equal(mapRemotePhase('mystery'), null)
})

test('telemetryFromWire 汇总 token、速度、缓存命中与人民币成本', () => {
  const telemetry = telemetryFromWire([
    JSON.stringify({ type: 'llm.request', time: 1_000, model: 'kimi-k3' }),
    JSON.stringify({
      type: 'usage.record',
      time: 11_000,
      model: 'kimi-k3',
      usage: { input_other: 100, input_cache_read: 300, output: 200 }
    }),
    'not-json-line'
  ].join('\n'))
  assert.ok(telemetry)
  assert.equal(telemetry.contextTokens, 400)
  assert.equal(telemetry.inputTokens, 100)
  assert.equal(telemetry.cachedInputTokens, 300)
  assert.equal(telemetry.outputTokens, 200)
  assert.equal(telemetry.activeDurationMs, 10_000)
  assert.ok(Math.abs(telemetry.tokensPerSecond - 20) < 1e-9)
  assert.ok(Math.abs(telemetry.cacheHitRate - 75) < 1e-9)
  // k3 定价：input 20、cachedInput 2、output 100（CNY / 百万 tokens）
  const expectedCny = (100 / 1e6) * 20 + (300 / 1e6) * 2 + (200 / 1e6) * 100
  assert.ok(Math.abs((telemetry.estimatedCostCny ?? 0) - expectedCny) < 1e-9)
  assert.equal(telemetryFromWire('garbage'), null)
})

test('friendlyRunError 按错误类别给出可操作指引并保留服务端信息', () => {
  assert.match(friendlyRunError('insufficient balance'), /额度不足/)
  assert.match(friendlyRunError('boom', 'rate_limit'), /限流/)
  assert.match(friendlyRunError('401 unauthorized'), /登录凭据/)
  assert.equal(friendlyRunError(''), '模型或服务链路异常终止，未生成可信的完成信号。')
})

test('editableToolPaths 只针对写入类工具抽取路径并去重', () => {
  const paths = editableToolPaths({
    name: 'Edit',
    args: { file_path: 'src/a.ts' },
    display: { options: [{}, '*** Update File: src/b.ts'] }
  })
  assert.deepEqual(paths.sort(), ['src/a.ts', 'src/b.ts'])
  assert.deepEqual(editableToolPaths({ name: 'Read', args: { file_path: 'src/a.ts' } }), [])
})

test('approvalFromRemote 还原计划审批并截断到三个选项', () => {
  const approval = approvalFromRemote({
    approval_id: 'a1',
    session_id: 's1',
    tool_name: 'ExitPlanMode',
    tool_input_display: {
      kind: 'plan_review',
      plan: '# 计划',
      path: '/tmp/plan.md',
      options: [
        { label: 'Approve', description: 'ok' },
        { label: 'Revise' },
        { label: 'Reject' },
        { label: 'Extra' }
      ]
    },
    created_at: 5_000
  })
  assert.equal(approval.id, 'a1')
  assert.equal(approval.planReview?.plan, '# 计划')
  assert.equal(approval.planReview?.path, '/tmp/plan.md')
  assert.equal(approval.planReview?.options.length, 3)
  assert.equal(approval.requestedAt, 5_000)

  const plain = approvalFromRemote({ approval_id: 'a2', session_id: 's1', tool_name: 'Bash' })
  assert.equal(plain.planReview, undefined)
  assert.equal(plain.detail, 'Bash')
})

test('decodedBase64Size 计算解码字节数并拒绝超限与非法输入', () => {
  assert.equal(decodedBase64Size('AQ=='), 1)
  assert.equal(decodedBase64Size('QUJD'), 3)
  assert.equal(decodedBase64Size('not base64!'), null)
  assert.equal(decodedBase64Size(''), null)
  assert.equal(decodedBase64Size('A'.repeat(30_000_000)), null)
})

test('workspaceFromRemote 以目录名兜底项目名并保持计数缺省', () => {
  const workspace = workspaceFromRemote({ id: 'w1', root: '/home/dev/my-app/' })
  assert.equal(workspace.name, 'my-app')
  assert.equal(workspace.isGitRepo, false)
  assert.equal(workspace.sessionCount, 0)
})

test('isBoundedString 执行长度与非空约束', () => {
  assert.equal(isBoundedString('abc', 5), true)
  assert.equal(isBoundedString('', 5), false)
  assert.equal(isBoundedString('', 5, true), true)
  assert.equal(isBoundedString('abcdef', 5), false)
  assert.equal(isBoundedString(42 as unknown, 5), false)
})

test('parseWireProfile 按文件聚合任务/token/工具统计，跨行容错', () => {
  const stats = parseWireProfile([
    JSON.stringify({ type: 'turn.prompt', time: 1_760_000_000_000 }),
    JSON.stringify({ type: 'llm.request', time: 1_760_000_001_000, model: 'kimi-k3-highspeed', thinkingEffort: 'high' }),
    JSON.stringify({ type: 'usage.record', time: 1_760_000_005_000, usage: { input_other: 10, output: 20 } }),
    JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.call', name: ' Skill ', args: { skill: '$review' } } }),
    JSON.stringify({ type: 'turn.prompt', time: 1_760_100_000_000 }),
    JSON.stringify({ type: 'usage.record', time: 1_760_100_004_000, usage: { output_tokens: 30 } }),
    'broken json line'
  ].join('\n'))
  assert.equal(stats.taskCount, 2)
  assert.equal(stats.requestCount, 1)
  assert.equal(stats.fastRequestCount, 1)
  assert.equal(stats.totalTokens, 60)
  assert.equal(stats.peakTaskTokens, 30)
  assert.equal(stats.longestTaskDurationMs, 4_000)
  assert.equal(stats.reasoning.get('high'), 1)
  assert.equal(stats.skills.get('review'), 1)
  assert.equal(stats.tools.get('Skill'), 1)
  assert.ok([...stats.daily.values()].reduce((sum, day) => sum + day.tasks, 0) === 2)
})
