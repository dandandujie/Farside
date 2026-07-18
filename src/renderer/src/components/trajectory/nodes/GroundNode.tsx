import { useEffect, useRef, useState } from 'react'
import type { Attachment, GroundEvent } from '@shared/types'
import { usePreferences } from '../../../lib/preferences'
import { useActiveSession, useFarsideStore } from '../../../lib/store'

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${bytes}B`
}

function AttachmentPill({ attachment }: { attachment: Attachment }) {
  return (
    <span className="mono" title={attachment.mimeType} style={{ fontSize: 11, color: 'var(--dust)', border: '1px solid var(--line)', borderRadius: 999, padding: '2px 10px', letterSpacing: '0.02em' }}>
      {attachment.name} · {formatSize(attachment.size)}
      {attachment.vision ? <span style={{ color: 'var(--faint)' }}> · vision</span> : null}
    </span>
  )
}

/** 用户请求固定靠右成块，和下方“已处理”分隔形成清晰的问答阅读顺序。 */
export function GroundNode({ event }: { event: GroundEvent }) {
  const { locale } = usePreferences()
  const active = useActiveSession()
  const undoLastTurn = useFarsideStore((state) => state.undoLastTurn)
  const editLastPrompt = useFarsideStore((state) => state.editLastPrompt)
  const textRef = useRef<HTMLParagraphElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const lastUser = [...(active?.events ?? [])].reverse().find((item) => item.kind === 'user')
  const canRevise = active?.phase === 'new' && lastUser?.id === event.id

  useEffect(() => {
    const element = textRef.current
    if (!element) return
    const measure = () => {
      if (expanded) return
      setOverflowing(element.scrollHeight > element.clientHeight + 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [event.text, expanded])

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', maxWidth: '78%' }}>
      <div
        data-user-request
        style={{
          width: 'fit-content',
          maxWidth: '100%',
          padding: '10px 13px',
          border: '1px solid var(--line-hi)',
          borderRadius: 12,
          background: 'var(--regolith)',
          boxShadow: '0 8px 22px color-mix(in srgb, var(--void) 34%, transparent)'
        }}
      >
        <p
          ref={textRef}
          className="selectable"
          style={{
            margin: 0,
            fontSize: 13.5,
            color: 'var(--moonlight)',
            lineHeight: 1.65,
            userSelect: 'text',
            whiteSpace: 'pre-wrap',
            ...(!expanded ? {
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: 6,
              overflow: 'hidden'
            } : {})
          }}
        >
          {event.text}
        </p>
        {overflowing || expanded ? (
          <button
            onClick={() => setExpanded((value) => !value)}
            style={{ display: 'block', marginTop: 5, fontSize: 11.5, color: 'var(--faint)' }}
          >
            {expanded
              ? (locale === 'en-US' ? 'Show less' : '收起')
              : (locale === 'en-US' ? 'Show more' : '显示更多')}
          </button>
        ) : null}
        {event.attachments?.length ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {event.attachments.map((attachment) => <AttachmentPill key={attachment.id} attachment={attachment} />)}
          </div>
        ) : null}
      </div>
      {canRevise ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 4, paddingRight: 3 }}>
          <button
            onClick={undoLastTurn}
            title={locale === 'en-US' ? 'Undo the last prompt' : '撤回上一轮请求'}
            style={{ fontSize: 10.5, color: 'var(--faint)', padding: '3px 5px' }}
          >
            {locale === 'en-US' ? 'Undo' : '撤回'}
          </button>
          <span aria-hidden style={{ width: 1, height: 10, background: 'var(--line)' }} />
          <button
            onClick={editLastPrompt}
            title={locale === 'en-US' ? 'Undo and edit the last prompt' : '撤回并重新编辑上一轮请求'}
            style={{ fontSize: 10.5, color: 'var(--faint)', padding: '3px 5px' }}
          >
            {locale === 'en-US' ? 'Edit & resend' : '重新编辑'}
          </button>
        </div>
      ) : null}
      </div>
    </div>
  )
}
