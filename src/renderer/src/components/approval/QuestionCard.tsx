import { useMemo, useState } from 'react'
import type { QuestionAnswer, QuestionRequest } from '@shared/types'
import { PrismLine } from '../../design-system/PrismLine'
import { useFarsideStore } from '../../lib/store'
import { usePreferences } from '../../lib/preferences'

/** Kimi Agent 的结构化提问卡；支持单选、多选和自由输入。 */
export function QuestionCard({ request }: { request: QuestionRequest }) {
  const { locale } = usePreferences()
  const english = locale === 'en-US'
  const resolve = useFarsideStore((state) => state.resolveQuestion)
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})

  const complete = useMemo(
    () =>
      request.questions.every(
        (question) =>
          (selected[question.id]?.length ?? 0) > 0 || (other[question.id]?.trim().length ?? 0) > 0
      ),
    [other, request.questions, selected]
  )

  const toggle = (questionId: string, optionId: string, multi: boolean) => {
    setSelected((current) => {
      if (!multi) return { ...current, [questionId]: [optionId] }
      const values = current[questionId] ?? []
      return {
        ...current,
        [questionId]: values.includes(optionId)
          ? values.filter((value) => value !== optionId)
          : [...values, optionId]
      }
    })
  }

  const submit = () => {
    if (!complete) return
    const answers: Record<string, QuestionAnswer> = {}
    for (const question of request.questions) {
      const text = other[question.id]?.trim()
      const values = selected[question.id] ?? []
      if (text) answers[question.id] = { kind: 'other', text }
      else if (question.multiSelect) answers[question.id] = { kind: 'multi', optionIds: values }
      else answers[question.id] = { kind: 'single', optionId: values[0] }
    }
    resolve(request.id, answers)
  }

  return (
    <div style={{ padding: '0 20px 10px', flexShrink: 0 }}>
      <section
        style={{
          position: 'relative',
          maxWidth: 760,
          margin: '0 auto',
          background: 'var(--regolith)',
          border: '1px solid var(--line-hi)',
          borderRadius: 10,
          overflow: 'hidden',
          boxShadow: '0 8px 24px rgba(0,0,0,0.32)'
        }}
      >
        <div style={{ position: 'absolute', left: 0, right: 0, top: 0 }}>
          <PrismLine />
        </div>
        <div style={{ padding: '13px 14px 12px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div
              className="mono"
              style={{ fontSize: 10.5, color: 'var(--faint)', letterSpacing: '0.1em' }}
            >
              {english ? 'Waiting for input' : '等待地面站输入'} · {request.questions.length} {english ? 'items' : '项'}
            </div>
          </div>

          {request.questions.map((question, questionIndex) => (
            <fieldset
              key={question.id}
              style={{ border: 0, padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 7 }}
            >
              <legend style={{ padding: 0, fontSize: 13, color: 'var(--moonlight)', lineHeight: 1.55 }}>
                {question.header ? `${question.header} · ` : ''}{question.question}
              </legend>
              {question.body ? (
                <p style={{ margin: 0, fontSize: 11.5, color: 'var(--faint)', lineHeight: 1.55 }}>
                  {question.body}
                </p>
              ) : null}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6 }}>
                {question.options.map((option, optionIndex) => {
                  const active = selected[question.id]?.includes(option.id) === true
                  return (
                    <button
                      key={option.id}
                      onClick={() => toggle(question.id, option.id, question.multiSelect)}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 8,
                        padding: '7px 8px',
                        textAlign: 'left',
                        background: active ? 'var(--crater)' : 'var(--mare)',
                        border: `1px solid ${active ? 'var(--line-hi)' : 'var(--line)'}`,
                        borderRadius: 6
                      }}
                    >
                      <span
                        className="mono"
                        style={{
                          color: active ? 'var(--moonlight)' : 'var(--faint)',
                          fontSize: 10.5,
                          paddingTop: 1
                        }}
                      >
                        {questionIndex + 1}.{optionIndex + 1}
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 12, color: 'var(--dust)' }}>
                          {option.label}
                        </span>
                        {option.description ? (
                          <span style={{ display: 'block', marginTop: 2, fontSize: 10.5, color: 'var(--faint)' }}>
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  )
                })}
              </div>
              {question.allowOther ? (
                <input
                  value={other[question.id] ?? ''}
                  onChange={(event) => setOther((current) => ({ ...current, [question.id]: event.target.value }))}
                  placeholder={english ? 'Other answer…' : '其他答案…'}
                  style={{
                    padding: '6px 8px',
                    fontSize: 12,
                    color: 'var(--moonlight)',
                    background: 'var(--mare)',
                    border: '1px solid var(--line)',
                    borderRadius: 6
                  }}
                />
              ) : null}
            </fieldset>
          ))}

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              disabled={!complete}
              onClick={submit}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                background: complete ? 'var(--moonlight)' : 'var(--crater)',
                color: complete ? 'var(--void)' : 'var(--ghost)',
                fontSize: 12.5,
                cursor: complete ? 'pointer' : 'default'
              }}
            >
              {english ? 'Submit answers' : '提交答案'}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
