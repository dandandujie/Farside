import { useEffect, useMemo, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import { normalizePreviewUrl } from '@shared/security'
import { SectionLabel } from '../../design-system/SectionLabel'
import { useFarsideStore } from '../../lib/store'
import { Markdown } from '../trajectory/Markdown'
import { usePreferences } from '../../lib/preferences'

function HtmlPreview({ source, revision }: { source: string; revision: number }) {
  const srcDoc = useMemo(() => {
    if (/<!doctype|<html[\s>]/i.test(source)) return source
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style>body{font-family:system-ui,sans-serif;margin:24px;line-height:1.6}img,video,svg{max-width:100%}</style></head><body>${source}</body></html>`
  }, [source])
  return (
    <iframe
      key={revision}
      title="HTML 安全预览"
      sandbox=""
      srcDoc={srcDoc}
      style={{ width: '100%', height: '100%', border: 0, background: '#fff' }}
    />
  )
}

/** 预览页的开发浏览器：真实 Electron webview，支持导航历史和页面交互。 */
function MiniBrowser({ initialUrl, onClose, english }: { initialUrl: string; onClose(): void; english: boolean }) {
  const webviewRef = useRef<WebviewTag>(null)
  const partition = useMemo(() => `farside-preview-${crypto.randomUUID()}`, [])
  const [address, setAddress] = useState(initialUrl)
  const [currentUrl, setCurrentUrl] = useState(initialUrl)
  const [pageTitle, setPageTitle] = useState('')
  const [loading, setLoading] = useState(true)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [error, setError] = useState('')
  const electronWebview = Boolean(window.api)

  const syncNavigation = () => {
    const view = webviewRef.current
    if (!view) return
    setCanBack(view.canGoBack())
    setCanForward(view.canGoForward())
    const next = view.getURL()
    if (next) {
      setCurrentUrl(next)
      setAddress(next)
    }
  }

  useEffect(() => {
    const view = webviewRef.current
    if (!view) return
    const didNavigate = (event: Event) => {
      const next = (event as Event & { url?: string }).url
      if (next) {
        setCurrentUrl(next)
        setAddress(next)
      }
      setError('')
      syncNavigation()
    }
    const titleChanged = (event: Event) => setPageTitle((event as Event & { title?: string }).title ?? '')
    const start = () => setLoading(true)
    const stop = () => { setLoading(false); syncNavigation() }
    const failed = (event: Event) => {
      const detail = event as Event & { errorCode?: number; errorDescription?: string }
      if (detail.errorCode === -3) return
      setLoading(false)
      setError(detail.errorDescription || (english ? 'Page failed to load.' : '页面加载失败。'))
    }
    view.addEventListener('did-navigate', didNavigate)
    view.addEventListener('did-navigate-in-page', didNavigate)
    view.addEventListener('page-title-updated', titleChanged)
    view.addEventListener('did-start-loading', start)
    view.addEventListener('did-stop-loading', stop)
    view.addEventListener('did-fail-load', failed)
    return () => {
      view.removeEventListener('did-navigate', didNavigate)
      view.removeEventListener('did-navigate-in-page', didNavigate)
      view.removeEventListener('page-title-updated', titleChanged)
      view.removeEventListener('did-start-loading', start)
      view.removeEventListener('did-stop-loading', stop)
      view.removeEventListener('did-fail-load', failed)
    }
  }, [english])

  const navigate = () => {
    const next = normalizePreviewUrl(address)
    if (!next) {
      setError(english ? 'Enter a valid HTTP(S) address.' : '请输入有效的 HTTP(S) 地址。')
      return
    }
    setError('')
    setAddress(next)
    setCurrentUrl(next)
    if (electronWebview) void webviewRef.current?.loadURL(next)
  }

  const controlStyle = (enabled = true) => ({
    width: 26,
    height: 26,
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
    borderRadius: 5,
    color: enabled ? 'var(--dust)' : 'var(--ghost)',
    cursor: enabled ? 'pointer' : 'default'
  }) as const

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--mare)' }}>
      <div style={{ position: 'relative', flexShrink: 0, padding: '8px 9px', borderBottom: '1px solid var(--line)', background: 'var(--regolith)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <button disabled={!canBack} onClick={() => webviewRef.current?.goBack()} aria-label={english ? 'Back' : '后退'} style={controlStyle(canBack)}>←</button>
          <button disabled={!canForward} onClick={() => webviewRef.current?.goForward()} aria-label={english ? 'Forward' : '前进'} style={controlStyle(canForward)}>→</button>
          <button onClick={() => electronWebview ? webviewRef.current?.reload() : setCurrentUrl((value) => `${value.split('#')[0]}#reload-${Date.now()}`)} aria-label={english ? 'Reload' : '刷新'} style={controlStyle()}>↻</button>
          <div style={{ flex: 1, minWidth: 0, height: 28, display: 'flex', alignItems: 'center', border: '1px solid var(--line-hi)', borderRadius: 7, background: 'var(--void)' }}>
            <span aria-hidden style={{ width: 6, height: 6, marginLeft: 9, flexShrink: 0, borderRadius: 99, background: /^https:\/\//i.test(currentUrl) ? 'var(--signal)' : 'var(--faint)' }} />
            <input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') navigate() }}
              aria-label={english ? 'Address' : '地址'}
              className="mono"
              style={{ minWidth: 0, flex: 1, padding: '0 8px', border: 0, outline: 0, background: 'transparent', color: 'var(--dust)', fontSize: 10.5 }}
            />
            <button onClick={navigate} aria-label={english ? 'Go' : '转到'} style={{ ...controlStyle(), width: 24 }}>↵</button>
          </div>
          <a href={currentUrl} target="_blank" rel="noreferrer" aria-label={english ? 'Open in system browser' : '在系统浏览器打开'} title={english ? 'Open in system browser' : '在系统浏览器打开'} style={controlStyle()}>↗</a>
          <button onClick={onClose} aria-label={english ? 'Close browser' : '关闭浏览器'} style={controlStyle()}>×</button>
        </div>
        <div className="mono" style={{ height: 13, marginTop: 4, paddingLeft: 88, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 9.5, color: error ? 'var(--redshift)' : 'var(--ghost)' }}>
          {error || pageTitle || (english ? 'Development browser' : '开发浏览器')}
        </div>
        {loading ? <div style={{ position: 'absolute', left: 0, right: 0, bottom: -1, height: 1, background: 'linear-gradient(90deg, transparent, var(--moonlight), transparent)', animation: 'caret-breathe 1s linear infinite' }} /> : null}
      </div>
      <div style={{ flex: 1, minHeight: 0, background: '#fff' }}>
        {electronWebview ? (
          <webview
            ref={webviewRef}
            src={initialUrl}
            partition={partition}
            webpreferences="contextIsolation=yes, nodeIntegration=no, sandbox=yes"
            style={{ display: 'inline-flex', width: '100%', height: '100%' }}
          />
        ) : (
          <iframe title="开发浏览器" src={currentUrl} sandbox="allow-scripts allow-forms allow-modals allow-same-origin" style={{ width: '100%', height: '100%', border: 0 }} />
        )}
      </div>
    </div>
  )
}

/** Markdown / HTML / 文本安全预览。HTML 在唯一源 sandbox 中运行，脚本与表单能力均关闭。 */
export function PreviewTab() {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
  const preview = useFarsideStore((state) => state.preview)
  const closePreview = useFarsideStore((state) => state.closePreview)
  const [revision, setRevision] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [url, setUrl] = useState('http://localhost:5173')
  const [urlError, setUrlError] = useState('')
  const openDevelopmentPreview = () => {
    const next = normalizePreviewUrl(url)
    if (!next) {
      setUrlError(english ? 'Enter a valid HTTP(S) address.' : '请输入有效的 HTTP(S) 地址。')
      return
    }
    const parsed = new URL(next)
    setUrlError('')
    useFarsideStore.getState().openPreview({
      title: parsed.host || parsed.href,
      content: parsed.href,
      kind: 'url'
    })
  }

  if (!preview) {
    return (
      <div style={{ padding: 18 }}>
        <SectionLabel>{english ? 'BROWSER / PREVIEW' : '浏览器 / 预览'}</SectionLabel>
        <p style={{ margin: '14px 0 12px', fontSize: 12, lineHeight: 1.7, color: 'var(--faint)' }}>
          {english ? 'Open a loopback development server here to operate the frontend without leaving Farside, or preview a project file from Files.' : '把本机回环地址上的开发服务直接打开在这里，可在 Farside 内操作前端；也可从“文件”页预览项目文件。'}
        </p>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') openDevelopmentPreview() }}
            className="mono"
            aria-label={english ? 'Development server URL' : '开发服务地址'}
            style={{ minWidth: 0, flex: 1, padding: '7px 9px', border: '1px solid var(--line)', borderRadius: 6, background: 'var(--regolith)', color: 'var(--moonlight)', fontSize: 11.5 }}
          />
          <button onClick={openDevelopmentPreview} style={{ padding: '6px 10px', border: '1px solid var(--line-hi)', borderRadius: 6, color: 'var(--moonlight)', fontSize: 11.5 }}>
            {english ? 'Open' : '打开'}
          </button>
        </div>
        {urlError ? <p style={{ margin: '7px 0 0', fontSize: 11, color: 'var(--redshift)' }}>{urlError}</p> : null}
      </div>
    )
  }

  if (preview.kind === 'url') {
    return <MiniBrowser initialUrl={preview.content} onClose={closePreview} english={english} />
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <header
        style={{
          flexShrink: 0,
          padding: '12px 14px 10px',
          borderBottom: '1px solid var(--line)',
          background: 'var(--mare)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            className="mono"
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 11.5,
              color: 'var(--moonlight)'
            }}
            title={preview.path ?? preview.title}
          >
            {preview.path ?? preview.title}
          </span>
          <span className="mono" style={{ fontSize: 9.5, color: 'var(--faint)', letterSpacing: '0.08em' }}>
            {preview.kind.toUpperCase()}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 7 }}>
          {preview.kind === 'html' ? (
            <span style={{ flex: 1, fontSize: 10.5, color: 'var(--faint)' }}>
              {english ? 'Sandbox preview · scripts disabled' : '沙箱预览 · 脚本已禁用'}
            </span>
          ) : (
            <span style={{ flex: 1, fontSize: 10.5, color: 'var(--faint)' }}>{english ? 'Read-only preview' : '只读预览'}</span>
          )}
          {preview.kind !== 'image' ? <button
            onClick={() => void navigator.clipboard?.writeText(preview.content)}
            className="mono"
            style={{ fontSize: 10.5, color: 'var(--dust)' }}
          >
            {english ? 'Copy source' : '复制源码'}
          </button> : null}
          {preview.kind === 'image' ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <button onClick={() => setZoom((value) => Math.max(0.25, value - 0.25))} style={{ color: 'var(--dust)' }}>−</button>
              <span className="mono" style={{ minWidth: 36, textAlign: 'center', fontSize: 10.5, color: 'var(--faint)' }}>{Math.round(zoom * 100)}%</span>
              <button onClick={() => setZoom((value) => Math.min(4, value + 0.25))} style={{ color: 'var(--dust)' }}>＋</button>
            </span>
          ) : null}
          {preview.kind === 'html' ? (
            <button
              onClick={() => setRevision((value) => value + 1)}
              className="mono"
              style={{ fontSize: 10.5, color: 'var(--dust)' }}
            >
              {english ? 'Refresh' : '刷新'}
            </button>
          ) : null}
          <button onClick={closePreview} aria-label={english ? 'Close preview' : '关闭预览'} style={{ color: 'var(--faint)', fontSize: 14 }}>
            ×
          </button>
        </div>
      </header>
      <div className="selectable" style={{ flex: 1, minHeight: 0, overflow: 'auto', userSelect: 'text' }}>
        {preview.kind === 'markdown' ? (
          <article style={{ padding: '18px 16px 32px' }}>
            <Markdown text={preview.content} />
          </article>
        ) : null}
        {preview.kind === 'html' ? <HtmlPreview source={preview.content} revision={revision} /> : null}
        {preview.kind === 'image' ? (
          <div
            style={{ minWidth: '100%', minHeight: '100%', display: 'grid', placeItems: 'center', padding: 18, background: 'var(--void)' }}
          >
            <img
              src={preview.encoding === 'base64' ? `data:${preview.mime || 'image/png'};base64,${preview.content}` : preview.content}
              alt={preview.title}
              style={{ display: 'block', maxWidth: 'none', width: `${zoom * 100}%`, height: 'auto', objectFit: 'contain' }}
            />
          </div>
        ) : null}
        {preview.kind === 'text' ? (
          <pre
            className="mono"
            style={{ margin: 0, padding: 16, fontSize: 11.5, lineHeight: 1.7, color: 'var(--dust)', whiteSpace: 'pre-wrap' }}
          >
            {preview.content}
          </pre>
        ) : null}
      </div>
    </div>
  )
}
