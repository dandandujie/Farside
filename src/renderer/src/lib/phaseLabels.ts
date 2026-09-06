import type { MoonPhase } from '@shared/types'

/**
 * 月相状态词表的唯一来源。三处消费：SessionList 状态 chips、EmptyState
 * 图例、MoonPhase tooltip 用紧凑词（PHASE_STATUS）；TrajectoryView 的
 * WorkingIndicator 用散文层（PHASE_STATUS_PROSE），语义与紧凑词一一对应。
 * 改文案只改这里，禁止在组件里再写本地词表。
 */
export const PHASE_STATUS: Record<MoonPhase, { zh: string; en: string }> = {
  new: { zh: '空闲', en: 'Idle' },
  waxing: { zh: '已接收', en: 'Queued' },
  'first-quarter': { zh: '思考中', en: 'Thinking' },
  gibbous: { zh: '执行中', en: 'Running' },
  full: { zh: '等待确认', en: 'Awaiting approval' },
  waning: { zh: '收尾中', en: 'Wrapping up' }
}

/** 运行中指示器的散文层：更完整的主谓描述，语义必须与 PHASE_STATUS 对应。 */
export const PHASE_STATUS_PROSE: Record<MoonPhase, { zh: string; en: string }> = {
  new: { zh: '已完成', en: 'Completed' },
  waxing: { zh: '请求已发送，等待 Kimi 响应', en: 'Sent, waiting for Kimi' },
  'first-quarter': { zh: '正在深空思考', en: 'Thinking in deep space' },
  gibbous: { zh: '正在执行工具', en: 'Running tools' },
  full: { zh: '等待你的确认', en: 'Awaiting your approval' },
  waning: { zh: '正在整理结果', en: 'Wrapping up' }
}
