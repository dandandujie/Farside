import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type {
  ConnectionResult,
  ConnectionSnapshot,
  ConnectionStatus,
  SshConnectionProfile,
  SshConnectionSaveInput
} from '@shared/ipc'
import { KIMI_SERVER_PORT } from '@shared/ipc'
import { probeKimiServer, versionAtLeast, type ServerService } from './server'

const ROOT = process.env['KIMI_CODE_HOME'] || join(homedir(), '.kimi-code')
const CONNECTIONS_PATH = join(ROOT, 'farside-connections.json')
const MAX_OUTPUT_BYTES = 128 * 1024

interface StoredConnections {
  version: 1
  profiles: SshConnectionProfile[]
}

function execFileText(command: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      timeout,
      windowsHide: true,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: process.env
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()))
        return
      }
      resolve((stdout || stderr).trim())
    })
  })
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  try {
    await fs.rename(temporary, path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM') throw error
    await fs.copyFile(temporary, path)
    await fs.unlink(temporary).catch(() => undefined)
  }
  await fs.chmod(path, 0o600).catch(() => undefined)
}

function boundedPort(value: unknown, fallback: number): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return fallback
  return port
}

async function normalizeProfile(input: SshConnectionSaveInput, existingId?: string): Promise<SshConnectionProfile> {
  const id = (existingId || input.id || randomUUID()).trim()
  const name = input.name?.trim()
  const host = input.host?.trim()
  const user = input.user?.trim()
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) throw new Error('连接 ID 格式无效')
  if (!name || name.length > 120) throw new Error('连接名称不能为空且不能超过 120 个字符')
  if (!host || host.startsWith('-') || !/^[a-z0-9][a-z0-9._:-]{0,252}$/i.test(host)) {
    throw new Error('SSH 主机名或 IP 地址无效')
  }
  if (!user || user.startsWith('-') || !/^[a-z_][a-z0-9._-]{0,63}$/i.test(user)) {
    throw new Error('SSH 用户名无效')
  }
  const identityFile = input.identityFile?.trim()
  if (identityFile) {
    if (!isAbsolute(identityFile) || identityFile.length > 4_096) throw new Error('私钥必须使用绝对路径')
    const stat = await fs.stat(identityFile).catch(() => null)
    if (!stat?.isFile()) throw new Error('私钥文件不存在')
  }
  const remoteKimiPath = input.remoteKimiPath?.trim() || 'kimi'
  if (!/^[a-z0-9_./~-]{1,512}$/i.test(remoteKimiPath) || remoteKimiPath.startsWith('-')) {
    throw new Error('远程 Kimi 命令路径无效')
  }
  const remoteKimiHome = input.remoteKimiHome?.trim() || '~/.kimi-code'
  if (!/^(?:~|\/)[a-z0-9_./-]{1,1024}$/i.test(remoteKimiHome) || remoteKimiHome.includes('..')) {
    throw new Error('远程 Kimi 数据目录无效')
  }
  return {
    id,
    name,
    host,
    port: boundedPort(input.port, 22),
    user,
    ...(identityFile ? { identityFile } : {}),
    remoteKimiPath,
    remoteKimiHome,
    remoteServerPort: boundedPort(input.remoteServerPort, KIMI_SERVER_PORT)
  }
}

function sshBaseArgs(profile: SshConnectionProfile): string[] {
  return [
    '-p', String(profile.port),
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    ...(profile.identityFile ? ['-i', profile.identityFile] : [])
  ]
}

function remoteQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function remotePath(value: string): string {
  return value.startsWith('~/') ? `"$HOME/${value.slice(2)}"` : remoteQuote(value)
}

function sshTarget(profile: SshConnectionProfile): string {
  return `${profile.user}@${profile.host}`
}

async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

export class ConnectionService {
  private tunnel: ChildProcess | null = null
  /** 0.28+ 远端前台 `kimi web --no-open` 的 ssh 载体；断开时随会话精确回收。 */
  private remoteServer: ChildProcess | null = null
  private status: ConnectionStatus = { state: 'idle' }

  constructor(
    private readonly server: ServerService,
    private readonly onBackendChanged: () => Promise<void>
  ) {}

  private async sshAvailable(): Promise<boolean> {
    return execFileText('ssh', ['-V'], 5_000).then(() => true).catch(() => false)
  }

  private async readProfiles(): Promise<SshConnectionProfile[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(CONNECTIONS_PATH, 'utf8')) as StoredConnections
      if (parsed.version !== 1 || !Array.isArray(parsed.profiles)) throw new Error('连接配置格式无效')
      const profiles: SshConnectionProfile[] = []
      for (const item of parsed.profiles) profiles.push(await normalizeProfile(item, item.id))
      return profiles
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async snapshot(): Promise<ConnectionSnapshot> {
    const [sshAvailable, profiles] = await Promise.all([this.sshAvailable(), this.readProfiles()])
    return { sshAvailable, profiles, status: this.status }
  }

  async get(): Promise<ConnectionResult> {
    try {
      return { ok: true, snapshot: await this.snapshot() }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '连接配置读取失败' }
    }
  }

  async save(input: SshConnectionSaveInput): Promise<ConnectionResult> {
    try {
      if (!input || typeof input !== 'object') throw new Error('连接配置无效')
      const profiles = await this.readProfiles()
      const index = input.id ? profiles.findIndex((item) => item.id === input.id) : -1
      const profile = await normalizeProfile(input, index >= 0 ? profiles[index].id : undefined)
      if (index >= 0) profiles[index] = profile
      else profiles.push(profile)
      await writeAtomic(CONNECTIONS_PATH, { version: 1, profiles } satisfies StoredConnections)
      return { ok: true, snapshot: await this.snapshot() }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '连接保存失败' }
    }
  }

  async remove(id: string): Promise<ConnectionResult> {
    try {
      if (this.status.activeProfileId === id) throw new Error('请先断开当前远程控制连接')
      const profiles = await this.readProfiles()
      const next = profiles.filter((item) => item.id !== id)
      if (next.length === profiles.length) throw new Error('连接不存在')
      await writeAtomic(CONNECTIONS_PATH, { version: 1, profiles: next } satisfies StoredConnections)
      return { ok: true, snapshot: await this.snapshot() }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '连接移除失败' }
    }
  }

  private async profile(id: string): Promise<SshConnectionProfile> {
    const profile = (await this.readProfiles()).find((item) => item.id === id)
    if (!profile) throw new Error('连接不存在')
    return profile
  }

  private async runRemote(profile: SshConnectionProfile, command: string, timeout = 15_000): Promise<string> {
    return execFileText('ssh', [...sshBaseArgs(profile), sshTarget(profile), command], timeout)
  }

  /**
   * 0.28 起上游移除了 `kimi server` 命令树，远端同样改用前台
   * `kimi web --no-open`。版本探测失败时按新生命周期处理：
   * Farside 唯一 Runtime 基线（0.39）只有前台模式。
   */
  private async remoteUsesForegroundWeb(profile: SshConnectionProfile): Promise<boolean> {
    const version = await this.runRemote(
      profile,
      `${remotePath(profile.remoteKimiPath)} --version`,
      10_000
    ).catch(() => '')
    return version === '' ? true : versionAtLeast(version, [0, 28, 0])
  }

  /** 只回收本服务启动的远端前台进程；关掉 ssh 载体，远端随 SIGHUP 退出。 */
  private stopRemoteServer(): void {
    const child = this.remoteServer
    this.remoteServer = null
    if (child && child.exitCode === null) child.kill()
  }

  async test(id: string): Promise<ConnectionResult> {
    try {
      const profile = await this.profile(id)
      const output = await this.runRemote(profile, 'printf FARSIDE_SSH_OK')
      if (output !== 'FARSIDE_SSH_OK') throw new Error('远端没有返回预期握手')
      this.status = this.status.state === 'connected' ? this.status : { state: 'idle' }
      return { ok: true, snapshot: await this.snapshot() }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'SSH 测试失败',
        snapshot: await this.snapshot().catch(() => undefined)
      }
    }
  }

  async connect(id: string): Promise<ConnectionResult> {
    if (this.tunnel) return { ok: false, error: '已有远程控制连接，请先断开', snapshot: await this.snapshot() }
    let profile: SshConnectionProfile | null = null
    let backendActivated = false
    this.status = { state: 'connecting', activeProfileId: id }
    try {
      profile = await this.profile(id)
      const foreground = await this.remoteUsesForegroundWeb(profile)
      const startCommand = foreground
        ? `${remotePath(profile.remoteKimiPath)} web --no-open --port ${profile.remoteServerPort}`
        : `${remotePath(profile.remoteKimiPath)} server run --port ${profile.remoteServerPort}`
      let remoteServerError = ''
      let serverChild: ChildProcess | null = null
      if (foreground) {
        // 0.28+ 前台生命周期：持有 ssh 会话；旧的一次性 exec 永远等不到
        // 前台命令退出，只会把连接拖到超时。
        serverChild = spawn('ssh', [...sshBaseArgs(profile), sshTarget(profile), startCommand], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env
        })
        serverChild.stderr?.on('data', (chunk: Buffer) => {
          remoteServerError = `${remoteServerError}${chunk.toString('utf8')}`.slice(-4_096)
        })
      } else {
        // 0.27 daemon 自行后台化并返回，沿用一次性 exec。
        await this.runRemote(profile, startCommand, 30_000)
      }
      const token = (await this.runRemote(
        profile,
        `cat ${remotePath(`${profile.remoteKimiHome}/server.token`)}`,
        10_000
      )).trim()
      if (!token || token.length > 4_096 || /[\r\n]/.test(token)) {
        throw new Error('远程 Kimi Server token 无效')
      }
      const localPort = await freeLoopbackPort()
      const tunnel = spawn('ssh', [
        ...sshBaseArgs(profile),
        '-N',
        '-o', 'ExitOnForwardFailure=yes',
        '-L', `${localPort}:127.0.0.1:${profile.remoteServerPort}`,
        sshTarget(profile)
      ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: process.env })
      this.tunnel = tunnel
      let tunnelError = ''
      tunnel.stderr?.on('data', (chunk: Buffer) => {
        tunnelError = `${tunnelError}${chunk.toString('utf8')}`.slice(-8_192)
      })
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        if (tunnel.exitCode !== null) throw new Error(tunnelError.trim() || 'SSH 隧道提前退出')
        // 远端子进程提前退出不立即判死：端口上可能已有可用的既有实例。
        if (await probeKimiServer({ host: '127.0.0.1', port: localPort })) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      if (!(await probeKimiServer({ host: '127.0.0.1', port: localPort }))) {
        throw new Error(
          tunnelError.trim() || remoteServerError.trim() || '远程 Kimi Server 未能通过 SSH 隧道就绪'
        )
      }
      this.remoteServer = serverChild
      this.server.activateRemote(localPort, token)
      backendActivated = true
      await this.onBackendChanged()
      this.status = { state: 'connected', activeProfileId: id, localPort, connectedAt: Date.now() }
      tunnel.once('exit', () => {
        if (this.tunnel !== tunnel) return
        this.tunnel = null
        this.stopRemoteServer()
        this.server.deactivateRemote()
        this.status = { state: 'error', activeProfileId: id, error: tunnelError.trim() || 'SSH 隧道已断开' }
        void this.onBackendChanged().catch(() => undefined)
      })
      return { ok: true, snapshot: await this.snapshot() }
    } catch (error) {
      this.tunnel?.kill()
      this.tunnel = null
      this.stopRemoteServer()
      this.server.deactivateRemote()
      if (backendActivated) await this.onBackendChanged().catch(() => undefined)
      this.status = {
        state: 'error',
        ...(profile ? { activeProfileId: profile.id } : {}),
        error: error instanceof Error ? error.message : '远程控制连接失败'
      }
      return { ok: false, error: this.status.error, snapshot: await this.snapshot().catch(() => undefined) }
    }
  }

  async disconnect(): Promise<ConnectionResult> {
    try {
      const tunnel = this.tunnel
      this.tunnel = null
      if (tunnel && tunnel.exitCode === null) tunnel.kill()
      this.stopRemoteServer()
      this.server.deactivateRemote()
      this.status = { state: 'idle' }
      await this.onBackendChanged()
      return { ok: true, snapshot: await this.snapshot() }
    } catch (error) {
      this.status = { state: 'error', error: error instanceof Error ? error.message : '断开连接失败' }
      return { ok: false, error: this.status.error, snapshot: await this.snapshot().catch(() => undefined) }
    }
  }

  dispose(): void {
    const tunnel = this.tunnel
    this.tunnel = null
    if (tunnel && tunnel.exitCode === null) tunnel.kill()
    this.stopRemoteServer()
    this.server.deactivateRemote()
  }
}
