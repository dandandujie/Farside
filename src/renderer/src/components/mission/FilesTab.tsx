import { useEffect, useState } from 'react'
import type { WorkspaceEntry } from '@shared/ipc'
import { SectionLabel } from '../../design-system/SectionLabel'
import { useActiveSession, useFarsideStore, type PreviewDocument } from '../../lib/store'
import { ResizeHandle, usePersistentWidth } from '../shell/ResizeHandle'
import { usePreferences } from '../../lib/preferences'

function previewKind(path: string, mime?: string): PreviewDocument['kind'] {
  const lower = path.toLowerCase()
  if (mime?.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(lower)) return 'image'
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || mime === 'text/markdown') return 'markdown'
  if (lower.endsWith('.html') || lower.endsWith('.htm') || lower.endsWith('.svg') || mime === 'text/html') {
    return 'html'
  }
  return 'text'
}

function FileIcon({ node }: { node: WorkspaceEntry }) {
  const common = {
    width: 12,
    height: 12,
    viewBox: '0 0 12 12',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1,
    style: { flexShrink: 0, color: 'var(--faint)' }
  } as const
  if (node.kind === 'directory') {
    return (
      <svg {...common}>
        <rect x="1.5" y="2.5" width="9" height="7" rx="1" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M4.5 3.5 2 6l2.5 2.5M7.5 3.5 10 6 7.5 8.5" />
    </svg>
  )
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg
      width="8"
      height="8"
      viewBox="0 0 8 8"
      fill="currentColor"
      style={{
        flexShrink: 0,
        color: 'var(--ghost)',
        transform: open ? 'rotate(90deg)' : 'none',
        transition: 'transform 120ms var(--ease-farside)'
      }}
    >
      <path d="M2 1l4 3-4 3z" />
    </svg>
  )
}

interface TreeNodeProps {
  node: WorkspaceEntry
  depth: number
  expanded: Set<string>
  onToggle(path: string): void
  selectedPath: string | null
  onSelect(path: string): void
}

function TreeNode({ node, depth, expanded, onToggle, selectedPath, onSelect }: TreeNodeProps) {
  const isDir = node.kind === 'directory'
  const open = expanded.has(node.path)
  const selected = node.path === selectedPath
  return (
    <div>
      <button
        className="mission-row"
        onClick={() => (isDir ? onToggle(node.path) : onSelect(node.path))}
        aria-expanded={isDir ? open : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          padding: '4px 6px',
          paddingLeft: 6 + depth * 12,
          borderRadius: 6,
          background: selected ? 'var(--crater)' : 'transparent',
          textAlign: 'left'
        }}
      >
        {isDir ? <Caret open={open} /> : <span style={{ width: 8, flexShrink: 0 }} />}
        <FileIcon node={node} />
        <span
          className="mono"
          style={{
            fontSize: 11.5,
            color: selected ? 'var(--moonlight)' : 'var(--dust)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {node.name}
        </span>
      </button>
      {isDir && open
        ? node.children?.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))
        : null}
    </div>
  )
}

/** 项目树与文件预览，数据直接来自 Kimi Server 的受限 fs API。 */
export function FilesTab() {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
  const active = useActiveSession()
  const openPreview = useFarsideStore((state) => state.openPreview)
  const [tree, setTree] = useState<WorkspaceEntry[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['src']))
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [content, setContent] = useState<string[]>([])
  const [rawContent, setRawContent] = useState('')
  const [mime, setMime] = useState<string | undefined>()
  const [encoding, setEncoding] = useState<'utf8' | 'base64'>('utf8')
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [treeWidth, setTreeWidth] = usePersistentWidth('file-tree', 180, 120, 420)

  useEffect(() => {
    if (!active || !window.api?.agent) return
    let alive = true
    setTree([])
    setSelectedPath(null)
    setContent([])
    setRawContent('')
    setMime(undefined)
    void window.api.agent
      .listWorkspace(active.id, '.', 6)
      .then((result) => {
        if (!alive) return
        if (result.ok) {
          setTree(result.items)
          setError(null)
        } else setError(result.error ?? (english ? 'Failed to read project tree' : '项目树读取失败'))
      })
      .catch((reason) => {
        if (alive) setError(reason instanceof Error ? reason.message : (english ? 'Failed to read project tree' : '项目树读取失败'))
      })
    return () => {
      alive = false
    }
  }, [active?.id, english])

  const toggle = (path: string): void =>
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const select = (path: string): void => {
    if (!active || !window.api?.agent) return
    setSelectedPath(path)
    setContent([])
    setRawContent('')
    void window.api.agent
      .readWorkspaceFile(active.id, path)
      .then((result) => {
        if (result.ok) {
          const nextContent = result.content ?? ''
          setContent(result.encoding === 'base64' ? [] : nextContent.split(/\r?\n/))
          setRawContent(nextContent)
          setMime(result.mime)
          setEncoding(result.encoding ?? 'utf8')
          setTruncated(result.truncated === true)
          setError(null)
        } else setError(result.error ?? (english ? 'Failed to read file' : '文件读取失败'))
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : (english ? 'Failed to read file' : '文件读取失败')))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 16px 10px', flexShrink: 0 }}>
        <SectionLabel>{english ? 'PROJECT TREE' : '项目树'} · {active?.project ?? '—'}</SectionLabel>
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div
          style={{
            flex: `0 0 ${treeWidth}px`,
            position: 'relative',
            minWidth: 0,
            overflowY: 'auto',
            padding: '0 8px 16px 16px'
          }}
        >
          <ResizeHandle edge="right" onDrag={(delta) => setTreeWidth(treeWidth + delta)} />
          {tree.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              expanded={expanded}
              onToggle={toggle}
              selectedPath={selectedPath}
              onSelect={select}
            />
          ))}
          {error ? <p style={{ fontSize: 11, color: 'var(--redshift)' }}>{error}</p> : null}
        </div>
        <div
          className="selectable"
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'auto',
            borderLeft: '1px solid var(--line)',
            paddingBottom: 16
          }}
        >
          {selectedPath ? (
            <div style={{ minWidth: 'max-content' }}>
              <div
                style={{
                  padding: '4px 10px 8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8
                }}
              >
                <span
                  className="mono"
                  style={{
                    minWidth: 0,
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 10.5,
                    color: 'var(--faint)',
                    letterSpacing: '0.04em'
                  }}
                  title={selectedPath}
                >
                  {selectedPath} · {content.length} {english ? 'lines' : '行'}
                </span>
                <button
                  onClick={() =>
                    openPreview({
                      title: selectedPath.split(/[\\/]/).pop() ?? selectedPath,
                      path: selectedPath,
                      content: rawContent,
                      kind: previewKind(selectedPath, mime),
                      mime,
                      encoding
                    })
                  }
                  disabled={!rawContent}
                  style={{
                    flexShrink: 0,
                    padding: '2px 6px',
                    border: '1px solid var(--line)',
                    borderRadius: 4,
                    fontSize: 10.5,
                    color: rawContent ? 'var(--dust)' : 'var(--ghost)'
                  }}
                >
                  {english ? 'Open preview' : '侧边预览'}
                </button>
              </div>
              {previewKind(selectedPath, mime) === 'image' && rawContent ? (
                <div style={{ padding: 10 }}>
                  <img
                    src={`data:${mime || 'image/png'};base64,${rawContent}`}
                    alt={selectedPath}
                    style={{ display: 'block', maxWidth: '100%', maxHeight: 260, objectFit: 'contain' }}
                  />
                </div>
              ) : content.map((text, index) => (
                <div
                  key={index}
                  className="mono"
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    fontSize: 11,
                    lineHeight: 1.7,
                    whiteSpace: 'pre',
                    color: 'var(--dust)'
                  }}
                >
                  <span
                    style={{
                      width: 30,
                      flexShrink: 0,
                      textAlign: 'right',
                      paddingRight: 8,
                      color: 'var(--ghost)',
                      fontSize: 10.5
                    }}
                  >
                    {index + 1}
                  </span>
                  <span style={{ paddingRight: 12 }}>{text}</span>
                </div>
              ))}
              {truncated ? (
                <div className="mono" style={{ padding: '6px 10px', fontSize: 10.5, color: 'var(--faint)' }}>
                  {english ? 'The file exceeds the 1 MB reading limit; content above is the available part.' : '文件超过 1 MB 读取上限，以上为当前可读取的全部内容。'}
                </div>
              ) : null}
            </div>
          ) : (
            <p style={{ margin: 0, padding: '4px 10px', fontSize: 11.5, color: 'var(--faint)' }}>
              {english ? 'Select a file to read its complete available content.' : '选择左侧文件，读取当前可用的完整内容。'}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
