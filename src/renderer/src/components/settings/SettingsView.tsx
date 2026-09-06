import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  AppInfo,
  AppReleaseInfo,
  CliStatus,
  ConnectionSnapshot,
  ConfigurationManageInput,
  ConfigurationSnapshot,
  ConfigurationTarget,
  PluginInfo,
  ProjectHook,
  ProjectHookEvent,
  SshConnectionProfile,
  SkillInfo
} from '@shared/ipc'
import { PERMISSION_MODE_LABELS, type AccountProfileStats } from '@shared/types'
import { Kbd } from '../../design-system/Kbd'
import { CrescentLogo } from '../../design-system/CrescentLogo'
import { useFarsideStore } from '../../lib/store'
import { usePreferences, type AppLocale, type AppTheme } from '../../lib/preferences'
import { AccountSetup } from './AccountSetup'

type SettingsSection = 'account' | 'profile' | 'extensions' | 'configuration' | 'connections' | 'general' | 'about'
type ExtensionTab = 'mcp' | 'skills' | 'plugins' | 'market'

const NAV: Array<{ id: SettingsSection; label: string; note: string; mark: string }> = [
  { id: 'account', label: '账户', note: 'Provider 与用量', mark: '01' },
  { id: 'profile', label: '个人资料', note: '活动与使用洞察', mark: '02' },
  { id: 'extensions', label: '扩展中心', note: 'MCP · Skill · Plugin', mark: '03' },
  { id: 'configuration', label: '配置文件', note: '磁盘双向同步', mark: '04' },
  { id: 'connections', label: '连接', note: 'Remote · SSH', mark: '05' },
  { id: 'general', label: '偏好与权限', note: '链路 · 快捷键', mark: '06' },
  { id: 'about', label: '关于', note: '版本与运行时', mark: '07' }
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

/** 配置编辑器是否有未保存改动；设置页 Esc 返回前读取，避免静默丢弃草稿。 */
let settingsEditorDirty = false

const KIMI_CONSOLE_URL = 'https://www.kimi.com/code/console'
const KIMI_QUOTA_URL = 'https://www.kimi.com/membership/subscription?tab=quota'

function ConsoleSection({
  eyebrow,
  title,
  action,
  children
}: {
  eyebrow: string
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section style={{ display: 'grid', gap: 9 }}>
      <header style={{ display: 'flex', alignItems: 'end', gap: 12 }}>
        <div>
          <div className="mono" style={{ fontSize: 9, letterSpacing: '.15em', color: 'var(--ghost)' }}>{eyebrow}</div>
          <h3 style={{ margin: '3px 0 0', fontSize: 13.5, fontWeight: 500, color: 'var(--moonlight)' }}>{title}</h3>
        </div>
        {action ? <div style={{ marginLeft: 'auto' }}>{action}</div> : null}
      </header>
      {children}
    </section>
  )
}

function AccountActivity() {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
  const sessions = useFarsideStore((state) => state.sessions)
  const [tab, setTab] = useState<'model' | 'tool'>('model')
  const rows = useMemo(() => {
    const all = sessions.flatMap((session) =>
      session.events.flatMap((event) => {
        if (tab === 'model' && event.kind === 'telemetry') {
          return [{
            id: event.id,
            name: session.title,
            source: 'Farside',
            subject: session.model,
            detail: `${event.outputTokens ?? 0} out · ${event.contextTokens} ctx`,
            at: event.at,
            status: 'recorded'
          }]
        }
        if (tab === 'tool' && event.kind === 'instrument') {
          return [{
            id: event.id,
            name: session.title,
            source: 'Farside',
            subject: event.tool,
            detail: event.argsSummary || '—',
            at: event.at,
            status: event.status
          }]
        }
        return []
      })
    )
    return all.sort((a, b) => b.at - a.at).slice(0, 24)
  }, [sessions, tab])
  const statusLabel = (status: string) => {
    if (status === 'failed') return english ? 'Failed' : '失败'
    if (status === 'running') return english ? 'Running' : '执行中'
    return english ? 'Recorded' : '已记录'
  }
  return (
    <ConsoleSection eyebrow="LOCAL OBSERVATORY" title={english ? 'Model & tool activity' : '模型与工具调用记录'}>
      <div style={{ border: '1px solid var(--line)', borderRadius: 9, background: 'var(--regolith)', overflow: 'hidden' }}>
        <div style={{ height: 39, padding: '0 11px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'end', gap: 18 }}>
          {([
            ['model', english ? 'Model calls' : '模型调用'],
            ['tool', english ? 'Tool calls' : '工具调用']
          ] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              style={{
                height: 39,
                borderBottom: `1px solid ${tab === id ? 'var(--moonlight)' : 'transparent'}`,
                color: tab === id ? 'var(--moonlight)' : 'var(--faint)',
                fontSize: 11.5
              }}
            >
              {label}
            </button>
          ))}
          <span className="mono" style={{ margin: '0 0 11px auto', fontSize: 9.5, color: 'var(--faint)' }}>
            {english ? 'THIS DEVICE · LAST 24' : '仅本机 · 最近 24 条'}
          </span>
        </div>
        {rows.length ? (
          <div style={{ maxHeight: 288, overflowY: 'auto' }}>
            <div className="mono" style={{ minWidth: 650, display: 'grid', gridTemplateColumns: 'minmax(150px,1.1fr) 92px minmax(140px,1fr) 145px 68px', gap: 10, padding: '8px 11px', borderBottom: '1px solid var(--line)', color: 'var(--faint)', fontSize: 9 }}>
              <span>{english ? 'SESSION' : '会话'}</span><span>{english ? 'SOURCE' : '来源'}</span><span>{tab === 'model' ? (english ? 'MODEL' : '模型') : (english ? 'TOOL' : '工具')}</span><span>{english ? 'TIME / DETAIL' : '时间 / 详情'}</span><span>{english ? 'STATUS' : '状态'}</span>
            </div>
            {rows.map((row) => (
              <div key={row.id} style={{ minWidth: 650, display: 'grid', gridTemplateColumns: 'minmax(150px,1.1fr) 92px minmax(140px,1fr) 145px 68px', gap: 10, alignItems: 'center', padding: '9px 11px', borderBottom: '1px solid var(--line)', fontSize: 10.5 }}>
                <span title={row.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dust)' }}>{row.name}</span>
                <span className="mono" style={{ color: 'var(--faint)' }}>{row.source}</span>
                <span className="mono" title={row.subject} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--moonlight)' }}>{row.subject}</span>
                <span title={row.detail} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--faint)' }}>
                  {new Date(row.at).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {row.detail}
                </span>
                <span style={{ color: row.status === 'failed' ? 'var(--redshift)' : row.status === 'running' ? 'var(--flare)' : 'var(--signal)' }}>{statusLabel(row.status)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--faint)', fontSize: 11.5 }}>
            {english ? 'No local records yet.' : '本机暂时没有可用记录。'}
          </div>
        )}
      </div>
    </ConsoleSection>
  )
}

function AccountPanel({ info }: { info: AppInfo | null }) {
  const { locale, t } = usePreferences()
  const english = locale === 'en-US'
  const account = useFarsideStore((state) => state.account)
  const refreshAccount = useFarsideStore((state) => state.refreshAccount)
  const [refreshing, setRefreshing] = useState(false)
  const active = account?.providers.find((provider) => provider.active)
  const apiProviders = account?.providers.filter((provider) => provider.kind === 'kimi-api') ?? []
  const usage = account?.usage
  const monthlyUsed = usage?.extraMonthlyUsedCny ?? null
  const monthlyLimit = usage?.extraMonthlyLimitCny ?? null
  const monthlyPct =
    monthlyUsed !== null && monthlyLimit !== null && monthlyLimit > 0
      ? Math.min(100, Math.max(0, (monthlyUsed / monthlyLimit) * 100))
      : 0
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <PanelTitle eyebrow="Identity / Provider" title={t('账户与接入')} note={t('OAuth 用量、官方 API 与 OpenAI 兼容服务集中管理')} actions={<button style={buttonStyle} disabled={refreshing} onClick={() => { setRefreshing(true); void refreshAccount().finally(() => setRefreshing(false)) }}>{refreshing ? t('刷新中…') : t('刷新账户')}</button>} />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 18 }}>
        <div style={{ maxWidth: 940, display: 'grid', gap: 22 }}>
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

          <ConsoleSection
            eyebrow="BOOSTER WALLET"
            title={english ? 'Quota booster' : '额度加油包'}
            action={<a href={KIMI_QUOTA_URL} target="_blank" rel="noreferrer" style={buttonStyle}>{english ? 'Top up & manage ↗' : '充值与管理 ↗'}</a>}
          >
            <div style={{ padding: 15, border: '1px solid var(--line)', borderRadius: 9, background: 'var(--regolith)', display: 'grid', gap: 14 }}>
              <div style={{ display: 'flex', alignItems: 'end', gap: 18 }}>
                <div>
                  <div style={{ fontSize: 10.5, color: 'var(--faint)' }}>{english ? 'Current balance' : '当前余额'}</div>
                  <div className="mono" style={{ marginTop: 5, fontSize: 22, color: 'var(--moonlight)' }}>
                    {usage?.extraBalanceCny === null || usage?.extraBalanceCny === undefined ? '—' : `¥${usage.extraBalanceCny.toFixed(2)}`}
                  </div>
                </div>
                <div className="mono" style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--faint)' }}>
                  {monthlyUsed === null ? '—' : `¥${monthlyUsed.toFixed(2)}`} / {monthlyLimit === null ? '—' : `¥${monthlyLimit.toFixed(2)}`}
                </div>
              </div>
              <div style={{ height: 4, overflow: 'hidden', borderRadius: 999, background: 'var(--line)' }}>
                <span style={{ display: 'block', width: `${monthlyPct}%`, height: '100%', background: monthlyPct > 85 ? 'var(--flare)' : 'var(--moonlight)' }} />
              </div>
              <p style={{ margin: 0, color: 'var(--faint)', fontSize: 10.5 }}>
                {usage?.error
                  ? usage.error
                  : english
                    ? 'Balance and monthly spend come from Kimi’s official coding usage endpoint.'
                    : '余额与本月消费来自 Kimi 官方 Coding 用量接口；没有加油包时会显示为 0 或 —。'}
              </p>
            </div>
          </ConsoleSection>

          <ConsoleSection
            eyebrow="CREDENTIAL BRIDGE"
            title="API Keys"
            action={<a href={KIMI_CONSOLE_URL} target="_blank" rel="noreferrer" style={buttonStyle}>{english ? 'Manage on Kimi ↗' : '前往官方控制台管理 ↗'}</a>}
          >
            <div style={{ border: '1px solid var(--line)', borderRadius: 9, background: 'var(--regolith)', overflow: 'hidden' }}>
              <div style={{ padding: '10px 12px', background: 'var(--mare)', color: 'var(--faint)', fontSize: 10.5, lineHeight: 1.6 }}>
                {english
                  ? 'Cloud keys are created and revoked by Kimi. Farside never reads the full key back; paste a newly created key into the provider form below to connect it.'
                  : '云端 Key 的新建、删除由 Kimi 官方控制台完成。Farside 不回读完整密钥；新建后可直接粘贴到下方 Provider 表单完成接入。'}
              </div>
              {apiProviders.length ? apiProviders.map((provider) => (
                <div key={provider.id} style={{ minHeight: 54, padding: '9px 12px', borderTop: '1px solid var(--line)', display: 'grid', gridTemplateColumns: 'minmax(130px,1fr) minmax(180px,1.4fr) 90px', gap: 12, alignItems: 'center' }}>
                  <div><div style={{ color: 'var(--moonlight)', fontSize: 11.5 }}>{provider.label}</div><div className="mono" style={{ marginTop: 3, color: 'var(--faint)', fontSize: 9.5 }}>{provider.id}</div></div>
                  <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--faint)', fontSize: 10 }}>{provider.baseUrl ?? 'https://api.moonshot.cn/v1'}</span>
                  <span style={{ color: provider.status === 'connected' ? 'var(--signal)' : 'var(--redshift)', fontSize: 10.5 }}>
                    {provider.hasCredential ? (english ? 'Key connected' : '密钥已接入') : (english ? 'No key' : '未接入')}
                  </span>
                </div>
              )) : (
                <div style={{ padding: 17, color: 'var(--faint)', fontSize: 11 }}>
                  {english ? 'No Kimi official API key is connected to Farside yet.' : 'Farside 尚未接入 Kimi 官方 API Key。'}
                </div>
              )}
            </div>
          </ConsoleSection>

          <ConsoleSection
            eyebrow="DEVICE LINK"
            title={english ? 'Signed-in devices' : '登录设备'}
            action={<a href={KIMI_CONSOLE_URL} target="_blank" rel="noreferrer" style={buttonStyle}>{english ? 'View all on Kimi ↗' : '在官方控制台查看全部 ↗'}</a>}
          >
            <div style={{ minHeight: 64, padding: '11px 13px', border: '1px solid var(--line)', borderRadius: 9, background: 'var(--regolith)', display: 'grid', gridTemplateColumns: 'minmax(180px,1fr) minmax(150px,.8fr) 90px', gap: 14, alignItems: 'center' }}>
              <div>
                <div style={{ color: 'var(--moonlight)', fontSize: 11.5 }}>Farside Desktop · {info ? `${info.platform} ${info.arch}` : '—'}</div>
                <div className="mono" style={{ marginTop: 4, color: 'var(--faint)', fontSize: 9.5 }}>{info ? `Farside ${info.appVersion} · Electron ${info.electronVersion}` : 'LOCAL DEVICE'}</div>
              </div>
              <div style={{ color: 'var(--faint)', fontSize: 10.5 }}>{active?.label ?? (english ? 'No active provider' : '未连接 Provider')}</div>
              <span style={{ color: account?.configured ? 'var(--signal)' : 'var(--faint)', fontSize: 10.5 }}>{account?.configured ? (english ? 'This device' : '当前设备') : (english ? 'Offline' : '未登录')}</span>
            </div>
            <p style={{ margin: 0, color: 'var(--faint)', fontSize: 10.5 }}>
              {english
                ? 'Farside shows only the current local link. Kimi has not exposed the complete device list through Kimi Server, so remote device removal stays in the official console.'
                : 'Farside 只展示当前本机链路。Kimi Server 尚未暴露完整设备列表，因此其他设备与下线操作保留在官方控制台。'}
            </p>
          </ConsoleSection>

          <AccountActivity />

          <ConsoleSection eyebrow="PROVIDER SETUP" title={english ? 'Connect a provider' : '接入或切换 Provider'}>
            <AccountSetup />
          </ConsoleSection>
        </div>
      </div>
    </div>
  )
}

type ProfileActivityView = 'daily' | 'weekly' | 'cumulative'

function ProfilePanel() {
  const { locale, t } = usePreferences()
  const english = locale === 'en-US'
  const account = useFarsideStore((state) => state.account)
  const [profile, setProfile] = useState<AccountProfileStats | null>(null)
  const [activityView, setActivityView] = useState<ProfileActivityView>('daily')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadProfile = (): void => {
    const api = window.api
    if (!api) {
      setLoading(false)
      setError(english ? 'Desktop bridge is unavailable.' : '桌面桥接不可用。')
      return
    }
    setLoading(true)
    setError('')
    void api.account.profile().then((result) => {
      if (result.ok && result.profile) setProfile(result.profile)
      else setError(result.error ?? (english ? 'Could not load profile.' : '个人资料读取失败。'))
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : (english ? 'Could not load profile.' : '个人资料读取失败。'))
    }).finally(() => setLoading(false))
  }

  useEffect(() => {
    loadProfile()
    // 进入页面时读取一次；语言切换不应重复扫描本机历史。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activity = useMemo(() => {
    if (!profile) return []
    const source = new Map(profile.daily.map((day) => [day.date, day]))
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    if (activityView === 'daily') {
      return Array.from({ length: 365 }, (_, index) => {
        const date = new Date(today)
        date.setDate(date.getDate() - (364 - index))
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        return { key, label: date.toLocaleDateString(locale, { month: 'short', day: 'numeric' }), value: source.get(key)?.tokens ?? 0 }
      })
    }
    if (activityView === 'weekly') {
      return Array.from({ length: 52 }, (_, index) => {
        const end = new Date(today)
        end.setDate(end.getDate() - (51 - index) * 7)
        const start = new Date(end)
        start.setDate(start.getDate() - 6)
        let value = 0
        for (let offset = 0; offset < 7; offset += 1) {
          const date = new Date(start)
          date.setDate(date.getDate() + offset)
          const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
          value += source.get(key)?.tokens ?? 0
        }
        return {
          key: start.toISOString(),
          label: `${start.toLocaleDateString(locale, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(locale, { month: 'short', day: 'numeric' })}`,
          value
        }
      })
    }
    return Array.from({ length: 12 }, (_, index) => {
      const date = new Date(today.getFullYear(), today.getMonth() - (11 - index), 1)
      const prefix = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      const value = profile.daily
        .filter((day) => day.date.startsWith(prefix))
        .reduce((sum, day) => sum + day.tokens, 0)
      return { key: prefix, label: date.toLocaleDateString(locale, { year: 'numeric', month: 'long' }), value }
    })
  }, [activityView, locale, profile])

  const compactNumber = (value: number): string => new Intl.NumberFormat(locale, {
    notation: value >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1
  }).format(value)
  const duration = (milliseconds: number): string => {
    const minutes = Math.floor(milliseconds / 60_000)
    const hours = Math.floor(minutes / 60)
    const remainder = minutes % 60
    if (hours > 0) return english ? `${hours}h ${remainder}m` : `${hours} 小时 ${remainder} 分`
    if (minutes > 0) return english ? `${minutes}m` : `${minutes} 分钟`
    const seconds = Math.max(0, Math.round(milliseconds / 1000))
    return english ? `${seconds}s` : `${seconds} 秒`
  }
  const username = profile?.identity?.username
  const displayName = profile?.identity?.displayName || (english ? 'Kimi user' : 'Kimi 用户')
  const initials = displayName.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'K'
  const plan = account?.usage?.planLabel ?? account?.providers.find((provider) => provider.active)?.label ?? 'Farside'
  const maxActivity = Math.max(1, ...activity.map((item) => item.value))
  const stats = profile ? [
    { value: compactNumber(profile.totalTokens), label: english ? 'Total tokens' : '累计 Token 数' },
    { value: compactNumber(profile.peakTaskTokens), label: english ? 'Peak task tokens' : '峰值 Token 数' },
    { value: duration(profile.longestTaskDurationMs), label: english ? 'Longest task' : '最长任务时长' },
    { value: `${profile.currentStreakDays}${english ? 'd' : ' 天'}`, label: english ? 'Current streak' : '当前连续天数' },
    { value: `${profile.longestStreakDays}${english ? 'd' : ' 天'}`, label: english ? 'Longest streak' : '最长连续天数' }
  ] : []

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <PanelTitle
        eyebrow="Local Profile"
        title={t('个人资料')}
        note={english ? 'A private activity profile calculated from local Kimi sessions' : '根据本机 Kimi 会话生成的私密活动档案'}
        actions={<button type="button" style={buttonStyle} disabled={loading} onClick={loadProfile}>{loading ? t('统计中…') : t('刷新统计')}</button>}
      />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 18 }}>
        <div style={{ maxWidth: 980, display: 'grid', gap: 22 }}>
          <section style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden', background: 'linear-gradient(145deg, color-mix(in srgb, var(--regolith) 94%, var(--moonlight) 6%), var(--regolith))' }}>
            <div style={{ minHeight: 190, padding: '30px 24px 24px', display: 'grid', placeItems: 'center', textAlign: 'center' }}>
              <div style={{ width: 72, height: 72, borderRadius: '50%', display: 'grid', placeItems: 'center', background: 'var(--moonlight)', color: 'var(--void)', fontSize: 24, fontWeight: 500, boxShadow: '0 10px 30px color-mix(in srgb, var(--void) 38%, transparent)' }}>{initials}</div>
              <div>
                <h3 style={{ margin: '15px 0 0', color: 'var(--moonlight)', fontSize: 22, fontWeight: 500 }}>{displayName}</h3>
                <div style={{ marginTop: 7, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, color: 'var(--faint)', fontSize: 11.5 }}>
                  <span className="mono">{username ? `@${username}` : (english ? 'Local profile' : '本机档案')}</span>
                  <span aria-hidden>·</span>
                  <span style={{ padding: '3px 7px', border: '1px solid var(--line-hi)', borderRadius: 999 }}>{plan}</span>
                </div>
              </div>
            </div>
            <div style={{ borderTop: '1px solid var(--line)', display: 'grid', gridTemplateColumns: 'repeat(5, minmax(110px, 1fr))', overflowX: 'auto' }}>
              {stats.map((item, index) => (
                <div key={item.label} style={{ minWidth: 110, padding: '15px 10px', textAlign: 'center', borderLeft: index ? '1px solid var(--line)' : 'none' }}>
                  <div className="mono" style={{ color: 'var(--moonlight)', fontSize: 14 }}>{item.value}</div>
                  <div style={{ marginTop: 5, color: 'var(--faint)', fontSize: 10.5 }}>{item.label}</div>
                </div>
              ))}
              {!profile && <div style={{ gridColumn: '1 / -1', padding: 18, textAlign: 'center', color: error ? 'var(--redshift)' : 'var(--faint)', fontSize: 11 }}>{error || (english ? 'Calculating local activity…' : '正在统计本机活动…')}</div>}
            </div>
          </section>

          <ConsoleSection
            eyebrow="TOKEN ACTIVITY"
            title={english ? 'Token activity' : 'Token 活动'}
            action={
              <div style={{ padding: 2, display: 'flex', gap: 2, border: '1px solid var(--line)', borderRadius: 7, background: 'var(--mare)' }}>
                {(['daily', 'weekly', 'cumulative'] as const).map((view) => (
                  <button key={view} type="button" onClick={() => setActivityView(view)} style={{ padding: '4px 8px', borderRadius: 5, color: activityView === view ? 'var(--moonlight)' : 'var(--faint)', background: activityView === view ? 'var(--regolith)' : 'transparent', fontSize: 10.5 }}>
                    {view === 'daily' ? (english ? 'Daily' : '每日') : view === 'weekly' ? (english ? 'Weekly' : '每周') : (english ? 'Monthly' : '累计')}
                  </button>
                ))}
              </div>
            }
          >
            <div style={{ padding: 15, border: '1px solid var(--line)', borderRadius: 9, background: 'var(--regolith)', overflowX: 'auto' }}>
              <div style={{
                minWidth: activityView === 'daily' ? 720 : 560,
                display: 'grid',
                gridTemplateRows: activityView === 'daily' ? 'repeat(7, 11px)' : undefined,
                gridTemplateColumns: activityView === 'daily' ? undefined : `repeat(${activity.length}, minmax(9px, 1fr))`,
                gridAutoFlow: activityView === 'daily' ? 'column' : 'row',
                gridAutoColumns: activityView === 'daily' ? '11px' : undefined,
                gap: 3
              }}>
                {activity.map((item) => {
                  const intensity = item.value > 0 ? 22 + Math.round((item.value / maxActivity) * 68) : 0
                  return (
                    <span
                      key={item.key}
                      title={`${item.label} · ${compactNumber(item.value)} Token`}
                      aria-label={`${item.label}: ${item.value} Token`}
                      style={{ height: activityView === 'daily' ? 11 : 34, borderRadius: activityView === 'daily' ? 3 : 4, background: item.value > 0 ? `color-mix(in srgb, var(--moonlight) ${intensity}%, var(--mare))` : 'var(--mare)', border: '1px solid color-mix(in srgb, var(--line) 76%, transparent)' }}
                    />
                  )
                })}
              </div>
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 5, color: 'var(--faint)', fontSize: 9.5 }}>
                <span>{english ? 'Less' : '较少'}</span>
                {[0, 25, 45, 65, 90].map((level) => <span key={level} style={{ width: 9, height: 9, borderRadius: 2, background: level ? `color-mix(in srgb, var(--moonlight) ${level}%, var(--mare))` : 'var(--mare)', border: '1px solid var(--line)' }} />)}
                <span>{english ? 'More' : '较多'}</span>
                <span className="mono" style={{ marginLeft: 'auto' }}>{profile ? `${profile.daily.length} ${english ? 'recorded days' : '个记录日'}` : '—'}</span>
              </div>
            </div>
          </ConsoleSection>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(250px, .9fr) minmax(300px, 1.1fr)', gap: 18 }}>
            <ConsoleSection eyebrow="ACTIVITY INSIGHTS" title={english ? 'Activity insights' : '活动洞察'}>
              <div style={{ border: '1px solid var(--line)', borderRadius: 9, background: 'var(--regolith)', overflow: 'hidden' }}>
                {[
                  [english ? 'Fast mode' : '快速模式', profile ? `${Math.round(profile.fastModePct)}%` : '—'],
                  [english ? 'Most-used reasoning' : '最常用的推理强度', profile?.topReasoningEffort ? `${profile.topReasoningEffort.label} · ${Math.round(profile.topReasoningEffort.pct)}%` : '—'],
                  [english ? 'Skills explored' : '已探索的技能', profile ? String(profile.exploredSkillCount) : '—'],
                  [english ? 'Total skill uses' : '使用的技能总数', profile ? String(profile.skillUseCount) : '—'],
                  [english ? 'Total tasks' : '任务总数', profile ? String(profile.taskCount) : '—']
                ].map(([label, value], index) => (
                  <div key={label} style={{ minHeight: 43, padding: '10px 12px', display: 'flex', alignItems: 'center', borderTop: index ? '1px solid var(--line)' : 'none', gap: 12 }}>
                    <span style={{ color: 'var(--faint)', fontSize: 10.5 }}>{label}</span>
                    <span className="mono" style={{ marginLeft: 'auto', color: 'var(--moonlight)', fontSize: 11 }}>{value}</span>
                  </div>
                ))}
              </div>
            </ConsoleSection>

            <ConsoleSection eyebrow="EXTENSIONS" title={english ? 'Most-used skills & tools' : '最常用的技能与工具'}>
              <div style={{ border: '1px solid var(--line)', borderRadius: 9, background: 'var(--regolith)', overflow: 'hidden' }}>
                {profile?.topExtensions.length ? profile.topExtensions.map((item, index) => (
                  <div key={`${item.kind}:${item.name}`} style={{ minHeight: 43, padding: '8px 11px', display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr) auto', alignItems: 'center', gap: 9, borderTop: index ? '1px solid var(--line)' : 'none' }}>
                    <span style={{ width: 25, height: 25, display: 'grid', placeItems: 'center', borderRadius: 7, border: '1px solid var(--line)', background: 'var(--mare)', color: 'var(--moonlight)', fontSize: 11 }}>{item.kind === 'skill' ? '◇' : '⌘'}</span>
                    <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--moonlight)', fontSize: 10.5 }}>{item.kind === 'skill' ? '$' : ''}{item.name}</span>
                    <span style={{ color: 'var(--faint)', fontSize: 10.5 }}>{item.count} {english ? 'runs' : '次运行'}</span>
                  </div>
                )) : (
                  <div style={{ padding: 22, textAlign: 'center', color: 'var(--faint)', fontSize: 10.5 }}>
                    {english ? 'No explicit skill or extension calls were found locally.' : '本机记录中还没有显式的技能或扩展调用。'}
                  </div>
                )}
              </div>
            </ConsoleSection>
          </div>

          <p style={{ margin: '-6px 2px 4px', color: error ? 'var(--redshift)' : 'var(--faint)', fontSize: 9.5, lineHeight: 1.6 }}>
            {error || (english
              ? 'Statistics stay on this device and are derived from ~/.kimi-code/sessions. Deleted or remote-only sessions are not included.'
              : '统计仅在本机计算，来源为 ~/.kimi-code/sessions；已删除或仅存在于远端的会话不会计入。')}
          </p>
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
      <div style={{ minWidth: 0 }}><div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}><strong className="mono" style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--moonlight)' }}>{title}</strong>{meta ? <span className="mono" style={{ fontSize: 9.5, color: 'var(--faint)' }}>{meta}</span> : null}</div>{subtitle ? <div style={{ marginTop: 4, fontSize: 10.5, color: 'var(--faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</div> : null}</div>
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
  const openSettings = useFarsideStore((state) => state.openSettings)
  return <div style={{ display: 'grid', gap: 12 }}><div style={{ display: 'flex', gap: 7 }}><input style={{ ...inputStyle, flex: 1 }} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('搜索扩展，例如 browser automation')} /><a style={buttonStyle} href={`https://www.google.com/search?q=${encodeURIComponent(`${query} site:registry.modelcontextprotocol.io OR site:skills.sh OR site:smithery.ai`)}`} target="_blank" rel="noreferrer">{t('跨市场搜索 ↗')}</a></div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(220px, 1fr))', gap: 8 }}>{MARKETS.map((market) => market.url ? <a key={market.name} href={market.url} target="_blank" rel="noreferrer" style={{ minHeight: 86, padding: 12, border: '1px solid var(--line)', borderRadius: 8, background: 'var(--regolith)', color: 'inherit' }}><span className="mono" style={{ fontSize: 9.5, color: 'var(--ghost)' }}>{market.kind}</span><div style={{ marginTop: 8, fontSize: 13, color: 'var(--moonlight)' }}>{t(market.name)} <span style={{ color: 'var(--faint)' }}>↗</span></div><div style={{ marginTop: 4, fontSize: 10.5, color: 'var(--faint)' }}>{t(market.note)}</div></a> : <button key={market.name} onClick={() => openSettings('extensions', 'plugins')} style={{ minHeight: 86, padding: 12, textAlign: 'left', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--regolith)' }}><span className="mono" style={{ fontSize: 9.5, color: 'var(--ghost)' }}>{market.kind}</span><div style={{ marginTop: 8, fontSize: 13, color: 'var(--moonlight)' }}>{t(market.name)} <span style={{ color: 'var(--faint)' }}>→</span></div><div style={{ marginTop: 4, fontSize: 10.5, color: 'var(--faint)' }}>{t(market.note)}</div></button>)}</div><p style={{ margin: 0, fontSize: 10.5, lineHeight: 1.6, color: 'var(--faint)' }}>{t('市场只负责发现。安装仍需在 MCP、Skills 或 Plugins 标签中确认来源，避免未经审查的代码直接进入 Agent 环境。')}</p></div>
}

function ExtensionCenter({ snapshot, onSnapshot, initialTab }: { snapshot: ConfigurationSnapshot; onSnapshot: (snapshot: ConfigurationSnapshot) => void; initialTab?: ExtensionTab }) {
  const { t } = usePreferences()
  const [tab, setTab] = useState<ExtensionTab>(initialTab ?? 'mcp')
  const tabs: Array<{ id: ExtensionTab; label: string; count?: number }> = [
    { id: 'mcp', label: 'MCP', count: Object.keys(parseMcp(snapshot.mcpJson)).length },
    { id: 'skills', label: 'Skills', count: snapshot.userSkills.length },
    { id: 'plugins', label: 'Plugins', count: snapshot.plugins.length },
    { id: 'market', label: t('发现市场') }
  ]
  return <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}><PanelTitle eyebrow="Extension Control" title={t('扩展中心')} note={t('从发现、安装到启停和移除的完整闭环')} actions={<button style={buttonStyle} onClick={() => void window.api?.configuration.open(tab === 'skills' ? 'skills' : tab === 'plugins' ? 'plugins' : 'mcp')}>{t('在资源管理器中打开')}</button>} /><div style={{ height: 43, padding: '0 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'end', gap: 18 }}>{tabs.map((item) => <button key={item.id} onClick={() => setTab(item.id)} style={{ height: 43, borderBottom: tab === item.id ? '1px solid var(--moonlight)' : '1px solid transparent', color: tab === item.id ? 'var(--moonlight)' : 'var(--faint)', fontSize: 11.5 }}>{item.label}{item.count !== undefined ? <span className="mono" style={{ marginLeft: 6, fontSize: 9.5, color: 'var(--faint)' }}>{item.count}</span> : null}</button>)}</div><div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>{tab === 'mcp' ? <McpManager snapshot={snapshot} onSnapshot={onSnapshot} /> : null}{tab === 'skills' ? <SkillManager snapshot={snapshot} onSnapshot={onSnapshot} /> : null}{tab === 'plugins' ? <PluginManager snapshot={snapshot} onSnapshot={onSnapshot} /> : null}{tab === 'market' ? <MarketPanel /> : null}</div></div>
}

const PROJECT_HOOK_EVENTS: ProjectHookEvent[] = [
  'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact',
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop'
]

function ProjectHooksManager() {
  const { locale, t } = usePreferences()
  const english = locale === 'en-US'
  const [projects, setProjects] = useState<Array<{ id: string; root: string; name: string }>>([])
  const [root, setRoot] = useState('')
  const [path, setPath] = useState('')
  const [hooks, setHooks] = useState<ProjectHook[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const [adding, setAdding] = useState(false)
  const [editingHookId, setEditingHookId] = useState('')
  const [draft, setDraft] = useState<ProjectHook>({
    id: '',
    event: 'PostToolUse',
    matcher: '',
    command: '',
    commandWindows: '',
    timeoutSec: 30,
    async: false,
    enabled: true,
    statusMessage: ''
  })

  useEffect(() => {
    let alive = true
    void window.api?.workspace.list().then((result) => {
      if (!alive || !result?.ok) {
        if (alive) setStatus(result?.error ?? (english ? 'Could not load projects.' : '项目列表读取失败'))
        return
      }
      setProjects(result.workspaces)
      setRoot((current) => current || result.workspaces[0]?.root || '')
    })
    return () => { alive = false }
  }, [english])

  useEffect(() => {
    if (!root) {
      setHooks([])
      setPath('')
      return
    }
    let alive = true
    setStatus(english ? 'Loading project hooks…' : '正在读取项目 Hooks…')
    void window.api?.configuration.hooks(root).then((result) => {
      if (!alive) return
      if (!result?.ok || !result.document) {
        setStatus(result?.error ?? (english ? 'Could not load hooks.' : 'Hooks 读取失败'))
        return
      }
      setHooks(result.document.hooks)
      setPath(result.path ?? '')
      setWarnings(result.warnings ?? [])
      setStatus(english ? 'Synced from project' : '已从项目同步')
    })
    return () => { alive = false }
  }, [english, root])

  const persist = (next: ProjectHook[], message: string) => {
    if (!root) return
    setStatus(english ? 'Validating and saving…' : '正在校验并保存…')
    void window.api?.configuration.saveHooks({
      root,
      document: { version: 1, hooks: next }
    }).then((result) => {
      if (!result?.ok || !result.document) {
        setStatus(result?.error ?? (english ? 'Save failed.' : '保存失败'))
        return
      }
      setHooks(result.document.hooks)
      setPath(result.path ?? '')
      setWarnings(result.warnings ?? [])
      setStatus(message)
    })
  }

  const add = () => {
    const hook: ProjectHook = {
      ...draft,
      id: draft.id.trim(),
      matcher: draft.matcher?.trim() || undefined,
      command: draft.command.trim(),
      commandWindows: draft.commandWindows?.trim() || undefined,
      timeoutSec: draft.timeoutSec || 30,
      statusMessage: draft.statusMessage?.trim() || undefined
    }
    if (!hook.id || !hook.command) {
      setStatus(english ? 'Hook ID and command are required.' : 'Hook ID 和命令不能为空')
      return
    }
    const next = editingHookId
      ? hooks.map((item) => item.id === editingHookId ? hook : item)
      : [...hooks, hook]
    persist(next, english ? `Saved ${hook.id}` : `已保存 ${hook.id}`)
    setAdding(false)
    setEditingHookId('')
    setDraft({ id: '', event: 'PostToolUse', matcher: '', command: '', commandWindows: '', timeoutSec: 30, async: false, enabled: true, statusMessage: '' })
  }

  return (
    <div style={{ height: '100%', minHeight: 0, overflowY: 'auto', padding: 14 }}>
      <div style={{ maxWidth: 960, display: 'grid', gap: 12 }}>
        <div style={{ padding: 12, border: '1px solid var(--line-hi)', borderRadius: 8, background: 'var(--regolith)', display: 'grid', gridTemplateColumns: 'minmax(180px, .7fr) minmax(220px, 1.3fr) auto', gap: 9, alignItems: 'center' }}>
          <div>
            <div className="mono" style={{ fontSize: 9, color: 'var(--faint)', letterSpacing: '.14em' }}>PROJECT SCOPE</div>
            <div style={{ marginTop: 4, color: 'var(--dust)', fontSize: 10.5 }}>{english ? 'Each project owns its hooks file.' : '每个项目独立维护 Hooks 文件。'}</div>
          </div>
          <select style={inputStyle} value={root} onChange={(event) => setRoot(event.target.value)}>
            {!projects.length ? <option value="">{english ? 'No registered projects' : '没有已注册项目'}</option> : null}
            {projects.map((project) => <option key={project.id} value={project.root}>{project.name} · {project.root}</option>)}
          </select>
          <button type="button" style={buttonStyle} disabled={!root} onClick={() => { setAdding((value) => !value); setEditingHookId(''); setDraft({ id: '', event: 'PostToolUse', matcher: '', command: '', commandWindows: '', timeoutSec: 30, async: false, enabled: true, statusMessage: '' }) }}>{adding ? t('取消') : t('+ 添加 Hook')}</button>
          <span className="mono" style={{ gridColumn: '2 / 4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--faint)', fontSize: 9.5 }}>{path || (root ? `${root}/.farside/hooks.json` : '—')}</span>
        </div>

        {adding ? (
          <div style={{ padding: 13, border: '1px solid var(--line-hi)', borderRadius: 8, background: 'var(--mare)', display: 'grid', gridTemplateColumns: 'minmax(130px,.65fr) minmax(160px,.8fr) minmax(220px,1.3fr)', gap: 8 }}>
            <input style={inputStyle} value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value.toLowerCase().replace(/\s+/g, '-') })} placeholder="hook-id" />
            <select style={inputStyle} value={draft.event} onChange={(event) => setDraft({ ...draft, event: event.target.value as ProjectHookEvent })}>{PROJECT_HOOK_EVENTS.map((event) => <option key={event}>{event}</option>)}</select>
            <input style={inputStyle} value={draft.matcher ?? ''} onChange={(event) => setDraft({ ...draft, matcher: event.target.value })} placeholder={english ? 'Matcher, e.g. Bash|Edit (optional)' : 'Matcher，例如 Bash|Edit（可选）'} />
            <input style={{ ...inputStyle, gridColumn: '1 / 4', fontFamily: 'var(--font-mono)' }} value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder={english ? 'Command, e.g. npm run lint' : '命令，例如 npm run lint'} />
            <input style={{ ...inputStyle, gridColumn: '1 / 3', fontFamily: 'var(--font-mono)' }} value={draft.commandWindows ?? ''} onChange={(event) => setDraft({ ...draft, commandWindows: event.target.value })} placeholder={english ? 'Windows command override (optional)' : 'Windows 专用命令（可选）'} />
            <input style={inputStyle} value={draft.statusMessage ?? ''} onChange={(event) => setDraft({ ...draft, statusMessage: event.target.value })} placeholder={english ? 'Status message (optional)' : '运行时状态提示（可选）'} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--faint)', fontSize: 10.5 }}>
              {english ? 'Timeout' : '超时'}
              <input type="number" min={1} max={3600} style={{ ...inputStyle, width: 72 }} value={draft.timeoutSec ?? 30} onChange={(event) => setDraft({ ...draft, timeoutSec: Number(event.target.value) })} />
              {english ? 'sec' : '秒'}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--faint)', fontSize: 10.5 }}><input type="checkbox" checked={draft.async} onChange={(event) => setDraft({ ...draft, async: event.target.checked })} />{english ? 'Run asynchronously' : '异步执行'}</label>
            <button type="button" style={{ ...buttonStyle, justifySelf: 'end', color: 'var(--moonlight)' }} onClick={add}>{t('保存')}</button>
          </div>
        ) : null}

        <div style={{ display: 'grid', gap: 7 }}>
          {hooks.map((hook) => (
            <div key={hook.id} style={{ minHeight: 68, padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--regolith)', display: 'grid', gridTemplateColumns: 'minmax(140px,.6fr) minmax(250px,1.4fr) auto', gap: 12, alignItems: 'center' }}>
              <div>
                <div className="mono" style={{ color: 'var(--moonlight)', fontSize: 11 }}>{hook.id}</div>
                <div className="mono" style={{ marginTop: 5, color: 'var(--faint)', fontSize: 9 }}>{hook.event}{hook.matcher ? ` · ${hook.matcher}` : ''}</div>
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="mono" title={hook.command} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dust)', fontSize: 10.5 }}>{hook.command}</div>
                <div style={{ marginTop: 5, color: 'var(--faint)', fontSize: 9.5 }}>{hook.async ? (english ? 'Async' : '异步') : (english ? 'Blocking' : '阻塞')} · {hook.timeoutSec ?? 30}s{hook.statusMessage ? ` · ${hook.statusMessage}` : ''}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <Switch label={`${hook.id} Hook`} checked={hook.enabled} onChange={(enabled) => persist(hooks.map((item) => item.id === hook.id ? { ...item, enabled } : item), english ? `${hook.id} ${enabled ? 'enabled' : 'disabled'}` : `${hook.id} 已${enabled ? '启用' : '停用'}`)} />
                <button type="button" style={{ color: 'var(--dust)', fontSize: 10.5 }} onClick={() => { setEditingHookId(hook.id); setDraft({ ...hook, matcher: hook.matcher ?? '', commandWindows: hook.commandWindows ?? '', statusMessage: hook.statusMessage ?? '', timeoutSec: hook.timeoutSec ?? 30 }); setAdding(true) }}>{t('编辑')}</button>
                <button type="button" style={{ color: 'var(--redshift)', fontSize: 10.5 }} onClick={() => { if (window.confirm(english ? `Remove hook “${hook.id}”?` : `移除 Hook“${hook.id}”？`)) persist(hooks.filter((item) => item.id !== hook.id), english ? `Removed ${hook.id}` : `已移除 ${hook.id}`) }}>{t('移除')}</button>
              </div>
            </div>
          ))}
          {!hooks.length ? <div style={{ padding: 34, textAlign: 'center', border: '1px dashed var(--line)', borderRadius: 8, color: 'var(--faint)', fontSize: 11 }}>{root ? (english ? 'This project has no hooks yet.' : '这个项目还没有配置 Hook。') : (english ? 'Register a project first.' : '请先注册项目。')}</div> : null}
        </div>
        {warnings.map((warning) => <div key={warning} style={{ padding: '7px 9px', borderLeft: '2px solid var(--flare)', color: 'var(--faint)', fontSize: 10 }}>{warning}</div>)}
        <StatusLine error={/失败|无效|不能|required|failed/i.test(status)}>{status}</StatusLine>
        <p style={{ margin: 0, color: 'var(--faint)', fontSize: 9.5, lineHeight: 1.6 }}>{english ? 'Schema follows Codex hook events and command fields. Files are stored per project under .farside/hooks.json.' : '字段设计参考 Codex Hooks 的事件、matcher 与 command 结构；配置按项目保存在 .farside/hooks.json。'}</p>
      </div>
    </div>
  )
}

function ConfigurationEditor({ snapshot, onSnapshot }: { snapshot: ConfigurationSnapshot; onSnapshot: (snapshot: ConfigurationSnapshot) => void }) {
  const { locale, t } = usePreferences()
  const english = locale === 'en-US'
  const [target, setTarget] = useState<ConfigurationTarget | 'hooks'>('config')
  const [draftByTarget, setDraftByTarget] = useState<Partial<Record<ConfigurationTarget, string>>>({})
  const content = target === 'config' ? snapshot.configToml : target === 'mcp' ? snapshot.mcpJson : target === 'instructions' ? snapshot.agentsMarkdown : ''
  const draft = target === 'hooks' ? '' : draftByTarget[target] ?? content
  const [status, setStatus] = useState('已连接磁盘监听')
  const dirty = target !== 'hooks' && draft !== content
  const editableTarget: ConfigurationTarget | null = target === 'hooks' ? null : target
  useEffect(() => {
    settingsEditorDirty = dirty
    return () => { settingsEditorDirty = false }
  }, [dirty])
  useEffect(() => {
    // 磁盘推送新内容时不得静默覆盖未保存草稿；保留编辑并提示冲突。
    if (!editableTarget) return
    setDraftByTarget((previous) => {
      const saved = previous[editableTarget]
      if (saved === undefined || saved === content) return previous
      setStatus(english ? 'Disk changed while editing — your unsaved draft is kept.' : '磁盘内容已变化，未保存的编辑已保留。')
      return previous
    })
  }, [content, editableTarget, english])
  const save = () => {
    if (target === 'hooks') return
    setStatus('保存并校验…')
    void window.api?.configuration.save({ target, content: draft }).then((result) => {
      if (!result?.ok || !result.snapshot) { setStatus(result?.error ?? '保存失败'); return }
      onSnapshot(result.snapshot)
      // 保存成功后回到“跟随磁盘”状态。
      setDraftByTarget((previous) => {
        const next = { ...previous }
        delete next[target]
        return next
      })
      setStatus('已写入磁盘')
    })
  }
  const switchTarget = (next: ConfigurationTarget | 'hooks') => {
    if (next === target) return
    if (dirty && !window.confirm(english ? 'Discard unsaved changes to this file?' : '当前文件有未保存的修改，确定丢弃并切换？')) return
    const previousTarget: ConfigurationTarget | null = target === 'hooks' ? null : target
    setDraftByTarget((previous) => {
      const nextDrafts = { ...previous }
      if (previousTarget) delete nextDrafts[previousTarget]
      return nextDrafts
    })
    setTarget(next)
  }
  const meta: Record<ConfigurationTarget | 'hooks', { label: string; note: string }> = {
    config: { label: 'config.toml', note: 'Provider、模型与 Kimi Code 运行参数' },
    mcp: { label: 'mcp.json', note: '用户级 MCP Server 原始配置' },
    instructions: { label: 'AGENTS.md', note: '所有项目继承的全局 Agent 指令' },
    hooks: { label: 'Hooks', note: '按项目管理生命周期命令、匹配规则与启停状态' }
  }
  const targets = Object.keys(meta) as Array<ConfigurationTarget | 'hooks'>
  return <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}><PanelTitle eyebrow="Disk Source of Truth" title={t('配置文件')} note={t('本地文件与编辑器双向热同步；项目 Hooks 独立存储')} actions={target === 'hooks' ? <StatusLine>{t('PROJECT SCOPED')}</StatusLine> : <><StatusLine error={status.includes('失败')}>{dirty ? t('未保存改动') : status}</StatusLine><button style={buttonStyle} onClick={() => void window.api?.configuration.open(target)}>{t('系统中打开')}</button><button style={{ ...buttonStyle, color: 'var(--moonlight)' }} disabled={!dirty} onClick={save}>{t('保存')}</button></>} /><div style={{ minHeight: 52, padding: '0 18px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 7 }}>{targets.map((id) => <button key={id} onClick={() => switchTarget(id)} style={{ padding: '6px 9px', borderRadius: 6, border: `1px solid ${target === id ? 'var(--line-hi)' : 'transparent'}`, background: target === id ? 'var(--regolith)' : 'transparent', color: target === id ? 'var(--moonlight)' : 'var(--faint)', fontSize: 11 }}>{meta[id].label}</button>)}<span className="mono" style={{ marginLeft: 'auto', maxWidth: '46%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 9.5, color: 'var(--faint)' }}>{target === 'hooks' ? '.farside/hooks.json' : snapshot.paths[target]}</span></div>{target === 'hooks' ? <div style={{ flex: 1, minHeight: 0 }}><ProjectHooksManager /></div> : <div style={{ flex: 1, minHeight: 0, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}><div style={{ display: 'flex', alignItems: 'center' }}><span style={{ fontSize: 11, color: 'var(--faint)' }}>{t(meta[target].note)}</span><span className="mono" style={{ marginLeft: 'auto', fontSize: 9.5, color: 'var(--faint)' }}>LIVE · {new Date(snapshot.updatedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div><textarea value={draft} onChange={(event) => { if (editableTarget) setDraftByTarget((previous) => ({ ...previous, [editableTarget]: event.target.value })) }} spellCheck={false} style={{ flex: 1, minHeight: 0, width: '100%', resize: 'none', padding: 13, border: '1px solid var(--line)', borderRadius: 7, background: 'var(--mare)', color: 'var(--dust)', fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.65, outline: 'none' }} /></div>}</div>
}

function ConnectionPanel() {
  const { locale, t } = usePreferences()
  const english = locale === 'en-US'
  const initialize = useFarsideStore((state) => state.initialize)
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState('')
  const [adding, setAdding] = useState(false)
  const [editingProfileId, setEditingProfileId] = useState('')
  const [draft, setDraft] = useState({
    name: '',
    host: '',
    port: 22,
    user: '',
    identityFile: '',
    remoteKimiPath: 'kimi',
    remoteKimiHome: '~/.kimi-code',
    remoteServerPort: 58627
  })

  const load = () => {
    void window.api?.connection.get().then((result) => {
      if (result?.snapshot) setSnapshot(result.snapshot)
      if (!result?.ok) setStatus(result?.error ?? (english ? 'Could not load connections.' : '连接配置读取失败'))
    })
  }
  useEffect(load, [english])

  const run = (
    key: string,
    message: string,
    action: () => Promise<{ ok: boolean; error?: string; snapshot?: ConnectionSnapshot }>,
    refreshAgent = false
  ) => {
    setBusy(key)
    setStatus('')
    void action().then(async (result) => {
      if (result.snapshot) setSnapshot(result.snapshot)
      if (!result.ok) {
        setStatus(result.error ?? (english ? 'Operation failed.' : '操作失败'))
        return
      }
      setStatus(message)
      if (refreshAgent) await initialize()
    }).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : (english ? 'Operation failed.' : '操作失败'))
    }).finally(() => setBusy(''))
  }

  const save = () => {
    run('save', english ? 'SSH profile saved.' : 'SSH 配置已保存', () => window.api!.connection.save({
      ...draft,
      ...(editingProfileId ? { id: editingProfileId } : {}),
      identityFile: draft.identityFile.trim() || undefined
    }))
    setAdding(false)
    setEditingProfileId('')
  }

  const connectionStatus = snapshot?.status
  const active = snapshot?.profiles.find((profile) => profile.id === connectionStatus?.activeProfileId)
  const stateLabel = connectionStatus?.state === 'connected'
    ? (english ? 'Connected' : '已连接')
    : connectionStatus?.state === 'connecting'
      ? (english ? 'Connecting' : '连接中')
      : connectionStatus?.state === 'error'
        ? (english ? 'Connection error' : '连接异常')
        : (english ? 'Local machine' : '当前为本机')

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <PanelTitle eyebrow="Remote / SSH" title={t('连接')} note={english ? 'Control a remote Kimi workspace through an authenticated SSH tunnel' : '通过经过身份验证的 SSH 隧道控制远程 Kimi 工作区'} actions={<button type="button" style={buttonStyle} disabled={Boolean(busy)} onClick={load}>{t('刷新')}</button>} />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 18 }}>
        <div style={{ maxWidth: 920, display: 'grid', gap: 20 }}>
          <section style={{ position: 'relative', overflow: 'hidden', minHeight: 168, padding: 18, border: '1px solid var(--line-hi)', borderRadius: 11, background: 'linear-gradient(135deg, color-mix(in srgb, var(--regolith) 94%, var(--signal) 6%), var(--regolith))' }}>
            <div aria-hidden style={{ position: 'absolute', right: -42, top: -70, width: 230, height: 230, border: '1px solid color-mix(in srgb, var(--moonlight) 10%, transparent)', borderRadius: '50%' }} />
            <div aria-hidden style={{ position: 'absolute', right: 6, top: -22, width: 134, height: 134, border: '1px solid color-mix(in srgb, var(--moonlight) 13%, transparent)', borderRadius: '50%' }} />
            <div className="mono" style={{ position: 'relative', color: 'var(--faint)', fontSize: 9.5, letterSpacing: '.16em' }}>REMOTE CONTROL</div>
            <div style={{ position: 'relative', marginTop: 20, display: 'flex', alignItems: 'center', gap: 14 }}>
              <span style={{ width: 42, height: 42, display: 'grid', placeItems: 'center', borderRadius: 9, border: '1px solid var(--line-hi)', background: 'var(--mare)', color: connectionStatus?.state === 'connected' ? 'var(--signal)' : 'var(--moonlight)', fontSize: 17 }}>⌁</span>
              <div>
                <div style={{ color: 'var(--moonlight)', fontSize: 18, fontWeight: 500 }}>{active?.name ?? stateLabel}</div>
                <div className="mono" style={{ marginTop: 5, color: connectionStatus?.state === 'error' ? 'var(--redshift)' : 'var(--faint)', fontSize: 10 }}>
                  {connectionStatus?.error || (active ? `${active.user}@${active.host}:${active.port}` : (english ? 'Kimi Server uses the local loopback connection' : 'Kimi Server 使用本机回环连接'))}
                </div>
              </div>
              <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
                <div style={{ color: connectionStatus?.state === 'connected' ? 'var(--signal)' : 'var(--dust)', fontSize: 11.5 }}>{stateLabel}</div>
                <div className="mono" style={{ marginTop: 5, color: 'var(--faint)', fontSize: 9.5 }}>{connectionStatus?.localPort ? `127.0.0.1:${connectionStatus.localPort}` : 'LOOPBACK ONLY'}</div>
              </div>
            </div>
            {connectionStatus?.state === 'connected' ? <button type="button" style={{ ...buttonStyle, position: 'relative', marginTop: 19, color: 'var(--redshift)' }} disabled={Boolean(busy)} onClick={() => run('disconnect', english ? 'Returned to the local Kimi Server.' : '已切回本机 Kimi Server', () => window.api!.connection.disconnect(), true)}>{busy === 'disconnect' ? t('断开中…') : t('断开远程控制')}</button> : null}
          </section>

          <ConsoleSection
            eyebrow="SSH TARGETS"
            title={english ? 'SSH connections' : 'SSH 连接'}
            action={<button type="button" style={buttonStyle} disabled={!snapshot?.sshAvailable} onClick={() => { setAdding((value) => !value); setEditingProfileId(''); setDraft({ name: '', host: '', port: 22, user: '', identityFile: '', remoteKimiPath: 'kimi', remoteKimiHome: '~/.kimi-code', remoteServerPort: 58627 }) }}>{adding ? t('取消') : t('+ 新建连接')}</button>}
          >
            {!snapshot?.sshAvailable ? <div style={{ padding: 12, border: '1px solid var(--redshift)', borderRadius: 7, color: 'var(--redshift)', fontSize: 10.5 }}>{english ? 'The system ssh command was not found.' : '未找到系统 ssh 命令，无法建立远程连接。'}</div> : null}
            {adding ? (
              <div style={{ padding: 13, border: '1px solid var(--line-hi)', borderRadius: 8, background: 'var(--mare)', display: 'grid', gridTemplateColumns: '1fr 1.15fr 90px', gap: 8 }}>
                <input style={inputStyle} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={english ? 'Connection name' : '连接名称'} />
                <input style={inputStyle} value={draft.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })} placeholder="host.example.com" />
                <input type="number" min={1} max={65535} style={inputStyle} value={draft.port} onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })} placeholder="22" />
                <input style={inputStyle} value={draft.user} onChange={(event) => setDraft({ ...draft, user: event.target.value })} placeholder={english ? 'SSH user' : 'SSH 用户'} />
                <input style={{ ...inputStyle, gridColumn: '2 / 4' }} value={draft.identityFile} onChange={(event) => setDraft({ ...draft, identityFile: event.target.value })} placeholder={english ? 'Private key absolute path (optional)' : '私钥绝对路径（可选，支持 SSH Agent）'} />
                <input style={inputStyle} value={draft.remoteKimiPath} onChange={(event) => setDraft({ ...draft, remoteKimiPath: event.target.value })} placeholder="kimi" />
                <input style={inputStyle} value={draft.remoteKimiHome} onChange={(event) => setDraft({ ...draft, remoteKimiHome: event.target.value })} placeholder="~/.kimi-code" />
                <input type="number" min={1} max={65535} style={inputStyle} value={draft.remoteServerPort} onChange={(event) => setDraft({ ...draft, remoteServerPort: Number(event.target.value) })} placeholder="58627" />
                <p style={{ gridColumn: '1 / 3', margin: 0, color: 'var(--faint)', fontSize: 9.5, lineHeight: 1.6 }}>{english ? 'Farside uses BatchMode and your system SSH Agent or key. Passwords are never requested or stored.' : 'Farside 使用 BatchMode 与系统 SSH Agent/私钥，不会请求或保存 SSH 密码。'}</p>
                <button type="button" style={{ ...buttonStyle, justifySelf: 'end', color: 'var(--moonlight)' }} disabled={busy === 'save'} onClick={save}>{busy === 'save' ? t('保存中…') : t('保存')}</button>
              </div>
            ) : null}
            <div style={{ display: 'grid', gap: 7 }}>
              {snapshot?.profiles.map((profile: SshConnectionProfile) => {
                const connected = connectionStatus?.state === 'connected' && connectionStatus.activeProfileId === profile.id
                return (
                  <div key={profile.id} style={{ minHeight: 72, padding: '10px 12px', border: `1px solid ${connected ? 'var(--line-hi)' : 'var(--line)'}`, borderRadius: 8, background: 'var(--regolith)', display: 'grid', gridTemplateColumns: 'minmax(160px,.7fr) minmax(230px,1.3fr) auto', gap: 12, alignItems: 'center' }}>
                    <div>
                      <div style={{ color: 'var(--moonlight)', fontSize: 12 }}>{profile.name}</div>
                      <div className="mono" style={{ marginTop: 5, color: 'var(--faint)', fontSize: 9.5 }}>{profile.user}@{profile.host}:{profile.port}</div>
                    </div>
                    <div>
                      <div className="mono" style={{ color: 'var(--dust)', fontSize: 10 }}>{profile.remoteKimiPath} server run --port {profile.remoteServerPort}</div>
                      <div style={{ marginTop: 5, color: 'var(--faint)', fontSize: 9.5 }}>{profile.identityFile ? (english ? 'Dedicated key' : '指定私钥') : 'SSH Agent / ~/.ssh/config'} · {profile.remoteKimiHome}</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button type="button" style={buttonStyle} disabled={Boolean(busy) || connected} onClick={() => run(`test:${profile.id}`, english ? `${profile.name} handshake succeeded.` : `${profile.name} SSH 握手成功`, () => window.api!.connection.test(profile.id))}>{busy === `test:${profile.id}` ? t('测试中…') : t('测试')}</button>
                      <button type="button" style={{ ...buttonStyle, color: 'var(--moonlight)' }} disabled={Boolean(busy) || connected || connectionStatus?.state === 'connected'} onClick={() => run(`connect:${profile.id}`, english ? `Remote control connected to ${profile.name}.` : `已连接 ${profile.name} 远程控制`, () => window.api!.connection.connect(profile.id), true)}>{busy === `connect:${profile.id}` ? t('连接中…') : connected ? t('已连接') : t('连接')}</button>
                      <button type="button" style={{ color: 'var(--dust)', fontSize: 10.5 }} disabled={Boolean(busy) || connected} onClick={() => { setEditingProfileId(profile.id); setDraft({ name: profile.name, host: profile.host, port: profile.port, user: profile.user, identityFile: profile.identityFile ?? '', remoteKimiPath: profile.remoteKimiPath, remoteKimiHome: profile.remoteKimiHome, remoteServerPort: profile.remoteServerPort }); setAdding(true) }}>{t('编辑')}</button>
                      <button type="button" style={{ color: 'var(--redshift)', fontSize: 10.5 }} disabled={Boolean(busy) || connected} onClick={() => { if (window.confirm(english ? `Remove connection “${profile.name}”?` : `移除连接“${profile.name}”？`)) run(`remove:${profile.id}`, english ? `Removed ${profile.name}` : `已移除 ${profile.name}`, () => window.api!.connection.remove(profile.id)) }}>{t('移除')}</button>
                    </div>
                  </div>
                )
              })}
              {!snapshot?.profiles.length ? <div style={{ padding: 34, textAlign: 'center', border: '1px dashed var(--line)', borderRadius: 8, color: 'var(--faint)', fontSize: 11 }}>{english ? 'No SSH targets yet.' : '尚未添加 SSH 连接。'}</div> : null}
            </div>
          </ConsoleSection>

          <div style={{ padding: '10px 12px', borderLeft: '2px solid var(--line-hi)', color: 'var(--faint)', fontSize: 10.5, lineHeight: 1.65 }}>
            {english ? 'Remote control keeps Kimi Server bound to loopback on both machines. Only the authenticated SSH tunnel is exposed. Host trust remains governed by your ~/.ssh/known_hosts.' : '远程控制会让两端 Kimi Server 始终只绑定回环地址，对外仅开放经过认证的 SSH 隧道；主机信任继续由 ~/.ssh/known_hosts 管理。'}
          </div>
          {status ? <StatusLine error={/失败|error|断开|not found|不存在/i.test(status)}>{status}</StatusLine> : null}
        </div>
      </div>
    </div>
  )
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
            <div className="mono" style={{ fontSize: 9.5, color: 'var(--faint)', letterSpacing: '.14em' }}>APPEARANCE</div>
            <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '120px 1fr', gap: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 11.5, color: 'var(--dust)' }}>{t('语言')}</span>
              <div style={{ justifySelf: 'start', display: 'flex', padding: 2, border: '1px solid var(--line)', borderRadius: 7, background: 'var(--mare)' }}>{segment<AppLocale>('zh-CN', locale, setLocale, t('中文'))}{segment<AppLocale>('en-US', locale, setLocale, t('英文'))}</div>
              <span style={{ fontSize: 11.5, color: 'var(--dust)' }}>{t('主题')}</span>
              <div style={{ justifySelf: 'start', display: 'flex', padding: 2, border: '1px solid var(--line)', borderRadius: 7, background: 'var(--mare)' }}>{segment<AppTheme>('dark', theme, setTheme, t('暗黑'))}{segment<AppTheme>('light', theme, setTheme, t('明亮'))}</div>
            </div>
            <p style={{ margin: '10px 0 0', fontSize: 10.5, color: 'var(--faint)' }}>{t('默认使用中文与暗黑主题，偏好会保存在本机。')}</p>
          </div>
          <div style={{ padding: 14, border: '1px solid var(--line)', borderRadius: 8, background: 'var(--regolith)' }}><div className="mono" style={{ fontSize: 9.5, color: 'var(--faint)', letterSpacing: '.14em' }}>LINK STATUS</div><div style={{ marginTop: 12, display: 'grid', gap: 9, fontSize: 11.5 }}>{[['Kimi Code', runtimeLabel], [t('登录态'), cli?.loggedIn === true ? t('已登录') : cli?.loggedIn === false ? t('未登录') : t('无法判定')], [t('桌面端'), info ? `Farside ${info.appVersion}` : '—'], [t('运行时'), info ? `Electron ${info.electronVersion}` : '—']].map(([label, value]) => <div key={label} style={{ display: 'flex', gap: 12 }}><span style={{ color: 'var(--faint)' }}>{label}</span><span className="mono" style={{ marginLeft: 'auto', color: 'var(--dust)' }}>{value}</span></div>)}</div></div>
          <div style={{ padding: 14, border: '1px solid var(--line)', borderRadius: 8, background: 'var(--regolith)' }}><div className="mono" style={{ fontSize: 9.5, color: 'var(--faint)', letterSpacing: '.14em' }}>PERMISSION</div><div className="mono" style={{ marginTop: 12, fontSize: 12.5, color: 'var(--moonlight)' }}>{permissionLabel}</div><p style={{ margin: '8px 0 0', fontSize: 11, lineHeight: 1.6, color: 'var(--faint)' }}>{t(permissionMode === 'manual' ? '读类工具自动放行，写入与执行逐项确认。' : permissionMode === 'auto' ? '自动处理审批，适合可信工作区。' : '跳过常规审批，请只在隔离环境使用。')}</p></div>
          <div style={{ gridColumn: '1 / -1', padding: 14, border: '1px solid var(--line)', borderRadius: 8 }}><div className="mono" style={{ fontSize: 9.5, color: 'var(--faint)', letterSpacing: '.14em' }}>KEYBOARD</div><div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>{SHORTCUTS.map(([label, keys]) => <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ fontSize: 11.5, color: 'var(--dust)' }}>{t(label)}</span><span style={{ marginLeft: 'auto' }}><Kbd>{keys}</Kbd></span></div>)}</div></div>
        </div>
      </div>
    </div>
  )
}

function releaseNotesText(notes: string | undefined, english: boolean): string {
  if (!notes?.trim()) return english ? 'No release notes were provided.' : '此版本没有提供更新说明。'
  return notes
    .replace(/<details[^>]*>|<\/details>|<summary[^>]*>|<\/summary>/gi, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 · $2')
    .trim()
}

function AboutPanel({ info }: { info: AppInfo | null }) {
  const { locale, t } = usePreferences()
  const english = locale === 'en-US'
  const checkUpdates = useFarsideStore((state) => state.checkUpdates)
  const updateNotice = useFarsideStore((state) => state.updateNotice)
  const updateInfo = useFarsideStore((state) => state.updateInfo)
  const clearUpdateNotice = useFarsideStore((state) => state.clearUpdateNotice)
  const [checking, setChecking] = useState(false)
  const [history, setHistory] = useState<AppReleaseInfo[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyError, setHistoryError] = useState('')

  const loadHistory = () => {
    const api = window.api?.update
    if (!api) {
      setHistoryLoading(false)
      return
    }
    setHistoryLoading(true)
    setHistoryError('')
    void api.history()
      .then((result) => {
        setHistory(result.releases)
        if (!result.ok) setHistoryError(result.error ?? (english ? 'Unable to load release history.' : '更新历史读取失败'))
      })
      .catch((error) => {
        setHistoryError(error instanceof Error ? error.message : (english ? 'Unable to load release history.' : '更新历史读取失败'))
      })
      .finally(() => setHistoryLoading(false))
  }

  useEffect(() => {
    loadHistory()
    // 只在进入“关于”时请求一次；按钮可手动刷新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runUpdateCheck = () => {
    clearUpdateNotice()
    setChecking(true)
    void checkUpdates(true).finally(() => setChecking(false))
  }

  const updateStatus = checking
    ? (english ? 'Contacting release channel…' : '正在连接 Release 更新通道…')
    : updateInfo?.latestVersion
      ? (english ? `Version ${updateInfo.latestVersion} is available` : `发现新版本 v${updateInfo.latestVersion}`)
      : updateNotice?.kind === 'latest'
        ? (english ? `Latest version · v${updateNotice.version}` : `当前已是最新版本 · v${updateNotice.version}`)
        : updateNotice?.kind === 'failed'
          ? (english ? 'Update check failed. Please retry.' : '检查更新失败，请稍后重试。')
          : (english ? 'Automatic update checks are enabled' : '已启用启动与定时自动检查')

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <PanelTitle
        eyebrow="Farside Desktop"
        title={t('关于')}
        note={t('为 Kimi Code 打造的桌面 Agent 工作台')}
        actions={
          <button
            style={{ ...buttonStyle, color: checking ? 'var(--faint)' : 'var(--moonlight)' }}
            disabled={checking}
            onClick={runUpdateCheck}
          >
            {checking ? (english ? 'Checking…' : '检查中…') : (english ? 'Check for updates' : '检查更新')}
          </button>
        }
      />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 18 }}>
        <div style={{ maxWidth: 900, display: 'grid', gap: 18 }}>
          <section style={{ display: 'grid', gridTemplateColumns: 'minmax(260px,.8fr) minmax(320px,1.2fr)', border: '1px solid var(--line-hi)', borderRadius: 11, overflow: 'hidden', background: 'var(--regolith)' }}>
            <div style={{ position: 'relative', minHeight: 190, padding: 24, borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', overflow: 'hidden' }}>
              <span aria-hidden style={{ position: 'absolute', width: 180, height: 180, top: -85, right: -70, border: '1px solid var(--line)', borderRadius: '50%' }} />
              <div>
                <CrescentLogo size={42} />
                <div style={{ marginTop: 13, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 19, letterSpacing: '.28em', color: 'var(--moonlight)' }}>FARSIDE</div>
                <p style={{ margin: '7px 0 0', color: 'var(--faint)', fontSize: 11.5 }}>{t('月之暗面 · Kimi Code 桌面端')}</p>
              </div>
              <div className="mono" style={{ color: 'var(--faint)', fontSize: 9.5, lineHeight: 1.8 }}>
                VERSION {info?.appVersion ?? '—'}<br />
                ELECTRON {info?.electronVersion ?? '—'} · {info ? `${info.platform}/${info.arch}` : 'RUNTIME —'}
              </div>
            </div>
            <div style={{ padding: 20, display: 'grid', alignContent: 'center', gap: 15 }}>
              <div>
                <div className="mono" style={{ fontSize: 9, letterSpacing: '.15em', color: 'var(--faint)' }}>UPDATE CHANNEL · GITHUB RELEASES</div>
                <div style={{ marginTop: 7, color: updateNotice?.kind === 'failed' ? 'var(--redshift)' : updateInfo ? 'var(--signal)' : 'var(--dust)', fontSize: 12.5 }}>{updateStatus}</div>
              </div>
              <div style={{ height: 1, background: 'var(--line)' }} />
              <div>
                <div style={{ fontSize: 10.5, color: 'var(--faint)' }}>{english ? 'Source repository' : '源代码仓库'}</div>
                <a
                  href="https://github.com/dandandujie/Farside"
                  target="_blank"
                  rel="noreferrer"
                  className="mono"
                  style={{ display: 'inline-block', marginTop: 6, color: 'var(--moonlight)', fontSize: 10.5 }}
                >
                  github.com/dandandujie/Farside ↗
                </a>
              </div>
            </div>
          </section>

          <section style={{ display: 'grid', gap: 9 }}>
            <header style={{ minHeight: 36, display: 'flex', alignItems: 'center', gap: 10 }}>
              <div>
                <div className="mono" style={{ fontSize: 9, letterSpacing: '.15em', color: 'var(--faint)' }}>MISSION LOG · RELEASE ARCHIVE</div>
                <h3 style={{ margin: '3px 0 0', fontSize: 13.5, fontWeight: 500, color: 'var(--moonlight)' }}>{english ? 'Changelog & history' : '更新日志与历史版本'}</h3>
              </div>
              <button style={{ ...buttonStyle, marginLeft: 'auto' }} disabled={historyLoading} onClick={loadHistory}>
                {historyLoading ? (english ? 'Loading…' : '载入中…') : (english ? 'Refresh history' : '刷新历史')}
              </button>
            </header>
            <div style={{ border: '1px solid var(--line)', borderRadius: 9, background: 'var(--regolith)', overflow: 'hidden' }}>
              {history.map((release, index) => {
                const current = release.version === info?.appVersion
                const date = release.publishedAt && !Number.isNaN(new Date(release.publishedAt).getTime())
                  ? new Date(release.publishedAt).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })
                  : '—'
                return (
                  <details key={`${release.version}-${release.url}`} open={index === 0}>
                    <summary style={{ minHeight: 54, padding: '10px 13px', borderBottom: '1px solid var(--line)', cursor: 'pointer', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span className="mono" style={{ minWidth: 76, color: 'var(--moonlight)', fontSize: 11 }}>v{release.version}</span>
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dust)', fontSize: 11.5 }}>{release.name || `Farside v${release.version}`}</span>
                      {release.prerelease ? <span className="mono" style={{ padding: '2px 5px', border: '1px solid var(--flare)', borderRadius: 4, color: 'var(--flare)', fontSize: 8.5 }}>PRE</span> : null}
                      {current ? <span className="mono" style={{ padding: '2px 5px', border: '1px solid var(--line-hi)', borderRadius: 4, color: 'var(--signal)', fontSize: 8.5 }}>{english ? 'CURRENT' : '当前版本'}</span> : null}
                      <time className="mono" dateTime={release.publishedAt} style={{ marginLeft: 'auto', color: 'var(--faint)', fontSize: 9.5 }}>{date}</time>
                      <span aria-hidden style={{ color: 'var(--faint)', fontSize: 11 }}>⌄</span>
                    </summary>
                    <div style={{ padding: '13px 14px 15px', borderBottom: '1px solid var(--line)', background: 'var(--mare)' }}>
                      <pre style={{ margin: 0, maxHeight: 260, overflowY: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--dust)', fontFamily: 'var(--font-sans)', fontSize: 11, lineHeight: 1.7 }}>{releaseNotesText(release.notes, english)}</pre>
                      <a href={release.url} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 11, color: 'var(--moonlight)', fontSize: 10.5 }}>{english ? 'Open this release on GitHub ↗' : '在 GitHub 查看此版本 ↗'}</a>
                    </div>
                  </details>
                )
              })}
              {!history.length && !historyLoading ? (
                <div style={{ padding: 26, textAlign: 'center', color: historyError ? 'var(--redshift)' : 'var(--faint)', fontSize: 11.5 }}>
                  {historyError || (english ? 'No published releases yet.' : '暂无已发布版本。')}
                </div>
              ) : null}
              {historyError && history.length ? <div style={{ padding: '8px 12px', color: 'var(--redshift)', fontSize: 10.5 }}>{historyError}</div> : null}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

export function SettingsView() {
  const { t } = usePreferences()
  const [section, setSection] = useState<SettingsSection>(() => new URLSearchParams(window.location.search).get('shot') === 'settings-light' ? 'general' : 'account')
  const settingsRequest = useFarsideStore((state) => state.settingsRequest)
  const [extensionTab, setExtensionTab] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<ConfigurationSnapshot>(EMPTY_SNAPSHOT)
  const [configError, setConfigError] = useState('')
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [cli, setCli] = useState<CliStatus | null>(null)
  const hasApi = typeof window !== 'undefined' && window.api != null

  // Esc 从设置页返回会话视图；正在输入或配置编辑器有未保存改动时不劫持。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (settingsEditorDirty) return
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
      if (target instanceof HTMLElement && target.isContentEditable) return
      useFarsideStore.getState().setView('sessions')
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // 斜杠命令/命令面板可以深链到指定分区（如 /plugins → 扩展中心）。
  useEffect(() => {
    if (!settingsRequest) return
    if (NAV.some((item) => item.id === settingsRequest.section)) {
      setSection(settingsRequest.section as SettingsSection)
      setExtensionTab(settingsRequest.tab ?? null)
    }
    useFarsideStore.setState({ settingsRequest: null })
  }, [settingsRequest])

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
      <div style={{ height: 64, flexShrink: 0, padding: '0 20px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center' }}><div><h1 style={{ margin: 0, fontSize: 18, fontWeight: 500, color: 'var(--moonlight)' }}>{t('设置控制中心')}</h1><p style={{ margin: '4px 0 0', fontSize: 10.5, color: 'var(--faint)' }}>{t('账户、扩展与磁盘配置分区管理')}</p></div><div className="mono" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 7, fontSize: 9.5, color: configError ? 'var(--redshift)' : 'var(--faint)' }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: configError ? 'var(--redshift)' : 'var(--moonlight)' }} />{configError || 'CONFIG WATCH ACTIVE'}</div></div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <nav style={{ width: 196, flexShrink: 0, padding: 10, borderRight: '1px solid var(--line)', background: 'color-mix(in srgb, var(--regolith) 34%, var(--void))', overflowY: 'auto' }}>{NAV.map((item) => <button key={item.id} onClick={() => setSection(item.id)} style={{ width: '100%', minHeight: 52, padding: '8px 9px', marginBottom: 3, border: `1px solid ${section === item.id ? 'var(--line-hi)' : 'transparent'}`, borderRadius: 7, background: section === item.id ? 'var(--regolith)' : 'transparent', textAlign: 'left', display: 'grid', gridTemplateColumns: '23px 1fr', columnGap: 8 }}><span className="mono" style={{ gridRow: '1 / 3', fontSize: 9.5, paddingTop: 2, color: section === item.id ? 'var(--moonlight)' : 'var(--ghost)' }}>{item.mark}</span><span style={{ fontSize: 11.5, color: section === item.id ? 'var(--moonlight)' : 'var(--dust)' }}>{t(item.label)}</span><span style={{ marginTop: 3, fontSize: 9.5, color: 'var(--faint)' }}>{t(item.note)}</span></button>)}</nav>
        <section style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>{section === 'account' ? <AccountPanel info={info} /> : null}{section === 'profile' ? <ProfilePanel /> : null}{section === 'extensions' ? <ExtensionCenter key={extensionTab ?? 'default'} snapshot={snapshot} onSnapshot={setSnapshot} initialTab={extensionTab as ExtensionTab | undefined} /> : null}{section === 'configuration' ? <ConfigurationEditor snapshot={snapshot} onSnapshot={setSnapshot} /> : null}{section === 'connections' ? <ConnectionPanel /> : null}{section === 'general' ? <GeneralPanel info={info} cli={cli} hasApi={hasApi} /> : null}{section === 'about' ? <AboutPanel info={info} /> : null}</section>
      </div>
    </div>
  )
}
