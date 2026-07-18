import { useEffect, useState } from 'react'
import type { AccountProviderKind } from '@shared/types'
import { useFarsideStore } from '../../lib/store'
import { usePreferences } from '../../lib/preferences'

type ConfigurableKind = Exclude<AccountProviderKind, 'kimi-oauth'>

const PROVIDERS: Array<{
  kind: AccountProviderKind
  label: string
  eyebrow: string
  description: string
}> = [
  {
    kind: 'kimi-oauth',
    label: 'Kimi 账户',
    eyebrow: '推荐',
    description: '设备码授权，支持套餐与 5 小时 / 周限额读数。'
  },
  {
    kind: 'kimi-api',
    label: 'Kimi 官方 API',
    eyebrow: 'API KEY',
    description: '接入 Moonshot AI 开放平台，自定义可用模型。'
  },
  {
    kind: 'openai-compatible',
    label: 'OpenAI 兼容服务',
    eyebrow: '自定义',
    description: '接入任何提供 OpenAI Chat Completions 协议的 Kimi 服务。'
  }
]

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text'
}: {
  label: string
  value: string
  onChange(value: string): void
  placeholder?: string
  type?: 'text' | 'password' | 'number'
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 11.5, color: 'var(--faint)' }}>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete={type === 'password' ? 'new-password' : 'off'}
        style={{
          width: '100%',
          border: '1px solid var(--line)',
          borderRadius: 6,
          background: 'var(--regolith)',
          color: 'var(--moonlight)',
          padding: '8px 10px',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          outline: 'none'
        }}
      />
    </label>
  )
}

/** 首次设置与设置页共用的 Provider 接入面板。敏感字段只短暂存在于表单。 */
export function AccountSetup({ compact = false }: { compact?: boolean }) {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
  const initialize = useFarsideStore((state) => state.initialize)
  const configureAccount = useFarsideStore((state) => state.configureAccount)
  const account = useFarsideStore((state) => state.account)
  const [kind, setKind] = useState<AccountProviderKind>('kimi-oauth')
  const [pending, setPending] = useState(false)
  const [verificationUri, setVerificationUri] = useState<string | null>(null)
  const [userCode, setUserCode] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://api.moonshot.cn/v1')
  const [model, setModel] = useState('kimi-k2.5')
  const [contextWindow, setContextWindow] = useState('262144')

  useEffect(() => {
    if (!pending || !window.api?.agent) return
    const timer = window.setInterval(() => {
      void window.api!.agent.pollLogin().then((result) => {
        if (!result.ok) {
          setPending(false)
          setLocalError(result.error ?? '登录状态查询失败')
          return
        }
        if (result.ready) {
          setPending(false)
          setSaved(true)
          void initialize()
        }
      })
    }, 2_000)
    return () => window.clearInterval(timer)
  }, [initialize, pending])

  const selectProvider = (next: AccountProviderKind) => {
    setKind(next)
    setLocalError(null)
    setSaved(false)
    if (next === 'kimi-api') {
      setBaseUrl('https://api.moonshot.cn/v1')
      setModel('kimi-k2.5')
    } else if (next === 'openai-compatible') {
      setBaseUrl('')
      setModel('')
    }
  }

  const startOAuth = async () => {
    setPending(true)
    setLocalError(null)
    setSaved(false)
    const result = await window.api?.agent.startLogin()
    if (!result) {
      setPending(false)
      setLocalError('桌面链路未就绪')
      return
    }
    if (!result.ok) {
      setPending(false)
      setLocalError(result.error ?? '登录流程启动失败')
      return
    }
    if (result.ready) {
      setPending(false)
      setSaved(true)
      await initialize()
      return
    }
    setVerificationUri(result.verificationUri ?? null)
    setUserCode(result.userCode ?? null)
    if (result.verificationUri) window.open(result.verificationUri, '_blank', 'noopener')
  }

  const saveApiProvider = async () => {
    if (kind === 'kimi-oauth') return
    setPending(true)
    setLocalError(null)
    setSaved(false)
    const ok = await configureAccount({
      kind: kind as ConfigurableKind,
      apiKey,
      baseUrl,
      model,
      contextWindow: Number(contextWindow)
    })
    setPending(false)
    if (ok) {
      setApiKey('')
      setSaved(true)
    } else {
      setLocalError(useFarsideStore.getState().lastError ?? '账户配置失败')
    }
  }

  const error = localError
  const activeKind = account?.providers.find((provider) => provider.active)?.kind

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 14 : 18 }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: compact ? '1fr' : 'repeat(3, minmax(0, 1fr))',
          gap: 8
        }}
      >
        {PROVIDERS.map((provider) => {
          const selected = provider.kind === kind
          const active = provider.kind === activeKind
          return (
            <button
              key={provider.kind}
              type="button"
              onClick={() => selectProvider(provider.kind)}
              style={{
                position: 'relative',
                minHeight: compact ? 66 : 104,
                padding: compact ? '10px 12px' : '13px 14px',
                textAlign: 'left',
                borderRadius: 8,
                border: selected ? '1px solid var(--line-hi)' : '1px solid var(--line)',
                background: selected ? 'var(--crater)' : 'var(--regolith)'
              }}
            >
              <span
                className="mono"
                style={{ display: 'block', fontSize: 9.5, letterSpacing: '0.1em', color: 'var(--faint)' }}
              >
                {active ? (english ? 'ACTIVE' : '当前链路') : english && provider.eyebrow === '推荐' ? 'RECOMMENDED' : english && provider.eyebrow === '自定义' ? 'CUSTOM' : provider.eyebrow}
              </span>
              <strong
                style={{ display: 'block', marginTop: 5, fontSize: 12.5, fontWeight: 500, color: 'var(--moonlight)' }}
              >
                {english ? ({ 'kimi-oauth': 'Kimi account', 'kimi-api': 'Kimi official API', 'openai-compatible': 'OpenAI-compatible service' } as Record<AccountProviderKind, string>)[provider.kind] : provider.label}
              </strong>
              {!compact ? (
                <span style={{ display: 'block', marginTop: 5, fontSize: 11, lineHeight: 1.45, color: 'var(--faint)' }}>
                  {english ? ({ 'kimi-oauth': 'Device authorization with plan, 5-hour, and weekly usage.', 'kimi-api': 'Connect to the Moonshot AI platform and choose a model.', 'openai-compatible': 'Connect any Kimi service implementing OpenAI Chat Completions.' } as Record<AccountProviderKind, string>)[provider.kind] : provider.description}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      {kind === 'kimi-oauth' ? (
        <div
          style={{
            padding: compact ? '13px 14px' : '16px',
            border: '1px solid var(--line)',
            borderRadius: 8,
            background: 'color-mix(in srgb, var(--regolith) 70%, transparent)'
          }}
        >
          <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, color: 'var(--moonlight)' }}>{english ? 'Browser device authorization' : '浏览器设备码授权'}</div>
              <p style={{ margin: '5px 0 0', fontSize: 11.5, lineHeight: 1.6, color: 'var(--faint)' }}>
                {english ? 'Sign in to view plan, 5-hour, and weekly usage. Credentials stay in the main process and are never exposed to the page.' : '登录后可读取会员套餐、5 小时窗口与周周期用量。凭据留在本机，页面不会收到令牌。'}
              </p>
            </div>
            <button
              type="button"
              disabled={pending}
              onClick={() => void startOAuth()}
              style={{
                flexShrink: 0,
                padding: '8px 13px',
                borderRadius: 6,
                background: pending ? 'var(--crater)' : 'var(--moonlight)',
                color: pending ? 'var(--faint)' : 'var(--void)',
                fontSize: 12
              }}
            >
              {pending ? (english ? 'Waiting…' : '等待授权…') : activeKind === 'kimi-oauth' ? (english ? 'Reauthorize' : '重新授权') : (english ? 'Sign in with Kimi' : '使用 Kimi 登录')}
            </button>
          </div>
          {userCode ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                marginTop: 13,
                paddingTop: 12,
                borderTop: '1px solid var(--line)'
              }}
            >
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--faint)' }}>{english ? 'DEVICE CODE' : '设备码'}</span>
              <strong className="mono" style={{ fontSize: 17, letterSpacing: '0.14em' }}>{userCode}</strong>
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(userCode)}
                style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--dust)' }}
              >
                {english ? 'Copy' : '复制'}
              </button>
              {verificationUri ? (
                <a href={verificationUri} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: 'var(--dust)' }}>
                  {english ? 'Open verification page' : '打开验证页'}
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: compact ? '1fr' : '1fr 1fr',
            gap: 12,
            padding: compact ? '13px 14px' : '16px',
            border: '1px solid var(--line)',
            borderRadius: 8,
            background: 'color-mix(in srgb, var(--regolith) 70%, transparent)'
          }}
        >
          <div style={{ gridColumn: compact ? undefined : '1 / -1' }}>
            <Field
              label={kind === 'kimi-api' ? 'Moonshot API Key' : 'API Key'}
              type="password"
              value={apiKey}
              onChange={setApiKey}
              placeholder={english ? 'Entered once; never echoed after saving' : '仅本次输入，保存后不再回显'}
            />
          </div>
          <Field label="Base URL" value={baseUrl} onChange={setBaseUrl} placeholder="https://example.com/v1" />
          <Field label={english ? 'Model ID' : '模型 ID'} value={model} onChange={setModel} placeholder={english ? 'Model name exposed by the service' : '服务端声明的模型名称'} />
          <Field
            label={english ? 'Context window' : '上下文窗口'}
            type="number"
            value={contextWindow}
            onChange={setContextWindow}
            placeholder="262144"
          />
          <div style={{ display: 'flex', alignItems: 'end', justifyContent: 'flex-end' }}>
            <button
              type="button"
              disabled={pending}
              onClick={() => void saveApiProvider()}
              style={{
                width: compact ? '100%' : 'auto',
                padding: '8px 14px',
                borderRadius: 6,
                background: pending ? 'var(--crater)' : 'var(--moonlight)',
                color: pending ? 'var(--faint)' : 'var(--void)',
                fontSize: 12
              }}
            >
              {pending ? (english ? 'Validating…' : '正在验证…') : (english ? 'Save & connect' : '保存并连接')}
            </button>
          </div>
        </div>
      )}

      {error ? <p style={{ margin: 0, fontSize: 11.5, color: 'var(--redshift)' }}>{error}</p> : null}
      {saved ? <p style={{ margin: 0, fontSize: 11.5, color: 'var(--moonlight)' }}>{english ? 'Connection saved and set as the active account.' : '链路已保存并设为当前账户。'}</p> : null}
    </div>
  )
}
