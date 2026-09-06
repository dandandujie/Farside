import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AccountProfileResult } from '@shared/ipc'
import type { AccountProfileStats, AccountUsage } from '@shared/types'
import {
  finiteNumber,
  fixedPointCny,
  PLAN_LABELS,
  isRecord,
  localDateKey,
  parseWireProfile,
  profileReasoningLabel,
  usageWindow,
  walletCny,
  type WireFileProfileStats
} from './wire-events'

/**
 * 账户域服务：官方订阅用量与本地任务画像统计。
 * 完全独立于 Kimi Server 链路（用量直连官方 API，画像只读 ~/.kimi-code），
 * 因此自 KimiClientService 拆出；随包工件为零外部依赖，可独立单测。
 */
export class AccountService {
  /** wire.jsonl → 统计缓存：按 mtime+size 失效，未变更文件零解析。 */
  private profileCache = new Map<string, { mtimeMs: number; size: number; stats: WireFileProfileStats }>()
  private managedIdentity: AccountProfileStats['identity']

  async fetchManagedUsage(): Promise<AccountUsage> {
    try {
      const root = process.env['KIMI_CODE_HOME'] || join(homedir(), '.kimi-code')
      const raw = JSON.parse(
        await fs.readFile(join(root, 'credentials', 'kimi-code.json'), 'utf8')
      ) as unknown
      if (!isRecord(raw) || typeof raw.access_token !== 'string' || !raw.access_token) {
        throw new Error('未找到可用的 Kimi OAuth 凭据')
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8_000)
      let response: Response
      try {
        const managedBase = (process.env['KIMI_CODE_BASE_URL'] || 'https://api.kimi.com/coding/v1').replace(/\/+$/, '')
        response = await fetch(`${managedBase}/usages`, {
          headers: { Authorization: `Bearer ${raw.access_token}`, Accept: 'application/json' },
          signal: controller.signal
        })
      } finally {
        clearTimeout(timer)
      }
      if (!response.ok) throw new Error(`官方用量接口返回 ${response.status}`)
      const payload = (await response.json()) as unknown
      if (!isRecord(payload)) throw new Error('官方用量响应格式无效')
      const user = isRecord(payload.user) ? payload.user : {}
      const membership = isRecord(user.membership) ? user.membership : {}
      const displayName = [user.displayName, user.display_name, user.nickname, user.name]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
      const username = [user.username, user.handle, user.userId, user.user_id, user.id]
        .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
      if (displayName || username) {
        this.managedIdentity = {
          ...(displayName ? { displayName: displayName.trim() } : {}),
          ...(username ? { username: username.trim().replace(/^@/, '') } : {})
        }
      }
      const planCode = typeof membership.level === 'string' ? membership.level : undefined
      const rawLimits = Array.isArray(payload.limits) ? payload.limits : []
      const fiveHourItem = rawLimits.find((item) => {
        if (!isRecord(item) || !isRecord(item.window)) return false
        const duration = finiteNumber(item.window.duration)
        const unit = typeof item.window.timeUnit === 'string' ? item.window.timeUnit : ''
        return (
          (duration === 300 && unit.includes('MINUTE')) ||
          (duration === 5 && unit.includes('HOUR'))
        )
      })
      const fiveHour =
        isRecord(fiveHourItem) && isRecord(fiveHourItem.detail)
          ? usageWindow(fiveHourItem.detail)
          : undefined
      const booster = isRecord(payload.boosterWallet) ? payload.boosterWallet : null
      const balance = booster && isRecord(booster.balance) ? booster.balance : null
      const amountLeft = balance ? finiteNumber(balance.amountLeft) : null
      const currency =
        booster && isRecord(booster.monthlyChargeLimit) &&
        typeof booster.monthlyChargeLimit.currency === 'string'
          ? booster.monthlyChargeLimit.currency
          : booster && isRecord(booster.monthlyUsed) && typeof booster.monthlyUsed.currency === 'string'
            ? booster.monthlyUsed.currency
            : 'USD'
      return {
        planCode,
        planLabel: planCode ? (PLAN_LABELS[planCode] ?? planCode.replace(/^LEVEL_/, '')) : 'Kimi 会员',
        weekly: usageWindow(payload.usage),
        fiveHour,
        extraBalanceCny:
          amountLeft !== null && currency.toUpperCase() === 'CNY'
            ? fixedPointCny(amountLeft)
            : null,
        extraMonthlyUsedCny: walletCny(booster?.monthlyUsed, 'amount', 'amountUsed', 'used'),
        extraMonthlyLimitCny: walletCny(
          booster?.monthlyChargeLimit,
          'amount',
          'amountLimit',
          'limit'
        ),
        updatedAt: Date.now()
      }
    } catch (error) {
      return {
        planLabel: 'Kimi 会员',
        extraBalanceCny: null,
        updatedAt: Date.now(),
        error: error instanceof Error ? error.message : '订阅用量查询失败'
      }
    }
  }

  /** 退出登录后清除缓存的 OAuth 身份，避免画像继续显示旧账户。 */
  resetIdentity(): void {
    this.managedIdentity = undefined
  }

  async getAccountProfile(): Promise<AccountProfileResult> {
    try {
      const root = process.env['KIMI_CODE_HOME'] || join(homedir(), '.kimi-code')
      const wireFiles: string[] = []
      const collectWireFiles = async (directory: string): Promise<void> => {
        let entries
        try {
          entries = await fs.readdir(directory, { withFileTypes: true })
        } catch {
          return
        }
        await Promise.all(entries.map(async (entry) => {
          const path = join(directory, entry.name)
          if (entry.isDirectory()) await collectWireFiles(path)
          else if (entry.isFile() && entry.name === 'wire.jsonl') wireFiles.push(path)
        }))
      }
      await collectWireFiles(join(root, 'sessions'))

      const daily = new Map<string, { tokens: number; tasks: number }>()
      const reasoning = new Map<string, number>()
      const skills = new Map<string, number>()
      const tools = new Map<string, number>()
      let totalTokens = 0
      let peakTaskTokens = 0
      let longestTaskDurationMs = 0
      let taskCount = 0
      let requestCount = 0
      let fastRequestCount = 0

      const seenFiles = new Set<string>()
      for (const file of wireFiles) {
        seenFiles.add(file)
        const stat = await fs.stat(file).catch(() => null)
        const cached = this.profileCache.get(file)
        let stats: WireFileProfileStats
        if (stat && cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          stats = cached.stats
        } else {
          const text = await fs.readFile(file, 'utf8').catch(() => '')
          stats = parseWireProfile(text)
          if (stat) this.profileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, stats })
        }
        for (const [key, value] of stats.daily) {
          const entry = daily.get(key) ?? { tokens: 0, tasks: 0 }
          entry.tokens += value.tokens
          entry.tasks += value.tasks
          daily.set(key, entry)
        }
        for (const [key, value] of stats.reasoning) reasoning.set(key, (reasoning.get(key) ?? 0) + value)
        for (const [key, value] of stats.skills) skills.set(key, (skills.get(key) ?? 0) + value)
        for (const [key, value] of stats.tools) tools.set(key, (tools.get(key) ?? 0) + value)
        totalTokens += stats.totalTokens
        peakTaskTokens = Math.max(peakTaskTokens, stats.peakTaskTokens)
        longestTaskDurationMs = Math.max(longestTaskDurationMs, stats.longestTaskDurationMs)
        taskCount += stats.taskCount
        requestCount += stats.requestCount
        fastRequestCount += stats.fastRequestCount
      }
      for (const file of this.profileCache.keys()) {
        if (!seenFiles.has(file)) this.profileCache.delete(file)
      }

      const activeDays = [...daily.entries()]
        .filter(([, value]) => value.tokens > 0 || value.tasks > 0)
        .map(([date]) => date)
        .sort()
      const activeSet = new Set(activeDays)
      let longestStreakDays = 0
      let runningStreak = 0
      let previousDay: number | null = null
      for (const day of activeDays) {
        // WHY: 用 UTC 日期序号比较，避免夏令时切换日并非恰好 24 小时而打断 streak。
        const timestamp = new Date(`${day}T00:00:00Z`).getTime()
        runningStreak = previousDay !== null && timestamp - previousDay === 86_400_000
          ? runningStreak + 1
          : 1
        longestStreakDays = Math.max(longestStreakDays, runningStreak)
        previousDay = timestamp
      }
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      let cursor = new Date(today)
      if (!activeSet.has(localDateKey(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1)
      let currentStreakDays = 0
      while (activeSet.has(localDateKey(cursor.getTime()))) {
        currentStreakDays += 1
        cursor.setDate(cursor.getDate() - 1)
      }

      const reasoningTop = [...reasoning.entries()].sort((a, b) => b[1] - a[1])[0]
      const reasoningTotal = [...reasoning.values()].reduce((sum, count) => sum + count, 0)
      const coreTools = new Set([
        'bash', 'edit', 'read', 'grep', 'todolist', 'readmediafile', 'write', 'fetchurl',
        'websearch', 'taskoutput', 'agent', 'glob', 'enterplanmode', 'exitplanmode',
        'skill', 'taskstop', 'tasklist'
      ])
      const topExtensions: AccountProfileStats['topExtensions'] = [
        ...[...skills.entries()].map(([name, count]) => ({ name, count, kind: 'skill' as const })),
        ...[...tools.entries()]
          .filter(([name]) => !coreTools.has(name.toLowerCase()))
          .map(([name, count]) => ({ name, count, kind: 'tool' as const }))
      ].sort((a, b) => b.count - a.count).slice(0, 5)

      let identity = this.managedIdentity
      try {
        const credential = JSON.parse(
          await fs.readFile(join(root, 'credentials', 'kimi-code.json'), 'utf8')
        ) as unknown
        if (isRecord(credential) && typeof credential.access_token === 'string') {
          const payload = credential.access_token.split('.')[1]
          if (payload) {
            const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown
            if (!identity && isRecord(claims) && typeof claims.user_id === 'string') {
              identity = { username: claims.user_id }
            }
          }
        }
      } catch {
        // API Key 和未登录用户没有 OAuth 身份；本机统计仍然可用。
      }

      const profile: AccountProfileStats = {
        ...(identity ? { identity } : {}),
        totalTokens,
        peakTaskTokens,
        longestTaskDurationMs,
        currentStreakDays,
        longestStreakDays,
        daily: [...daily.entries()]
          .map(([date, value]) => ({ date, ...value }))
          .sort((a, b) => a.date.localeCompare(b.date)),
        fastModePct: requestCount > 0 ? (fastRequestCount / requestCount) * 100 : 0,
        ...(reasoningTop && reasoningTotal > 0 ? {
          topReasoningEffort: {
            label: profileReasoningLabel(reasoningTop[0]),
            pct: (reasoningTop[1] / reasoningTotal) * 100
          }
        } : {}),
        exploredSkillCount: skills.size,
        skillUseCount: [...skills.values()].reduce((sum, count) => sum + count, 0),
        taskCount,
        topExtensions,
        updatedAt: Date.now()
      }
      return { ok: true, profile }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '个人资料统计读取失败'
      }
    }
  }
}
