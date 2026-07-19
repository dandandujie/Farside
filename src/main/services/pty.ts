import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { WebContents } from 'electron'
import { IPC, type PtyBackend, type PtyCreateResult, type PtyDataPayload } from '@shared/ipc'

/**
 * node-pty 的最小类型面。node-pty 是可选原生依赖（未装进 package.json），
 * 运行时动态 import，装不上就走 pipe 降级——这里只声明我们用到的几个方法。
 */
interface NodePty {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: { name?: string; cwd?: string; env?: Record<string, string>; cols?: number; rows?: number }
  ): NodePty
}

/** 统一的终端句柄：node-pty 与管道子进程都收敛成这三个动作 */
interface PtyHandle {
  ownerId: number
  backend: PtyBackend
  shell: string
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const MAX_PTY_INPUT_CHARS = 1024 * 1024
/** 进程退出时写进终端的一行提示（等宽、暗色，由 xterm 直接渲染） */
const EXIT_NOTICE = (code: number | null): string =>
  `\r\n\x1b[2m链路关闭 · 进程已退出${code === null ? '' : `（code ${code}）`}\x1b[0m\r\n`

/** 按平台挑 shell：Windows 优先 Git Bash，缺失退 powershell；macOS 用 zsh */
function pickShell(): string {
  if (process.platform === 'win32') {
    return existsSync(GIT_BASH) ? GIT_BASH : 'powershell.exe'
  }
  if (process.platform === 'darwin') return '/bin/zsh'
  return process.env['SHELL'] || '/bin/bash'
}

/** 管道模式下给 shell 一个交互态提示符（powershell 不需要参数） */
function shellArgs(shell: string): string[] {
  return /ba?sh(\.exe)?$/i.test(shell) ? ['-i'] : []
}

/**
 * PTY 服务：每个终端一个 id，数据经 pty:data 事件按 id 路由回渲染端。
 * 任何一步失败都降级或返回 ok:false，绝不把异常抛给 IPC 层。
 */
export class PtyService {
  private handles = new Map<string, PtyHandle>()
  private watchedOwners = new Set<number>()
  /** node-pty 只尝试加载一次，结果（含失败）缓存 */
  private nodePty: NodePtyModule | null | undefined

  private async loadNodePty(): Promise<NodePtyModule | null> {
    if (this.nodePty !== undefined) return this.nodePty
    // specifier 必须是 string 类型而非字面量：否则 tsc/rollup 会静态解析这个未安装的可选依赖
    const specifier: string = 'node-pty'
    try {
      this.nodePty = (await import(specifier)) as NodePtyModule
    } catch {
      this.nodePty = null
    }
    return this.nodePty
  }

  async create(sender: WebContents, cwd?: string): Promise<PtyCreateResult> {
    const id = `pty-${randomUUID()}`
    const shell = pickShell()
    let workDir = homedir()
    if (typeof cwd === 'string' && cwd.length <= 4_096 && existsSync(cwd)) {
      try {
        if (statSync(cwd).isDirectory()) workDir = cwd
      } catch {
        // 目录在检查期间消失时使用家目录。
      }
    }
    if (!this.watchedOwners.has(sender.id)) {
      this.watchedOwners.add(sender.id)
      sender.once('destroyed', () => {
        this.disposeOwner(sender.id)
        this.watchedOwners.delete(sender.id)
      })
    }
    let exited = false
    const send = (data: string): void => {
      if (!sender.isDestroyed()) {
        sender.send(IPC.PtyData, { id, data } satisfies PtyDataPayload)
      }
    }
    const onExit = (code: number | null): void => {
      if (exited) return
      exited = true
      this.handles.delete(id)
      send(EXIT_NOTICE(code))
    }

    const nodePty = await this.loadNodePty()
    if (nodePty) {
      try {
        const pty = nodePty.spawn(shell, shellArgs(shell), {
          name: 'xterm-256color',
          cwd: workDir,
          env: process.env as Record<string, string>,
          cols: 80,
          rows: 24
        })
        pty.onData(send)
        pty.onExit((e) => onExit(e.exitCode))
        this.handles.set(id, {
          ownerId: sender.id,
          backend: 'node-pty',
          shell,
          write: (data) => pty.write(data),
          resize: (cols, rows) => pty.resize(cols, rows),
          kill: () => pty.kill()
        })
        return { ok: true, id, backend: 'node-pty', shell }
      } catch {
        // node-pty 加载成功但 spawn 失败：继续走管道降级
      }
    }

    // ── 降级：匿名管道子进程，stdout/stdin 直连 xterm，无 resize 能力 ──
    let child: ChildProcess
    try {
      child = spawn(shell, shellArgs(shell), {
        cwd: workDir,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '终端进程创建失败' }
    }
    child.once('error', () => onExit(null))
    child.once('exit', (code) => onExit(code))
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (data: string) => send(data))
    child.stderr?.on('data', (data: string) => send(data))
    this.handles.set(id, {
      ownerId: sender.id,
      backend: 'pipe',
      shell,
      write: (data) => {
        try {
          child.stdin?.write(data)
        } catch {
          // 进程已退出、管道已断：丢弃本次输入
        }
      },
      // 管道没有窗口尺寸概念，resize 为空操作
      resize: () => undefined,
      kill: () => child.kill()
    })
    return { ok: true, id, backend: 'pipe', shell }
  }

  private ownedHandle(sender: WebContents, id: unknown): PtyHandle | undefined {
    if (typeof id !== 'string') return undefined
    const handle = this.handles.get(id)
    return handle?.ownerId === sender.id ? handle : undefined
  }

  write(sender: WebContents, id: string, data: string): void {
    if (typeof data !== 'string' || data.length > MAX_PTY_INPUT_CHARS) return
    this.ownedHandle(sender, id)?.write(data)
  }

  resize(sender: WebContents, id: string, cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
    try {
      this.ownedHandle(sender, id)?.resize(
        Math.max(1, Math.min(1_000, Math.trunc(cols))),
        Math.max(1, Math.min(500, Math.trunc(rows)))
      )
    } catch {
      // 尺寸竞争（进程刚好退出）：忽略
    }
  }

  kill(sender: WebContents, id: string): void {
    const handle = this.ownedHandle(sender, id)
    if (!handle) return
    this.killHandle(id)
  }

  /** App 退出前清场，不留孤儿 shell 进程 */
  disposeAll(): void {
    for (const id of [...this.handles.keys()]) this.killHandle(id)
    this.watchedOwners.clear()
  }

  private disposeOwner(ownerId: number): void {
    for (const [id, handle] of this.handles) {
      if (handle.ownerId === ownerId) this.killHandle(id)
    }
  }

  private killHandle(id: string): void {
    const handle = this.handles.get(id)
    this.handles.delete(id)
    try {
      handle?.kill()
    } catch {
      // 已经退出：无需处理
    }
  }
}
