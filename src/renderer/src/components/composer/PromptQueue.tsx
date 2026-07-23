import { useEffect, useRef, useState } from 'react'
import { useFarsideStore, type QueuedPrompt } from '../../lib/store'
import { usePreferences } from '../../lib/preferences'

const EMPTY_QUEUE: QueuedPrompt[] = []

export function PromptQueue({ sessionId }: { sessionId: string }) {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
  const items = useFarsideStore((state) => state.promptQueues[sessionId] ?? EMPTY_QUEUE)
  const update = useFarsideStore((state) => state.updateQueuedPrompt)
  const remove = useFarsideStore((state) => state.removeQueuedPrompt)
  const clear = useFarsideStore((state) => state.clearPromptQueue)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')
  const cancelSaveRef = useRef(false)

  useEffect(() => {
    if (editingId && !items.some((item) => item.id === editingId)) setEditingId(null)
  }, [editingId, items])

  if (!items.length) return null

  const save = (): void => {
    if (cancelSaveRef.current) {
      cancelSaveRef.current = false
      setEditingId(null)
      return
    }
    if (!editingId) return
    const text = editingText.trim()
    if (text) update(sessionId, editingId, text)
    setEditingId(null)
  }

  return (
    <section
      className="prompt-queue"
      aria-label={english ? 'Request queue' : '请求队列'}
      style={{
        maxWidth: 760,
        margin: '0 auto 8px',
        overflow: 'hidden',
        border: '1px solid var(--line)',
        borderRadius: 9,
        background: 'color-mix(in srgb, var(--regolith) 94%, transparent)',
        boxShadow: '0 5px 18px rgba(0, 0, 0, .2)'
      }}
    >
      <header
        style={{
          height: 32,
          display: 'flex',
          alignItems: 'center',
          padding: '0 11px 0 13px',
          borderBottom: '1px solid var(--line)',
          color: 'var(--dust)',
          fontSize: 11.5
        }}
      >
        <span style={{ fontWeight: 500 }}>{english ? 'QUEUE' : '队列'}</span>
        <span className="mono" style={{ marginLeft: 7, color: 'var(--faint)', fontSize: 9.5 }}>
          {items.length}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => clear(sessionId)}
          style={{ padding: '3px 4px', color: 'var(--faint)', fontSize: 10.5 }}
        >
          {english ? 'Clear' : '清空'}
        </button>
      </header>
      <div style={{ maxHeight: 150, overflowY: 'auto' }}>
        {items.map((item, index) => {
          const editing = item.id === editingId
          return (
            <div
              key={item.id}
              style={{
                minHeight: 42,
                display: 'grid',
                gridTemplateColumns: '22px minmax(0, 1fr) auto',
                alignItems: 'center',
                gap: 8,
                padding: '6px 9px 6px 11px',
                borderTop: index ? '1px solid var(--line)' : 0
              }}
            >
              <span className="mono" style={{ color: index === 0 ? 'var(--moonlight)' : 'var(--faint)', fontSize: 10 }}>
                {index + 1}
              </span>
              {editing ? (
                <input
                  autoFocus
                  value={editingText}
                  onChange={(event) => setEditingText(event.target.value)}
                  onBlur={save}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') save()
                    if (event.key === 'Escape') {
                      cancelSaveRef.current = true
                      setEditingId(null)
                    }
                  }}
                  style={{
                    minWidth: 0,
                    width: '100%',
                    padding: '4px 7px',
                    border: '1px solid var(--line-hi)',
                    borderRadius: 5,
                    background: 'var(--crater)',
                    color: 'var(--moonlight)',
                    fontSize: 12
                  }}
                />
              ) : (
                <span
                  title={item.text}
                  style={{
                    minWidth: 0,
                    overflow: 'hidden',
                    color: 'var(--dust)',
                    fontSize: 12.5,
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {item.text}
                  {item.fileRefs.length ? (
                    <span className="mono" style={{ marginLeft: 8, color: 'var(--faint)', fontSize: 9 }}>
                      @{item.fileRefs.length}
                    </span>
                  ) : null}
                  {item.attachments.length ? (
                    <span className="mono" style={{ marginLeft: 6, color: 'var(--faint)', fontSize: 9 }}>
                      ◇{item.attachments.length}
                    </span>
                  ) : null}
                </span>
              )}
              <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <button
                  type="button"
                  aria-label={english ? 'Edit queued request' : '修改排队请求'}
                  title={english ? 'Edit' : '修改'}
                  onClick={() => {
                    cancelSaveRef.current = false
                    setEditingText(item.text)
                    setEditingId(item.id)
                  }}
                  style={{ width: 25, height: 25, display: 'grid', placeItems: 'center', color: 'var(--faint)', fontSize: 11 }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  aria-label={english ? 'Remove queued request' : '取消排队请求'}
                  title={english ? 'Remove' : '取消'}
                  onClick={() => remove(sessionId, item.id)}
                  style={{ width: 25, height: 25, display: 'grid', placeItems: 'center', color: 'var(--faint)', fontSize: 14 }}
                >
                  ×
                </button>
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
