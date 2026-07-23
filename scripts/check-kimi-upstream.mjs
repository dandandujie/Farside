import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadRuntimeLock } from './runtime-lock.mjs'

const REGISTRY_URL = 'https://registry.npmjs.org/@moonshot-ai%2Fkimi-code/latest'
const MAX_JSON_BYTES = 1024 * 1024
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function fetchJson(url, label) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error(`${label} 请求失败（${response.status}）`)
  const declaredSize = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > MAX_JSON_BYTES) {
    throw new Error(`${label} 响应体积异常`)
  }
  if (!response.body) throw new Error(`${label} 响应为空`)
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_JSON_BYTES) {
        await reader.cancel()
        throw new Error(`${label} 响应体积异常`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8'))
}

export function stableVersion(value, label = '版本') {
  if (typeof value !== 'string' || value.length > 64 || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`${label} 不是稳定版本号`)
  }
  return value
}

export function compareVersions(left, right) {
  const a = stableVersion(left, '左侧版本').split('.').map(BigInt)
  const b = stableVersion(right, '右侧版本').split('.').map(BigInt)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] < b[index]) return -1
    if (a[index] > b[index]) return 1
  }
  return 0
}

export function upstreamTag(version) {
  return `@moonshot-ai/kimi-code@${stableVersion(version)}`
}

export function compareUrl(currentVersion, latestVersion) {
  const base = encodeURIComponent(upstreamTag(currentVersion))
  const head = encodeURIComponent(upstreamTag(latestVersion))
  return `https://github.com/MoonshotAI/kimi-code/compare/${base}...${head}`
}

export function renderAuditReport(currentVersion, latestVersion) {
  const comparison = compareUrl(currentVersion, latestVersion)
  return `# Kimi Code ${latestVersion} 上游差异审查\n\n` +
    `Farside 当前基线：\`${currentVersion}\`  \n` +
    `Kimi Code 新版本：\`${latestVersion}\`  \n` +
    `源码比较：${comparison}\n\n` +
    `此事项只用于发现和审查上游变化，**禁止直接下载新官方 release、覆盖 runtime.lock.json 或整包搬运 CLI**。\n\n` +
    `## 必须完成的适配审查\n\n` +
    `- [ ] 阅读提交与 release notes，按功能域列出行为变化，而不只记录文件列表。\n` +
    `- [ ] 审查 REST、WebSocket、wire、session、profile、tool、auth 和配置 schema 变化。\n` +
    `- [ ] 对照 Farside 补丁队列，判断哪些上游实现可吸收、哪些补丁需重写或删除。\n` +
    `- [ ] 评估 UI、IPC、持久化数据和六平台构建兼容性。\n` +
    `- [ ] 为每项采纳的变化编写独立适配提交与回归测试。\n` +
    `- [ ] 重新运行 harness 配对评测、协议 smoke、真实账号回归与六平台构建。\n` +
    `- [ ] 只有 Farside 唯一 runtime 产物发布并锁定 SHA-256 后，才原位更新 current 条目。\n`
}

async function setOutputs(available, currentVersion, latestVersion, comparison) {
  const output = process.env.GITHUB_OUTPUT
  if (!output) return
  await appendFile(output, [
    `available=${available ? 'true' : 'false'}`,
    `current_version=${currentVersion}`,
    `upstream_version=${latestVersion}`,
    `compare_url=${comparison}`,
    ''
  ].join('\n'))
}

export async function run() {
  const lock = await loadRuntimeLock(resolve(root, 'runtime.lock.json'))
  const currentVersion = stableVersion(
    lock.runtime.upstreamVersion,
    'runtime.lock runtime.upstreamVersion'
  )
  const packageInfo = await fetchJson(REGISTRY_URL, 'npm latest')
  const latestVersion = stableVersion(packageInfo?.version, 'npm latest.version')
  const comparison = compareVersions(latestVersion, currentVersion)
  if (comparison < 0) {
    throw new Error(`官方 latest ${latestVersion} 早于 Farside 当前基线 ${currentVersion}`)
  }
  const available = comparison > 0
  const url = compareUrl(currentVersion, latestVersion)
  await setOutputs(available, currentVersion, latestVersion, url)
  if (!available) {
    console.log(`Farside 已基于最新 Kimi Code ${currentVersion}`)
    return
  }
  const reportPath = resolve(root, '.tmp', 'kimi-upstream-audit.md')
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, renderAuditReport(currentVersion, latestVersion), 'utf8')
  console.log(`发现 Kimi Code ${latestVersion}；只生成差异审查，不修改 Farside runtime`)
  console.log(`源码比较：${url}`)
  console.log(`审查模板：${reportPath}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
