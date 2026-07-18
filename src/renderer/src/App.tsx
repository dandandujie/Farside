import { useCallback, useEffect } from 'react'
import { useFarsideStore, useActiveSession } from './lib/store'
import { Titlebar } from './components/shell/Titlebar'
import { OrbitRail } from './components/shell/OrbitRail'
import { BootSplash } from './components/shell/BootSplash'
import { EmptyState } from './components/shell/EmptyState'
import { SessionList } from './components/sessions/SessionList'
import { TrajectoryView } from './components/trajectory/TrajectoryView'
import { Composer } from './components/composer/Composer'
import { MissionPanel } from './components/mission/MissionPanel'
import { ApprovalCard } from './components/approval/ApprovalCard'
import { QuestionCard } from './components/approval/QuestionCard'
import { CommandPalette } from './components/palette/CommandPalette'
import { TerminalView } from './components/terminal/TerminalView'
import { GoalsView } from './components/goals/GoalsView'
import { SettingsView } from './components/settings/SettingsView'
import { NoiseOverlay } from './design-system/NoiseOverlay'
import { Onboarding } from './components/shell/Onboarding'
import { usePreferences } from './lib/preferences'

export default function App() {
  const { t } = usePreferences()
  const booted = useFarsideStore((s) => s.booted)
  const setBooted = useFarsideStore((s) => s.setBooted)
  const initialize = useFarsideStore((s) => s.initialize)
  const view = useFarsideStore((s) => s.view)
  const sidebarOpen = useFarsideStore((s) => s.sidebarOpen)
  const missionOpen = useFarsideStore((s) => s.missionOpen)
  const approvalQueue = useFarsideStore((s) => s.approvalQueue)
  const questionQueue = useFarsideStore((s) => s.questionQueue)
  const lastError = useFarsideStore((s) => s.lastError)
  const active = useActiveSession()

  const handleBooted = useCallback(() => setBooted(), [setBooted])

  useEffect(() => {
    void initialize()
  }, [initialize])

  // dev-only 截图钩子：按场景初始化界面状态，默认行为不受影响。
  // 仅在 URL 带参时生效，默认行为不受影响（离屏走查脚本 scripts/screenshot.mjs 用）。
  useEffect(() => {
    const shot = new URLSearchParams(window.location.search).get('shot')
    if (!shot) return
    const s = useFarsideStore.getState()
    if (shot === 'palette') s.setPaletteOpen(true)
    else if (shot === 'diff' || shot === 'files') s.setMissionTab(shot)
    else if (shot === 'goals' || shot === 'terminal') s.setView(shot)
    else if (shot === 'settings' || shot === 'settings-light') s.setView('settings')
    else if (shot === 'account') {
      useFarsideStore.setState({
        authReady: false,
        account: { configured: false, providers: [], models: [] },
        lastError: null
      })
    } else if (shot === 'image-input') {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="#0a0b0f"/><circle cx="78" cy="58" r="34" fill="#f0f1f4"/><circle cx="92" cy="48" r="34" fill="#0a0b0f"/><text x="80" y="105" text-anchor="middle" fill="#8f929d" font-family="monospace" font-size="11">FARSIDE</text></svg>'
      useFarsideStore.setState({
        draft: '分析这张界面截图，并指出信息层级问题。',
        attachments: [{
          id: 'shot-image-attachment',
          name: 'farside-interface.png',
          mimeType: 'image/svg+xml',
          size: svg.length,
          vision: true,
          dataBase64: btoa(svg)
        }],
        approvalQueue: [],
        questionQueue: []
      })
    } else if (shot === 'preview') {
      s.openPreview({
        title: 'release-notes.md',
        path: 'docs/release-notes.md',
        kind: 'markdown',
        content:
          '# 轨道更新\n\n预览舱已经接入当前会话，支持 **Markdown**、HTML、SVG 与纯文本。\n\n- 无需离开工作区\n- HTML 脚本默认禁用\n- 可从文件页或代码块打开\n\n```html\n<section class="signal">Hello, Farside.</section>\n```'
      })
    } else if (shot === 'turns') {
      const current = s.sessions.find((session) => session.id === s.activeSessionId)
      if (current) {
        const now = Date.now()
        const toolNames = ['Read', 'Read', 'Bash', 'Edit', 'Bash', 'FetchURL', 'Bash', 'Edit', 'Bash', 'Bash']
        const next = {
          ...current,
          phase: 'first-quarter' as const,
          events: [
            ...current.events,
            {
              id: 'shot-user-2',
              kind: 'user' as const,
              at: now - 16_000,
              text: '继续检查完成态收纳是否保持紧凑，并运行最后一次界面验收。\n需要保留文字输出与工具调用的原始顺序。\n工具组默认只显示一行摘要。\n展开后最多显示八行。\n单条命令详情也要限制高度。\n本地交付物路径需要可以直接打开。\nShell 代码块需要可以在当前项目目录运行。\n这行用于验证“显示更多”不会让气泡无限增高。'
            },
            {
              id: 'shot-message-before-tools',
              kind: 'message' as const,
              at: now - 15_000,
              markdown: '先核对事件顺序，再集中验证紧凑工具组。'
            },
            {
              id: 'shot-thinking-2',
              kind: 'transmission' as const,
              at: now - 14_000,
              durationMs: 3_420,
              text: '按文字边界聚合中间的工具调用，并为工具列表和详情分别设置滚动上限。'
            },
            {
              id: 'shot-system-2',
              kind: 'system' as const,
              at: now - 13_000,
              label: '能力上下文',
              text: 'Skill tool loaded instructions for this request. Follow them.\n<kimi-skill-loaded name="visual-check">…</kimi-skill-loaded>'
            },
            {
              id: 'shot-thinking-2b',
              kind: 'transmission' as const,
              at: now - 12_800,
              durationMs: 2_180,
              text: '继续核对工具摘要的聚合边界。'
            },
            {
              id: 'shot-thinking-2c',
              kind: 'transmission' as const,
              at: now - 12_600,
              durationMs: 1_360,
              text: '确认多段思考只占据一行摘要。'
            },
            ...toolNames.map((tool, index) => ({
              id: `shot-tool-${index}`,
              kind: 'instrument' as const,
              at: now - 12_000 + index * 500,
              tool,
              argsSummary: tool === 'Edit'
                ? `src/renderer/src/components/trajectory/View${index}.tsx (+8 −2)`
                : tool === 'FetchURL'
                  ? 'https://www.kimi.com/code/docs/en/'
                  : tool === 'Bash'
                    ? `npm run verify:${index}`
                    : `src/renderer/src/components/trajectory/Node${index}.tsx`,
              status: 'done' as const,
              durationMs: 420 + index * 90,
              output: `已完成第 ${index + 1} 项检查。\n${'输出内容用于验证详情区域的固定高度与滚动行为。\n'.repeat(8)}`
            })),
            {
              id: 'shot-message-after-tools',
              kind: 'message' as const,
              at: now - 2_000,
              markdown: '工具组验证完成。交付物：[TrajectoryView.tsx](<D:/Github/kode/src/renderer/src/components/trajectory/TrajectoryView.tsx>)。\n\n```powershell\nnpm run typecheck\n```'
            }
          ]
        }
        useFarsideStore.setState({
          sessions: s.sessions.map((session) => (session.id === current.id ? next : session)),
          approvalQueue: [],
          questionQueue: []
        })
      }
    }
  }, [])

  // 全局快捷键：⌘K 命令面板 / ⌘B 侧栏 / ⌘J Mission Panel
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const state = useFarsideStore.getState()
      if (
        e.key === 'Escape' &&
        state.sending &&
        state.approvalQueue.length === 0 &&
        state.questionQueue.length === 0
      ) {
        e.preventDefault()
        state.abortCurrent()
        return
      }
      const meta = e.metaKey || e.ctrlKey
      if (!meta) return
      const key = e.key.toLowerCase()
      const s = state
      if (key === 'k') {
        e.preventDefault()
        s.setPaletteOpen(!s.paletteOpen)
      } else if (key === 'b') {
        e.preventDefault()
        s.toggleSidebar()
      } else if (key === 'j') {
        e.preventDefault()
        s.toggleMission()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: 'var(--void)',
        color: 'var(--moonlight)',
        overflow: 'hidden'
      }}
    >
      <Titlebar />
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <OrbitRail />
        {sidebarOpen && view === 'sessions' ? <SessionList /> : null}

        <main style={{ flex: 1, display: 'flex', minWidth: 0, minHeight: 0 }}>
          {view === 'terminal' ? <TerminalView /> : null}
          {view === 'goals' ? <GoalsView /> : null}
          {view === 'settings' ? <SettingsView /> : null}
          {view === 'sessions' ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0,
                background: 'var(--void)'
              }}
            >
              {active ? (
                <>
                  <TrajectoryView session={active} />
                  {lastError ? (
                    <div
                      className="mono"
                      style={{
                        margin: '0 20px 8px',
                        padding: '6px 10px',
                        border: '1px solid color-mix(in srgb, var(--redshift) 45%, var(--line))',
                        borderRadius: 6,
                        color: 'var(--redshift)',
                        background: 'var(--regolith)',
                        fontSize: 11.5
                      }}
                    >
                      {t('链路警告')} · {lastError}
                    </div>
                  ) : null}
                  {approvalQueue[0] ? <ApprovalCard request={approvalQueue[0]} /> : null}
                  {questionQueue[0] ? <QuestionCard request={questionQueue[0]} /> : null}
                  <Composer />
                </>
              ) : (
                <EmptyState />
              )}
            </div>
          ) : null}
          {missionOpen && view === 'sessions' ? <MissionPanel /> : null}
        </main>
      </div>

      <CommandPalette />
      <NoiseOverlay />
      <Onboarding />
      {!booted ? <BootSplash onDone={handleBooted} /> : null}
    </div>
  )
}
