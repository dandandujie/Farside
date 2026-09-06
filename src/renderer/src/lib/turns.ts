import type { TrajectoryEvent } from '@shared/types'

/**
 * 轨迹分组的纯函数层：Turn 划分、流式 reconcile、正文叙事分组。
 * 从 TrajectoryView.tsx 抽出，使分组逻辑可以直接单测（tests/turn-grouping.test.ts）。
 */

export interface Turn {
  id: string
  events: TrajectoryEvent[]
  hasUser: boolean
}

export function groupTurns(events: TrajectoryEvent[]): Turn[] {
  const turns: Turn[] = []
  let active: Turn | null = null
  for (const event of events) {
    if (event.kind === 'user') {
      active = { id: event.id, events: [event], hasUser: true }
      turns.push(active)
      continue
    }
    if (!active) {
      active = { id: 'session-preamble', events: [], hasUser: false }
      turns.push(active)
    }
    active.events.push(event)
  }
  return turns
}

function sameTurn(previous: Turn | undefined, current: Turn): boolean {
  if (!previous || previous.id !== current.id || previous.events.length !== current.events.length) {
    return false
  }
  for (let eventIndex = 0; eventIndex < current.events.length; eventIndex += 1) {
    if (previous.events[eventIndex] !== current.events[eventIndex]) return false
  }
  return true
}

/**
 * 流式期间每次 event-upsert 都会重建 events 数组，groupTurns 的全部 Turn
 * 对象随之换新引用；但只有当前 Turn 的事件引用真正变化，已完成 Turn 的
 * 事件保持同一实例。按 Turn 逐个比对事件引用并复用旧对象，memo 化的
 * TurnGroup 在流式更新时就能跳过所有未变化 Turn 的重渲染。
 */
export function reconcileTurns(previous: Turn[], next: Turn[]): Turn[] {
  if (previous.length === next.length && previous.every((turn, index) => sameTurn(turn, next[index]))) {
    return previous
  }
  const previousById = new Map(previous.map((turn) => [turn.id, turn]))
  return next.map((turn) => (sameTurn(previousById.get(turn.id), turn) ? previousById.get(turn.id) as Turn : turn))
}

export type NarrativeItem =
  | { kind: 'event'; event: TrajectoryEvent }
  | { kind: 'activity'; id: string; events: TrajectoryEvent[] }
  | { kind: 'thinking'; id: string; events: Extract<TrajectoryEvent, { kind: 'transmission' }>[] }
  | { kind: 'telemetry'; id: string; event: Extract<TrajectoryEvent, { kind: 'telemetry' }> }
  | { kind: 'swarm'; id: string; events: Extract<TrajectoryEvent, { kind: 'satellite' }>[] }

/** 正文消息是阅读边界；边界之间的所有工具统一收成一个活动组。 */
export function groupNarrative(events: TrajectoryEvent[]): NarrativeItem[] {
  const items: NarrativeItem[] = []
  let segment: TrajectoryEvent[] = []
  const flushSegment = () => {
    if (!segment.length) return
    const satellites = segment.filter((event): event is Extract<TrajectoryEvent, { kind: 'satellite' }> => event.kind === 'satellite')
    const satelliteGroups = new Map<string, typeof satellites>()
    for (const event of satellites) {
      const key = event.parentToolCallId ?? 'unscoped'
      satelliteGroups.set(key, [...(satelliteGroups.get(key) ?? []), event])
    }
    const activity = segment.filter((event) => {
      if (event.kind !== 'instrument') return false
      if (!satellites.length) return true
      return !/^(agent|agent.?swarm)$/i.test(event.tool.replace(/[^a-z]/gi, ''))
    })
    const thinking = segment.filter((event): event is Extract<TrajectoryEvent, { kind: 'transmission' }> => event.kind === 'transmission')
    // 每个 step 都会上发一条遥测，多段思考会堆出一整列；只保留最新一条原地更新。
    const telemetryEvents = segment.filter((event): event is Extract<TrajectoryEvent, { kind: 'telemetry' }> => event.kind === 'telemetry')
    let activityInserted = false
    let thinkingInserted = false
    let telemetryInserted = false
    const swarmsInserted = new Set<string>()
    for (const event of segment) {
      if (event.kind === 'instrument') {
        if (!activityInserted && activity.length && activity.some((item) => item.id === event.id)) {
          items.push({ kind: 'activity', id: `activity-${activity[0].id}`, events: activity })
          activityInserted = true
        }
      } else if (event.kind === 'transmission') {
        if (!thinkingInserted) {
          items.push({ kind: 'thinking', id: `thinking-batch-${thinking[0].id}`, events: thinking })
          thinkingInserted = true
        }
      } else if (event.kind === 'telemetry') {
        if (!telemetryInserted) {
          items.push({
            kind: 'telemetry',
            id: `telemetry-batch-${telemetryEvents[0].id}`,
            event: telemetryEvents[telemetryEvents.length - 1]
          })
          telemetryInserted = true
        }
      } else if (event.kind === 'satellite') {
        const key = event.parentToolCallId ?? 'unscoped'
        if (!swarmsInserted.has(key)) {
          const group = satelliteGroups.get(key) ?? [event]
          items.push({ kind: 'swarm', id: `swarm-${group[0].id}`, events: group })
          swarmsInserted.add(key)
        }
      } else {
        items.push({ kind: 'event', event })
      }
    }
    segment = []
  }
  for (const event of events) {
    if (event.kind === 'message') {
      flushSegment()
      items.push({ kind: 'event', event })
    } else {
      segment.push(event)
    }
  }
  flushSegment()
  return items
}
