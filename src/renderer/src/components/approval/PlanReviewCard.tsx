import { useEffect, useRef, useState } from 'react'
import type { ApprovalRequest } from '@shared/types'
import { PrismLine } from '../../design-system/PrismLine'
import { useFarsideStore } from '../../lib/store'
import { usePreferences } from '../../lib/preferences'

export function PlanReviewCard({ request }: { request: ApprovalRequest }) {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
  const resolve = useFarsideStore((state) => state.resolveApproval)
  const [revising, setRevising] = useState(false)
  const [feedback, setFeedback] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const plan = request.planReview

  useEffect(() => {
    if (revising) requestAnimationFrame(() => inputRef.current?.focus())
  }, [revising])

  if (!plan) return null

  const revise = (): void => {
    const text = feedback.trim()
    if (!text) return
    resolve(request.id, 'deny', text, 'Revise')
  }

  const reject = (): void => {
    const confirmed = window.confirm(
      english
        ? 'Reject this plan and exit plan mode?'
        : '确定否决这份计划并退出计划模式吗？'
    )
    if (confirmed) resolve(request.id, 'deny', undefined, 'Reject and Exit')
  }

  return (
    <div
      data-approval-card
      className="plan-review-card"
      style={{ padding: '0 20px 10px', flexShrink: 1, minHeight: 0, overflowY: 'auto' }}
    >
      <section
        style={{
          maxWidth: 760,
          margin: '0 auto',
          overflow: 'hidden',
          border: '1px solid var(--line-hi)',
          borderRadius: 10,
          background: 'var(--regolith)',
          boxShadow: '0 10px 30px rgba(0, 0, 0, .32)'
        }}
      >
        <PrismLine />
        <div style={{ padding: '11px 13px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span
              className="mono"
              style={{ color: 'var(--faint)', fontSize: 9.5, letterSpacing: '0.1em' }}
            >
              {english ? 'PLAN REVIEW' : '计划待审'}
            </span>
            <span style={{ color: 'var(--moonlight)', fontSize: 12.5, fontWeight: 500 }}>
              {english ? 'Ready to execute' : '计划已生成，等待你的决定'}
            </span>
            <span style={{ flex: 1 }} />
            {plan.path ? (
              <span
                className="mono"
                title={plan.path}
                style={{
                  maxWidth: 260,
                  overflow: 'hidden',
                  color: 'var(--faint)',
                  fontSize: 9,
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {plan.path}
              </span>
            ) : null}
          </div>

          {revising ? (
            <div style={{ marginTop: 10 }}>
              <textarea
                ref={inputRef}
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault()
                    revise()
                  }
                  if (event.key === 'Escape') setRevising(false)
                }}
                rows={3}
                placeholder={
                  english
                    ? 'What should Kimi change? Ctrl+Enter to submit'
                    : '哪里不满意、希望如何修改？Ctrl+Enter 提交'
                }
                style={{
                  width: '100%',
                  resize: 'vertical',
                  padding: '8px 10px',
                  border: '1px solid var(--line-hi)',
                  borderRadius: 6,
                  background: 'var(--mare)',
                  color: 'var(--moonlight)',
                  fontSize: 12.5,
                  lineHeight: 1.55
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 7, marginTop: 7 }}>
                <button
                  type="button"
                  onClick={() => setRevising(false)}
                  style={{ padding: '5px 11px', color: 'var(--faint)', fontSize: 11.5 }}
                >
                  {english ? 'Cancel' : '取消'}
                </button>
                <button
                  type="button"
                  disabled={!feedback.trim()}
                  onClick={revise}
                  style={{
                    padding: '5px 12px',
                    border: '1px solid var(--line-hi)',
                    borderRadius: 6,
                    color: feedback.trim() ? 'var(--moonlight)' : 'var(--ghost)',
                    fontSize: 11.5
                  }}
                >
                  {english ? 'Send revision' : '让 Kimi 修改'}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10, flexWrap: 'wrap' }}>
              {plan.options.length > 0 ? (
                plan.options.map((option, index) => (
                  <button
                    key={option.label}
                    type="button"
                    title={option.description}
                    onClick={() => resolve(request.id, 'allow-once', undefined, option.label)}
                    style={{
                      padding: '6px 12px',
                      border: index === 0 ? '1px solid var(--moonlight)' : '1px solid var(--line-hi)',
                      borderRadius: 6,
                      background: index === 0 ? 'var(--moonlight)' : 'transparent',
                      color: index === 0 ? 'var(--void)' : 'var(--dust)',
                      fontSize: 11.5
                    }}
                  >
                    {option.label}
                  </button>
                ))
              ) : (
                <button
                  type="button"
                  onClick={() => resolve(request.id, 'allow-once', undefined, 'Approve')}
                  style={{
                    padding: '6px 14px',
                    borderRadius: 6,
                    background: 'var(--moonlight)',
                    color: 'var(--void)',
                    fontSize: 11.5,
                    fontWeight: 500
                  }}
                >
                  {english ? 'Approve and execute' : '同意并执行'}
                </button>
              )}
              <button
                type="button"
                onClick={() => setRevising(true)}
                style={{
                  padding: '6px 12px',
                  border: '1px solid var(--line)',
                  borderRadius: 6,
                  color: 'var(--dust)',
                  fontSize: 11.5
                }}
              >
                {english ? 'Request changes' : '提出修改'}
              </button>
              <button
                type="button"
                onClick={reject}
                style={{
                  padding: '6px 11px',
                  border: '1px solid color-mix(in srgb, var(--redshift) 34%, var(--line))',
                  borderRadius: 6,
                  color: 'var(--redshift)',
                  fontSize: 11.5
                }}
              >
                {english ? 'Reject' : '否决'}
              </button>
              <span style={{ flex: 1 }} />
              <span style={{ color: 'var(--faint)', fontSize: 10 }}>
                {english ? 'Read the full plan in Preview →' : '完整计划已在右侧“预览”中打开 →'}
              </span>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
