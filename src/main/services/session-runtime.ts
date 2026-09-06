import type { SubagentRuntime } from './wire-events'

export interface SessionThinking {
  id: string
  startedAt: number
}

/**
 * 单个会话在主进程内的运行态：思考流、在途工具调用、子代理、
 * 完成核对定时器与运行标记。原来分散在 7 个平级 Map/Set 里，
 * 收敛后生命周期清晰（建/查/空闲回收/全量清理都在一处）。
 */
export interface SessionRuntime {
  thinking: SessionThinking | null
  activeToolCalls: Set<string>
  subagents: Map<string, SubagentRuntime>
  settleTimer: NodeJS.Timeout | null
  /** 对应原 activeRuns：是否仍有一轮在运行（窗口关闭守卫依赖它）。 */
  runActive: boolean
  /** 对应原 failedRuns：上一轮是否失败，保持到下一次提交前。 */
  runFailed: boolean
}

function emptyRuntime(): SessionRuntime {
  return {
    thinking: null,
    activeToolCalls: new Set(),
    subagents: new Map(),
    settleTimer: null,
    runActive: false,
    runFailed: false
  }
}

function isIdle(runtime: SessionRuntime): boolean {
  return (
    !runtime.thinking &&
    runtime.activeToolCalls.size === 0 &&
    runtime.subagents.size === 0 &&
    runtime.settleTimer === null &&
    !runtime.runActive &&
    // runFailed 要保持到下一次提交，提前回收会让后续 prompt.completed 误报“已完成”。
    !runtime.runFailed
  )
}

/** 所有会话运行态的唯一容器；条目在完全空闲后回收，避免随会话数累积。 */
export class SessionRuntimeStore {
  private bySession = new Map<string, SessionRuntime>()

  get(sessionId: string): SessionRuntime | undefined {
    return this.bySession.get(sessionId)
  }

  ensure(sessionId: string): SessionRuntime {
    let runtime = this.bySession.get(sessionId)
    if (!runtime) {
      runtime = emptyRuntime()
      this.bySession.set(sessionId, runtime)
    }
    return runtime
  }

  /** 条目完全空闲时回收；runFailed 未被下一次提交清除前不算空闲。 */
  dropIfIdle(sessionId: string): void {
    const runtime = this.bySession.get(sessionId)
    if (runtime && isIdle(runtime)) this.bySession.delete(sessionId)
  }

  isActive(sessionId: string): boolean {
    return this.bySession.get(sessionId)?.runActive === true
  }

  anyActiveRun(): boolean {
    for (const runtime of this.bySession.values()) {
      if (runtime.runActive) return true
    }
    return false
  }

  disposeAll(): void {
    for (const runtime of this.bySession.values()) {
      if (runtime.settleTimer) clearTimeout(runtime.settleTimer)
    }
    this.bySession.clear()
  }
}
