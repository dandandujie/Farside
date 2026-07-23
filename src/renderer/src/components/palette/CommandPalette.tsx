import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { PERMISSION_MODE_LABELS, type TrajectoryEvent } from '@shared/types'
import { useFarsideStore } from '../../lib/store'
import { Kbd } from '../../design-system/Kbd'
import { MoonPhase } from '../../design-system/MoonPhase'
import { PrismLine } from '../../design-system/PrismLine'
import { SLASH_COMMANDS } from '../composer/slashCommands'
import { usePreferences } from '../../lib/preferences'

interface PaletteItem {
  id: string
  group: '动作' | '斜杠命令' | '会话'
  label: string
  hint?: string
  /** 模糊匹配的目标文本 */
  keywords: string
  icon?: ReactNode
  run(): void
}

/** 子序列模糊匹配：query 的每个字符按序出现在 target 中即命中。 */
function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let i = 0
  for (const ch of t) {
    if (ch === q[i]) i++
    if (i >= q.length) return true
  }
  return q.length === 0 || i >= q.length
}

/** 轨道事件 → Markdown 行（导出用，地面站口吻的分节标题）。 */
function eventToMarkdown(e: TrajectoryEvent): string {
  switch (e.kind) {
    case 'user':
      return `## 地面站指令\n\n${e.text}`
    case 'system':
      return `### ${e.label}\n\n${e.text}`
    case 'transmission':
      return `### 深空思考 · ${(e.durationMs / 1000).toFixed(1)}s\n\n${e.text}`
    case 'instrument':
      return `### 仪器 · ${e.tool}\n\n\`${e.argsSummary}\``
    case 'satellite':
      return `### 卫星 · ${e.satelliteKind}\n\n${e.task}${e.result ? `\n\n${e.result}` : ''}`
    case 'approval':
      return `### 等待地面站确认 · ${e.tool}\n\n${e.detail}`
    case 'message':
      return e.markdown
    case 'telemetry':
      return `\`遥测 · ${e.tokensPerSecond} tok/s · ${e.contextTokens.toLocaleString()} tok${e.cost === undefined ? '' : ` · $${e.cost.toFixed(4)}`}\``
  }
}

/** 命令面板：⌘K 唤起，动作 / 斜杠命令 / 会话三段，子序列模糊匹配。 */
export function CommandPalette() {
  const { locale, t } = usePreferences()
  const english = locale === 'en-US'
  const open = useFarsideStore((s) => s.paletteOpen)
  const setOpen = useFarsideStore((s) => s.setPaletteOpen)
  const sessions = useFarsideStore((s) => s.sessions)
  const setActiveSession = useFarsideStore((s) => s.setActiveSession)
  const newSession = useFarsideStore((s) => s.newSession)
  const setView = useFarsideStore((s) => s.setView)
  const openTerminal = useFarsideStore((s) => s.openTerminal)
  const setDraft = useFarsideStore((s) => s.setDraft)
  const permissionMode = useFarsideStore((s) => s.permissionMode)
  const cyclePermissionMode = useFarsideStore((s) => s.cyclePermissionMode)

  const [query, setQuery] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setIdx(0)
      // 等浮层挂载后再聚焦
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // ── 三段列表：动作 → 斜杠命令 → 会话 ────────────────────────────
  const items = useMemo<PaletteItem[]>(() => {
    const exportMarkdown = () => {
      const s = useFarsideStore.getState()
      const session = s.sessions.find((x) => x.id === s.activeSessionId)
      if (!session) return
      const md = [
        `# ${session.title}`,
        '',
        `> ${session.project} · ${session.cwd}`,
        '',
        ...session.events.filter((event) => event.kind !== 'system').map(eventToMarkdown)
      ].join('\n\n')
      const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `${session.title}.md`
      a.click()
      URL.revokeObjectURL(url)
    }

    const actions: PaletteItem[] = [
      {
        id: 'act-new',
        group: '动作',
        label: english ? 'New session' : '新建会话',
        keywords: '新建会话 new session',
        run: () => {
          newSession()
          setView('sessions')
        }
      },
      {
        id: 'act-permission',
        group: '动作',
        label: english ? 'Cycle permissions' : '切换权限档位',
        hint: english ? `Current: ${permissionMode}` : `当前：${PERMISSION_MODE_LABELS[permissionMode]}`,
        keywords: '切换权限档位 permission mode',
        run: cyclePermissionMode
      },
      {
        id: 'act-export',
        group: '动作',
        label: english ? 'Export Markdown' : '导出 Markdown',
        keywords: '导出 markdown export',
        run: exportMarkdown
      },
      {
        id: 'act-terminal',
        group: '动作',
        label: english ? 'Open terminal' : '打开终端',
        keywords: '打开终端 terminal',
        run: openTerminal
      },
      {
        id: 'act-settings',
        group: '动作',
        label: t('打开设置'),
        keywords: '打开设置 settings',
        run: () => setView('settings')
      }
    ]

    const slashes: PaletteItem[] = SLASH_COMMANDS.map((c) => ({
      id: `slash-${c.name}`,
      group: '斜杠命令',
      label: `/${c.name}`,
      hint: t(c.desc),
      keywords: `/${c.name} ${c.desc}`,
      run: () => {
        // 填入输入舱并回到会话视图，由地面站确认后发送
        setDraft(`/${c.name} `)
        setView('sessions')
      }
    }))

    const sessionItems: PaletteItem[] = sessions.map((s) => ({
      id: `session-${s.id}`,
      group: '会话',
      label: s.title,
      hint: s.project,
      keywords: `${s.title} ${s.project}`,
      icon: <MoonPhase phase={s.phase} size={12} />,
      run: () => {
        setActiveSession(s.id)
        setView('sessions')
      }
    }))

    return [...actions, ...slashes, ...sessionItems]
  }, [sessions, permissionMode, newSession, setView, setActiveSession, setDraft, cyclePermissionMode, english, t])

  const q = query.trim()
  const filtered = q ? items.filter((i) => fuzzyMatch(q, i.keywords)) : items

  // 查询变化回到第一项；选中项滚入可视区
  useEffect(() => setIdx(0), [q])
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  if (!open) return null

  const select = (item: PaletteItem) => {
    item.run()
    setOpen(false)
  }

  let lastGroup = ''

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'color-mix(in srgb, var(--void) 72%, transparent)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '14vh'
      }}
    >
      <div
        className="fade-in"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxHeight: '52vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--mare)',
          border: '1px solid var(--line-hi)',
          borderRadius: 10,
          overflow: 'hidden',
          boxShadow: '0 16px 48px rgba(0,0,0,0.5)'
        }}
      >
        <PrismLine />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 14px',
            borderBottom: '1px solid var(--line)'
          }}
        >
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIdx((i) => (filtered.length ? (i + 1) % filtered.length : 0))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIdx((i) =>
                  filtered.length ? (i - 1 + filtered.length) % filtered.length : 0
                )
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const item = filtered[idx]
                if (item) select(item)
              } else if (e.key === 'Escape') {
                setOpen(false)
              }
            }}
            placeholder={english ? 'Search actions, slash commands, sessions…' : '搜索动作、斜杠命令、会话…'}
            style={{ flex: 1, fontSize: 14, color: 'var(--moonlight)', background: 'transparent' }}
          />
          <Kbd>esc</Kbd>
        </div>
        <div ref={listRef} style={{ overflowY: 'auto', padding: 6 }}>
          {filtered.map((item, i) => {
            const header =
              item.group !== lastGroup ? (
                <div
                  key={`g-${item.group}-${item.id}`}
                  style={{
                    padding: '8px 10px 4px',
                    fontSize: 11,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: 'var(--faint)'
                  }}
                >
                  {english ? ({ '动作': 'Actions', '斜杠命令': 'Slash commands', '会话': 'Sessions' } as Record<PaletteItem['group'], string>)[item.group] : item.group}
                </div>
              ) : null
            lastGroup = item.group
            const active = i === idx
            return (
              <div key={item.id}>
                {header}
                <button
                  data-active={active || undefined}
                  onClick={() => select(item)}
                  onMouseEnter={() => setIdx(i)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 10px',
                    borderRadius: 6,
                    fontSize: 13,
                    color: active ? 'var(--moonlight)' : 'var(--dust)',
                    background: active ? 'var(--crater)' : 'transparent',
                    transition: 'background 120ms var(--ease-farside)'
                  }}
                >
                  {item.icon ? (
                    <span style={{ display: 'flex', flexShrink: 0 }}>{item.icon}</span>
                  ) : null}
                  <span
                    className={item.group === '斜杠命令' ? 'mono' : undefined}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {item.label}
                  </span>
                  {item.hint ? (
                    <span
                      style={{
                        fontSize: 11,
                        color: 'var(--faint)',
                        flexShrink: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        maxWidth: 220
                      }}
                    >
                      {item.hint}
                    </span>
                  ) : null}
                </button>
              </div>
            )
          })}
          {filtered.length === 0 ? (
            <div
              style={{
                padding: '22px 10px',
                textAlign: 'center',
                fontSize: 12.5,
                color: 'var(--faint)'
              }}
            >
              {english ? 'No commands found' : '未找到指令'}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
