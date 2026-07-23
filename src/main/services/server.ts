import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { KIMI_SERVER_PORT, type ServerActionResult, type ServerStatus } from '@shared/ipc'
import { detectCli } from './cli-detect'
import { resolveKimiRuntime, type KimiRuntime } from './kimi-runtime'
import {
  isFarsideRuntimeEndpoint,
  kimiServerOrigin,
  readKimiServerEndpoint,
  readKimiServerInstances,
  type KimiServerEndpoint
} from './kimi-server-endpoint'

const HOST = '127.0.0.1'
const DEFAULT_ENDPOINT: KimiServerEndpoint = { host: HOST, port: KIMI_SERVER_PORT }
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

function versionAtLeast(version: string, minimum: readonly [number, number, number]): boolean {
  const matched = version.match(/(?:^|\D)(\d+)\.(\d+)\.(\d+)(?:\D|$)/)
  if (!matched) return false
  const actual = matched.slice(1, 4).map(Number)
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index]
  }
  return true
}

async function usesForegroundWeb(runtime: KimiRuntime): Promise<boolean> {
  const version = runtime.manifest?.version
    ?? await runKimi(runtime.command, runtime.bundled, ['--version'], 8_000)
  return versionAtLeast(version, [0, 28, 0])
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

/** healthz 是官方无鉴权探针；真正接入前仍会用 token 校验 meta 与能力。 */
export async function probeKimiServer(endpoint = DEFAULT_ENDPOINT): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(`${kimiServerOrigin(endpoint)}/api/v1/healthz`, {
      signal: controller.signal
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
export async function readKimiServerMeta(endpoint = DEFAULT_ENDPOINT): Promise<KimiServerMeta> {
  const token = await readKimiServerToken()
  if (!token) throw new Error('未找到 Kimi Server token')
  const response = await fetch(`${kimiServerOrigin(endpoint)}/api/v1/meta`, {
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

async function assertKimiServerCompatibility(runtime: KimiRuntime, endpoint: KimiServerEndpoint): Promise<void> {
  const meta = await readKimiServerMeta(endpoint)
  if (runtime.manifest && meta.serverVersion !== runtime.manifest.version) {
    throw new Error(`Kimi Server 版本不匹配：随包 runtime 为 ${runtime.manifest.version}，端口实例为 ${meta.serverVersion}`)
  }
}

async function requestKimiServerShutdown(endpoint: KimiServerEndpoint): Promise<void> {
  const token = await readKimiServerToken()
  if (!token) throw new Error('未找到 Kimi Server token')
  await fetch(`${kimiServerOrigin(endpoint)}/api/v1/shutdown`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(3_000)
  })
}

/**
 * 管理 Kimi Server 生命周期：0.27 使用后台 daemon，0.28+ 持有 `kimi web --no-open`
 * 前台子进程，并通过多实例注册表发现实际端口及精确停止自己启动的实例。
 */
export class ServerService {
  private cliInstalled: boolean | null = null
  private cliError: string | undefined
  private startedByApp = false
  private runtime: Awaited<ReturnType<typeof resolveKimiRuntime>> | null = null
  private startInFlight: Promise<ServerActionResult> | null = null
  private endpoint = DEFAULT_ENDPOINT
  private foregroundChild: ChildProcess | null = null
  private foregroundServerId: string | undefined
  private foregroundError = ''

  private async runningEndpoint(serverId = this.foregroundServerId): Promise<KimiServerEndpoint | null> {
    const locked = await readKimiServerEndpoint(serverId)
    const candidates = [locked, this.endpoint, DEFAULT_ENDPOINT].filter(
      (candidate): candidate is KimiServerEndpoint => candidate !== null
    )
    const seen = new Set<string>()
    for (const candidate of candidates) {
      const origin = kimiServerOrigin(candidate)
      if (seen.has(origin)) continue
      seen.add(origin)
      if (await probeKimiServer(candidate)) return candidate
    }
    return null
  }

  baseUrl(): string {
    return kimiServerOrigin(this.endpoint)
  }

  webSocketUrl(): string {
    return `${this.baseUrl().replace(/^http:/, 'ws:')}/api/v1/ws`
  }

  private async ensureCli(): Promise<boolean> {
    if (this.cliInstalled !== null) return this.cliInstalled
    const status = await detectCli()
    this.cliInstalled = status.installed
    this.cliError = status.error
    if (status.installed) this.runtime = await resolveKimiRuntime()
    return this.cliInstalled
  }

  private startForegroundWeb(runtime: KimiRuntime, existingServerIds: Set<string>): void {
    this.foregroundError = ''
    const child = spawn(runtime.command, ['web', '--no-open', '--port', String(KIMI_SERVER_PORT)], {
      windowsHide: true,
      shell: process.platform === 'win32' && !runtime.bundled,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    })
    this.foregroundChild = child
    const appendOutput = (chunk: Buffer): void => {
      this.foregroundError = `${this.foregroundError}${chunk.toString()}`.slice(-4_096)
    }
    child.stdout?.on('data', appendOutput)
    child.stderr?.on('data', appendOutput)
    child.once('error', (error) => {
      this.foregroundError = error.message
    })

    void (async () => {
      const deadline = Date.now() + READY_TIMEOUT_MS
      while (this.foregroundChild === child && child.exitCode === null && Date.now() < deadline) {
        const instances = await readKimiServerInstances()
        const owned = instances.find((instance) =>
          instance.pid === child.pid || (instance.serverId && !existingServerIds.has(instance.serverId)))
        if (owned?.serverId) {
          this.foregroundServerId = owned.serverId
          return
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      }
    })()
  }

  private async stopManaged(runtime: KimiRuntime): Promise<void> {
    const child = this.foregroundChild
    const serverId = this.foregroundServerId
    if (serverId) {
      await runKimi(runtime.command, runtime.bundled, ['web', 'kill', serverId], 8_000)
    } else if (child && child.exitCode === null) {
      child.kill()
    } else {
      await runKimi(runtime.command, runtime.bundled, ['server', 'kill'], 8_000)
    }
    this.foregroundChild = null
    this.foregroundServerId = undefined
    this.foregroundError = ''
  }

  async status(): Promise<ServerStatus> {
    const running = await this.runningEndpoint()
    const base = { port: running?.port ?? this.endpoint.port }
    if (running) {
      this.endpoint = running
      const available = await this.ensureCli()
      if (!available || !this.runtime) {
        return { ...base, available: false, running: true, managedByApp: false, error: this.cliError }
      }
      try {
        await assertKimiServerCompatibility(this.runtime, running)
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
    const existing = await this.runningEndpoint()
    if (existing) {
      this.endpoint = existing
      try {
        await assertKimiServerCompatibility(runtime, existing)
        return { ok: true, available: true }
      } catch (error) {
        if (!isFarsideRuntimeEndpoint(existing)) {
          return {
            ok: false,
            available: true,
            error: error instanceof Error ? error.message : 'Kimi Server 兼容性校验失败'
          }
        }
        await requestKimiServerShutdown(existing).catch(() => {
          if (existing.pid) {
            try { process.kill(existing.pid, 'SIGTERM') } catch {}
          }
        })
        this.endpoint = DEFAULT_ENDPOINT
      }
    }

    try {
      if (await usesForegroundWeb(runtime)) {
        const existingServerIds = new Set(
          (await readKimiServerInstances())
            .map((instance) => instance.serverId)
            .filter((serverId): serverId is string => Boolean(serverId))
        )
        this.startForegroundWeb(runtime, existingServerIds)
      } else {
        // 0.27 daemon 只绑定 loopback，客户端断开后由上游 idle 策略自动退出。
        await runKimi(runtime.command, runtime.bundled, ['server', 'run', '--port', String(KIMI_SERVER_PORT)])
      }
    } catch (error) {
      return {
        ok: false,
        available: true,
        error: error instanceof Error ? error.message : '服务进程创建失败'
      }
    }

    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      const running = await this.runningEndpoint()
      if (running) {
        this.endpoint = running
        if (running.serverId) this.foregroundServerId = running.serverId
        try {
          await assertKimiServerCompatibility(runtime, running)
        } catch (error) {
          await this.stopManaged(runtime).catch(() => {})
          return {
            ok: false,
            available: true,
            error: error instanceof Error ? error.message : 'Kimi Server 兼容性校验失败'
          }
        }
        this.startedByApp = true
        return { ok: true, available: true }
      }
      if (this.foregroundChild && this.foregroundChild.exitCode !== null) {
        return {
          ok: false,
          available: true,
          error: this.foregroundError.trim() || `Kimi web 提前退出（${this.foregroundChild.exitCode}）`
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
    return {
      ok: false,
      available: true,
      error: 'Kimi 服务未能就绪。请退出其他 Kimi Code/Farside 实例后重试。'
    }
  }

  async stop(): Promise<ServerActionResult> {
    const available = await this.ensureCli()
    if (!available) return { ok: false, available: false, error: 'kimi CLI 未安装' }
    if (!this.startedByApp) {
      return { ok: true, available: true }
    }
    const running = await this.runningEndpoint()
    const foregroundAlive = this.foregroundChild?.exitCode === null
    if (!running && !foregroundAlive) {
      this.startedByApp = false
      this.foregroundChild = null
      this.foregroundServerId = undefined
      return { ok: true, available: true }
    }
    try {
      const runtime = this.runtime ?? await resolveKimiRuntime()
      await this.stopManaged(runtime)
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

  /** App 退出时只清理由本实例启动的服务，不触碰共享 home 下的其他 Kimi Server。 */
  dispose(): void {
    if (!this.startedByApp) return
    try {
      if (!this.foregroundServerId && this.foregroundChild?.exitCode === null) {
        this.foregroundChild.kill()
        this.foregroundChild = null
        this.startedByApp = false
        return
      }
      const runtime = this.runtime
      const args = this.foregroundServerId
        ? ['web', 'kill', this.foregroundServerId]
        : ['server', 'kill']
      const child = spawn(runtime?.command ?? 'kimi', args, {
        windowsHide: true,
        shell: process.platform === 'win32' && !runtime?.bundled,
        stdio: 'ignore',
        env: process.env
      })
      child.unref()
    } catch {
      // 退出清理不阻断 App。
    }
    this.foregroundChild = null
    this.foregroundServerId = undefined
    this.startedByApp = false
  }
}
