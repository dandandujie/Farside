import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  AppInfo,
  CliStatus,
  ConfigurationManageInput,
  ConfigurationSnapshot,
  ConfigurationTarget,
  PluginInfo,
  SkillInfo
} from '@shared/ipc'
import { PERMISSION_MODE_LABELS } from '@shared/types'
import { Kbd } from '../../design-system/Kbd'
import { CrescentLogo } from '../../design-system/CrescentLogo'
import { useFarsideStore } from '../../lib/store'
import { usePreferences, type AppLocale, type AppTheme } from '../../lib/preferences'
import { AccountSetup } from './AccountSetup'

type SettingsSection = 'account' | 'extensions' | 'configuration' | 'general' | 'about'
type ExtensionTab = 'mcp' | 'skills' | 'plugins' | 'market'

const NAV: Array<{ id: SettingsSection; label: string; note: string; mark: string }> = [
  { id: 'account', label: '账户', note: 'Provider 与用量', mark: '01' },
  { id: 'extensions', label: '扩展中心', note: 'MCP · Skill · Plugin', mark: '02' },
  { id: 'configuration', label: '配置文件', note: '磁盘双向同步', mark: '03' },
  { id: 'general', label: '偏好与权限', note: '链路 · 快捷键', mark: '04' },
  { id: 'about', label: '关于', note: '版本与运行时', mark: '05' }
]

const EMPTY_SNAPSHOT: ConfigurationSnapshot = {
  configToml: '',
  mcpJson: '{\n  "mcpServers": {}\n}\n',
  agentsMarkdown: '',
  plugins: [],
  userSkills: [],
  paths: {
    config: '~/.kimi-code/config.toml',
    mcp: '~/.kimi-code/mcp.json',
    instructions: '~/.kimi-code/AGENTS.md',
    skills: '~/.kimi-code/skills',
    plugins: '~/.kimi-code/plugins'
  },
  updatedAt: Date.now()
}

const buttonStyle = {
  padding: '6px 10px',
  border: '1px solid var(--line-hi)',
  borderRadius: 6,
  color: 'var(--dust)',
  fontSize: 11.5,
  background: 'var(--regolith)'
} as const

const inputStyle = {
  minWidth: 0,
  padding: '7px 9px',
  border: '1px solid var(--line)',
  borderRadius: 6,
  background: 'var(--mare)',
  color: 'var(--moonlight)',
  fontSize: 11.5,
  outline: 'none'
} as const

function PanelTitle({ eyebrow, title, note, actions }: { eyebrow: string; title: string; note: string; actions?: ReactNode }) {
  return (
    <div style={{ minHeight: 69, padding: '14px 18px 12px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 16 }}>
      <div style={{ minWidth: 0 }}>
        <div className="mono" style={{ fontSize: 9.5, letterSpacing: '0.18em', color: 'var(--faint)', textTransform: 'uppercase' }}>{eyebrow}</div>
        <h2 style={{ margin: '3px 0 0', fontSize: 16, fontWeight: 500, color: 'var(--moonlight)' }}>{title}</h2>
        <p style={{ margin: '3px 0 0', fontSize: 11.5, color: 'var(--faint)' }}>{note}</p>
      </div>
      {actions ? <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7 }}>{actions}</div> : null}
    </div>
  )
}

function Switch({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{ width: 32, height: 18, padding: 2, borderRadius: 999, background: checked ? 'color-mix(in srgb, var(--moonlight) 38%, var(--mare))' : 'var(--line)', opacity: disabled ? 0.4 : 1 }}
    >
      <span style={{ display: 'block', width: 14, height: 14, borderRadius: '50%', background: checked ? 'var(--moonlight)' : 'var(--faint)', transform: checked ? 'translateX(14px)' : 'translateX(0)', transition: 'transform 140ms ease' }} />
    </button>
  )
}

function StatusLine({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <span className="mono" style={{ fontSize: 10.5, color: error ? 'var(--redshift)' : 'var(--faint)' }}>{children}</span>
}

function UsageMeter({ label, usedPct, resetAt }: { label: string; usedPct: number; resetAt?: string }) {
  const { locale, t } = usePreferences()
  const safe = Math.min(100, Math.max(0, usedPct))
  const reset = resetAt && !Number.isNaN(new Date(resetAt).getTime())
    ? new Date(resetAt).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : t('重置时间未知')
  return (
    <div style={{ display: 'grid', gap: 7 }}>
      <div style={{ display: 'flex', gap: 10, fontSize: 11.5 }}><span style={{ color: 'var(--dust)' }}>{label}</span><span className="mono" style={{ marginLeft: 'auto', color: 'var(--moonlight)' }}>{t('剩余')} {Math.round(100 - safe)}%</span><span className="mono" style={{ color: 'var(--faint)' }}>{reset}</span></div>
      <div style={{ height: 3, borderRadius: 999, background: 'var(--line)', overflow: 'hidden' }}><div style={{ width: `${safe}%`, height: '100%', background: safe > 80 ? 'var(--flare)' : 'var(--moonlight)' }} /></div>
    </div>
  )
}

function AccountPanel() {
  const { t } = usePreferences()
  const account = useFarsideStore((state) => state.account)
  const refreshAccount = useFarsideStore((state) => state.refreshAccount)
  const [refreshing, setRefreshing] = useState(false)
  const active = account?.providers.find((provider) => provider.active)
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <PanelTitle eyebrow="Identity / Provider" title={t('账户与接入')} note={t('OAuth 用量、官方 API 与 OpenAI 兼容服务集中管理')} actions={<button style={buttonStyle} disabled={refreshing} onClick={() => { setRefreshing(true); void refreshAccount().finally(() => setRefreshing(false)) }}>{refreshing ? t('刷新中…') : t('刷新账户')}</button>} />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 18 }}>
        <div style={{ maxWidth: 760, display: 'grid', gap: 14 }}>
          <div style={{ border: '1px solid var(--line)', borderRadius: 9, background: 'var(--regolith)', padding: 16, display: 'grid', gap: 15 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 36, height: 36, display: 'grid', placeItems: 'center', borderRadius: '50%', border: '1px solid var(--line-hi)', background: 'var(--mare)' }}><CrescentLogo size={21} /></div>
              <div><strong style={{ fontSize: 14, fontWeight: 500, color: 'var(--moonlight)' }}>{account?.usage?.planLabel ?? active?.label ?? t('尚未配置')}</strong><div className="mono" style={{ marginTop: 3, fontSize: 10.5, color: 'var(--faint)' }}>{active?.label ?? 'NO ACTIVE PROVIDER'}{account?.activeModel ? ` · ${account.activeModel}` : ''}</div></div>
              <a href="https://www.kimi.com/membership/pricing?from=farside" target="_blank" rel="noreferrer" style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--moonlight)' }}>{t('官方套餐与升级 ↗')}</a>
            </div>
            {account?.usage?.fiveHour ? <UsageMeter label={t('5 小时窗口')} usedPct={account.usage.fiveHour.usedPct} resetAt={account.usage.fiveHour.resetAt} /> : null}
            {account?.usage?.weekly ? <UsageMeter label={t('周周期')} usedPct={account.usage.weekly.usedPct} resetAt={account.usage.weekly.resetAt} /> : null}
            {!account?.usage?.fiveHour && !account?.usage?.weekly ? <p style={{ margin: 0, fontSize: 11.5, color: 'var(--faint)' }}>{account?.usage?.error ?? t('API Key 接入不提供会员周期读数；Kimi OAuth 可显示套餐和限额。')}</p> : null}
          </div>
          <AccountSetup />
        </div>
      </div>
    </div>
  )
}

type McpServerConfig = Record<string, unknown>

function parseMcp(source: string): Record<string, McpServerConfig> {
  try {
    const parsed = JSON.parse(source) as { mcpServers?: unknown }
    return parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
      ? parsed.mcpServers as Record<string, McpServerConfig>
      : {}
  } catch {
    return {}
  }
}

function mcpKind(config: McpServerConfig): string {
  if (config.transport === 'sse') return 'SSE'
  if (typeof config.url === 'string') return 'HTTP'
  return 'STDIO'
}

function ExtensionRow({ title, subtitle, meta, children }: { title: string; subtitle?: string; meta?: string; children: ReactNode }) {
  return (
    <div style={{ minHeight: 58, padding: '9px 11px', border: '1px solid var(--line)', borderRadius: 7, background: 'color-mix(in srgb, var(--regolith) 82%, transparent)', display: 'flex', alignItems: 'center', gap: 11 }}>
      <div style={{ minWidth: 0 }}><div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}><strong className="mono" style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--moonlight)' }}>{title}</strong>{meta ? <span className="mono" style={{ fontSize: 9.5, color: 'var(--ghost)' }}>{meta}</span> : null}</div>{subtitle ? <div style={{ marginTop: 4, fontSize: 10.5, color: 'var(--faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</div> : null}</div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 9 }}>{children}</div>
    </div>
  )
}

function McpManager({ snapshot, onSnapshot }: { snapshot: ConfigurationSnapshot; onSnapshot: (snapshot: ConfigurationSnapshot) => void }) {
  const { locale, t } = usePreferences()
  const servers = useMemo(() => parseMcp(snapshot.mcpJson), [snapshot.mcpJson])
  const [runtime, setRuntime] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', transport: 'stdio', command: '', args: '', url: '' })
  const [status, setStatus] = useState('')

  useEffect(() => {
    void window.api?.agent.listMcpServers().then((result) => {
      if (result?.ok) setRuntime(Object.fromEntries(result.servers.map((server) => [server.name, server.status])))
    })
  }, [snapshot.mcpJson])

  const persist = (next: Record<string, McpServerConfig>, message: string) => {
    setStatus('写入 mcp.json…')
    void window.api?.configuration.save({ target: 'mcp', content: `${JSON.stringify({ mcpServers: next }, null, 2)}\n` }).then((result) => {
      if (!result?.ok || !result.snapshot) { setStatus(result?.error ?? '保存失败'); return }
      onSnapshot(result.snapshot)
      setStatus(message)
    })
  }

  const add = () => {
    const name = form.name.trim()
    if (!name || servers[name]) { setStatus(name ? '名称已存在' : '请输入名称'); return }
    let config: McpServerConfig
    if (form.transport === 'stdio') {
      if (!form.command.trim()) { setStatus('STDIO 需要 command'); return }
      config = { command: form.command.trim(), ...(form.args.trim() ? { args: form.args.split(/\r?\n/).map((arg) => arg.trim()).filter(Boolean) } : {}) }
    } else {
      try { new URL(form.url.trim()) } catch { setStatus('请输入有效 URL'); return }
      config = { url: form.url.trim(), ...(form.transport === 'sse' ? { transport: 'sse' } : {}) }
    }
    persist({ ...servers, [name]: config }, `已添加 ${name}；新会话生效`)
    setForm({ name: '', transport: 'stdio', command: '', args: '', url: '' })
    setAdding(false)
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}><p style={{ margin: 0, fontSize: 11.5, color: 'var(--faint)' }}>{t('可视化维护用户级 mcp.json；运行态来自 Kimi Server。')}</p><button style={{ ...buttonStyle, marginLeft: 'auto' }} onClick={() => setAdding((value) => !value)}>{adding ? t('取消') : t('+ 添加 MCP')}</button></div>
      {adding ? <div style={{ padding: 11, border: '1px solid var(--line-hi)', borderRadius: 7, display: 'grid', gridTemplateColumns: 'minmax(120px,.7fr) 95px minmax(160px,1.3fr) auto', gap: 7 }}><input style={inputStyle} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={t('唯一名称')} /><select style={inputStyle} value={form.transport} onChange={(event) => setForm({ ...form, transport: event.target.value })}><option value="stdio">STDIO</option><option value="http">HTTP</option><option value="sse">SSE</option></select>{form.transport === 'stdio' ? <input style={inputStyle} value={form.command} onChange={(event) => setForm({ ...form, command: event.target.value })} placeholder={locale === 'en-US' ? 'command, e.g. npx' : 'command，例如 npx'} /> : <input style={inputStyle} value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="https://…" />}<button style={buttonStyle} onClick={add}>{t('保存')}</button>{form.transport === 'stdio' ? <textarea style={{ ...inputStyle, gridColumn: '3 / 5', minHeight: 54, resize: 'vertical', fontFamily: 'var(--font-mono)' }} value={form.args} onChange={(event) => setForm({ ...form, args: event.target.value })} placeholder={`${t('参数，每行一个')}\n-y`} /> : null}</div> : null}
      <div style={{ display: 'grid', gap: 6 }}>{Object.entries(servers).map(([name, config]) => <ExtensionRow key={name} title={name} subtitle={typeof config.command === 'string' ? `${config.command} ${Array.isArray(config.args) ? config.args.join(' ') : ''}` : String(config.url ?? '')} meta={`${mcpKind(config)} · ${runtime[name] ?? t('待连接')}`}><Switch label={`${name} MCP`} checked={config.enabled !== false} onChange={(enabled) => persist({ ...servers, [name]: { ...config, enabled } }, locale === 'en-US' ? `${name} ${enabled ? 'enabled' : 'disabled'}; applies to new sessions` : `${name} 已${enabled ? '启用' : '停用'}；新会话生效`)} /><button style={{ color: 'var(--redshift)', fontSize: 10.5 }} onClick={() => { if (window.confirm(locale === 'en-US' ? `Remove MCP “${name}”?` : `移除 MCP “${name}”？`)) persist(Object.fromEntries(Object.entries(servers).filter(([id]) => id !== name)), locale === 'en-US' ? `Removed ${name}` : `已移除 ${name}`) }}>{t('移除')}</button></ExtensionRow>)}{!Object.keys(servers).length ? <div style={{ padding: 28, textAlign: 'center', border: '1px dashed var(--line)', borderRadius: 8, color: 'var(--faint)', fontSize: 11.5 }}>{t('尚未添加 MCP Server')}</div> : null}</div>
      {status ? <StatusLine error={/失败|无效|需要|请输入|存在/.test(status)}>{status}</StatusLine> : null}
    </div>
  )
}

function SourceInstaller({ kind, placeholder, onDone }: { kind: 'skill' | 'plugin'; placeholder: string; onDone: (snapshot: ConfigurationSnapshot, message: string) => void }) {
  const { t } = usePreferences()
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const install = () => {
    if (!source.trim() || busy) return
    setBusy(true); setStatus(kind === 'skill' ? '正在扫描并安装 Skill…' : '正在验证并安装 Plugin…')
    void window.api?.configuration.manage({ kind, action: 'install', source: source.trim() }).then((result) => {
      setBusy(false)
      if (!result?.ok || !result.snapshot) { setStatus(result?.error ?? '安装失败'); return }
      onDone(result.snapshot, `${kind === 'skill' ? 'Skill' : 'Plugin'} 已安装`)
      setSource(''); setStatus('')
    })
  }
  return <div><div style={{ display: 'flex', gap: 7 }}><input style={{ ...inputStyle, flex: 1 }} value={source} onChange={(event) => setSource(event.target.value)} placeholder={t(placeholder)} /><button style={buttonStyle} disabled={!source.trim() || busy} onClick={install}>{busy ? t('安装中…') : t('安装')}</button></div>{status ? <div style={{ marginTop: 6 }}><StatusLine error={status.includes('失败')}>{status}</StatusLine></div> : null}</div>
}

function SkillManager({ snapshot, onSnapshot }: { snapshot: ConfigurationSnapshot; onSnapshot: (snapshot: ConfigurationSnapshot) => void }) {
  const { locale, t } = usePreferences()
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({ name: '', description: '' })
  const [status, setStatus] = useState('')
  const run = (input: ConfigurationManageInput, success: string) => {
    setStatus('更新中…')
    void window.api?.configuration.manage(input).then((result) => {
      if (!result?.ok || !result.snapshot) { setStatus(result?.error ?? '操作失败'); return }
      onSnapshot(result.snapshot); setStatus(success)
    })
  }
  return <div style={{ display: 'grid', gap: 10 }}><div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px,1fr) auto', gap: 7 }}><SourceInstaller kind="skill" placeholder="GitHub owner/repo、仓库 URL 或本地 Skill 目录" onDone={(next, message) => { onSnapshot(next); setStatus(message) }} /><button style={buttonStyle} onClick={() => setCreating((value) => !value)}>{creating ? t('取消新建') : t('+ 新建 Skill')}</button></div>{creating ? <div style={{ display: 'grid', gridTemplateColumns: '170px 1fr auto', gap: 7, padding: 10, border: '1px solid var(--line-hi)', borderRadius: 7 }}><input style={inputStyle} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="skill-id" /><input style={inputStyle} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder={t('何时使用这个 Skill')} /><button style={buttonStyle} onClick={() => { run({ kind: 'skill', action: 'create', ...draft }, locale === 'en-US' ? 'Skill created' : 'Skill 已创建'); setCreating(false); setDraft({ name: '', description: '' }) }}>{t('创建')}</button></div> : null}<div style={{ display: 'grid', gap: 6 }}>{snapshot.userSkills.map((skill: SkillInfo) => <ExtensionRow key={skill.path} title={skill.name} subtitle={skill.description || skill.path} meta={skill.managed ? 'KIMI USER' : 'SHARED'}><span style={{ fontSize: 10.5, color: 'var(--faint)' }}>{t('自动调用')}</span><Switch label={`${skill.name} ${t('自动调用')}`} checked={!skill.disabledForModel} disabled={!skill.managed} onChange={(enabled) => run({ kind: 'skill', action: 'toggle', path: skill.path, enabled }, locale === 'en-US' ? `${skill.name} auto invocation ${enabled ? 'enabled' : 'disabled'}` : `${skill.name} 自动调用已${enabled ? '启用' : '关闭'}`)} />{skill.managed ? <button style={{ color: 'var(--redshift)', fontSize: 10.5 }} onClick={() => { if (window.confirm(locale === 'en-US' ? `Delete Skill “${skill.name}” and its directory?` : `删除 Skill “${skill.name}”及其目录？`)) run({ kind: 'skill', action: 'remove', path: skill.path }, locale === 'en-US' ? `Deleted ${skill.name}` : `已删除 ${skill.name}`) }}>{t('删除')}</button> : null}</ExtensionRow>)}{!snapshot.userSkills.length ? <div style={{ padding: 28, textAlign: 'center', border: '1px dashed var(--line)', borderRadius: 8, color: 'var(--faint)', fontSize: 11.5 }}>{t('没有发现用户 Skill')}</div> : null}</div>{status ? <StatusLine error={status.includes('失败')}>{status}</StatusLine> : null}</div>
}

function PluginManager({ snapshot, onSnapshot }: { snapshot: ConfigurationSnapshot; onSnapshot: (snapshot: ConfigurationSnapshot) => void }) {
  const { locale, t } = usePreferences()
  const [status, setStatus] = useState('')
  const run = (input: ConfigurationManageInput, success: string) => {
    setStatus('更新插件登记…')
    void window.api?.configuration.manage(input).then((result) => {
      if (!result?.ok || !result.snapshot) { setStatus(result?.error ?? '操作失败'); return }
      onSnapshot(result.snapshot); setStatus(success)
    })
  }
  return <div style={{ display: 'grid', gap: 10 }}><SourceInstaller kind="plugin" placeholder="GitHub owner/repo、仓库 URL 或本地 Plugin 目录" onDone={(next) => { onSnapshot(next); setStatus(locale === 'en-US' ? 'Plugin installed; applies to new sessions or after /reload' : '插件已安装；新会话或 /reload 生效') }} /><div style={{ padding: '7px 9px', borderLeft: '2px solid var(--line-hi)', color: 'var(--faint)', fontSize: 10.5 }}>{t('第三方插件可执行代码。安装前请确认来源可信；Farside 会复制到 Kimi 官方 managed 目录。')}</div><div style={{ display: 'grid', gap: 6 }}>{snapshot.plugins.map((plugin: PluginInfo) => <ExtensionRow key={plugin.id} title={plugin.name} subtitle={plugin.description || plugin.source || plugin.root} meta={`${plugin.version ?? 'VERSION —'} · ${plugin.enabled ? 'ENABLED' : 'DISABLED'}`}><Switch label={`${plugin.name} Plugin`} checked={plugin.enabled} onChange={(enabled) => run({ kind: 'plugin', action: 'toggle', id: plugin.id, enabled }, locale === 'en-US' ? `${plugin.name} ${enabled ? 'enabled' : 'disabled'}; applies to new sessions` : `${plugin.name} 已${enabled ? '启用' : '停用'}；新会话生效`)} /><button style={{ color: 'var(--redshift)', fontSize: 10.5 }} onClick={() => { if (window.confirm(locale === 'en-US' ? `Remove Plugin “${plugin.name}” from Kimi? The managed copy will remain.` : `从 Kimi 登记中移除 Plugin “${plugin.name}”？managed 副本会保留。`)) run({ kind: 'plugin', action: 'remove', id: plugin.id }, locale === 'en-US' ? `Removed ${plugin.name}` : `已移除 ${plugin.name}`) }}>{t('移除')}</button></ExtensionRow>)}{!snapshot.plugins.length ? <div style={{ padding: 28, textAlign: 'center', border: '1px dashed var(--line)', borderRadius: 8, color: 'var(--faint)', fontSize: 11.5 }}>{t('尚未安装 Plugin')}</div> : null}</div>{status ? <StatusLine error={status.includes('失败')}>{status}</StatusLine> : null}</div>
}

const MARKETS = [
  { kind: 'MCP', name: 'MCP Registry', note: 'Model Context Protocol 官方注册表', url: 'https://registry.modelcontextprotocol.io/' },
  { kind: 'MCP', name: 'Smithery', note: 'MCP Server 发现与配置', url: 'https://smithery.ai/' },
  { kind: 'MCP', name: 'Glama', note: '扩展索引与 MCP 目录', url: 'https://glama.ai/mcp/servers' },
  { kind: 'SKILL', name: 'skills.sh', note: '开放 Agent Skill 市场', url: 'https://skills.sh/' },
  { kind: 'SKILL', name: 'GitHub Skills', note: '社区 Agent Skill 仓库', url: 'https://github.com/topics/agent-skills' },
  { kind: 'PLUGIN', name: 'Kimi 官方市场', note: '由 Kimi /plugins marketplace 提供', url: '' }
]

function MarketPanel() {
  const { t } = usePreferences()
  const [query, setQuery] = useState('')
  const setDraft = useFarsideStore((state) => state.setDraft)
  const setView = useFarsideStore((state) => state.setView)
  return <div style={{ display: 'grid', gap: 12 }}><div style={{ display: 'flex', gap: 7 }}><input style={{ ...inputStyle, flex: 1 }} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索扩展，例如 browser automation')} /><a style={buttonStyle} href={`https://www.google.com/search?q=${encodeURIComponent(`${query} site:registry.modelcontextprotocol.io OR site:skills.sh OR site:smithery.ai`)}`} target="_blank" rel="noreferrer">{t('跨市场搜索 ↗')}</a></div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(220px, 1fr))', gap: 8 }}>{MARKETS.map((market) => market.url ? <a key={market.name} href={market.url} target="_blank" rel="noreferrer" style={{ minHeight: 86, padding: 12, border: '1px solid var(--line)', borderRadius: 8, background: 'var(--regolith)', color: 'inherit' }}><span className="mono" style={{ fontSize: 9.5, color: 'var(--ghost)' }}>{market.kind}</span><div style={{ marginTop: 8, fontSize: 13, color: 'var(--moonlight)' }}>{t(market.name)} <span style={{ color: 'var(--faint)' }}>↗</span></div><div style={{ marginTop: 4, fontSize: 10.5, color: 'var(--faint)' }}>{t(market.note)}</div></a> : <button key={market.name} onClick={() => { setDraft('/plugins marketplace'); setView('sessions') }} style={{ minHeight: 86, padding: 12, textAlign: 'left', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--regolith)' }}><span className="mono" style={{ fontSize: 9.5, color: 'var(--ghost)' }}>{market.kind}</span><div style={{ marginTop: 8, fontSize: 13, color: 'var(--moonlight)' }}>{t(market.name)} <span style={{ color: 'var(--faint)' }}>→</span></div><div style={{ marginTop: 4, fontSize: 10.5, color: 'var(--faint)' }}>{t(market.note)}</div></button>)}</div><p style={{ margin: 0, fontSize: 10.5, lineHeight: 1.6, color: 'var(--faint)' }}>{t('市场只负责发现。安装仍需在 MCP、Skills 或 Plugins 标签中确认来源，避免未经审查的代码直接进入 Agent 环境。')}</p></div>
}

function ExtensionCenter({ snapshot, onSnapshot }: { snapshot: ConfigurationSnapshot; onSnapshot: (snapshot: ConfigurationSnapshot) => void }) {
  const { t } = usePreferences()
  const [tab, setTab] = useState<ExtensionTab>('mcp')
  const tabs: Array<{ id: ExtensionTab; label: string; count?: number }> = [
    { id: 'mcp', label: 'MCP', count: Object.keys(parseMcp(snapshot.mcpJson)).length },
    { id: 'skills', label: 'Skills', count: snapshot.userSkills.length },
    { id: 'plugins', label: 'Plugins', count: snapshot.plugins.length },
    { id: 'market', label: t('发现市场') }
  ]
  return <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}><PanelTitle eyebrow="Extension Control" title={t('扩展中心')} note={t('从发现、安装到启停和移除的完整闭环')} actions={<button style={buttonStyle} onClick={() => void window.api?.configuration.open(tab === 'skills' ? 'skills' : tab === 'plugins' ? 'plugins' : 'mcp')}>{t('在资源管理器中打开')}</button>} /><div style={{ height: 43, padding: '0 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'end', gap: 18 }}>{tabs.map((item) => <button key={item.id} onClick={() => setTab(item.id)} style={{ height: 43, borderBottom: tab === item.id ? '1px solid var(--moonlight)' : '1px solid transparent', color: tab === item.id ? 'var(--moonlight)' : 'var(--faint)', fontSize: 11.5 }}>{item.label}{item.count !== undefined ? <span className="mono" style={{ marginLeft: 6, fontSize: 9.5, color: 'var(--ghost)' }}>{item.count}</span> : null}</button>)}</div><div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>{tab === 'mcp' ? <McpManager snapshot={snapshot} onSnapshot={onSnapshot} /> : null}{tab === 'skills' ? <SkillManager snapshot={snapshot} onSnapshot={onSnapshot} /> : null}{tab === 'plugins' ? <PluginManager snapshot={snapshot} onSnapshot={onSnapshot} /> : null}{tab === 'market' ? <MarketPanel /> : null}</div></div>
}

function ConfigurationEditor({ snapshot, onSnapshot }: { snapshot: ConfigurationSnapshot; onSnapshot: (snapshot: ConfigurationSnapshot) => void }) {
  const { locale, t } = usePreferences()
  const [target, setTarget] = useState<ConfigurationTarget>('config')
  const content = target === 'config' ? snapshot.configToml : target === 'mcp' ? snapshot.mcpJson : snapshot.agentsMarkdown
  const [draft, setDraft] = useState(content)
  const [status, setStatus] = useState('已连接磁盘监听')
  useEffect(() => { setDraft(content); setStatus('已从磁盘同步') }, [content])
  const dirty = draft !== content
  const save = () => {
    setStatus('保存并校验…')
    void window.api?.configuration.save({ target, content: draft }).then((result) => {
      if (!result?.ok || !result.snapshot) { setStatus(result?.error ?? '保存失败'); return }
      onSnapshot(result.snapshot); setStatus('已写入磁盘')
    })
  }
  const meta: Record<ConfigurationTarget, { label: string; note: string }> = {
    config: { label: 'config.toml', note: 'Provider、模型与 Kimi Code 运行参数' },
    mcp: { label: 'mcp.json', note: '用户级 MCP Server 原始配置' },
    instructions: { label: 'AGENTS.md', note: '所有项目继承的全局 Agent 指令' }
  }
  return <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}><PanelTitle eyebrow="Disk Source of Truth" title={t('配置文件')} note={t('本地文件与编辑器双向热同步；外部修改会自动载入')} actions={<><StatusLine error={status.includes('失败')}>{dirty ? t('未保存改动') : status}</StatusLine><button style={buttonStyle} onClick={() => void window.api?.configuration.open(target)}>{t('系统中打开')}</button><button style={{ ...buttonStyle, color: 'var(--moonlight)' }} disabled={!dirty} onClick={save}>{t('保存')}</button></>} /><div style={{ minHeight: 52, padding: '0 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 7 }}>{(Object.keys(meta) as ConfigurationTarget[]).map((id) => <button key={id} onClick={() => setTarget(id)} style={{ padding: '6px 9px', borderRadius: 6, border: `1px solid ${target === id ? 'var(--line-hi)' : 'transparent'}`, background: target === id ? 'var(--regolith)' : 'transparent', color: target === id ? 'var(--moonlight)' : 'var(--faint)', fontSize: 11 }}>{meta[id].label}</button>)}<span className="mono" style={{ marginLeft: 'auto', maxWidth: '46%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 9.5, color: 'var(--ghost)' }}>{snapshot.paths[target]}</span></div><div style={{ flex: 1, minHeight: 0, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}><div style={{ display: 'flex', alignItems: 'center' }}><span style={{ fontSize: 11, color: 'var(--faint)' }}>{t(meta[target].note)}</span><span className="mono" style={{ marginLeft: 'auto', fontSize: 9.5, color: 'var(--ghost)' }}>LIVE · {new Date(snapshot.updatedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div><textarea value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} style={{ flex: 1, minHeight: 0, width: '100%', resize: 'none', padding: 13, border: '1px solid var(--line)', borderRadius: 7, background: 'var(--mare)', color: 'var(--dust)', fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.65, outline: 'none' }} /></div></div>
}

const SHORTCUTS = [
  ['命令面板', '⌘K / Ctrl+K'], ['切换侧栏', '⌘B / Ctrl+B'], ['切换任务面板', '⌘J / Ctrl+J'], ['计划模式', 'Shift+Tab'], ['中断当前任务', 'Esc']
]

function GeneralPanel({ info, cli, hasApi }: { info: AppInfo | null; cli: CliStatus | null; hasApi: boolean }) {
  const permissionMode = useFarsideStore((state) => state.permissionMode)
  const { locale, theme, setLocale, setTheme, t } = usePreferences()
  const segment = <T extends string>(value: T, current: T, onChange: (next: T) => void, label: string) => (
    <button onClick={() => onChange(value)} style={{ padding: '5px 10px', border: `1px solid ${current === value ? 'var(--line-hi)' : 'transparent'}`, borderRadius: 5, background: current === value ? 'var(--crater)' : 'transparent', color: current === value ? 'var(--moonlight)' : 'var(--faint)', fontSize: 11 }}>{label}</button>
  )
  const permissionLabel = permissionMode === 'manual' ? (locale === 'en-US' ? 'Manual approval' : PERMISSION_MODE_LABELS.manual) : permissionMode === 'auto' ? (locale === 'en-US' ? 'Automatic' : PERMISSION_MODE_LABELS.auto) : (locale === 'en-US' ? 'YOLO' : PERMISSION_MODE_LABELS.yolo)
  const runtimeLabel = !hasApi ? t('浏览器预览') : cli?.installed ? `${cli.bundled ? t('内置运行时') : t('系统运行时')} · ${cli.version ?? t('版本未知')}` : t('未检测到')
  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <PanelTitle eyebrow="Runtime / Control" title={t('偏好与权限')} note={t('当前链路状态与键盘控制，一屏完成核对')} />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 18 }}>
        <div style={{ maxWidth: 820, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div style={{ gridColumn: '1 / -1', padding: 14, border: '1px solid var(--line-hi)', borderRadius: 8, background: 'var(--regolith)' }}>
            <div className="mono" style={{ fontSize: 9.5, color: 'var(--ghost)', letterSpacing: '.14em' }}>APPEARANCE</div>
            <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '120px 1fr', gap: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 11.5, color: 'var(--dust)' }}>{t('语言')}</span>
              <div style={{ justifySelf: 'start', display: 'flex', padding: 2, border: '1px solid var(--line)', borderRadius: 7, background: 'var(--mare)' }}>{segment<AppLocale>('zh-CN', locale, setLocale, t('中文'))}{segment<AppLocale>('en-US', locale, setLocale, t('英文'))}</div>
              <span style={{ fontSize: 11.5, color: 'var(--dust)' }}>{t('主题')}</span>
              <div style={{ justifySelf: 'start', display: 'flex', padding: 2, border: '1px solid var(--line)', borderRadius: 7, background: 'var(--mare)' }}>{segment<AppTheme>('dark', theme, setTheme, t('暗黑'))}{segment<AppTheme>('light', theme, setTheme, t('明亮'))}</div>
            </div>
            <p style={{ margin: '10px 0 0', fontSize: 10.5, color: 'var(--faint)' }}>{t('默认使用中文与暗黑主题，偏好会保存在本机。')}</p>
          </div>
          <div style={{ padding: 14, border: '1px solid var(--line)', borderRadius: 8, background: 'var(--regolith)' }}><div className="mono" style={{ fontSize: 9.5, color: 'var(--ghost)', letterSpacing: '.14em' }}>LINK STATUS</div><div style={{ marginTop: 12, display: 'grid', gap: 9, fontSize: 11.5 }}>{[['Kimi Code', runtimeLabel], [t('登录态'), cli?.loggedIn === true ? t('已登录') : cli?.loggedIn === false ? t('未登录') : t('无法判定')], [t('桌面端'), info ? `Farside ${info.appVersion}` : '—'], [t('运行时'), info ? `Electron ${info.electronVersion}` : '—']].map(([label, value]) => <div key={label} style={{ display: 'flex', gap: 12 }}><span style={{ color: 'var(--faint)' }}>{label}</span><span className="mono" style={{ marginLeft: 'auto', color: 'var(--dust)' }}>{value}</span></div>)}</div></div>
          <div style={{ padding: 14, border: '1px solid var(--line)', borderRadius: 8, background: 'var(--regolith)' }}><div className="mono" style={{ fontSize: 9.5, color: 'var(--ghost)', letterSpacing: '.14em' }}>PERMISSION</div><div className="mono" style={{ marginTop: 12, fontSize: 12.5, color: 'var(--moonlight)' }}>{permissionLabel}</div><p style={{ margin: '8px 0 0', fontSize: 11, lineHeight: 1.6, color: 'var(--faint)' }}>{t(permissionMode === 'manual' ? '读类工具自动放行，写入与执行逐项确认。' : permissionMode === 'auto' ? '自动处理审批，适合可信工作区。' : '跳过常规审批，请只在隔离环境使用。')}</p></div>
          <div style={{ gridColumn: '1 / -1', padding: 14, border: '1px solid var(--line)', borderRadius: 8 }}><div className="mono" style={{ fontSize: 9.5, color: 'var(--ghost)', letterSpacing: '.14em' }}>KEYBOARD</div><div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>{SHORTCUTS.map(([label, keys]) => <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ fontSize: 11.5, color: 'var(--dust)' }}>{t(label)}</span><span style={{ marginLeft: 'auto' }}><Kbd>{keys}</Kbd></span></div>)}</div></div>
        </div>
      </div>
    </div>
  )
}

function AboutPanel({ info }: { info: AppInfo | null }) {
  const { t } = usePreferences()
  return <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}><PanelTitle eyebrow="Farside Desktop" title={t('关于')} note={t('为 Kimi Code 打造的桌面 Agent 工作台')} /><div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 24 }}><div style={{ width: 'min(520px, 100%)', padding: 28, border: '1px solid var(--line)', borderRadius: 12, background: 'var(--regolith)', textAlign: 'center' }}><CrescentLogo size={44} /><div style={{ marginTop: 15, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18, letterSpacing: '.28em', color: 'var(--moonlight)' }}>FARSIDE</div><p style={{ margin: '8px 0 0', color: 'var(--faint)', fontSize: 12 }}>{t('月之暗面 · Kimi Code 桌面端')}</p><div className="mono" style={{ marginTop: 22, paddingTop: 14, borderTop: '1px solid var(--line)', color: 'var(--ghost)', fontSize: 10.5 }}>VERSION {info?.appVersion ?? '—'} · ELECTRON {info?.electronVersion ?? '—'} · {info ? `${info.platform}/${info.arch}` : 'RUNTIME —'}</div></div></div></div>
}

export function SettingsView() {
  const { t } = usePreferences()
  const [section, setSection] = useState<SettingsSection>(() => new URLSearchParams(window.location.search).get('shot') === 'settings-light' ? 'general' : 'extensions')
  const [snapshot, setSnapshot] = useState<ConfigurationSnapshot>(EMPTY_SNAPSHOT)
  const [configError, setConfigError] = useState('')
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [cli, setCli] = useState<CliStatus | null>(null)
  const hasApi = typeof window !== 'undefined' && window.api != null

  useEffect(() => {
    const api = window.api
    if (!api) return
    let alive = true
    void api.getAppInfo().then((value) => alive && setInfo(value)).catch(() => undefined)
    void api.detectCli().then((value) => alive && setCli(value)).catch(() => undefined)
    void api.configuration.get().then((result) => {
      if (!alive) return
      if (result.ok && result.snapshot) setSnapshot(result.snapshot)
      else setConfigError(result.error ?? '配置读取失败')
    })
    const unsubscribe = api.configuration.onChanged((next) => {
      if (alive) { setSnapshot(next); setConfigError('') }
    })
    return () => { alive = false; unsubscribe() }
  }, [hasApi])

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--void)' }}>
      <div style={{ height: 64, flexShrink: 0, padding: '0 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center' }}><div><h1 style={{ margin: 0, fontSize: 18, fontWeight: 500, color: 'var(--moonlight)' }}>{t('设置控制中心')}</h1><p style={{ margin: '4px 0 0', fontSize: 10.5, color: 'var(--faint)' }}>{t('账户、扩展与磁盘配置分区管理')}</p></div><div className="mono" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7, fontSize: 9.5, color: configError ? 'var(--redshift)' : 'var(--ghost)' }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: configError ? 'var(--redshift)' : 'var(--moonlight)' }} />{configError || 'CONFIG WATCH ACTIVE'}</div></div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <nav style={{ width: 196, flexShrink: 0, padding: 10, borderRight: '1px solid var(--line)', background: 'color-mix(in srgb, var(--regolith) 34%, var(--void))', overflowY: 'auto' }}>{NAV.map((item) => <button key={item.id} onClick={() => setSection(item.id)} style={{ width: '100%', minHeight: 52, padding: '8px 9px', marginBottom: 3, border: `1px solid ${section === item.id ? 'var(--line-hi)' : 'transparent'}`, borderRadius: 7, background: section === item.id ? 'var(--regolith)' : 'transparent', textAlign: 'left', display: 'grid', gridTemplateColumns: '23px 1fr', columnGap: 8 }}><span className="mono" style={{ gridRow: '1 / 3', fontSize: 9.5, paddingTop: 2, color: section === item.id ? 'var(--moonlight)' : 'var(--ghost)' }}>{item.mark}</span><span style={{ fontSize: 11.5, color: section === item.id ? 'var(--moonlight)' : 'var(--dust)' }}>{t(item.label)}</span><span style={{ marginTop: 3, fontSize: 9.5, color: 'var(--faint)' }}>{t(item.note)}</span></button>)}</nav>
        <section style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>{section === 'account' ? <AccountPanel /> : null}{section === 'extensions' ? <ExtensionCenter snapshot={snapshot} onSnapshot={setSnapshot} /> : null}{section === 'configuration' ? <ConfigurationEditor snapshot={snapshot} onSnapshot={setSnapshot} /> : null}{section === 'general' ? <GeneralPanel info={info} cli={cli} hasApi={hasApi} /> : null}{section === 'about' ? <AboutPanel info={info} /> : null}</section>
      </div>
    </div>
  )
}
