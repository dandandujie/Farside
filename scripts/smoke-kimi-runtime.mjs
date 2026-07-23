import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import WebSocket from 'ws'

const REQUIRED_CAPABILITIES = ['websocket', 'file_upload', 'fs_query', 'mcp', 'tasks', 'terminal']
const target = `${process.platform}-${process.arch}`
const executable = process.platform === 'win32' ? 'kimi.exe' : 'kimi'
const runtimeRoot = resolve(process.env.FARSIDE_RUNTIME_OUTPUT_DIR?.trim() || join(process.cwd(), 'resources', 'runtime'))
const command = resolve(process.argv[2] || join(runtimeRoot, target, executable))
const manifestPath = join(dirname(command), 'manifest.json')

function run(args, env, timeout = 20_000) {
  return new Promise((resolveRun, reject) => {
    execFile(command, args, {
      env,
      maxBuffer: 1024 * 1024,
      timeout,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()))
        return
      }
      resolveRun((stdout || stderr).trim())
    })
  })
}

function versionAtLeast(version, minimum) {
  const matched = version.match(/(?:^|\D)(\d+)\.(\d+)\.(\d+)(?:\D|$)/)
  if (!matched) return false
  const actual = matched.slice(1, 4).map(Number)
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index]
  }
  return true
}

function startForeground(args, env) {
  const child = spawn(command, args, {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  const append = (chunk) => { output = `${output}${chunk}`.slice(-4_096) }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  return { child, output: () => output }
}

async function availablePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
  if (!port) throw new Error('无法分配 runtime smoke test 端口')
  return port
}

async function probeMeta(origin, token) {
  const response = await fetch(`${origin}/api/v1/meta`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(1_500)
  })
  if (!response.ok) return null
  const body = await response.json()
  return body?.code === 0 && body.data && typeof body.data === 'object' ? body.data : null
}

async function probeWebSocket(origin, token, protocolVersion) {
  const wsOrigin = origin.replace(/^http:/, 'ws:')
  await new Promise((resolveProbe, reject) => {
    const helloId = randomUUID()
    const socket = new WebSocket(`${wsOrigin}/api/v1/ws`, {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: 5_000,
      maxPayload: 1024 * 1024
    })
    let serverHello = false
    let settled = false
    const timer = setTimeout(() => finish(new Error('Kimi Server WebSocket 握手超时')), 5_000)
    function finish(error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.close()
      if (error) reject(error)
      else resolveProbe()
    }
    socket.on('open', () => {
      socket.send(JSON.stringify({
        type: 'client_hello',
        id: helloId,
        payload: { client_id: `farside-smoke-${randomUUID()}`, subscriptions: [] }
      }))
    })
    socket.on('message', (data) => {
      let frame
      try {
        frame = JSON.parse(data.toString())
      } catch {
        finish(new Error('Kimi Server WebSocket 返回无效 JSON'))
        return
      }
      if (frame?.type === 'server_hello') {
        if (frame.payload?.protocol_version !== protocolVersion) {
          finish(new Error(`Kimi Server WebSocket 协议不匹配：expected ${protocolVersion}, got ${String(frame.payload?.protocol_version)}`))
          return
        }
        serverHello = true
      }
      if (frame?.type === 'ack' && frame.id === helloId) {
        if (frame.code !== 0) finish(new Error(`Kimi Server client_hello 被拒绝：${String(frame.msg)}`))
        else if (!serverHello) finish(new Error('Kimi Server 未发送 server_hello'))
        else finish()
      }
    })
    socket.on('error', (error) => finish(error))
    socket.on('close', () => {
      if (!settled) finish(new Error('Kimi Server WebSocket 在握手完成前关闭'))
    })
  })
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
if (manifest.schemaVersion !== 1 || manifest.target !== target || manifest.executable !== basename(command)) {
  throw new Error('runtime smoke test 读取到不兼容的 manifest')
}

const home = await mkdtemp(join(tmpdir(), 'farside-kimi-smoke-'))
const port = await availablePort()
const origin = `http://127.0.0.1:${port}`
const env = { ...process.env, KIMI_CODE_HOME: home }
let attemptedStart = false
let smokeFailed = false
let foreground
const foregroundWeb = versionAtLeast(manifest.version, [0, 28, 0])

try {
  attemptedStart = true
  if (foregroundWeb) {
    foreground = startForeground(['web', '--no-open', '--port', String(port)], env)
  } else {
    await run(['server', 'run', '--port', String(port)], env)
  }
  const deadline = Date.now() + 15_000
  let meta = null
  while (Date.now() < deadline) {
    try {
      const token = (await readFile(join(home, 'server.token'), 'utf8')).trim()
      if (token) meta = await probeMeta(origin, token)
    } catch {}
    if (meta) break
    if (foreground?.child.exitCode !== null) {
      throw new Error(`Kimi web 提前退出（${foreground.child.exitCode}）：${foreground.output()}`)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  if (!meta) throw new Error('Kimi Server meta smoke test 超时')
  if (meta.server_version !== manifest.version) {
    throw new Error(`Kimi Server 版本不匹配：expected ${manifest.version}, got ${String(meta.server_version)}`)
  }
  const missing = REQUIRED_CAPABILITIES.filter((capability) => meta.capabilities?.[capability] !== true)
  if (missing.length) throw new Error(`Kimi Server 缺少能力：${missing.join(', ')}`)
  await probeWebSocket(origin, (await readFile(join(home, 'server.token'), 'utf8')).trim(), manifest.wsProtocolVersion)
  console.log(`Kimi Server ${meta.server_version} smoke test 通过（${target}）`)
} catch (error) {
  smokeFailed = true
  throw error
} finally {
  let cleanupError
  if (attemptedStart) {
    try {
      if (foreground?.child.exitCode === null) {
        const exited = new Promise((resolveExit) => foreground.child.once('exit', resolveExit))
        foreground.child.kill()
        await Promise.race([
          exited,
          new Promise((resolveWait) => setTimeout(resolveWait, 5_000))
        ])
      } else if (!foregroundWeb) {
        await run(['server', 'kill'], env, 10_000)
      }
    } catch (error) {
      cleanupError = error
    }
  }
  try {
    await rm(home, { recursive: true, force: true })
  } catch (error) {
    cleanupError ??= error
  }
  if (cleanupError) {
    if (smokeFailed) console.error(`Runtime smoke test 清理失败：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
    else throw cleanupError
  }
}
