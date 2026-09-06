import { useCallback, useEffect, useRef } from 'react'
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
import { PlanReviewCard } from './components/approval/PlanReviewCard'
import { CommandPalette } from './components/palette/CommandPalette'
import { TerminalView } from './components/terminal/TerminalView'
import { GoalsView } from './components/goals/GoalsView'
import { SettingsView } from './components/settings/SettingsView'
import { NoiseOverlay } from './design-system/NoiseOverlay'
import { Onboarding } from './components/shell/Onboarding'
import { UpdatePrompt } from './components/shell/UpdatePrompt'
import { UndoSelector } from './components/trajectory/UndoSelector'
import { usePreferences } from './lib/preferences'
import { applyShotScenario } from './lib/devShots'

export default function App() {
  const { t } = usePreferences()
  const booted = useFarsideStore((s) => s.booted)
  const setBooted = useFarsideStore((s) => s.setBooted)
  const initialize = useFarsideStore((s) => s.initialize)
  const view = useFarsideStore((s) => s.view)
  const sidebarOpen = useFarsideStore((s) => s.sidebarOpen)
  const missionOpen = useFarsideStore((s) => s.missionOpen)
  const terminalOpen = useFarsideStore((s) => s.terminalOpen)
  const terminalMounted = useFarsideStore((s) => s.terminalMounted)
  const activeApproval = useFarsideStore((s) =>
    s.approvalQueue.find((item) => item.sessionId === s.activeSessionId)
  )
  const activeQuestion = useFarsideStore((s) =>
    s.questionQueue.find((item) => item.sessionId === s.activeSessionId)
  )
  const lastError = useFarsideStore((s) => s.lastError)
  const activeSessionError = useFarsideStore((s) =>
    s.activeSessionId ? s.sessionErrors[s.activeSessionId] : undefined
  )
  const retrySessionError = useFarsideStore((s) => s.retrySessionError)
  const clearSessionError = useFarsideStore((s) => s.clearSessionError)
  const sending = useFarsideStore((s) => s.sending)
  const active = useActiveSession()
  const lastEscapeAt = useRef(0)

  const handleBooted = useCallback(() => setBooted(), [setBooted])

  useEffect(() => {
    void initialize()
  }, [initialize])

  useEffect(() => {
    const plan = activeApproval?.planReview
    if (!plan) return
    useFarsideStore.getState().openPreview({
      title: plan.path?.split(/[\\/]/).pop() || (t('计划') === '计划' ? '执行计划' : 'Execution plan'),
      path: plan.path,
      kind: 'markdown',
      content: plan.plan
    })
  }, [activeApproval?.id, activeApproval?.planReview, t])

  // dev-only 截图钩子：按场景初始化界面状态（scripts/screenshot.mjs 离屏走查用）。
  // 仅在 URL 带参时生效，场景夹具集中在 lib/devShots.ts。
  useEffect(() => {
    const shot = new URLSearchParams(window.location.search).get('shot')
    if (shot) applyShotScenario(shot)
  }, [])

  // 全局快捷键：⌘K 命令面板 / ⌘B 侧栏 / ⌘J Mission Panel
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const state = useFarsideStore.getState()
      if (e.key === 'Escape' && state.sending) {
        const onField =
          e.target instanceof HTMLInputElement ||
          e.target instanceof HTMLTextAreaElement ||
          (e.target instanceof HTMLElement && e.target.isContentEditable)
        // 输入框和浮层里的 Escape 属于本地交互（关闭补全/面板），
        // 不应顺带中断正在运行的 Agent 任务。
        if (onField || state.paletteOpen || state.undoSelectorOpen) return
        if (state.approvalQueue.length === 0 && state.questionQueue.length === 0) {
          e.preventDefault()
          state.abortCurrent()
          return
        }
      }
      if (
        e.key === 'Escape' &&
        !state.undoSelectorOpen &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement) &&
        !(e.target instanceof HTMLElement && e.target.isContentEditable) &&
        state.view === 'sessions' &&
        state.activeSessionId &&
        state.sessions.find((session) => session.id === state.activeSessionId)?.phase === 'new' &&
        state.approvalQueue.length === 0 &&
        state.questionQueue.length === 0
      ) {
        const now = performance.now()
        if (now - lastEscapeAt.current <= 500) {
          e.preventDefault()
          lastEscapeAt.current = 0
          state.setUndoSelectorOpen(true)
          return
        }
        lastEscapeAt.current = now
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
          {view === 'goals' ? <GoalsView /> : null}
          {view === 'settings' ? <SettingsView /> : null}
          {view === 'sessions' ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0,
                minHeight: 0,
                overflow: 'hidden',
                background: 'var(--void)'
              }}
            >
              {active ? (
                <>
                  <TrajectoryView session={active} />
                  {activeSessionError ? (
                    <div
                      className="mono"
                      style={{
                        margin: '0 20px 8px',
                        padding: '6px 10px',
                        border: '1px solid color-mix(in srgb, var(--redshift) 45%, var(--line))',
                        borderRadius: 6,
                        color: 'var(--redshift)',
                        background: 'var(--regolith)',
                        fontSize: 11.5,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12
                      }}
                    >
                      <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}>
                        {t('链路警告')} · {activeSessionError.message}
                      </span>
                      {activeSessionError.kind !== 'session' ? (
                        <button
                          type="button"
                          onClick={() => active && retrySessionError(active.id)}
                          style={{ flexShrink: 0, color: 'var(--moonlight)', border: '1px solid var(--line-hi)', borderRadius: 5, padding: '2px 9px', fontSize: 11 }}
                        >
                          {t('重试')}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => active && clearSessionError(active.id)}
                        style={{ flexShrink: 0, color: 'var(--dust)', border: '1px solid var(--line)', borderRadius: 5, padding: '2px 9px', fontSize: 11 }}
                      >
                        {t('知道了')}
                      </button>
                    </div>
                  ) : lastError ? (
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
                  {activeApproval?.planReview
                    ? <PlanReviewCard request={activeApproval} />
                    : activeApproval
                      ? <ApprovalCard request={activeApproval} />
                      : null}
                  {activeQuestion ? <QuestionCard request={activeQuestion} /> : null}
                  <Composer />
                  {terminalMounted ? (
                    <div
                      className={terminalOpen ? 'terminal-drawer' : undefined}
                      aria-hidden={!terminalOpen}
                      style={{
                        height: terminalOpen ? 'clamp(220px, 34vh, 360px)' : 0,
                        flexShrink: 0,
                        display: 'flex',
                        minHeight: 0,
                        overflow: 'hidden',
                        visibility: terminalOpen ? 'visible' : 'hidden',
                        pointerEvents: terminalOpen ? 'auto' : 'none',
                        borderTop: terminalOpen ? '1px solid var(--line-hi)' : 0,
                        boxShadow: terminalOpen ? '0 -14px 36px rgba(0, 0, 0, .2)' : 'none'
                      }}
                    >
                      <TerminalView />
                    </div>
                  ) : null}
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
      <UndoSelector />
      <NoiseOverlay />
      <Onboarding />
      <UpdatePrompt enabled={booted} visible={!sending} />
      {!booted ? <BootSplash onDone={handleBooted} /> : null}
    </div>
  )
}
