import type { ModelId, PermissionMode } from '@shared/types'

/**
 * 斜杠命令注册表的工厂层，自 store.ts 抽出：新增命令加一个 handler 即可。
 * SlashStateView 是 store 相关字段的"松散结构视图"（字段类型只收窄到 handler
 * 实际用到的程度），factory 不 import store 本体，node:test 可以用假 store
 * 直接驱动；与 composer 的 SLASH_COMMANDS 补全清单保持同名
 * （tests/slash-handlers.test.ts 守护两侧一致）。
 */

export type SlashOutcome =
  | { action: 'handled' }
  /** 条件不满足（如会话级命令但无活动会话）：按原文继续作为提示词上送。 */
  | { action: 'pass' }
  /** 命令改写为提示词继续上送（如 /goal <目标>）。 */
  | { action: 'prompt'; text: string; goalObjective?: string }

export interface SlashStateView {
  activeSessionId: string | null
  swarmMode: boolean
  model: ModelId
  account: { models: { id: string }[] } | null
  sessions: { id: string; phase: string }[]
  promptQueues: Record<string, { id: string }[]>
  view: string
  sidebarOpen: boolean
  paletteOpen: boolean
  missionOpen: boolean
  missionTab: string
  lastError: string | null
  setDraft(text: string): void
  newSession(): void
  togglePlanMode(): void
  setSwarmMode(enabled: boolean): void
  setPermissionMode(mode: PermissionMode): void
  setModel(model: ModelId): void
  logoutAccount(): void | Promise<void>
  openSettings(section: string, tab?: string): void
  forkSession(id: string): void
  exportSession(id: string): void
  renameSession(id: string, title: string): void
  setActiveSession(id: string): void
  undoLastTurn(): void
  pauseGoal(): void
  resumeGoal(): void
  cancelGoal(): void
}

export interface SlashStoreApi {
  getState(): SlashStateView
  setState(partial: Partial<SlashStateView> | ((state: SlashStateView) => Partial<SlashStateView>)): void
}

export interface SlashEnv {
  activeSessionId: string | null
}

export type SlashHandler = (arg: string, env: SlashEnv) => SlashOutcome

export function createSlashHandlers(store: SlashStoreApi): Record<string, SlashHandler> {
  const handled = (): SlashOutcome => ({ action: 'handled' })
  const clearDraft = (): void => {
    store.getState().setDraft('')
  }

  const handlers: Record<string, SlashHandler> = {
    new: () => {
      clearDraft()
      store.getState().newSession()
      return handled()
    },
    settings: () => {
      clearDraft()
      store.setState({ view: 'settings' })
      return handled()
    },
    sessions: () => {
      clearDraft()
      store.setState({ view: 'sessions', sidebarOpen: true })
      return handled()
    },
    plan: () => {
      clearDraft()
      store.getState().togglePlanMode()
      return handled()
    },
    swarm: (arg) => {
      const enabled = arg === 'on' ? true : arg === 'off' ? false : !store.getState().swarmMode
      clearDraft()
      store.getState().setSwarmMode(enabled)
      return handled()
    },
    auto: () => {
      clearDraft()
      store.getState().setPermissionMode('auto')
      return handled()
    },
    yolo: () => {
      clearDraft()
      store.getState().setPermissionMode('yolo')
      return handled()
    },
    permission: (arg) => {
      if (!['manual', 'auto', 'yolo'].includes(arg)) return { action: 'pass' }
      clearDraft()
      store.getState().setPermissionMode(arg as PermissionMode)
      return handled()
    },
    model: (arg) => {
      const picked =
        arg === 'k3' || arg === 'kimi-k3'
          ? 'kimi-k3'
          : arg.includes('highspeed')
            ? 'kimi-for-coding-highspeed'
            : arg as ModelId || null
      if (!picked) return handled()
      // 校验模型 ID 确实在当前账户可用列表中，避免任意字符串静默生效。
      const known = store.getState().account?.models ?? []
      if (known.length > 0 && !known.some((item) => item.id === picked)) {
        clearDraft()
        store.setState({ lastError: `未知模型「${picked}」。可用模型：${known.map((item) => item.id).join('、')}` })
        return handled()
      }
      clearDraft()
      store.getState().setModel(picked)
      return handled()
    },
    exit: () => {
      clearDraft()
      const state = store.getState()
      const busy = state.sessions.some(
        (session) => session.phase !== 'new' || state.promptQueues[session.id]?.length
      )
      if (busy && !window.confirm('仍有会话在运行或排队中，退出会中断任务。确定关闭 Farside？')) return handled()
      void window.api?.window.close()
      return handled()
    },
    help: () => {
      clearDraft()
      store.setState({ paletteOpen: true })
      return handled()
    },
    status: () => {
      clearDraft()
      store.setState({ missionOpen: true, missionTab: 'telemetry' })
      return handled()
    },
    mcp: () => {
      clearDraft()
      store.getState().openSettings('extensions')
      return handled()
    },
    plugins: () => {
      clearDraft()
      store.getState().openSettings('extensions')
      return handled()
    },
    'mcp-config': () => {
      clearDraft()
      store.getState().openSettings('configuration')
      return handled()
    },
    login: () => {
      // 桌面端登录与 Provider 切换集中在设置的账户页完成。
      clearDraft()
      store.getState().openSettings('account')
      return handled()
    },
    logout: () => {
      clearDraft()
      void store.getState().logoutAccount()
      return handled()
    },
    theme: () => {
      clearDraft()
      window.dispatchEvent(new CustomEvent('farside:toggle-theme'))
      return handled()
    },
    fork: (_arg, env) => {
      if (!env.activeSessionId) return { action: 'pass' }
      clearDraft()
      store.getState().forkSession(env.activeSessionId)
      return handled()
    },
    'export-md': (_arg, env) => {
      if (!env.activeSessionId) return { action: 'pass' }
      clearDraft()
      store.getState().exportSession(env.activeSessionId)
      return handled()
    },
    title: (arg, env) => {
      if (!env.activeSessionId || !arg) return { action: 'pass' }
      clearDraft()
      store.getState().renameSession(env.activeSessionId, arg)
      return handled()
    },
    reload: (_arg, env) => {
      if (!env.activeSessionId) return { action: 'pass' }
      clearDraft()
      store.getState().setActiveSession(env.activeSessionId)
      return handled()
    },
    undo: (_arg, env) => {
      if (!env.activeSessionId) return { action: 'pass' }
      clearDraft()
      store.getState().undoLastTurn()
      return handled()
    },
    compact: (arg, env) => {
      if (!env.activeSessionId) return { action: 'pass' }
      clearDraft()
      const sessionId = env.activeSessionId
      void window.api?.agent
        .runSessionAction({
          sessionId,
          action: 'compact',
          instruction: arg || undefined
        })
        .then((result) => {
          if (!result.ok) store.setState({ lastError: result.error ?? '/compact 执行失败' })
        })
      return handled()
    },
    goal: (arg) => {
      if (arg === 'pause') {
        clearDraft()
        store.getState().pauseGoal()
        return handled()
      }
      if (arg === 'resume') {
        clearDraft()
        store.getState().resumeGoal()
        return handled()
      }
      if (arg === 'cancel') {
        clearDraft()
        store.getState().cancelGoal()
        return handled()
      }
      if (!arg) {
        clearDraft()
        store.setState({ view: 'goals' })
        return handled()
      }
      return { action: 'prompt', text: arg, goalObjective: arg }
    }
  }
  // 同义命令复用同一 handler。
  handlers.usage = handlers.status
  handlers['update-config'] = handlers['mcp-config']
  handlers.provider = handlers.login
  handlers.export = handlers['export-md']
  return handlers
}
