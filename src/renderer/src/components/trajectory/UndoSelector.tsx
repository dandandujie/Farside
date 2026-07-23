import { useEffect, useMemo, useRef, useState } from 'react'
import { useFarsideStore } from '../../lib/store'
import { usePreferences } from '../../lib/preferences'

const promptLabel = (text: string, english: boolean): string => {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact || (english ? 'Image or attachment request' : '图片或附件请求')
}

/**
 * Kimi Code 双击 Esc 的多轮回退选择器。
 * 列表从最近请求向前排列；选择一项会撤销该请求及其之后的所有轮次。
 */
export function UndoSelector() {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
  const open = useFarsideStore((state) => state.undoSelectorOpen)
  const setOpen = useFarsideStore((state) => state.setUndoSelectorOpen)
  const undoTurns = useFarsideStore((state) => state.undoTurns)
  const sessionId = useFarsideStore((state) => state.activeSessionId)
  const session = useFarsideStore((state) =>
    state.sessions.find((item) => item.id === state.activeSessionId)
  )
  const [selected, setSelected] = useState(0)
  const dialogRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const prompts = useMemo(
    () =>
      [...(session?.events ?? [])]
        .filter((event) => event.kind === 'user')
        .reverse()
        .slice(0, 100),
    [session]
  )

  useEffect(() => {
    if (!open) return
    setSelected(0)
    requestAnimationFrame(() => dialogRef.current?.focus())
  }, [open, sessionId])

  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, selected])

  if (!open) return null

  const confirm = (index: number): void => {
    const count = index + 1
    if (count > prompts.length) return
    undoTurns(count)
  }

  return (
    <div
      className="undo-selector__backdrop"
      onMouseDown={() => setOpen(false)}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 86,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '13vh 18px 18px',
        background: 'color-mix(in srgb, var(--void) 76%, transparent)'
      }}
    >
      <div
        ref={dialogRef}
        className="undo-selector"
        role="dialog"
        aria-modal="true"
        aria-label={english ? 'Select request to undo' : '选择要回退到的请求'}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
          } else if (event.key === 'ArrowDown') {
            event.preventDefault()
            setSelected((current) => Math.min(prompts.length - 1, current + 1))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setSelected((current) => Math.max(0, current - 1))
          } else if (event.key === 'Enter') {
            event.preventDefault()
            confirm(selected)
          }
        }}
        style={{
          width: 'min(620px, 100%)',
          maxHeight: '64vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          border: '1px solid var(--line-hi)',
          borderRadius: 10,
          background: 'var(--mare)',
          boxShadow: '0 24px 72px rgba(0, 0, 0, .56)'
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            padding: '14px 16px 12px',
            borderBottom: '1px solid var(--line)'
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ color: 'var(--moonlight)', fontSize: 13.5, fontWeight: 500 }}>
              {english ? 'Select request to undo' : '选择要回退到的请求'}
            </div>
            <div style={{ marginTop: 4, color: 'var(--faint)', fontSize: 10.5 }}>
              {english
                ? 'The selected request and every request after it will be removed.'
                : '所选请求及其之后的请求与文件改动将一并回退。'}
            </div>
          </div>
          <kbd
            className="mono"
            style={{
              flexShrink: 0,
              padding: '3px 6px',
              border: '1px solid var(--line)',
              borderRadius: 4,
              color: 'var(--faint)',
              background: 'var(--regolith)',
              fontSize: 9
            }}
          >
            ESC
          </kbd>
        </div>

        <div ref={listRef} role="listbox" style={{ overflowY: 'auto', padding: 6 }}>
          {prompts.length ? (
            prompts.map((prompt, index) => {
              const active = index === selected
              const count = index + 1
              return (
                <button
                  key={prompt.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-active={active}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => confirm(index)}
                  style={{
                    width: '100%',
                    display: 'grid',
                    gridTemplateColumns: '22px minmax(0, 1fr) auto',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 10px',
                    border: active ? '1px solid var(--line-hi)' : '1px solid transparent',
                    borderRadius: 7,
                    color: active ? 'var(--moonlight)' : 'var(--dust)',
                    background: active ? 'var(--crater)' : 'transparent',
                    textAlign: 'left',
                    cursor: 'pointer'
                  }}
                >
                  <span
                    className="mono"
                    aria-hidden
                    style={{ color: active ? 'var(--signal)' : 'var(--faint)', fontSize: 11 }}
                  >
                    {active ? '←' : '·'}
                  </span>
                  <span
                    style={{
                      overflow: 'hidden',
                      fontSize: 12.5,
                      lineHeight: 1.4,
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {prompt.kind === 'user' ? promptLabel(prompt.text, english) : ''}
                  </span>
                  <span
                    className="mono"
                    style={{
                      padding: '2px 6px',
                      border: '1px solid var(--line)',
                      borderRadius: 999,
                      color: count === 1 ? 'var(--faint)' : 'var(--redshift)',
                      fontSize: 9,
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {english ? `undo ${count}` : `撤销 ${count} 轮`}
                  </span>
                </button>
              )
            })
          ) : (
            <div style={{ padding: '28px 16px', color: 'var(--faint)', fontSize: 12, textAlign: 'center' }}>
              {english ? 'No request can be undone.' : '当前没有可回退的请求'}
            </div>
          )}
        </div>

        <div
          className="mono"
          style={{
            padding: '8px 16px',
            borderTop: '1px solid var(--line)',
            color: 'var(--faint)',
            fontSize: 9
          }}
        >
          ↑↓ {english ? 'select' : '选择'} · ENTER {english ? 'undo' : '回退'} · ESC {english ? 'close' : '关闭'}
        </div>
      </div>
    </div>
  )
}
