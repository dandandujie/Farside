import { useEffect, useMemo, useRef, useState } from 'react'
import type { SatelliteEvent, SatelliteStatus } from '@shared/types'
import { Chevron, SatelliteArc } from './markers'
import { usePreferences } from '../../../lib/preferences'

const TERMINAL = new Set<SatelliteStatus>(['done', 'failed', 'cancelled'])
const BRAILLE_LEVELS = ['⣀', '⣄', '⣤', '⣦', '⣶', '⣷', '⣿'] as const
const STATUS_ORDER: SatelliteStatus[] = ['done', 'in-orbit', 'launching', 'suspended', 'cancelled', 'failed']

const STATUS_LABEL: Record<SatelliteStatus, [string, string]> = {
  launching: ['正在编排', 'Orchestrating'],
  'in-orbit': ['运行中', 'Running'],
  suspended: ['速率受限', 'Rate limited'],
  done: ['已完成', 'Completed'],
  failed: ['失败', 'Failed'],
  cancelled: ['已取消', 'Cancelled']
}

function statusColor(status: SatelliteStatus): string {
  if (status === 'done') return 'var(--signal)'
  if (status === 'failed') return 'var(--redshift)'
  if (status === 'cancelled' || status === 'suspended') return 'var(--flare)'
  return status === 'in-orbit' ? 'var(--moonlight)' : 'var(--faint)'
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function formatTokens(value: number): string {
  if (value < 1_000) return `${Math.round(value)} tok`
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k tok`
  return `${(value / 1_000_000).toFixed(1)}m tok`
}

function elapsedMs(event: SatelliteEvent, now: number): number {
  const live = event.startedAt && !TERMINAL.has(event.status) ? now - event.startedAt : 0
  return Math.max(event.durationMs ?? 0, live)
}

/** 与 Kimi TUI 一致使用 Braille 活动条，但不把启发式活动量伪装成精确百分比。 */
function brailleSignal(event: SatelliteEvent, now: number): string {
  const width = 8
  if (event.status === 'done') return `[${'⣿'.repeat(width)}]`
  if (event.status === 'suspended') return `[${'⣤'.repeat(width)}]`
  const elapsedTicks = Math.floor(elapsedMs(event, now) / 2_500)
  const rawTicks = Math.max(0, (event.toolCount ?? 0) * 7 + elapsedTicks)
  const capacity = width * BRAILLE_LEVELS.length
  const ticks = Math.min(capacity - 1, rawTicks)
  const cells = Array.from({ length: width }, (_, index) => {
    const remaining = ticks - index * BRAILLE_LEVELS.length
    if (remaining <= 0) return BRAILLE_LEVELS[0]
    return BRAILLE_LEVELS[Math.min(BRAILLE_LEVELS.length - 1, remaining)]
  })
  if (event.status === 'failed' || event.status === 'cancelled') {
    return `[${cells.join('')}]`
  }
  const pulse = Math.floor(now / 240) % width
  cells[pulse] = BRAILLE_LEVELS[Math.max(BRAILLE_LEVELS.indexOf(cells[pulse]), 3)]
  return `[${cells.join('')}]`
}

function aggregateStatus(events: SatelliteEvent[]): SatelliteStatus {
  if (events.some((event) => event.status === 'in-orbit')) return 'in-orbit'
  if (events.some((event) => event.status === 'launching')) return 'launching'
  if (events.some((event) => event.status === 'suspended')) return 'suspended'
  if (events.some((event) => event.status === 'failed')) return 'failed'
  if (events.some((event) => event.status === 'cancelled')) return 'cancelled'
  return 'done'
}

function summaryText(events: SatelliteEvent[], english: boolean): string {
  const count = (status: SatelliteStatus) => events.filter((event) => event.status === status).length
  const running = count('in-orbit') + count('launching')
  const parts = [
    [count('done'), english ? 'done' : '完成'],
    [running, english ? 'running' : '运行'],
    [count('suspended'), english ? 'limited' : '限流'],
    [count('failed'), english ? 'failed' : '失败'],
    [count('cancelled'), english ? 'cancelled' : '取消']
  ] as const
  return parts.filter(([value]) => value > 0).map(([value, label]) => `${value} ${label}`).join(english ? ' · ' : ' · ')
}

function SatelliteMember({ event, index, now }: { event: SatelliteEvent; index: number; now: number }) {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
  const duration = elapsedMs(event, now)
  const metrics = [
    `${event.toolCount ?? 0} ${english ? 'tools' : '工具'}`,
    duration > 0 ? formatDuration(duration) : null,
    event.tokens ? formatTokens(event.tokens) : null,
    event.runInBackground ? (english ? 'background' : '后台') : null
  ].filter(Boolean)

  return (
    <article className="swarm-member" data-status={event.status} aria-label={`${event.satelliteKind} ${STATUS_LABEL[event.status][english ? 1 : 0]}`}>
      <div className="swarm-member__header">
        <span className="swarm-member__index mono">{String(event.swarmIndex ?? index + 1).padStart(2, '0')}</span>
        <span className="swarm-member__kind mono">{event.satelliteKind}</span>
        <span className="swarm-member__status" style={{ color: statusColor(event.status) }}>
          {STATUS_LABEL[event.status][english ? 1 : 0]}
        </span>
      </div>
      <div className={`swarm-member__signal mono${TERMINAL.has(event.status) ? '' : ' swarm-member__signal--active'}`} style={{ color: statusColor(event.status) }}>
        {brailleSignal(event, now)}
      </div>
      <div className="swarm-member__task" title={event.task}>{event.task}</div>
      <div className="swarm-member__metrics mono">{metrics.join(' · ')}</div>
    </article>
  )
}

/**
 * Kimi TUI AgentSwarm 的桌面映射：整体总览 + 横向滚动的窄成员卡片 + 活动信号条。
 * 运行时保持展开，全部结束后自动收起；用户仍可手动查看每颗卫星的任务与结果。
 */
export function SatelliteGroup({ events }: { events: SatelliteEvent[] }) {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
  const sorted = useMemo(
    () => [...events].sort((a, b) => (a.swarmIndex ?? Number.MAX_SAFE_INTEGER) - (b.swarmIndex ?? Number.MAX_SAFE_INTEGER) || a.at - b.at),
    [events]
  )
  const active = sorted.some((event) => !TERMINAL.has(event.status))
  const [open, setOpen] = useState(active)
  const [now, setNow] = useState(Date.now())
  const wasActive = useRef(active)
  const status = aggregateStatus(sorted)
  const swarm = sorted.length > 1 || sorted.some((event) => event.swarmIndex !== undefined)

  useEffect(() => {
    if (active) setOpen(true)
    else if (wasActive.current) setOpen(false)
    wasActive.current = active
  }, [active])

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(Date.now()), 480)
    return () => window.clearInterval(timer)
  }, [active])

  if (!sorted.length) return null
  return (
    <section className="swarm-panel" data-active={active || undefined}>
      <SatelliteArc status={status} />
      <button className="swarm-panel__header" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="swarm-panel__title">{swarm ? 'Agent Swarm' : 'Agent'}</span>
        <span className="swarm-panel__count mono">{sorted.length.toString().padStart(2, '0')}</span>
        <span className="swarm-panel__summary">{summaryText(sorted, english)}</span>
        <Chevron open={open} />
      </button>
      <div className="swarm-panel__aggregate" aria-hidden>
        {[...sorted]
          .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status))
          .map((event) => <span key={event.id} style={{ background: statusColor(event.status) }} />)}
      </div>
      {open ? (
        <div className="swarm-grid">
          {sorted.map((event, index) => <SatelliteMember key={event.id} event={event} index={index} now={now} />)}
        </div>
      ) : null}
    </section>
  )
}

export function SatelliteNode({ event }: { event: SatelliteEvent }) {
  return <SatelliteGroup events={[event]} />
}
