import { spawn, execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_SOURCE = resolve(root, '.tmp', 'kimi-code-0.28.0')
const DEFAULT_AUTH_HOME = resolve(homedir(), '.kimi-code')
const LEAN_PROMPT_PATH = resolve(root, 'experiments', 'harness-factorial', 'lean-system-prompt.md')
const LEAN_TOOLS = ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash']
const MODEL = 'kimi-code/k3'
const POLL_INTERVAL_MS = 2_000
const RUN_TIMEOUT_MS = Number(process.env.FARSIDE_FACTORIAL_TIMEOUT_MS || 10 * 60_000)

const CONDITIONS = [
  { id: 'original-prompt__original-tools', leanPrompt: false, leanTools: false },
  { id: 'lean-prompt__original-tools', leanPrompt: true, leanTools: false },
  { id: 'original-prompt__lean-tools', leanPrompt: false, leanTools: true },
  { id: 'lean-prompt__lean-tools', leanPrompt: true, leanTools: true }
]

const TASKS = [
  {
    id: 'retry-off-by-one',
    instruction:
      '修复 src/retry.js，使 npm test 全部通过。保持现有导出和 API，不要修改测试。完成后停止。',
    files: {
      'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }, null, 2),
      'src/retry.js': `export async function retry(operation, options = {}) {
  const attempts = options.attempts ?? 3
  const delayMs = options.delayMs ?? 0
  let lastError

  for (let index = 0; index <= attempts; index += 1) {
    try {
      return await operation(index + 1)
    } catch (error) {
      lastError = error
      if (delayMs > 0 && index < attempts) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs))
      }
    }
  }

  throw lastError
}
`,
      'test/retry.test.js': `import assert from 'node:assert/strict'
import test from 'node:test'

import { retry } from '../src/retry.js'

test('returns on the first successful attempt', async () => {
  let calls = 0
  const value = await retry(async () => {
    calls += 1
    return 'ok'
  })
  assert.equal(value, 'ok')
  assert.equal(calls, 1)
})

test('attempts means the total number of calls', async () => {
  let calls = 0
  await assert.rejects(
    retry(async () => {
      calls += 1
      throw new Error('still broken')
    }, { attempts: 3 }),
    /still broken/
  )
  assert.equal(calls, 3)
})

test('passes the one-based attempt number', async () => {
  const seen = []
  const value = await retry(async (attempt) => {
    seen.push(attempt)
    if (attempt < 3) throw new Error('again')
    return attempt
  }, { attempts: 4 })
  assert.equal(value, 3)
  assert.deepEqual(seen, [1, 2, 3])
})
`
    }
  },
  {
    id: 'inventory-summary',
    instruction:
      '实现 src/inventory.js 中的 summarizeInventory，使 npm test 全部通过。不要修改测试或 package.json。完成后停止。',
    files: {
      'package.json': JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }, null, 2),
      'src/inventory.js': `export function summarizeInventory(records) {
  throw new Error('TODO')
}
`,
      'test/inventory.test.js': `import assert from 'node:assert/strict'
import test from 'node:test'

import { summarizeInventory } from '../src/inventory.js'

test('groups valid rows, sums quantity and keeps the latest price', () => {
  const records = [
    { sku: 'B-2', quantity: 2, price: 8 },
    { sku: 'A-1', quantity: 3, price: 5 },
    { sku: 'B-2', quantity: -1, price: 9 },
    { sku: 'A-1', quantity: 4, price: 6 }
  ]
  assert.deepEqual(summarizeInventory(records), [
    { sku: 'A-1', quantity: 7, latestPrice: 6, value: 42 },
    { sku: 'B-2', quantity: 1, latestPrice: 9, value: 9 }
  ])
})

test('ignores malformed rows without mutating the input', () => {
  const records = [
    { sku: '', quantity: 2, price: 4 },
    { sku: 'A', quantity: Number.NaN, price: 4 },
    { sku: 'A', quantity: 1, price: -2 },
    { sku: 'C', quantity: 2, price: 4 }
  ]
  const before = structuredClone(records)
  assert.deepEqual(summarizeInventory(records), [
    { sku: 'C', quantity: 2, latestPrice: 4, value: 8 }
  ])
  assert.deepEqual(records, before)
})

test('returns rows sorted by sku', () => {
  assert.deepEqual(summarizeInventory([
    { sku: 'z', quantity: 1, price: 1 },
    { sku: 'a', quantity: 1, price: 2 }
  ]).map((row) => row.sku), ['a', 'z'])
})
`
    }
  }
]

function parseArgs(argv) {
  const options = {
    source: DEFAULT_SOURCE,
    authHome: DEFAULT_AUTH_HOME,
    out: undefined,
    task: undefined,
    condition: undefined
  }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (key === '--source' && value) options.source = resolve(value)
    else if (key === '--auth-home' && value) options.authHome = resolve(value)
    else if (key === '--out' && value) options.out = resolve(value)
    else if (key === '--task' && value) options.task = value
    else if (key === '--condition' && value) options.condition = value
    else throw new Error(`未知参数或缺少参数值：${key}`)
    index += 1
  }
  return options
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
  if (!port) throw new Error('无法分配实验端口')
  return port
}

async function seedWorkspace(workspace, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(workspace, relativePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${content.trimEnd()}\n`, 'utf8')
  }
}

async function prepareHome(authHome, home) {
  for (const relativePath of ['config.toml', 'device_id']) {
    await cp(join(authHome, relativePath), join(home, relativePath))
  }
  await cp(join(authHome, 'credentials'), join(home, 'credentials'), { recursive: true })
}

async function waitForServer(origin, tokenPath, child) {
  const deadline = Date.now() + 60_000
  let lastError
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Kimi Server 提前退出：${child.exitCode}`)
    try {
      const token = (await readFile(tokenPath, 'utf8')).trim()
      const response = await fetch(`${origin}/api/v1/meta`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2_000)
      })
      const body = await response.json()
      if (response.ok && body?.code === 0) return token
    } catch (error) {
      lastError = error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  }
  throw new Error(`Kimi Server 启动超时：${lastError instanceof Error ? lastError.message : ''}`)
}

async function requestJson(origin, token, method, path, body) {
  const response = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000)
  })
  const envelope = await response.json()
  if (!response.ok || envelope?.code !== 0) {
    throw new Error(`${method} ${path} 失败：HTTP ${response.status} ${JSON.stringify(envelope)}`)
  }
  return envelope.data
}

async function waitForPrompt(origin, token, sessionId) {
  const deadline = Date.now() + RUN_TIMEOUT_MS
  while (Date.now() < deadline) {
    const prompts = await requestJson(origin, token, 'GET', `/sessions/${sessionId}/prompts`)
    if (prompts.active === null && prompts.queued.length === 0) return
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_INTERVAL_MS))
  }
  throw new Error(`会话 ${sessionId} 超过 ${RUN_TIMEOUT_MS}ms 未完成`)
}

async function findWireFile(path, sessionId) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === sessionId) {
        const wirePath = join(child, 'agents', 'main', 'wire.jsonl')
        try {
          await readFile(wirePath, 'utf8')
          return wirePath
        } catch {}
      }
      const nested = await findWireFile(child, sessionId)
      if (nested) return nested
    }
  }
  return undefined
}

async function readMetrics(home, sessionId) {
  const wirePath = await findWireFile(join(home, 'sessions'), sessionId)
  if (!wirePath) throw new Error(`找不到会话 ${sessionId} 的 wire.jsonl`)
  const records = (await readFile(wirePath, 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const usageRecords = records.filter((record) => record.type === 'usage.record')
  const requests = records.filter((record) => record.type === 'llm.request')
  const snapshots = records.filter((record) => record.type === 'llm.tools_snapshot')
  const toolCalls = records.filter(
    (record) => record.type === 'context.append_loop_event' && record.event?.type === 'tool.call'
  )
  const usage = usageRecords.reduce(
    (sum, record) => ({
      inputOther: sum.inputOther + (record.usage?.inputOther || 0),
      inputCacheRead: sum.inputCacheRead + (record.usage?.inputCacheRead || 0),
      inputCacheCreation: sum.inputCacheCreation + (record.usage?.inputCacheCreation || 0),
      output: sum.output + (record.usage?.output || 0)
    }),
    { inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0, output: 0 }
  )
  return {
    ...usage,
    totalInput: usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation,
    requestCount: requests.length,
    toolCallCount: toolCalls.length,
    toolCount: snapshots[0]?.tools?.length,
    toolNames: snapshots[0]?.tools?.map((tool) => tool.name) || [],
    systemPromptHash: requests[0]?.systemPromptHash,
    wirePath
  }
}

async function verifyWorkspace(workspace) {
  try {
    const { stdout, stderr } = await execFile(process.execPath, ['--test'], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true
    })
    return { passed: true, output: `${stdout}${stderr}`.trim().slice(-2_000) }
  } catch (error) {
    return {
      passed: false,
      output: `${error.stdout || ''}${error.stderr || error.message}`.trim().slice(-2_000)
    }
  }
}

function summarize(results) {
  return CONDITIONS
    .filter((condition) => results.some((result) => result.condition === condition.id))
    .map((condition) => {
      const cells = results.filter((result) => result.condition === condition.id)
      const total = (key) => cells.reduce((sum, cell) => sum + (cell.metrics[key] || 0), 0)
      return {
        condition: condition.id,
        passed: cells.filter((cell) => cell.verification.passed).length,
        attempts: cells.length,
        totalInput: total('totalInput'),
        inputOther: total('inputOther'),
        inputCacheRead: total('inputCacheRead'),
        inputCacheCreation: total('inputCacheCreation'),
        output: total('output'),
        requests: total('requestCount'),
        toolCalls: total('toolCallCount'),
        durationMs: cells.reduce((sum, cell) => sum + cell.durationMs, 0)
      }
    })
}

function renderMarkdown(report) {
  const rows = report.summary.map((row) =>
    `| ${row.condition} | ${row.passed}/${row.attempts} | ${row.totalInput} | ${row.output} | ${row.requests} | ${row.toolCalls} | ${(row.durationMs / 1000).toFixed(1)} |`
  )
  return `# K3 Harness 2×2 Pilot\n\n` +
    `- Runtime: Kimi Code ${report.runtimeVersion}, patched revision ${report.sourceRevision}\n` +
    `- Model: ${MODEL}, thinking=max\n` +
    `- Tasks: ${report.tasks.join(', ')}\n` +
    `- Generated: ${report.generatedAt}\n\n` +
    `| Condition | Pass | Input tokens | Output tokens | Requests | Tool calls | Seconds |\n` +
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows.join('\n')}\n\n` +
    `这是链路与方向性 pilot，不提供统计显著性结论。正式结论需要在 Terminal-Bench 2.1 上增加配对样本。\n`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const selectedTasks = options.task
    ? TASKS.filter((task) => task.id === options.task)
    : TASKS
  const selectedConditions = options.condition
    ? CONDITIONS.filter((condition) => condition.id === options.condition)
    : CONDITIONS
  if (selectedTasks.length === 0) throw new Error(`未知任务：${options.task}`)
  if (selectedConditions.length === 0) throw new Error(`未知条件：${options.condition}`)
  const leanPrompt = (await readFile(LEAN_PROMPT_PATH, 'utf8')).trim()
  const tempRoot = await mkdtemp(join(tmpdir(), 'farside-factorial-'))
  const home = join(tempRoot, 'kimi-home')
  const workspaces = join(tempRoot, 'workspaces')
  await mkdir(home, { recursive: true })
  await mkdir(workspaces, { recursive: true })
  await prepareHome(options.authHome, home)

  const port = await availablePort()
  const origin = `http://127.0.0.1:${port}`
  const kimiNode = resolve(process.env.FARSIDE_KIMI_NODE || process.execPath)
  const serverEntry = join(
    options.source,
    'packages',
    'kap-server',
    'test',
    `.farside-factorial-${process.pid}.test.ts`
  )
  const stopFile = join(tempRoot, 'stop-server')
  await writeFile(
    serverEntry,
    `import { existsSync } from 'node:fs'

import { test } from 'vitest'

import { startServer } from '../src/start'

test('Farside factorial server bridge', async () => {
  const server = await startServer({
    host: '127.0.0.1',
    port: ${port},
    homeDir: ${JSON.stringify(home)},
    logLevel: 'error'
  })
  while (!existsSync(${JSON.stringify(stopFile)})) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  await server.close()
}, ${RUN_TIMEOUT_MS * selectedTasks.length * selectedConditions.length + 120_000})
`,
    'utf8'
  )
  const vitest = join(options.source, 'node_modules', 'vitest', 'vitest.mjs')
  const serverArgs = [
    vitest,
    'run',
    serverEntry
  ]
  let child
  let serverLog = ''
  const results = []
  try {
    child = spawn(kimiNode, serverArgs, {
      cwd: options.source,
      env: { ...process.env, KIMI_CODE_HOME: home },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', (chunk) => { serverLog = `${serverLog}${chunk}`.slice(-8_000) })
    child.stderr.on('data', (chunk) => { serverLog = `${serverLog}${chunk}`.slice(-8_000) })
    const token = await waitForServer(origin, join(home, 'server.token'), child)
    const meta = await requestJson(origin, token, 'GET', '/meta')
    for (let taskIndex = 0; taskIndex < selectedTasks.length; taskIndex += 1) {
      const task = selectedTasks[taskIndex]
      const order = taskIndex % 2 === 0
        ? CONDITIONS
        : [CONDITIONS[2], CONDITIONS[3], CONDITIONS[0], CONDITIONS[1]]
      for (const condition of order.filter((candidate) =>
        selectedConditions.some((selected) => selected.id === candidate.id))) {
        const workspace = join(workspaces, `${task.id}__${condition.id}`)
        await mkdir(workspace, { recursive: true })
        await seedWorkspace(workspace, task.files)
        const agentConfig = {
          model: MODEL,
          thinking: 'max',
          permission_mode: 'yolo',
          ...(condition.leanPrompt ? { system_prompt: leanPrompt } : {}),
          ...(condition.leanTools ? { tools: LEAN_TOOLS } : {})
        }
        const session = await requestJson(origin, token, 'POST', '/sessions', {
          title: `${task.id} ${condition.id}`,
          metadata: { cwd: workspace },
          agent_config: agentConfig
        })
        const startedAt = Date.now()
        await requestJson(origin, token, 'POST', `/sessions/${session.id}/prompts`, {
          content: [{ type: 'text', text: task.instruction }]
        })
        await waitForPrompt(origin, token, session.id)
        const durationMs = Date.now() - startedAt
        const verification = await verifyWorkspace(workspace)
        const metrics = await readMetrics(home, session.id)
        const result = { task: task.id, condition: condition.id, durationMs, verification, metrics }
        results.push(result)
        process.stdout.write(
          `${task.id} | ${condition.id} | ${verification.passed ? 'PASS' : 'FAIL'} | input=${metrics.totalInput} output=${metrics.output} tools=${metrics.toolCount} | ${(durationMs / 1000).toFixed(1)}s\n`
        )
      }
    }

    const revision = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: options.source, encoding: 'utf8' })).stdout.trim()
    const kimiPackage = JSON.parse(
      await readFile(join(options.source, 'apps', 'kimi-code', 'package.json'), 'utf8')
    )
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      runtimeVersion: kimiPackage.version,
      serverVersion: meta.server_version,
      sourceRevision: revision,
      model: MODEL,
      thinking: 'max',
      leanPromptSha256: createHash('sha256').update(leanPrompt).digest('hex'),
      leanTools: LEAN_TOOLS,
      tasks: selectedTasks.map((task) => task.id),
      summary: summarize(results),
      results
    }
    const out = options.out || resolve(root, '.tmp', 'harness-factorial-pilot.json')
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    await writeFile(out.replace(/\.json$/i, '.md'), renderMarkdown(report), 'utf8')
    process.stdout.write(`结果：${out}\n`)
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nServer log:\n${serverLog}`)
  } finally {
    await writeFile(stopFile, '', 'utf8')
    const closeDeadline = Date.now() + 10_000
    while (child?.exitCode === null && Date.now() < closeDeadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    if (child?.exitCode === null) child.kill()
    await rm(serverEntry, { force: true })
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
