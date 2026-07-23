import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppUpdateInfo } from '@shared/ipc'
import { CrescentLogo } from '../../design-system/CrescentLogo'
import { PrismLine } from '../../design-system/PrismLine'
import { usePreferences } from '../../lib/preferences'
import { useFarsideStore } from '../../lib/store'

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000

const MOCK_UPDATE: AppUpdateInfo = {
  updateAvailable: true,
  currentVersion: '0.1.0',
  latestVersion: '0.2.0',
  releaseName: 'Farside v0.2.0 · 近月更新',
  releaseNotes: [
    '## 更新内容',
    '- 新增 Release 更新提醒与版本说明',
    '- 改进会话轨迹的实时状态反馈',
    '- 修复配置文件热同步与预览刷新问题'
  ].join('\n'),
  publishedAt: '2026-07-19T08:00:00Z',
  assetName: 'Farside.Setup.0.2.0.exe'
}

function releaseHighlights(notes: string | undefined, english: boolean): string[] {
  const fallback = english
    ? 'Open the GitHub Release page for the full notes.'
    : '完整更新说明可在 GitHub Release 页面查看。'
  if (!notes) return [fallback]
  const lines = notes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^```/.test(line) && !/^<\/?(?:details|summary)/i.test(line))
    .map((line) => line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/^#{1,6}\s*/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/^(?:feat|fix|perf|refactor|docs|chore|test|build|ci|style)(?:\([^)]*\))?!?:\s*/i, '')
      .trim())
    .filter(Boolean)
    .filter((line) => !/^(what'?s changed|更新内容|full changelog|new contributors)$/i.test(line))
    .map((line) => line.length > 180 ? `${line.slice(0, 177)}…` : line)
    .filter((line, index, lines) => lines.indexOf(line) === index)
    .slice(0, 6)
  return lines.length > 0
    ? lines
    : [fallback]
}

interface UpdatePromptProps {
  enabled: boolean
}

export function UpdatePrompt({ enabled }: UpdatePromptProps) {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
  const updateInfo = useFarsideStore((s) => s.updateInfo)
  const checkUpdates = useFarsideStore((s) => s.checkUpdates)
  const dismissUpdate = useFarsideStore((s) => s.dismissUpdate)
  const [opening, setOpening] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const primaryButton = useRef<HTMLButtonElement | null>(null)
  const shot = new URLSearchParams(window.location.search).get('shot')
  const update = shot === 'update' ? MOCK_UPDATE : updateInfo

  useEffect(() => {
    if (!enabled || shot === 'update') return
    const startup = window.setTimeout(() => void checkUpdates(), 1_500)
    const interval = window.setInterval(() => void checkUpdates(), CHECK_INTERVAL_MS)
    return () => {
      window.clearTimeout(startup)
      window.clearInterval(interval)
    }
  }, [checkUpdates, enabled, shot])

  useEffect(() => {
    if (shot === 'update') return
    return window.api?.update.onProgress((received, total) => setProgress({ received, total }))
  }, [shot])

  useEffect(() => {
    if (!update) return
    primaryButton.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      dismissUpdate()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [update, dismissUpdate])

  const highlights = useMemo(
    () => releaseHighlights(update?.releaseNotes, english),
    [english, update?.releaseNotes]
  )
  const publishedAt = useMemo(() => {
    if (!update?.publishedAt) return null
    const date = new Date(update.publishedAt)
    if (Number.isNaN(date.getTime())) return null
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(date)
  }, [locale, update?.publishedAt])

  if (!enabled || !update) return null

  const dismiss = () => {
    dismissUpdate()
  }
  const openUpdate = async () => {
    if (shot === 'update') return
    setOpening(true)
    setOpenError(null)
    const result = await window.api?.update.open().catch(() => ({ ok: false, error: undefined }))
    if (result?.ok) dismissUpdate()
    else setOpenError(result?.error ?? (english ? 'Unable to open the update.' : '无法打开更新地址。'))
    setOpening(false)
  }
  // 一键更新：有匹配安装包时应用内直接下载并自动打开；没有则退回浏览器。
  const runUpdate = async () => {
    if (shot === 'update') return
    if (!update?.assetName) {
      await openUpdate()
      return
    }
    setDownloading(true)
    setProgress(null)
    setOpenError(null)
    const result = await window.api?.update.download().catch(() => ({ ok: false, error: undefined }))
    setDownloading(false)
    if (result?.ok) setDownloaded(true)
    else setOpenError(result?.error ?? (english ? 'Download failed. Try the browser instead.' : '下载失败，可改用浏览器下载。'))
  }
  const progressPct = downloading && progress && progress.total > 0
    ? Math.min(100, Math.round((progress.received / progress.total) * 100))
    : null
  const primaryLabel = downloading
    ? progressPct !== null
      ? (english ? `Downloading… ${progressPct}%` : `正在下载… ${progressPct}%`)
      : (english ? 'Downloading…' : '正在下载…')
    : downloaded
      ? (english ? 'Installer opened ✓' : '安装包已打开 ✓')
      : update?.assetName
        ? (english ? 'Update now' : '一键更新')
        : opening
          ? (english ? 'Opening…' : '正在打开…')
          : (english ? 'Download update ↗' : '下载更新 ↗')

  return (
    <div className="update-prompt__backdrop fade-in">
      <section
        className="update-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-prompt-title"
        aria-describedby="update-prompt-description"
      >
        <PrismLine />
        <div className="update-prompt__body">
          <header className="update-prompt__header">
            <div className="update-prompt__moon" aria-hidden>
              <span className="update-prompt__orbit" />
              <CrescentLogo size={28} />
            </div>
            <div className="update-prompt__heading">
              <span className="update-prompt__eyebrow mono">
                {english ? 'NEW RELEASE · SIGNAL ACQUIRED' : 'NEW RELEASE · 已捕获更新信号'}
              </span>
              <h2 id="update-prompt-title">{english ? 'A new Farside is in orbit' : '发现新版本 Farside'}</h2>
              <p id="update-prompt-description">
                {english ? 'Update when convenient. Your local projects and settings stay where they are.' : '可在方便时完成更新，本地项目与设置不会被移动。'}
              </p>
            </div>
          </header>

          <div className="update-prompt__version" aria-label={english ? 'Version upgrade' : '版本升级'}>
            <span className="mono">v{update.currentVersion}</span>
            <span className="update-prompt__route" aria-hidden><i /><b>›</b></span>
            <strong className="mono">v{update.latestVersion}</strong>
            {publishedAt ? <time dateTime={update.publishedAt}>{publishedAt}</time> : null}
          </div>

          <div className="update-prompt__notes">
            <div className="update-prompt__notes-title">
              <span>{english ? 'Release highlights' : '本次更新'}</span>
              {update.releaseName && update.releaseName !== update.latestVersion
                ? <span className="mono">{update.releaseName}</span>
                : null}
            </div>
            <ul>
              {highlights.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </div>

          {openError ? (
            <p className="update-prompt__error mono">
              {openError}{' '}
              {update.assetName ? (
                <button type="button" className="update-prompt__fallback" onClick={() => void openUpdate()}>
                  {english ? 'Try the browser ↗' : '改用浏览器下载 ↗'}
                </button>
              ) : null}
            </p>
          ) : null}
          {downloaded ? (
            <p className="update-prompt__done">
              {english
                ? 'The installer has been opened — follow its steps to finish the update.'
                : '安装包已自动打开，按提示完成安装即可。'}
            </p>
          ) : null}
          {downloading ? (
            <div
              className="update-prompt__progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPct ?? undefined}
            >
              <span style={progressPct !== null ? { width: `${progressPct}%` } : undefined} />
            </div>
          ) : null}
          <footer className="update-prompt__footer">
            <span className="mono update-prompt__asset">
              {update.assetName
                ? `${english ? 'Ready' : '对应安装包'} · ${update.assetName}`
                : (english ? 'Opens the GitHub Release page' : '将在 GitHub Release 页面选择安装包')}
            </span>
            <button type="button" className="update-prompt__later" onClick={dismiss}>
              {english ? 'Later' : '稍后提醒'}
            </button>
            <button
              ref={primaryButton}
              type="button"
              className="update-prompt__download"
              onClick={() => void runUpdate()}
              disabled={downloading || opening || downloaded}
            >
              {primaryLabel}
            </button>
          </footer>
        </div>
      </section>
    </div>
  )
}
