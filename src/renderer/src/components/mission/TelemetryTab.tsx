import { useFarsideStore, useActiveSession } from '../../lib/store'
import { FuelGauge } from '../../design-system/FuelGauge'
import { TelemetryNum } from '../../design-system/TelemetryNum'
import { SectionLabel } from '../../design-system/SectionLabel'
import { MODELS, type TelemetryEvent } from '@shared/types'
import { usePreferences } from '../../lib/preferences'

function formatWindow(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`
  if (n >= 1_000) return `${Math.round(n / 1000)}K`
  return String(n)
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`
  return n.toLocaleString()
}

function formatCny(value: number | undefined): string {
  if (value === undefined) return '—'
  return `¥${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`
}

function inferredActiveDuration(session: NonNullable<ReturnType<typeof useActiveSession>>): number {
  let startedAt: number | null = null
  let lastAt: number | null = null
  let total = 0
  for (const event of session.events) {
    if (event.kind === 'system') continue
    if (event.kind === 'user') {
      if (startedAt !== null && lastAt !== null) total += Math.max(0, lastAt - startedAt)
      startedAt = event.at
    }
    if (startedAt !== null) lastAt = Math.max(lastAt ?? event.at, event.at)
  }
  if (startedAt !== null && lastAt !== null) total += Math.max(0, lastAt - startedAt)
  return total
}

/** 实际请求处理时间之和，不把 CLI 会话闲置时间算进去。 */
function formatElapsed(session: ReturnType<typeof useActiveSession>, english: boolean): string {
  if (!session || session.events.length === 0) return '—'
  const ms = session.activeDurationMs ?? inferredActiveDuration(session)
  const totalSec = Math.floor(ms / 1000)
  const days = Math.floor(totalSec / 86_400)
  const hours = Math.floor((totalSec % 86_400) / 3_600)
  const m = Math.floor((totalSec % 3_600) / 60)
  const s = totalSec % 60
  if (days > 0) return english ? `${days}d ${hours}h` : `${days}天 ${hours}小时`
  if (hours > 0) return english ? `${hours}h ${m}m` : `${hours}小时 ${m}分`
  return english ? `${m}m ${s}s` : `${m}分 ${s}秒`
}

function QuotaBar({ label, pct }: { label: string; pct: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 12.5, color: 'var(--dust)' }}>{label}</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>
          {pct}%
        </span>
      </div>
      <div style={{ height: 2, background: 'var(--line)', borderRadius: 999 }}>
        <div
          style={{
            width: `${Math.min(100, Math.max(0, pct))}%`,
            height: '100%',
            background: pct > 80 ? 'var(--flare)' : 'var(--moonlight)',
            borderRadius: 999,
            transition: 'width 600ms var(--ease-farside)'
          }}
        />
      </div>
    </div>
  )
}

/** 遥测 tab：燃料环（总量 = 当前模型上下文窗口）+ 读数网格 + 配额 + 模型卡片。 */
export function TelemetryTab() {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
  const active = useActiveSession()
  const model = useFarsideStore((s) => s.model)
  const quota = useFarsideStore((s) => s.quota)
  const account = useFarsideStore((s) => s.account)
  const remoteInfo = account?.models.find(
    (item) => item.id === model && (!account.activeProviderId || item.providerId === account.activeProviderId)
  )
  const info = remoteInfo
    ? {
        id: remoteInfo.id,
        label: remoteInfo.label,
        contextWindow: remoteInfo.contextWindow,
        note: remoteInfo.capabilities.length
          ? remoteInfo.capabilities.join(' · ')
          : (english ? 'Model exposed by the current Provider' : '当前 Provider 声明的模型')
      }
    : (MODELS.find((item) => item.id === model) ?? MODELS[0])

  const telemetry = [...(active?.events ?? [])].reverse().find((e) => e.kind === 'telemetry') as
    | TelemetryEvent
    | undefined
  const used = active?.contextTokens ?? 0
  const quotaAvailable =
    quota.weekUsedPct > 0 || quota.fiveHourUsedPct > 0 || quota.extraBalanceCny !== null
  const costValue = telemetry?.estimatedCostCny !== undefined
    ? formatCny(telemetry.estimatedCostCny)
    : telemetry?.cost !== undefined
      ? `$${telemetry.cost.toFixed(4)}`
      : '—'
  const inputTokens = telemetry?.inputTokens ?? 0
  const cachedInputTokens = telemetry?.cachedInputTokens ?? 0
  const outputTokens = telemetry?.outputTokens ?? 0
  const tokenTotal = inputTokens + cachedInputTokens + outputTokens

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SectionLabel>{english ? 'FUEL' : '燃料'} · {formatWindow(info.contextWindow)} {english ? 'CONTEXT' : '上下文'}</SectionLabel>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0' }}>
        <FuelGauge used={used} total={info.contextWindow} size={148} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px 12px' }}>
        <TelemetryNum
          label={english ? 'Rate' : '速率'}
          value={telemetry && telemetry.tokensPerSecond > 0 ? telemetry.tokensPerSecond.toFixed(1) : '—'}
          unit="tok/s"
        />
        <TelemetryNum label={english ? 'Active time' : '处理耗时'} value={formatElapsed(active, english)} />
        <TelemetryNum
          label={english ? 'API estimate' : 'API 估算'}
          value={costValue}
        />
        <TelemetryNum
          label={english ? 'Cache hit rate' : '缓存命中率'}
          value={telemetry?.cacheHitRate !== undefined ? `${telemetry.cacheHitRate.toFixed(1)}%` : '—'}
        />
      </div>

      <div style={{ border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden', background: 'var(--regolith)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '9px 10px', borderBottom: '1px solid var(--line)' }}>
          <SectionLabel>{english ? 'TOKEN COST' : 'TOKEN 与成本'}</SectionLabel>
          <span className="mono" style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--faint)' }}>
            {tokenTotal > 0 ? `${formatTokens(tokenTotal)} tok` : '—'}
          </span>
        </div>
        {[
          [english ? 'Input · cache miss' : '输入 · 未命中', inputTokens, telemetry?.inputCostCny],
          [english ? 'Input · cache hit' : '输入 · 缓存命中', cachedInputTokens, telemetry?.cachedInputCostCny],
          [english ? 'Output' : '输出', outputTokens, telemetry?.outputCostCny]
        ].map(([label, tokens, cost]) => (
          <div key={String(label)} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10, alignItems: 'baseline', padding: '7px 10px', borderBottom: '1px solid color-mix(in srgb, var(--line) 70%, transparent)' }}>
            <span style={{ fontSize: 11.5, color: 'var(--dust)' }}>{String(label)}</span>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--faint)' }}>{formatTokens(Number(tokens))}</span>
            <span className="mono" style={{ minWidth: 58, textAlign: 'right', fontSize: 10.5, color: 'var(--moonlight)' }}>{formatCny(cost as number | undefined)}</span>
          </div>
        ))}
        <p style={{ margin: 0, padding: '8px 10px', fontSize: 10.5, lineHeight: 1.55, color: 'var(--faint)' }}>
          {english
            ? 'Estimated from each usage record using the matching Kimi API list price. Subscription accounts are not charged again.'
            : '按每条 usage 记录对应模型的 Kimi 开放平台单价估算；订阅账户不会因此重复扣费。'}
        </p>
      </div>

      <div
        style={{
          borderTop: '1px solid var(--line)',
          paddingTop: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 12
        }}
      >
        <SectionLabel>{english ? 'USAGE' : '配额'}</SectionLabel>
        {quotaAvailable ? (
          <>
            <QuotaBar label={english ? '7-day window' : '7 天周期'} pct={quota.weekUsedPct} />
            <QuotaBar label={english ? '5-hour window' : '5 小时窗口'} pct={quota.fiveHourUsedPct} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontSize: 12.5, color: 'var(--dust)' }}>Extra Usage</span>
              <span className="mono" style={{ fontSize: 12.5, color: 'var(--moonlight)' }}>
                {quota.extraBalanceCny === null ? '—' : `¥ ${quota.extraBalanceCny.toFixed(2)}`}
              </span>
            </div>
          </>
        ) : (
          <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.6, color: 'var(--faint)' }}>
            {english ? 'API-key providers do not expose subscription windows. A Kimi OAuth account can show 5-hour and weekly usage.' : 'API Key 接入不提供会员周期读数；Kimi OAuth 账户可显示 5 小时与周周期用量。'}
          </p>
        )}
      </div>

      <div
        style={{
          borderTop: '1px solid var(--line)',
          paddingTop: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 8
        }}
      >
        <SectionLabel>{english ? 'MODEL' : '模型'}</SectionLabel>
        <div
          style={{
            background: 'var(--regolith)',
            border: '1px solid var(--line)',
            borderRadius: 6,
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 4
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: 14, color: 'var(--moonlight)', letterSpacing: '0.01em' }}>
              {info.label}
            </span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>
              {formatWindow(info.contextWindow)} ctx
            </span>
          </div>
          <span className="mono" style={{ fontSize: 11, color: 'var(--dust)', lineHeight: 1.6 }}>
            {info.note}
          </span>
        </div>
      </div>
    </div>
  )
}
