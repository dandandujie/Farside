import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { KIMI_SERVER_PORT, type ServerActionResult, type ServerStatus } from '@shared/ipc'
import { detectCli } from './cli-detect'
import { resolveKimiRuntime } from './kimi-runtime'

const HOST = '127.0.0.1'
const READY_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 350
const PROBE_TIMEOUT_MS = 1_500

async function runKimi(command: string, bundled: boolean, args: string[], timeout = READY_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout,
        windowsHide: true,
        shell: process.platform === 'win32' && !bundled,
        maxBuffer: 1024 * 1024,
        env: process.env
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || stdout || error.message).trim()))
          return
        }
        resolve((stdout || stderr).trim())
      }
    )
  })
}

/** Kimi Server 持久 token 只在主进程读取，永不经 IPC 暴露。 */
export async function readKimiServerToken(): Promise<string | null> {
  const candidates = [...new Set([
    process.env['KIMI_CODE_HOME'] ? join(process.env['KIMI_CODE_HOME'], 'server.token') : '',
    join(homedir(), '.kimi-code', 'server.token'),
    join(homedir(), '.kimi', 'server.token')
  ].filter(Boolean))]
  for (const path of candidates) {
    try {
      const token = (await fs.readFile(path, 'utf8')).trim()
      if (token) return token
    } catch {
      // 兼容不同 Kimi Code 数据目录版本。
    }
  }
  return null
}

/** 带鉴权的健康探测；Kimi Server 默认所有 REST 路由都要求 bearer token。 */
export async function probeKimiServer(): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const token = await readKimiServerToken()
    if (!token) return false
    const res = await fetch(`http://${HOST}:${KIMI_SERVER_PORT}/api/v1/healthz`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` }
    })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 管理 Kimi Server daemon。`kimi server run` 会自行 daemonize，启动命令退出并不代表
 * 服务退出；状态必须以带鉴权的 healthz 为准，停止则使用官方 `kimi server kill`。
 */
export class ServerService {
  private cliInstalled: boolean | null = null
  private startedByApp = false
  private runtime: Awaited<ReturnType<typeof resolveKimiRuntime>> | null = null
  private startInFlight: Promise<ServerActionResult> | null = null

  private async ensureCli(): Promise<boolean> {
    if (this.cliInstalled !== null) return this.cliInstalled
    this.runtime = await resolveKimiRuntime()
    const status = await detectCli()
    this.cliInstalled = status.installed
    return this.cliInstalled
  }

  async status(): Promise<ServerStatus> {
    const base = { port: KIMI_SERVER_PORT }
    if (await probeKimiServer()) {
      return {
        ...base,
        available: await this.ensureCli(),
        running: true,
        managedByApp: this.startedByApp
      }
    }
    const available = await this.ensureCli()
    return {
      ...base,
      available,
      running: false,
      managedByApp: false,
      error: available ? undefined : 'kimi CLI 未安装，服务链路不可用'
    }
  }

  async start(): Promise<ServerActionResult> {
    if (this.startInFlight) return this.startInFlight
    const operation = this.startOnce()
    this.startInFlight = operation
    try {
      return await operation
    } finally {
      if (this.startInFlight === operation) this.startInFlight = null
    }
  }

  private async startOnce(): Promise<ServerActionResult> {
    if (!(await this.ensureCli())) {
      return { ok: false, available: false, error: 'kimi CLI 未安装，无法拉起服务' }
    }
    if (await probeKimiServer()) return { ok: true, available: true }

    try {
      // 不传 --host/--keep-alive：只绑定 loopback，客户端断开 60s 后 daemon 自动退出。
      const runtime = this.runtime ?? await resolveKimiRuntime()
      await runKimi(runtime.command, runtime.bundled, ['server', 'run', '--port', String(KIMI_SERVER_PORT)])
    } catch (error) {
      return {
        ok: false,
        available: true,
        error: error instanceof Error ? error.message : '服务进程创建失败'
      }
    }

    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await probeKimiServer()) {
        this.startedByApp = true
        return { ok: true, available: true }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
    return { ok: false, available: true, error: '服务就绪超时（15s）' }
  }

  async stop(): Promise<ServerActionResult> {
    const available = await this.ensureCli()
    if (!available) return { ok: false, available: false, error: 'kimi CLI 未安装' }
    if (!(await probeKimiServer())) {
      this.startedByApp = false
      return { ok: true, available: true }
    }
    try {
      const runtime = this.runtime ?? await resolveKimiRuntime()
      await runKimi(runtime.command, runtime.bundled, ['server', 'kill'], 8_000)
      this.startedByApp = false
      return { ok: true, available: true }
    } catch (error) {
      return {
        ok: false,
        available: true,
        error: error instanceof Error ? error.message : '服务停止失败'
      }
    }
  }

  /** App 退出时断开事件桥后 daemon 会自动回收；这里只做兜底，不阻塞退出。 */
  dispose(): void {
    if (!this.startedByApp) return
    try {
      const runtime = this.runtime
      const child = spawn(runtime?.command ?? 'kimi', ['server', 'kill'], {
        windowsHide: true,
        shell: process.platform === 'win32' && !runtime?.bundled,
        stdio: 'ignore',
        env: process.env
      })
      child.unref()
    } catch {
      // 退出清理不阻断 App。
    }
    this.startedByApp = false
  }
}
