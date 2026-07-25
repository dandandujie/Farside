import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

function argsOf(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key?.startsWith('--')) continue
    args[key.slice(2)] = argv[index + 1] ?? ''
    index += 1
  }
  return args
}

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`)
  return result.stdout
}

function cleanBody(body, subject) {
  const paragraphs = []
  let current = ''
  const flush = () => {
    if (current.trim()) paragraphs.push(current.trim())
    current = ''
  }
  for (const rawLine of body.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed) {
      flush()
      continue
    }
    if (/^[-*]\s+/.test(trimmed)) {
      flush()
      current = trimmed.replace(/^[-*]\s+/, '')
      continue
    }
    current = current ? `${current} ${trimmed}` : trimmed
  }
  flush()
  const seen = new Set()
  return paragraphs
    .filter(Boolean)
    .filter((line) => !/^(?:co-authored-by|signed-off-by|full changelog):/i.test(line))
    .filter((line) => line.toLowerCase() !== subject.toLowerCase())
    .filter((line) => {
      const key = line.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 5)
}

function parseCommits(range) {
  const raw = git('log', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', range)
  return raw
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = '', subject = '', body = ''] = record.split('\x1f')
      const conventional = /^(feat|fix|perf|refactor|docs|style|test|build|ci|chore)(?:\(([^)]+)\))?(!)?:\s*(.+)$/i.exec(subject)
      const type = conventional?.[1]?.toLowerCase() ?? 'other'
      const title = conventional?.[4]?.trim() || subject.trim()
      return {
        sha: sha.slice(0, 7),
        type,
        scope: conventional?.[2],
        breaking: conventional?.[3] === '!' || /BREAKING CHANGE:/i.test(body),
        title,
        details: cleanBody(body, title)
      }
    })
    .filter((commit) => !(commit.type === 'chore' && /release/i.test(`${commit.scope ?? ''} ${commit.title}`)))
}

const SECTION = {
  feat: '新增与改进',
  fix: '问题修复',
  perf: '性能优化',
  refactor: '内部重构',
  docs: '文档',
  test: '测试与验证',
  build: '构建与发布',
  ci: '构建与发布',
  chore: '工程维护',
  style: '界面与样式',
  other: '其他变化'
}

function releaseAssets(assetsDir) {
  if (!existsSync(assetsDir)) return []
  return readdirSync(assetsDir)
    .filter((name) => /\.(?:exe|dmg|AppImage)$/i.test(name))
    .sort()
    .map((name) => {
      const path = join(assetsDir, name)
      const size = statSync(path).size
      const hash = createHash('sha256')
      const fd = openSync(path, 'r')
      const buffer = Buffer.allocUnsafe(1024 * 1024)
      try {
        for (;;) {
          const bytes = readSync(fd, buffer, 0, buffer.length, null)
          if (!bytes) break
          hash.update(buffer.subarray(0, bytes))
        }
      } finally {
        closeSync(fd)
      }
      return { name, size, sha256: hash.digest('hex') }
    })
}

function formatBytes(bytes) {
  const mib = bytes / (1024 * 1024)
  return mib >= 1024 ? `${(mib / 1024).toFixed(2)} GiB` : `${mib.toFixed(1)} MiB`
}

function assetLines(assets) {
  return assets.map(({ name, size, sha256 }) =>
    `- \`${name}\` · ${formatBytes(size)} · SHA-256 \`${sha256}\``
  )
}

function generatedNotes({ tag, previous, repository, assetsDir }) {
  const range = previous ? `${previous}..${tag}` : tag
  const commits = parseCommits(range)
  const grouped = new Map()
  for (const commit of commits) {
    const section = SECTION[commit.type] ?? SECTION.other
    grouped.set(section, [...(grouped.get(section) ?? []), commit])
  }
  const lines = [
    `# Farside ${tag.replace(/^v/i, '')}`,
    '',
    '> 本版本说明由提交记录生成。发布重要版本时，请在打 tag 前添加同名的 `releases/vX.Y.Z.md` 手写说明。',
    '',
    '## 本次升级',
    '',
    `包含 ${commits.length} 个非合并提交。下面按用户影响分类展示，不再只输出一串提交标题。`
  ]
  for (const [section, items] of grouped) {
    lines.push('', `## ${section}`, '')
    for (const item of items) {
      const scope = item.scope ? `**${item.scope}** · ` : ''
      const breaking = item.breaking ? ' **BREAKING**' : ''
      lines.push(`- ${scope}${item.title}${breaking} (\`${item.sha}\`)`)
      for (const detail of item.details) lines.push(`  - ${detail}`)
    }
  }
  const assets = releaseAssets(assetsDir)
  lines.push(
    '',
    '## 下载与安装',
    '',
    ...(assets.length
      ? assetLines(assets)
      : ['- 安装包会作为本 Release 的 Assets 上传；请按操作系统选择 `.exe` 或 `.dmg`。']),
    '',
    '## 兼容性与升级',
    '',
    '- 升级前建议先结束正在执行的 Agent 任务。',
    '- 本地项目、Kimi 配置与会话数据不会由安装包主动删除。',
    '- macOS 与 Windows 可能对未签名安装包显示系统安全提示。',
    '',
    '## 发布验证',
    '',
    '- Windows 与 macOS 均执行测试和 TypeScript 类型检查。',
    '- 安装包构建失败或缺少目标平台产物时，Release 不会发布。',
    '',
    '## 完整变更',
    '',
    previous
      ? `https://github.com/${repository}/compare/${previous}...${tag}`
      : `https://github.com/${repository}/commits/${tag}`,
    ''
  )
  return lines.join('\n')
}

const args = argsOf(process.argv.slice(2))
const tag = args.tag?.trim()
const previous = args.previous?.trim() || ''
const repository = args.repository?.trim()
const output = resolve(args.output || 'release-notes.md')
const assetsDir = resolve(args['assets-dir'] || 'release-assets')
if (!tag || !/^v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error('--tag 必须是 vX.Y.Z 形式')
}
if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error('--repository 必须是 owner/repo')
}

const manual = join(process.cwd(), 'releases', `${tag}.md`)
const assets = releaseAssets(assetsDir)
const notes = existsSync(manual)
  ? [
      readFileSync(manual, 'utf8').trimEnd(),
      ...(assets.length
        ? ['', '## 安装包校验', '', ...assetLines(assets)]
        : []),
      ''
    ].join('\n')
  : generatedNotes({ tag, previous, repository, assetsDir })
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, notes)
console.log(existsSync(manual) ? `使用手写发布说明：${manual}` : `已生成结构化发布说明：${output}`)
