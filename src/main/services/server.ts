import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { KIMI_SERVER_PORT, type ServerActionResult, type ServerStatus } from '@shared/ipc'
import { detectCli } from './cli-detect'
import { resolveKimiRuntime, type KimiRuntime } from './kimi-runtime'

const HOST = '127.0.0.1'
const READY_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 350
const PROBE_TIMEOUT_MS = 1_500
const META_MAX_BYTES = 64 * 1024
const REQUIRED_CAPABILITIES = ['websocket', 'file_upload', 'fs_query', 'mcp', 'tasks', 'terminal'] as const

interface KimiServerMeta {
  serverVersion: string
  capabilities: Record<(typeof REQUIRED_CAPABILITIES)[number], true>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredSize = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > META_MAX_BYTES) throw new Error('Kimi Server meta 响应体积异常')
  if (!response.body) throw new Error('Kimi Server meta 响应为空')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > META_MAX_BYTES) {
        await reader.cancel()
        throw new Error('Kimi Server meta 响应体积异常')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8'))
}

/** 读取服务端自报版本与能力，用于阻止误连到同端口上的不兼容实例。 */
export async function readKimiServerMeta(): Promise<KimiServerMeta> {
  const token = await readKimiServerToken()
  if (!token) throw new Error('未找到 Kimi Server token')
  const response = await fetch(`http://${HOST}:${KIMI_SERVER_PORT}/api/v1/meta`, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${token}` }
  })
  const body = await readBoundedJson(response)
  if (!response.ok || !isRecord(body) || body.code !== 0 || !isRecord(body.data)) {
    throw new Error(`Kimi Server meta 不可用（${response.status}）`)
  }
  const serverVersion = body.data.server_version
  const capabilities = body.data.capabilities
  if (typeof serverVersion !== 'string' || serverVersion.length === 0 || serverVersion.length > 128) {
    throw new Error('Kimi Server 未返回有效版本')
  }
  if (!isRecord(capabilities)) throw new Error('Kimi Server 未返回能力清单')
  const missing = REQUIRED_CAPABILITIES.filter((capability) => capabilities[capability] !== true)
  if (missing.length) throw new Error(`Kimi Server 缺少 Farside 所需能力：${missing.join(', ')}`)
  return {
    serverVersion,
    capabilities: capabilities as KimiServerMeta['capabilities']
  }
}

async function assertKimiServerCompatibility(runtime: KimiRuntime): Promise<void> {
  const meta = await readKimiServerMeta()
  if (runtime.manifest && meta.serverVersion !== runtime.manifest.version) {
    throw new Error(`Kimi Server 版本不匹配：随包 runtime 为 ${runtime.manifest.version}，端口实例为 ${meta.serverVersion}`)
  }
}

/**
 * 管理 Kimi Server daemon。`kimi server run` 会自行 daemonize，启动命令退出并不代表
 * 服务退出；状态必须以带鉴权的 healthz 为准，停止则使用官方 `kimi server kill`。
 */
export class ServerService {
  private cliInstalled: boolean | null = null
  private cliError: string | undefined
  private startedByApp = false
  private runtime: Awaited<ReturnType<typeof resolveKimiRuntime>> | null = null
  private startInFlight: Promise<ServerActionResult> | null = null

  private async ensureCli(): Promise<boolean> {
    if (this.cliInstalled !== null) return this.cliInstalled
    const status = await detectCli()
    this.cliInstalled = status.installed
    this.cliError = status.error
    if (status.installed) this.runtime = await resolveKimiRuntime()
    return this.cliInstalled
  }

  async status(): Promise<ServerStatus> {
    const base = { port: KIMI_SERVER_PORT }
    if (await probeKimiServer()) {
      const available = await this.ensureCli()
      if (!available || !this.runtime) {
        return { ...base, available: false, running: true, managedByApp: false, error: this.cliError }
      }
      try {
        await assertKimiServerCompatibility(this.runtime)
      } catch (error) {
        return {
          ...base,
          available: true,
          running: true,
          managedByApp: this.startedByApp,
          error: error instanceof Error ? error.message : 'Kimi Server 兼容性校验失败'
        }
      }
      return {
        ...base,
        available: true,
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
      error: available ? undefined : (this.cliError || 'kimi CLI 未安装，服务链路不可用')
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
      return { ok: false, available: false, error: this.cliError || 'kimi CLI 未安装，无法拉起服务' }
    }
    const runtime = this.runtime ?? await resolveKimiRuntime()
    if (await probeKimiServer()) {
      try {
        await assertKimiServerCompatibility(runtime)
        return { ok: true, available: true }
      } catch (error) {
        return {
          ok: false,
          available: true,
          error: error instanceof Error ? error.message : 'Kimi Server 兼容性校验失败'
        }
      }
    }

    try {
      // 不传 --host/--keep-alive：只绑定 loopback，客户端断开 60s 后 daemon 自动退出。
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
        try {
          await assertKimiServerCompatibility(runtime)
        } catch (error) {
          await runKimi(runtime.command, runtime.bundled, ['server', 'kill'], 8_000).catch(() => {})
          return {
            ok: false,
            available: true,
            error: error instanceof Error ? error.message : 'Kimi Server 兼容性校验失败'
          }
        }
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
