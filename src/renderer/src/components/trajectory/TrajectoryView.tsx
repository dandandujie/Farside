import { useEffect, useRef, useState } from 'react'
import type { MoonPhase, Session, TrajectoryEvent } from '@shared/types'
import { SessionHeader } from './SessionHeader'
import { GoalBar } from './GoalBar'
import { GroundNode } from './nodes/GroundNode'
import { TransmissionNode } from './nodes/TransmissionNode'
import { InstrumentNode } from './nodes/InstrumentNode'
import { SatelliteGroup, SatelliteNode } from './nodes/SatelliteNode'
import { ApprovalNode } from './nodes/ApprovalNode'
import { MessageNode } from './nodes/MessageNode'
import { TelemetryNode } from './nodes/TelemetryNode'
import { SystemNode } from './nodes/SystemNode'
import { usePreferences } from '../../lib/preferences'
import { MoonPhase as MoonPhaseIcon } from '../../design-system/MoonPhase'
import { Chevron } from './nodes/markers'
import { TurnChangesCard } from './TurnChangesCard'

function renderNode(event: TrajectoryEvent, isLast: boolean, phase: MoonPhase) {
  switch (event.kind) {
    case 'user':
      return <GroundNode event={event} />
    case 'system':
      return <SystemNode event={event} />
    case 'transmission':
      return <TransmissionNode event={event} active={isLast && phase === 'first-quarter'} />
    case 'instrument':
      return <InstrumentNode event={event} />
    case 'satellite':
      return <SatelliteNode event={event} />
    case 'approval':
      return <ApprovalNode event={event} />
    case 'message':
      return <MessageNode event={event} streaming={isLast && (phase === 'first-quarter' || phase === 'gibbous')} />
    case 'telemetry':
      return <TelemetryNode event={event} />
  }
}

interface Turn {
  id: string
  events: TrajectoryEvent[]
  hasUser: boolean
}

function groupTurns(events: TrajectoryEvent[]): Turn[] {
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

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function activityLabel(events: TrajectoryEvent[], english: boolean): string {
  const tools = events.filter((event) => event.kind === 'instrument')
  const satellites = events.filter((event) => event.kind === 'satellite')
  const systemEvents = events.filter((event) => event.kind === 'system')
  const running = tools.some((event) => event.kind === 'instrument' && event.status === 'running')
  if (tools.length) {
    const counts = { edit: 0, command: 0, web: 0, read: 0, other: 0 }
    for (const tool of tools) {
      const value = `${tool.tool} ${tool.argsSummary}`.toLowerCase()
      if (/edit|write|patch|replace|create.?file|delete.?file/.test(value)) counts.edit++
      else if (/bash|shell|powershell|terminal|exec|command|cmd\b/.test(value)) counts.command++
      else if (/fetch|browser|web|url|search.?web/.test(value)) counts.web++
      else if (/read|glob|grep|search|find|list|file/.test(value)) counts.read++
      else counts.other++
    }
    const labels: string[] = []
    if (counts.edit) labels.push(english ? 'Edited files' : '编辑了文件')
    if (counts.command) {
      labels.push(english
        ? `${running ? 'Running' : 'Ran'} ${counts.command > 1 ? 'multiple commands' : 'a command'}`
        : `${running ? '正在运行' : '运行了'}${counts.command > 1 ? '多个命令' : '命令'}`)
    }
    if (counts.web) labels.push(english ? 'Searched the web' : '搜索了网页')
    if (counts.read) labels.push(english ? 'Inspected files' : '查看了文件')
    if (counts.other) labels.push(english ? `Used ${counts.other} ${counts.other > 1 ? 'tools' : 'tool'}` : `调用了 ${counts.other} 个工具`)
    return labels.join(english ? ', ' : '、')
  }
  if (satellites.length) return english ? `${satellites.length} subagents participated` : `${satellites.length} 个子代理参与处理`
  if (systemEvents.length) return english ? `Synced ${systemEvents.length} runtime context items` : `同步了 ${systemEvents.length} 条运行上下文`
  return english ? 'Analyzed the request' : '分析了请求'
}

function ProcessEvents({
  events,
  phase,
  lastId
}: {
  events: TrajectoryEvent[]
  phase: MoonPhase
  lastId?: string
}) {
  return (
    <div
      data-activity-list
      style={{
        maxHeight: 232,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        scrollbarGutter: 'stable',
        padding: '4px 4px 4px 15px',
        borderLeft: '1px solid var(--line)',
        margin: '3px 0 0 3px'
      }}
    >
      {events.map((event, index) => (
        <div key={event.id} style={{ marginTop: index ? 2 : 0 }}>
          {renderNode(event, event.id === lastId, phase)}
        </div>
      ))}
    </div>
  )
}

type NarrativeItem =
  | { kind: 'event'; event: TrajectoryEvent }
  | { kind: 'activity'; id: string; events: TrajectoryEvent[] }
  | { kind: 'thinking'; id: string; events: Extract<TrajectoryEvent, { kind: 'transmission' }>[] }
  | { kind: 'telemetry'; id: string; event: Extract<TrajectoryEvent, { kind: 'telemetry' }> }
  | { kind: 'swarm'; id: string; events: Extract<TrajectoryEvent, { kind: 'satellite' }>[] }

/** 正文消息是阅读边界；边界之间的所有工具统一收成一个活动组。 */
function groupNarrative(events: TrajectoryEvent[]): NarrativeItem[] {
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

function WorkingIndicator({ phase, startedAt }: { phase: MoonPhase; startedAt: number }) {
  const { locale } = usePreferences()
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => {
    if (phase !== 'waxing') return
    setClock(Date.now())
    const timer = window.setInterval(() => setClock(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [phase, startedAt])
  if (phase === 'new') return null
  const english = locale === 'en-US'
  const labels: Record<MoonPhase, [string, string]> = {
    new: ['已完成', 'Completed'],
    waxing: ['请求已发送，等待 Kimi 响应', 'Sent, waiting for Kimi'],
    'first-quarter': ['正在深空思考', 'Thinking in deep space'],
    gibbous: ['正在执行工具', 'Running tools'],
    full: ['等待你的确认', 'Awaiting your approval'],
    waning: ['正在整理结果', 'Wrapping up']
  }
  const active = phase !== 'full'
  const waitingSeconds = Math.max(0, clock - startedAt) / 1000
  return (
    <div
      data-working-indicator
      role="status"
      aria-live="polite"
      style={{ display: 'flex', alignItems: 'center', gap: 9, width: 'fit-content', minHeight: 30, marginTop: 16, padding: '3px 10px 3px 5px', border: '1px solid var(--line)', borderRadius: 999, background: 'color-mix(in srgb, var(--regolith) 70%, transparent)', color: 'var(--faint)' }}
    >
      <span style={{ width: 23, height: 23, display: 'grid', placeItems: 'center' }}>
        <MoonPhaseIcon phase={phase} size={17} title={labels[phase][english ? 1 : 0]} active={active} />
      </span>
      <span style={{ fontSize: 11.5, letterSpacing: '0.01em', color: phase === 'full' ? 'var(--dust)' : 'var(--moonlight)' }}>
        {labels[phase][english ? 1 : 0]}
        {phase === 'waxing' && waitingSeconds >= 1 ? ` · ${waitingSeconds.toFixed(1)}s` : ''}
      </span>
    </div>
  )
}

function NarrativeEvents({ events, phase, lastId, live = false }: { events: TrajectoryEvent[]; phase: MoonPhase; lastId?: string; live?: boolean }) {
  const items = groupNarrative(events)
  return (
    <>
      {items.map((item, index) => (
        <div key={item.kind === 'event' ? item.event.id : item.id} className="fade-in" style={{ marginTop: index ? 16 : 14 }}>
          {item.kind === 'activity'
            ? <ActivityBatch events={item.events} phase={phase} lastId={lastId} live={live} />
            : item.kind === 'thinking'
              ? <ThinkingBatch events={item.events} phase={phase} lastId={lastId} />
              : item.kind === 'telemetry'
                ? renderNode(item.event, item.event.id === lastId, phase)
                : item.kind === 'swarm'
                  ? <SatelliteGroup events={item.events} />
                  : renderNode(item.event, item.event.id === lastId, phase)}
        </div>
      ))}
    </>
  )
}

function ThinkingBatch({
  events,
  phase,
  lastId
}: {
  events: Extract<TrajectoryEvent, { kind: 'transmission' }>[]
  phase: MoonPhase
  lastId?: string
}) {
  const last = events[events.length - 1]
  const active = phase === 'first-quarter' && last?.id === lastId
  const previousDurationMs = active
    ? events.slice(0, -1).reduce((total, event) => total + event.durationMs, 0)
    : 0
  const event = {
    id: `thinking-batch-${events[0].id}`,
    kind: 'transmission' as const,
    at: active ? last.at : events[0].at,
    text: events.map((item) => item.text.trim()).filter(Boolean).join('\n\n'),
    durationMs: events.reduce((total, item) => total + item.durationMs, 0)
  }
  return (
    <TransmissionNode
      event={event}
      active={active}
      activeOffsetMs={previousDurationMs}
      itemCount={events.length}
    />
  )
}

function ActivityBatch({
  events,
  phase,
  lastId,
  live
}: {
  events: TrajectoryEvent[]
  phase: MoonPhase
  lastId?: string
  live: boolean
}) {
  const { locale } = usePreferences()
  const executing = live && phase !== 'new' && phase !== 'waning'
  const [open, setOpen] = useState(executing)
  useEffect(() => {
    if (executing) setOpen(true)
  }, [executing])
  if (!events.length) return null
  const running = events.some((event) => event.kind === 'instrument' && event.status === 'running')
  const label = activityLabel(events, locale === 'en-US')
  return (
    <div>
      <button
        data-activity-batch
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={label}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minHeight: 24, color: 'var(--faint)' }}
      >
        <span
          aria-hidden
          className="mono"
          style={{ width: 15, height: 15, display: 'grid', placeItems: 'center', border: '1px solid var(--line-hi)', borderRadius: 4, fontSize: 8 }}
        >
          ›_
        </span>
        <span style={{ fontSize: 12.5, color: running ? 'var(--dust)' : 'var(--faint)' }}>
          {label}
        </span>
        <Chevron open={open} />
      </button>
      {open ? <ProcessEvents events={events} phase={phase} lastId={lastId} /> : null}
    </div>
  )
}

function TurnGroup({
  turn,
  completed,
  phase,
  lastId,
  showChangeCard,
  sessionId
}: {
  turn: Turn
  completed: boolean
  phase: MoonPhase
  lastId?: string
  showChangeCard: boolean
  sessionId: string
}) {
  const { t } = usePreferences()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (turn.hasUser) setOpen(false)
  }, [completed, turn.hasUser, turn.id])

  if (!turn.hasUser) {
    return <div><NarrativeEvents events={turn.events} phase={phase} lastId={lastId} live={false} /></div>
  }

  const prompt = turn.events.find((event) => event.kind === 'user')
  const narrativeEvents = turn.events.filter((event) => event.kind !== 'user')
  const finalMessage = [...narrativeEvents].reverse().find((event) => event.kind === 'message')
  const finalTelemetry = [...narrativeEvents].reverse().find((event) => event.kind === 'telemetry')
  const elapsed = turn.events.length > 1
    ? turn.events[turn.events.length - 1].at - turn.events[0].at
    : 0

  return (
    <section style={{ position: 'relative', paddingBottom: 8 }}>
      {prompt ? <GroundNode event={prompt as Extract<TrajectoryEvent, { kind: 'user' }>} /> : null}
      {completed ? (
        <div style={{ margin: '18px 0 16px' }}>
        <button
          onClick={() => { if (narrativeEvents.length) setOpen((value) => !value) }}
          aria-expanded={open}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            minHeight: 28,
            color: 'var(--faint)',
            textAlign: 'left'
          }}
        >
          <span style={{ fontSize: 12.5 }}>{t('已处理')} {formatDuration(elapsed)}</span>
          {narrativeEvents.length ? <Chevron open={open} /> : null}
          <span aria-hidden style={{ flex: 1, height: 1, background: 'var(--line)' }} />
        </button>
        {open && narrativeEvents.length ? <NarrativeEvents events={narrativeEvents} phase={phase} lastId={lastId} live={false} /> : null}
        </div>
      ) : null}
      {completed && !open && finalMessage ? (
        <div className="fade-in" style={{ marginTop: 16 }}>{renderNode(finalMessage, finalMessage.id === lastId, phase)}</div>
      ) : null}
      {completed && !open && finalTelemetry ? (
        <div className="fade-in" style={{ marginTop: 10 }}>{renderNode(finalTelemetry, finalTelemetry.id === lastId, phase)}</div>
      ) : null}
      {!completed ? (
        <NarrativeEvents events={narrativeEvents} phase={phase} lastId={lastId} live />
      ) : null}
      {completed && showChangeCard ? <TurnChangesCard sessionId={sessionId} events={turn.events} /> : null}
    </section>
  )
}

/** 纵向任务轨道：按用户请求分 Turn，完成的 Turn 自动折叠，当前 Turn 保持展开。 */
export function TrajectoryView({ session }: { session: Session }) {
  const { t } = usePreferences()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  // 运行时注入仅供 Agent 使用，不属于用户与助手的对话内容。
  const visibleEvents = session.events.filter((event) => event.kind !== 'system')
  const turns = groupTurns(visibleEvents)

  const handleScroll = () => {
    const element = scrollRef.current
    if (!element) return
    pinnedRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
  }

  useEffect(() => {
    const element = scrollRef.current
    if (element && pinnedRef.current) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
  }, [session.events.length, session.phase])

  useEffect(() => {
    pinnedRef.current = true
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [session.id])

  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    const observer = new ResizeObserver(() => {
      const element = scrollRef.current
      if (!element) return
      const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
      if (pinnedRef.current || distanceFromBottom < 180) {
        element.scrollTop = element.scrollHeight
        pinnedRef.current = true
      }
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [session.id])

  const lastId = visibleEvents[visibleEvents.length - 1]?.id

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <SessionHeader session={session} />
      <GoalBar />
      <div ref={scrollRef} onScroll={handleScroll} style={{ flex: 1, overflowY: 'auto', padding: '20px 24px 24px' }}>
        {visibleEvents.length === 0 ? (
          <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 12.5, color: 'var(--faint)', letterSpacing: '0.02em' }}>
              {t('轨道尚未建立，发出第一条指令。')}
            </span>
          </div>
        ) : (
          <div
            ref={contentRef}
            role="log"
            style={{
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              gap: 28,
              paddingLeft: 26,
              maxWidth: 820
            }}
          >
            <div aria-hidden style={{ position: 'absolute', left: 0, top: 4, bottom: 4, width: 1, background: 'var(--line)' }} />
            {turns.map((turn, index) => {
              const isLastTurn = index === turns.length - 1
              const completed = turn.hasUser && (!isLastTurn || session.phase === 'new')
              return (
                <TurnGroup
                  key={`${session.id}-${turn.id}`}
                  turn={turn}
                  completed={completed}
                  phase={session.phase}
                  lastId={lastId}
                  showChangeCard={isLastTurn}
                  sessionId={session.id}
                />
              )
            })}
          </div>
        )}
      </div>
      {session.phase !== 'new' ? (
        <div style={{ flexShrink: 0, padding: '7px 24px 8px', borderTop: '1px solid var(--line)', background: 'color-mix(in srgb, var(--mare) 88%, transparent)' }}>
          <WorkingIndicator phase={session.phase} startedAt={session.updatedAt} />
        </div>
      ) : null}
    </div>
  )
}
