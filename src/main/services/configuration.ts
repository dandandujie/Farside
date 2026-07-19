import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promises as fs, watch as watchFs, type FSWatcher } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import type {
  ConfigurationManageInput,
  ConfigurationResult,
  ConfigurationSaveInput,
  ConfigurationSnapshot,
  PluginInfo,
  SkillInfo
} from '@shared/ipc'

const ROOT = process.env['KIMI_CODE_HOME'] || join(homedir(), '.kimi-code')
const MAX_CONFIGURATION_BYTES = 2 * 1024 * 1024

export const CONFIGURATION_PATHS: ConfigurationSnapshot['paths'] = {
  config: join(ROOT, 'config.toml'),
  mcp: join(ROOT, 'mcp.json'),
  instructions: join(ROOT, 'AGENTS.md'),
  skills: join(ROOT, 'skills'),
  plugins: join(ROOT, 'plugins')
}

interface InstalledPluginRecord {
  id: string
  root: string
  source: 'local-path' | 'github' | 'zip-url'
  enabled: boolean
  installedAt: string
  updatedAt?: string
  originalSource?: string
  capabilities?: unknown
  github?: unknown
}

interface InstalledPluginFile {
  version: 1
  plugins: InstalledPluginRecord[]
}

interface MaterializedSource {
  root: string
  cleanup?: string
}

async function readText(path: string, fallback = ''): Promise<string> {
  try {
    return await fs.readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
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

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function frontmatterValue(source: string, key: string): string | undefined {
  const block = /^---\s*\r?\n([\s\S]*?)\r?\n---/m.exec(source)?.[1]
  if (!block) return undefined
  const match = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.+)$`, 'im').exec(block)
  if (!match) return undefined
  return match[1].trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2')
}

function skillInfo(path: string, text: string, source: string): SkillInfo {
  const fallbackName = basename(dirname(path))
  const name = frontmatterValue(text, 'name') || fallbackName
  const description = frontmatterValue(text, 'description') ||
    text.replace(/^---[\s\S]*?---\s*/m, '').replace(/^#+\s*/m, '').trim().split(/\r?\n/)[0] || ''
  const disabled = /^(?:disableModelInvocation|disable-model-invocation):\s*true\s*$/im.test(text)
  return {
    name,
    description,
    path,
    source,
    disabledForModel: disabled,
    managed: isWithin(CONFIGURATION_PATHS.skills, path)
  }
}

async function readSkills(): Promise<SkillInfo[]> {
  const roots = [CONFIGURATION_PATHS.skills, join(homedir(), '.agents', 'skills')]
  const skills: SkillInfo[] = []
  for (const root of roots) {
    let entries
    try {
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(root, entry.name, 'SKILL.md')
      const text = await readText(path)
      if (text) skills.push(skillInfo(path, text, root))
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

async function readInstalledPlugins(): Promise<InstalledPluginFile> {
  const raw = await readText(join(CONFIGURATION_PATHS.plugins, 'installed.json'))
  if (!raw) return { version: 1, plugins: [] }
  const parsed = JSON.parse(raw) as unknown
  if (
    typeof parsed !== 'object' || parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { plugins?: unknown }).plugins)
  ) {
    throw new Error('plugins/installed.json 不是 Kimi Code 支持的 version 1 格式')
  }
  return parsed as InstalledPluginFile
}

async function readPluginManifest(root: string): Promise<Record<string, unknown>> {
  const candidates = [join(root, 'kimi.plugin.json'), join(root, '.kimi-plugin', 'plugin.json')]
  for (const path of candidates) {
    const raw = await readText(path)
    if (!raw) continue
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  }
  return {}
}

async function readPlugins(): Promise<PluginInfo[]> {
  const file = await readInstalledPlugins()
  return Promise.all(file.plugins.map(async (record) => {
    const manifest: Record<string, unknown> = await readPluginManifest(record.root).catch(() => ({}))
    const interfaceInfo = typeof manifest.interface === 'object' && manifest.interface !== null
      ? manifest.interface as Record<string, unknown>
      : {}
    return {
      id: record.id,
      name: typeof interfaceInfo.displayName === 'string' ? interfaceInfo.displayName : record.id,
      version: typeof manifest.version === 'string' ? manifest.version : undefined,
      description: typeof manifest.description === 'string'
        ? manifest.description
        : typeof interfaceInfo.description === 'string' ? interfaceInfo.description : undefined,
      enabled: record.enabled,
      source: record.originalSource || record.source,
      root: record.root
    }
  }))
}

function validateMcp(content: string): void {
  const parsed = JSON.parse(content) as unknown
  const servers = typeof parsed === 'object' && parsed !== null
    ? (parsed as Record<string, unknown>).mcpServers
    : null
  if (
    typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) ||
    typeof servers !== 'object' || servers === null || Array.isArray(servers)
  ) {
    throw new Error('MCP 配置必须是包含 mcpServers 对象的 JSON')
  }
}

function normalizeExtensionId(value: string, label: string): string {
  const id = value.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    throw new Error(`${label} ID 只能包含小写字母、数字、点、下划线和连字符`)
  }
  return id
}

function runGit(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { windowsHide: true, timeout: 120_000 }, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()))
        return
      }
      resolvePromise()
    })
  })
}

function githubCloneUrl(source: string): string | null {
  const trimmed = source.trim()
  const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(trimmed)
  if (shorthand) return `https://github.com/${shorthand[1]}/${shorthand[2].replace(/\.git$/, '')}.git`
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null
    const parts = url.pathname.split('/').filter(Boolean).slice(0, 2)
    if (parts.length !== 2) return null
    return `https://github.com/${parts[0]}/${parts[1].replace(/\.git$/, '')}.git`
  } catch {
    return null
  }
}

async function materializeSource(source: string): Promise<MaterializedSource> {
  const trimmed = source.trim().replace(/^"|"$/g, '')
  if (!trimmed) throw new Error('请输入本地目录或 GitHub 仓库地址')
  if (trimmed.length > 2_048) throw new Error('扩展来源地址过长')
  if (isAbsolute(trimmed)) {
    const stat = await fs.stat(trimmed).catch(() => null)
    if (!stat?.isDirectory()) throw new Error('本地来源必须是存在的目录')
    return { root: await fs.realpath(trimmed) }
  }
  const cloneUrl = githubCloneUrl(trimmed)
  if (!cloneUrl) throw new Error('远程来源目前支持 GitHub HTTPS 地址或 owner/repo')
  const cleanup = await fs.mkdtemp(join(tmpdir(), 'farside-skill-'))
  const root = join(cleanup, 'source')
  try {
    await runGit(['clone', '--depth', '1', '--', cloneUrl, root])
    return { root, cleanup }
  } catch (error) {
    await fs.rm(cleanup, { recursive: true, force: true })
    throw error
  }
}

async function findNamedFiles(root: string, names: Set<string>, maxDepth: number): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || found.length >= 100) return
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const path = join(dir, entry.name)
      if (entry.isFile() && names.has(entry.name)) found.push(path)
      else if (entry.isDirectory()) await walk(path, depth + 1)
    }
  }
  await walk(root, 0)
  return found
}

function setSkillAutoInvocation(source: string, enabled: boolean): string {
  const value = enabled ? 'false' : 'true'
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/
  const match = frontmatter.exec(source)
  if (!match) {
    return `---\ndisableModelInvocation: ${value}\n---\n\n${source}`
  }
  const block = match[1]
  const property = /^(?:disableModelInvocation|disable-model-invocation):\s*.*$/im
  const next = property.test(block)
    ? block.replace(property, `disableModelInvocation: ${value}`)
    : `${block.trimEnd()}\ndisableModelInvocation: ${value}`
  return source.replace(frontmatter, `---\n${next}\n---`)
}

async function installSkill(source: string): Promise<void> {
  const materialized = await materializeSource(source)
  try {
    const manifests = await findNamedFiles(materialized.root, new Set(['SKILL.md']), 7)
    if (!manifests.length) throw new Error('来源中没有找到 SKILL.md')
    const candidates = await Promise.all(manifests.map(async (manifestPath) => {
      const text = await fs.readFile(manifestPath, 'utf8')
      const id = normalizeExtensionId(frontmatterValue(text, 'name') || basename(dirname(manifestPath)), 'Skill')
      return { id, sourceDir: dirname(manifestPath) }
    }))
    const seen = new Set<string>()
    for (const item of candidates) {
      if (seen.has(item.id)) throw new Error(`来源中存在重复 Skill：${item.id}`)
      seen.add(item.id)
      const target = join(CONFIGURATION_PATHS.skills, item.id)
      if (await fs.stat(target).then(() => true).catch(() => false)) {
        throw new Error(`Skill ${item.id} 已存在，请先移除再安装`)
      }
    }
    await fs.mkdir(CONFIGURATION_PATHS.skills, { recursive: true })
    for (const item of candidates) await fs.cp(item.sourceDir, join(CONFIGURATION_PATHS.skills, item.id), { recursive: true })
  } finally {
    if (materialized.cleanup) await fs.rm(materialized.cleanup, { recursive: true, force: true })
  }
}

async function managedSkillPath(path: string): Promise<string> {
  if (basename(path).toLowerCase() !== 'skill.md') throw new Error('只能管理 Skill 清单文件')
  const [root, candidate] = await Promise.all([
    fs.realpath(CONFIGURATION_PATHS.skills),
    fs.realpath(path)
  ])
  if (!isWithin(root, candidate) || resolve(dirname(candidate)) === resolve(root)) {
    throw new Error('只能管理 Kimi 用户目录中的 Skill')
  }
  return candidate
}

export class ConfigurationService {
  private watcher: FSWatcher | null = null
  private watchTimer: NodeJS.Timeout | null = null
  private readonly listeners = new Set<(snapshot: ConfigurationSnapshot) => void>()

  async get(): Promise<ConfigurationResult> {
    try {
      const [configToml, mcpJson, agentsMarkdown, plugins, userSkills] = await Promise.all([
        readText(CONFIGURATION_PATHS.config),
        readText(CONFIGURATION_PATHS.mcp, '{\n  "mcpServers": {}\n}\n'),
        readText(CONFIGURATION_PATHS.instructions),
        readPlugins(),
        readSkills()
      ])
      return {
        ok: true,
        snapshot: {
          configToml,
          mcpJson,
          agentsMarkdown,
          plugins,
          userSkills,
          paths: CONFIGURATION_PATHS,
          updatedAt: Date.now()
        }
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '配置读取失败' }
    }
  }

  async save(input: ConfigurationSaveInput): Promise<ConfigurationResult> {
    try {
      if (
        !input ||
        !['config', 'mcp', 'instructions'].includes(input.target) ||
        typeof input.content !== 'string'
      ) {
        throw new Error('配置保存参数无效')
      }
      if (Buffer.byteLength(input.content, 'utf8') > MAX_CONFIGURATION_BYTES) {
        throw new Error('单个配置文件不能超过 2 MiB')
      }
      if (input.target === 'mcp') validateMcp(input.content)
      if (input.target === 'config') parseToml(input.content)
      await writeAtomic(CONFIGURATION_PATHS[input.target], input.content)
      return this.get()
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '配置保存失败' }
    }
  }

  async manage(input: ConfigurationManageInput): Promise<ConfigurationResult> {
    try {
      if (input.kind === 'skill' && input.action === 'create') {
        const id = normalizeExtensionId(input.name, 'Skill')
        const target = join(CONFIGURATION_PATHS.skills, id, 'SKILL.md')
        if (await fs.stat(target).then(() => true).catch(() => false)) throw new Error(`Skill ${id} 已存在`)
        const description = input.description.trim().slice(0, 1_000) || `${id} skill`
        await writeAtomic(target, `---\nname: ${id}\ndescription: ${JSON.stringify(description)}\ndisableModelInvocation: false\n---\n\n# ${id}\n\n在这里编写 Skill 指令。\n`)
      } else if (input.kind === 'skill' && input.action === 'install') {
        await installSkill(input.source)
      } else if (input.kind === 'skill' && input.action === 'toggle') {
        const path = await managedSkillPath(input.path)
        const source = await fs.readFile(path, 'utf8')
        await writeAtomic(path, setSkillAutoInvocation(source, input.enabled))
      } else if (input.kind === 'skill' && input.action === 'remove') {
        const path = await managedSkillPath(input.path)
        await fs.rm(dirname(path), { recursive: true, force: true })
      } else if (input.kind === 'plugin') {
        throw new Error('Plugin 操作必须通过 Kimi PluginService 执行')
      } else {
        throw new Error('不支持的扩展操作')
      }
      return this.get()
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '扩展操作失败' }
    }
  }

  async watch(listener: (snapshot: ConfigurationSnapshot) => void): Promise<() => void> {
    this.listeners.add(listener)
    await fs.mkdir(ROOT, { recursive: true })
    if (!this.watcher) {
      this.watcher = watchFs(ROOT, { recursive: true }, (_event, fileName) => {
        const top = String(fileName || '').replace(/\\/g, '/').split('/')[0]
        if (!['config.toml', 'mcp.json', 'AGENTS.md', 'skills', 'plugins'].includes(top)) return
        if (this.watchTimer) clearTimeout(this.watchTimer)
        this.watchTimer = setTimeout(() => void this.emitSnapshot(), 140)
      })
    }
    return () => this.listeners.delete(listener)
  }

  private async emitSnapshot(): Promise<void> {
    this.watchTimer = null
    const result = await this.get()
    if (!result.ok || !result.snapshot) return
    for (const listener of this.listeners) listener(result.snapshot)
  }

  dispose(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer)
    this.watchTimer = null
    this.watcher?.close()
    this.watcher = null
    this.listeners.clear()
  }
}
