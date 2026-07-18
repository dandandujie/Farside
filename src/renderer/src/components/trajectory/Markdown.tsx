import { useState, type ReactNode } from 'react'
import { useActiveSession, useFarsideStore } from '../../lib/store'
import { usePreferences } from '../../lib/preferences'

/**
 * 极简 markdown 渲染器（零依赖，自研）。
 * 块级：``` 代码块（语言标签 + 复制按钮）、#/## 标题、- / 1. 列表、段落；
 * 行内：`code`、**粗体**、[链接](https://…)。其余语法按纯文本呈现。
 * 中文排版行高 1.75。
 */

type Block =
  | { type: 'code'; lang: string; code: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'para'; text: string }

function parseBlocks(md: string): Block[] {
  const lines = md.split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null

  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: 'para', text: para.join('\n') })
      para = []
    }
  }
  const flushList = () => {
    if (list) {
      blocks.push({ type: 'list', ordered: list.ordered, items: list.items })
      list = null
    }
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // ``` 代码块（围栏内一切原样保留）
    const fence = /^```([^\s]*)\s*$/.exec(line.trim())
    if (fence) {
      flushPara()
      flushList()
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        buf.push(lines[i])
        i++
      }
      i++ // 跳过收尾 ```
      blocks.push({ type: 'code', lang: fence[1], code: buf.join('\n') })
      continue
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      flushPara()
      flushList()
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] })
      i++
      continue
    }

    const ul = /^\s*[-*]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ul || ol) {
      flushPara()
      const ordered = !ul
      const item = (ul ?? ol)![1]
      if (list && list.ordered === ordered) {
        list.items.push(item)
      } else {
        flushList()
        list = { ordered, items: [item] }
      }
      i++
      continue
    }

    if (line.trim() === '') {
      flushPara()
      flushList()
      i++
      continue
    }

    flushList()
    para.push(line)
    i++
  }
  flushPara()
  flushList()
  return blocks
}

/* ── 行内：`code`、**粗体**、[链接](url) ── */

const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((?:<[^>]+>|[^)]*)\)|https?:\/\/[^\s<]+|(?:[A-Za-z]:[\\/]|\/[A-Za-z]:\/)[^\s<>"|?*,，。；;）)\]]+)/g

function cleanLocalTarget(raw: string, cwd: string): string {
  let target = raw.trim().replace(/^<|>$/g, '')
  try { target = decodeURIComponent(target) } catch { /* 保留原始路径 */ }
  target = target.replace(/^\/([A-Za-z]:[\\/])/, '$1')
  const lineSuffix = /^(.*[\\/].*):\d+(?::\d+)?$/.exec(target)
  if (lineSuffix) target = lineSuffix[1]
  const absolute = /^[A-Za-z]:[\\/]/.test(target) || /^\\\\/.test(target) || /^\//.test(target)
  if (!absolute && cwd) {
    const separator = cwd.includes('\\') ? '\\' : '/'
    target = `${cwd.replace(/[\\/]$/, '')}${separator}${target.replace(/^[\\/]/, '')}`
  }
  return target
}

function looksLikeLocalPath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\/[A-Za-z]:\/|\\\\|\.\.?(?:[\\/])|[\w.-]+[\\/])/.test(value) ||
    /^[\w.-]+\.(?:md|html?|tsx?|jsx?|json|toml|ya?ml|py|rs|go|java|kt|css|scss|svg|png|jpe?g|gif|webp|pdf|docx?|xlsx?)$/i.test(value)
}

function looksLikeCommand(value: string): boolean {
  const trimmed = value.trim()
  if (!/\s/.test(trimmed)) return false
  return /^(?:npm|pnpm|yarn|bun|npx|git|node|python\d*|pip\d*|cargo|go|dotnet|java|gradle|mvn|kimi|rg|grep|curl|wget|cd|ls|dir|mkdir|cp|copy|mv|move|del|rm|pwsh|powershell|cmd|bash|sh|Get-|Set-|Invoke-|Start-Process)\b/i.test(trimmed)
}

interface InlineActions {
  cwd: string
  openLocal(target: string): void
  run(command: string): void
  english: boolean
}

function renderInline(text: string, keyBase: string, actions: InlineActions): ReactNode[] {
  return text.split(INLINE_RE).map((part, i) => {
    if (!part) return null
    const key = `${keyBase}-${i}`
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={key} style={{ fontWeight: 600, color: 'var(--moonlight)' }}>
          {part.slice(2, -2)}
        </strong>
      )
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const value = part.slice(1, -1)
      const localPath = looksLikeLocalPath(value)
      const command = !localPath && looksLikeCommand(value)
      return (
        <button
          key={key}
          className="mono"
          onClick={localPath ? () => actions.openLocal(value) : command ? () => actions.run(value) : undefined}
          title={localPath
            ? (actions.english ? 'Open path' : '打开路径')
            : command
              ? (actions.english ? 'Run in terminal' : '在当前目录的终端运行')
              : undefined}
          style={{
            fontSize: '0.86em',
            color: 'var(--dust)',
            background: 'var(--regolith)',
            border: '1px solid var(--line)',
            borderRadius: 4,
            padding: '1px 5px',
            cursor: localPath || command ? 'pointer' : 'text'
          }}
        >
          {value}
        </button>
      )
    }
    const link = /^\[([^\]]+)\]\((?:<([^>]+)>|([^)]*))\)$/.exec(part)
    if (link) {
      const target = link[2] ?? link[3] ?? ''
      if (!/^https?:\/\//i.test(target)) {
        return (
          <button
            key={key}
            onClick={() => actions.openLocal(target)}
            title={cleanLocalTarget(target, actions.cwd)}
            style={{ color: 'var(--moonlight)', textDecoration: 'underline', textDecorationColor: 'var(--faint)', textUnderlineOffset: 3 }}
          >
            {link[1]}
          </button>
        )
      }
      return (
        <a
          key={key}
          href={target}
          target="_blank"
          rel="noreferrer"
          style={{
            color: 'var(--moonlight)',
            textDecoration: 'underline',
            textDecorationColor: 'var(--faint)',
            textUnderlineOffset: 3
          }}
        >
          {link[1]}
        </a>
      )
    }
    if (/^https?:\/\//i.test(part)) {
      return <a key={key} href={part} target="_blank" rel="noreferrer" style={{ color: 'var(--moonlight)', textDecoration: 'underline', textDecorationColor: 'var(--faint)', textUnderlineOffset: 3 }}>{part}</a>
    }
    if (looksLikeLocalPath(part)) {
      return <button key={key} onClick={() => actions.openLocal(part)} title={cleanLocalTarget(part, actions.cwd)} style={{ color: 'var(--moonlight)', textDecoration: 'underline', textDecorationColor: 'var(--faint)', textUnderlineOffset: 3 }}>{part}</button>
    }
    return <span key={key}>{part}</span>
  })
}

/** 段落正文：源内单换行保留为 <br/>（中文语境下比合并成空格更忠实）。 */
function InlineLines({ text, keyBase, actions }: { text: string; keyBase: string; actions: InlineActions }) {
  return (
    <>
      {text.split('\n').map((line, i) => (
        <span key={`${keyBase}-${i}`}>
          {i > 0 ? <br /> : null}
          {renderInline(line, `${keyBase}-${i}`, actions)}
        </span>
      ))}
    </>
  )
}

function CodeBlockView({ lang, code }: { lang: string; code: string }) {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
  const [copied, setCopied] = useState(false)
  const openPreview = useFarsideStore((state) => state.openPreview)
  const runInTerminal = useFarsideStore((state) => state.runInTerminal)
  const normalizedLang = lang.toLowerCase()
  const previewKind = ['html', 'htm', 'svg'].includes(normalizedLang)
    ? 'html'
    : ['md', 'markdown'].includes(normalizedLang)
      ? 'markdown'
      : null
  const runnable = ['shell', 'bash', 'sh', 'zsh', 'powershell', 'pwsh', 'ps1', 'cmd', 'bat', 'console'].includes(normalizedLang)
  const copy = () => {
    if (!navigator.clipboard) return
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => undefined)
  }
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 6, background: 'var(--mare)', overflow: 'hidden' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '5px 12px',
          borderBottom: '1px solid var(--line)'
        }}
      >
        <span className="mono" style={{ fontSize: 11, color: 'var(--faint)', letterSpacing: '0.08em' }}>
          {lang || 'text'}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {runnable ? (
            <button onClick={() => runInTerminal(code)} className="mono" title={english ? 'Run in the current project directory' : '在当前项目目录的终端运行'} style={{ fontSize: 11, letterSpacing: '0.04em', color: 'var(--signal)' }}>
              {english ? 'Run' : '运行'}
            </button>
          ) : null}
          {previewKind ? (
            <button
              onClick={() => openPreview({ title: `${normalizedLang || 'text'} ${english ? 'code block' : '代码块'}`, content: code, kind: previewKind })}
              className="mono"
              style={{ fontSize: 11, letterSpacing: '0.04em', color: 'var(--dust)' }}
            >
              {english ? 'Preview' : '预览'}
            </button>
          ) : null}
          <button
            onClick={copy}
            className="mono"
            style={{
              fontSize: 11,
              letterSpacing: '0.04em',
              color: copied ? 'var(--signal)' : 'var(--faint)',
              transition: 'color 150ms var(--ease-farside)'
            }}
            onMouseEnter={(e) => {
              if (!copied) e.currentTarget.style.color = 'var(--dust)'
            }}
            onMouseLeave={(e) => {
              if (!copied) e.currentTarget.style.color = 'var(--faint)'
            }}
          >
            {copied ? (english ? 'Copied' : '已复制') : (english ? 'Copy' : '复制')}
          </button>
        </span>
      </div>
      <pre
        className="mono selectable"
        style={{
          margin: 0,
          padding: '10px 12px',
          fontSize: 12,
          lineHeight: 1.65,
          color: 'var(--dust)',
          overflowX: 'auto',
          userSelect: 'text'
        }}
      >
        {code}
      </pre>
    </div>
  )
}

const HEADING_SIZE = [16, 16, 14, 12.5] // # / ## / ### / ####

export function Markdown({ text }: { text: string }) {
  const { locale } = usePreferences()
  const session = useActiveSession()
  const runInTerminal = useFarsideStore((state) => state.runInTerminal)
  const actions: InlineActions = {
    cwd: session?.cwd ?? '',
    english: locale === 'en-US',
    openLocal: (target) => { void window.api?.workspace.open(cleanLocalTarget(target, session?.cwd ?? '')) },
    run: runInTerminal
  }
  const blocks = parseBlocks(text)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'code':
            return <CodeBlockView key={i} lang={b.lang} code={b.code} />
          case 'heading':
            return (
              <div
                key={i}
                role="heading"
                aria-level={b.level}
                style={{
                  fontSize: HEADING_SIZE[b.level - 1] ?? 12.5,
                  fontWeight: 500,
                  color: 'var(--moonlight)',
                  letterSpacing: '0.01em',
                  lineHeight: 1.5,
                  marginTop: b.level <= 2 ? 4 : 0
                }}
              >
                {renderInline(b.text, `h${i}`, actions)}
              </div>
            )
          case 'list':
            return (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {b.items.map((item, j) => (
                  <div
                    key={j}
                    className="selectable"
                    style={{ display: 'flex', gap: 8, fontSize: 14, lineHeight: 1.75, color: 'var(--moonlight)', userSelect: 'text' }}
                  >
                    {b.ordered ? (
                      <span className="mono" style={{ flexShrink: 0, fontSize: 12, color: 'var(--faint)' }}>
                        {j + 1}.
                      </span>
                    ) : (
                      <span aria-hidden style={{ flexShrink: 0, color: 'var(--faint)' }}>
                        —
                      </span>
                    )}
                    <span>{renderInline(item, `li${i}-${j}`, actions)}</span>
                  </div>
                ))}
              </div>
            )
          case 'para':
            return (
              <p
                key={i}
                className="selectable"
                style={{ margin: 0, fontSize: 14, lineHeight: 1.75, color: 'var(--moonlight)', userSelect: 'text' }}
              >
                <InlineLines text={b.text} keyBase={`p${i}`} actions={actions} />
              </p>
            )
        }
      })}
    </div>
  )
}
