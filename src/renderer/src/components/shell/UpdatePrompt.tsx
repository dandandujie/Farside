import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppUpdateInfo } from '@shared/ipc'
import { CrescentLogo } from '../../design-system/CrescentLogo'
import { PrismLine } from '../../design-system/PrismLine'
import { usePreferences } from '../../lib/preferences'

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
  const [update, setUpdate] = useState<AppUpdateInfo | null>(null)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const dismissedVersion = useRef<string | null>(null)
  const primaryButton = useRef<HTMLButtonElement | null>(null)
  const shot = new URLSearchParams(window.location.search).get('shot')

  const check = useCallback(async () => {
    if (shot === 'update') {
      setUpdate(MOCK_UPDATE)
      return
    }
    const result = await window.api?.update.check().catch(() => null)
    if (result?.updateAvailable && result.latestVersion !== dismissedVersion.current) {
      setUpdate(result)
    }
  }, [shot])

  useEffect(() => {
    if (!enabled) return
    const startup = window.setTimeout(() => void check(), shot === 'update' ? 0 : 1_500)
    const interval = window.setInterval(() => void check(), CHECK_INTERVAL_MS)
    return () => {
      window.clearTimeout(startup)
      window.clearInterval(interval)
    }
  }, [check, enabled, shot])

  useEffect(() => {
    if (!update) return
    primaryButton.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      dismissedVersion.current = update.latestVersion ?? null
      setUpdate(null)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [update])

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
    dismissedVersion.current = update.latestVersion ?? null
    setUpdate(null)
  }
  const openUpdate = async () => {
    if (shot === 'update') return
    setOpening(true)
    setOpenError(null)
    const result = await window.api?.update.open().catch(() => ({ ok: false, error: undefined }))
    if (result?.ok) setUpdate(null)
    else setOpenError(result?.error ?? (english ? 'Unable to open the update.' : '无法打开更新地址。'))
    setOpening(false)
  }

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

          {openError ? <p className="update-prompt__error mono">{openError}</p> : null}
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
              onClick={() => void openUpdate()}
              disabled={opening}
            >
              {opening ? (english ? 'Opening…' : '正在打开…') : (english ? 'Download update ↗' : '下载更新 ↗')}
            </button>
          </footer>
        </div>
      </section>
    </div>
  )
}
