import { useEffect, useMemo, useRef, useState } from 'react'
import type { ApprovalDecision, ApprovalRequest } from '@shared/types'
import { useFarsideStore } from '../../lib/store'
import { PrismLine } from '../../design-system/PrismLine'
import { Kbd } from '../../design-system/Kbd'
import { usePreferences } from '../../lib/preferences'

/** unified diff 渲染：行号 + 克制的着色（+ signal / − redshift / 上下文 dust）。 */
function DiffBlock({ diff }: { diff: string }) {
  const lines = diff.split('\n')
  let oldLine = 0
  let newLine = 0
  return (
    <pre
      className="mono selectable"
      style={{
        margin: 0,
        fontSize: 12,
        lineHeight: 1.65,
        overflowX: 'auto',
        userSelect: 'text'
      }}
    >
      {lines.map((line, i) => {
        let color = 'var(--dust)'
        let gutter = ''
        if (line.startsWith('@@')) {
          color = 'var(--faint)'
          const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
          if (m) {
            oldLine = parseInt(m[1], 10)
            newLine = parseInt(m[2], 10)
          }
          gutter = '·'
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
          color = 'var(--signal)'
          gutter = String(newLine++)
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          color = 'var(--redshift)'
          gutter = String(oldLine++)
        } else if (!line.startsWith('+++') && !line.startsWith('---')) {
          gutter = String(newLine)
          oldLine++
          newLine++
        }
        if (line.startsWith('+++') || line.startsWith('---')) color = 'var(--faint)'
        return (
          <div key={i} style={{ display: 'flex' }}>
            <span
              style={{
                width: 36,
                flexShrink: 0,
                textAlign: 'right',
                paddingRight: 10,
                color: 'var(--ghost)',
                userSelect: 'none'
              }}
            >
              {gutter}
            </span>
            <span style={{ color, whiteSpace: 'pre' }}>{line || ' '}</span>
          </div>
        )
      })}
    </pre>
  )
}

/** 从 unified diff 提取文件路径与增删行数，供折叠态摘要使用。 */
function parseDiffMeta(diff: string) {
  const lines = diff.split('\n')
  let add = 0
  let del = 0
  for (const l of lines) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++
    else if (l.startsWith('-') && !l.startsWith('---')) del++
  }
  return { file: /^\+\+\+ b\/(.+)$/m.exec(diff)?.[1], add, del, total: lines.length }
}

/**
 * 审批卡：从 Composer 上方升起的全宽卡片，顶部 1px prism 线。
 * 完整工具参数 + 完整 diff（内部滚动，不做小窗）。
 * 操作：允许一次(1) / 本会话放行(2) / 拒绝(3，进入反馈输入态)；
 * Ctrl+E 折叠/展开 diff；Esc 等价拒绝。键盘只在此卡聚焦时生效。
 */
export function ApprovalCard({ request }: { request: ApprovalRequest }) {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
  const resolve = useFarsideStore((s) => s.resolveApproval)
  const queueLen = useFarsideStore((s) => s.approvalQueue.length)

  const [feedbackMode, setFeedbackMode] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [diffOpen, setDiffOpen] = useState(true)
  const [focused, setFocused] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 队首换请求时复位状态并接管焦点
  useEffect(() => {
    setFeedbackMode(false)
    setFeedback('')
    setDiffOpen(true)
    requestAnimationFrame(() => cardRef.current?.focus())
  }, [request.id])

  useEffect(() => {
    if (feedbackMode) requestAnimationFrame(() => inputRef.current?.focus())
  }, [feedbackMode])

  const diffMeta = useMemo(
    () => (request.diff ? parseDiffMeta(request.diff) : null),
    [request.diff]
  )

  const decide = (decision: ApprovalDecision, note?: string) =>
    resolve(request.id, decision, note)

  const onCardKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (feedbackMode) return // 反馈输入态的按键由输入框自理
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
      if (!request.diff) return
      e.preventDefault()
      setDiffOpen((v) => !v)
      return
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === '1') decide('allow-once')
    else if (e.key === '2') decide('allow-always')
    else if (e.key === '3' || e.key === 'Escape') {
      e.preventDefault()
      setFeedbackMode(true)
    }
  }

  const actions: {
    decision: ApprovalDecision
    label: string
    keyHint: string
    primary?: boolean
    danger?: boolean
  }[] = [
    { decision: 'allow-once', label: english ? 'Allow once' : '允许一次', keyHint: '1', primary: true },
    { decision: 'allow-always', label: english ? 'Allow for session' : '本会话放行', keyHint: '2' },
    { decision: 'deny', label: english ? 'Deny' : '拒绝', keyHint: '3', danger: true }
  ]

  return (
    // data-approval-card：trajectory 的 ApprovalNode 点击时靠它定位本卡（scrollIntoView + focus）
    <div
      data-approval-card
      style={{ padding: '0 20px 10px', flexShrink: 1, minHeight: 0, overflowY: 'auto' }}
      className="fade-in"
    >
      <div
        ref={cardRef}
        tabIndex={-1}
        onKeyDown={onCardKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          maxWidth: 760,
          margin: '0 auto',
          background: 'var(--regolith)',
          border: `1px solid ${focused ? 'var(--line-hi)' : 'var(--line)'}`,
          borderRadius: 10,
          overflow: 'hidden',
          outline: 'none',
          transition: 'border-color 150ms var(--ease-farside)'
        }}
      >
        <PrismLine />
        <div style={{ padding: '12px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span
              style={{
                fontSize: 11,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--faint)'
              }}
            >
              {english ? 'Waiting for approval' : '等待地面站确认'}
              {queueLen > 1 ? ` · ${english ? 'Queue' : '队列'} 1/${queueLen}` : ''}
            </span>
            <span className="mono" style={{ fontSize: 12.5, color: 'var(--moonlight)' }}>
              {request.tool}
            </span>
          </div>

          {/* 工具参数：等宽参数块，完整展示 */}
          <pre
            className="mono selectable"
            style={{
              margin: '8px 0 0',
              padding: '8px 10px',
              background: 'var(--mare)',
              border: '1px solid var(--line)',
              borderRadius: 6,
              fontSize: 12,
              lineHeight: 1.65,
              color: 'var(--dust)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              userSelect: 'text'
            }}
          >
            {request.detail}
          </pre>

          {request.diff && diffMeta ? (
            <div
              style={{
                marginTop: 10,
                border: '1px solid var(--line)',
                borderRadius: 6,
                background: 'var(--mare)',
                overflow: 'hidden'
              }}
            >
              <div
                className="mono"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 10px',
                  borderBottom: diffOpen ? '1px solid var(--line)' : 'none',
                  fontSize: 11,
                  color: 'var(--faint)'
                }}
              >
                {diffMeta.file ? <span style={{ color: 'var(--dust)' }}>{diffMeta.file}</span> : null}
                <span style={{ color: 'var(--signal)' }}>+{diffMeta.add}</span>
                <span style={{ color: 'var(--redshift)' }}>−{diffMeta.del}</span>
                <span style={{ flex: 1 }} />
                {!diffOpen ? <span>{english ? 'Collapsed' : '已折叠'} · {diffMeta.total} {english ? 'lines' : '行'}</span> : null}
                <span>Ctrl+E {diffOpen ? (english ? 'Collapse' : '折叠') : (english ? 'Expand' : '展开')}</span>
              </div>
              {diffOpen ? (
                <div style={{ maxHeight: '50vh', overflowY: 'auto', padding: '8px 0' }}>
                  <DiffBlock diff={request.diff} />
                </div>
              ) : null}
            </div>
          ) : null}

          {feedbackMode ? (
            /* ── 拒绝后的反馈输入态：Enter 提交，Esc 返回 ── */
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--redshift)', flexShrink: 0 }}>
                {english ? 'Reason for denial' : '拒绝理由'}
              </span>
              <input
                ref={inputRef}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    decide('deny', feedback.trim() || undefined)
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setFeedbackMode(false)
                    requestAnimationFrame(() => cardRef.current?.focus())
                  }
                }}
                placeholder={english ? 'Optional · Enter submit · Esc back' : '可留空 · Enter 提交 · Esc 返回'}
                style={{
                  flex: 1,
                  fontSize: 12,
                  color: 'var(--moonlight)',
                  background: 'var(--mare)',
                  border: '1px solid var(--line)',
                  borderRadius: 6,
                  padding: '5px 10px'
                }}
              />
              <button
                onClick={() => decide('deny', feedback.trim() || undefined)}
                style={{
                  fontSize: 12.5,
                  padding: '5px 14px',
                  borderRadius: 6,
                  border: '1px solid var(--line)',
                  color: 'var(--redshift)',
                  flexShrink: 0,
                  transition: 'background 150ms var(--ease-farside)'
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--crater)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                {english ? 'Submit denial' : '提交拒绝'}
              </button>
            </div>
          ) : (
            /* ── 三键操作 + 快捷键提示 ── */
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
              {actions.map((a) => (
                <button
                  key={a.decision}
                  onClick={() =>
                    a.decision === 'deny' ? setFeedbackMode(true) : decide(a.decision)
                  }
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    fontSize: 12.5,
                    letterSpacing: '0.02em',
                    padding: '5px 14px',
                    borderRadius: 6,
                    border: a.primary ? 'none' : '1px solid var(--line)',
                    color: a.primary
                      ? 'var(--void)'
                      : a.danger
                        ? 'var(--redshift)'
                        : 'var(--dust)',
                    background: a.primary ? 'var(--moonlight)' : 'transparent',
                    transition: 'background 150ms var(--ease-farside), color 150ms var(--ease-farside)'
                  }}
                  onMouseEnter={(e) => {
                    if (!a.primary) e.currentTarget.style.background = 'var(--crater)'
                  }}
                  onMouseLeave={(e) => {
                    if (!a.primary) e.currentTarget.style.background = 'transparent'
                  }}
                >
                  <span className="mono" style={{ fontSize: 11, opacity: 0.55, marginRight: 6 }}>
                    {a.keyHint}
                  </span>
                  {a.label}
                </button>
              ))}
              <div style={{ flex: 1 }} />
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 11,
                  color: 'var(--faint)'
                }}
              >
                {request.diff ? (
                  <>
                    <Kbd>Ctrl+E</Kbd>
                    {diffOpen ? (english ? 'Collapse' : '折叠') : (english ? 'Expand' : '展开')}
                  </>
                ) : null}
                <Kbd>Esc</Kbd>{english ? 'Deny' : '拒绝'}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
