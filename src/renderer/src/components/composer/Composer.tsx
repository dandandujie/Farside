import { useEffect, useMemo, useRef, useState } from 'react'
import { MODELS, PERMISSION_MODE_LABELS } from '@shared/types'
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_TOTAL_ATTACHMENT_BYTES
} from '@shared/security'
import { useFarsideStore } from '../../lib/store'
import { MoonPhase } from '../../design-system/MoonPhase'
import { PrismLine } from '../../design-system/PrismLine'
import { SLASH_COMMANDS, type SlashCommand } from './slashCommands'
import type { WorkspaceEntry } from '@shared/ipc'
import { usePreferences } from '../../lib/preferences'

/** 上下文窗口换算：1_000_000 → 1M，262_144 → 256K */
function formatContextWindow(n: number): string {
  return n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1024)}K`
}

/** 引用文件 pill（输入区前缀，mock 期仅存本地，三期随消息上链） */
interface FileRef {
  id: string
  path: string
}

const LINE_HEIGHT = 14 * 1.6 // textarea：fontSize 14 × lineHeight 1.6
const MAX_TEXTAREA_HEIGHT = LINE_HEIGHT * 8 + 12 // 最多 8 行 + 上下 padding

/** 悬浮输入舱：模型选择 / 权限档位 / 计划开关 / 附件 / 斜杠与 @ 补全 / 发送。 */
export function Composer() {
  const { locale, t } = usePreferences()
  const activeSessionId = useFarsideStore((s) => s.activeSessionId)
  const activeSession = useFarsideStore((s) => s.sessions.find((session) => session.id === s.activeSessionId) ?? null)
  const draft = useFarsideStore((s) => s.draft)
  const setDraft = useFarsideStore((s) => s.setDraft)
  const attachments = useFarsideStore((s) => s.attachments)
  const addAttachment = useFarsideStore((s) => s.addAttachment)
  const removeAttachment = useFarsideStore((s) => s.removeAttachment)
  const model = useFarsideStore((s) => s.model)
  const account = useFarsideStore((s) => s.account)
  const setModel = useFarsideStore((s) => s.setModel)
  const permissionMode = useFarsideStore((s) => s.permissionMode)
  const cyclePermissionMode = useFarsideStore((s) => s.cyclePermissionMode)
  const planMode = useFarsideStore((s) => s.planMode)
  const togglePlanMode = useFarsideStore((s) => s.togglePlanMode)
  const sending = useFarsideStore((s) => s.sending)
  const send = useFarsideStore((s) => s.send)
  const abortCurrent = useFarsideStore((s) => s.abortCurrent)

  const [refs, setRefs] = useState<FileRef[]>([])
  const [attachmentError, setAttachmentError] = useState('')
  const [modelOpen, setModelOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [slashIdx, setSlashIdx] = useState(0)
  const [refIdx, setRefIdx] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [refDismissed, setRefDismissed] = useState(false)
  const [projectFiles, setProjectFiles] = useState<string[]>([])

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const slashListRef = useRef<HTMLDivElement>(null)
  const refListRef = useRef<HTMLDivElement>(null)

  // ── 补全：draft 整体是一个 / 或 @ token 时浮出 ──────────────────
  const slashQuery = /^\/(\S*)$/.exec(draft)?.[1] ?? null
  const refQuery = /^@(\S*)$/.exec(draft)?.[1] ?? null

  const filteredCommands = useMemo(
    () =>
      slashQuery === null
        ? []
        : SLASH_COMMANDS.filter((c) => c.name.includes(slashQuery.toLowerCase())),
    [slashQuery]
  )
  const filteredFiles = useMemo(
    () =>
      refQuery === null
        ? []
        : projectFiles.filter((f) =>
            f.toLowerCase().includes(refQuery.toLowerCase())
          ).slice(0, 8),
    [projectFiles, refQuery]
  )

  const slashOpen = slashQuery !== null && !slashDismissed && filteredCommands.length > 0
  const refOpen = refQuery !== null && !refDismissed && filteredFiles.length > 0

  // 查询词变化时回到第一项；键盘导航时选中项滚入可视区
  useEffect(() => setSlashIdx(0), [slashQuery])
  useEffect(() => setRefIdx(0), [refQuery])
  useEffect(() => {
    setRefs([])
    setModelOpen(false)
    setSlashDismissed(false)
    setRefDismissed(false)
  }, [activeSessionId])
  useEffect(() => {
    if (refQuery === null || !activeSessionId || !window.api?.agent) return
    let active = true
    const timer = window.setTimeout(() => {
      const flatten = (items: WorkspaceEntry[]): string[] =>
        items.flatMap((item) =>
          item.kind === 'file' ? [item.path] : flatten(item.children ?? [])
        )
      const request = refQuery
        ? window.api!.agent.searchWorkspace(activeSessionId, refQuery)
        : window.api!.agent.listWorkspace(activeSessionId, '.', 6)
      void request.then((result) => {
        if (active && result.ok) setProjectFiles(flatten(result.items))
      })
    }, 120)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [activeSessionId, refQuery])
  useEffect(() => {
    slashListRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [slashIdx])
  useEffect(() => {
    refListRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [refIdx])

  // ── textarea 自动增高（1–8 行）──────────────────────────────────
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
  }, [draft])

  const focusTextarea = () => requestAnimationFrame(() => textareaRef.current?.focus())

  const pickCommand = (cmd: SlashCommand) => {
    // 尾部补空格：补全浮层只匹配「纯 /token」，填入后自然关闭，用户可继续输参数
    setDraft(`/${cmd.name} `)
    focusTextarea()
  }

  const pickFile = (path: string) => {
    setRefs((list) =>
      list.some((r) => r.path === path)
        ? list
        : [...list, { id: `ref-${Date.now()}-${path}`, path }]
    )
    setDraft('')
    focusTextarea()
  }

  const handleSend = () => {
    if ((!draft.trim() && attachments.length === 0) || sending || activeSession?.phase !== 'new') return
    send(refs.map((ref) => ref.path))
    setRefs([])
  }

  /** 选择、拖拽和剪贴板图片统一走这里。 */
  const handleFiles = async (files: FileList | File[] | null) => {
    if (!files) return
    setAttachmentError('')
    let nextCount = attachments.length
    let nextBytes = attachments.reduce((total, attachment) => total + attachment.size, 0)
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/') && !f.type.startsWith('video/')) continue
      if (nextCount >= MAX_ATTACHMENT_COUNT) {
        setAttachmentError(locale === 'en-US' ? `Up to ${MAX_ATTACHMENT_COUNT} attachments are allowed.` : `最多添加 ${MAX_ATTACHMENT_COUNT} 个附件。`)
        break
      }
      if (f.size > MAX_ATTACHMENT_BYTES) {
        setAttachmentError(locale === 'en-US' ? `${f.name} exceeds the 20 MiB limit.` : `${f.name} 超过 20 MiB 单文件上限。`)
        continue
      }
      if (nextBytes + f.size > MAX_TOTAL_ATTACHMENT_BYTES) {
        setAttachmentError(locale === 'en-US' ? 'Attachments exceed the 40 MiB total limit.' : '附件总大小不能超过 40 MiB。')
        break
      }
      let dataBase64: string
      try {
        dataBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const result = typeof reader.result === 'string' ? reader.result : ''
            resolve(result.slice(result.indexOf(',') + 1))
          }
          reader.onerror = () => reject(reader.error ?? new Error('附件读取失败'))
          reader.readAsDataURL(f)
        })
      } catch {
        setAttachmentError(locale === 'en-US' ? `Could not read ${f.name}.` : `无法读取附件 ${f.name}。`)
        continue
      }
      addAttachment({
        id: `att-${crypto.randomUUID()}`,
        name: f.name,
        mimeType: f.type,
        size: f.size,
        vision: true,
        dataBase64
      })
      nextCount += 1
      nextBytes += f.size
    }
  }

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (!images.length) return
    event.preventDefault()
    void handleFiles(images)
  }

  const onTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Shift+Tab 切换计划模式（任何状态下都生效）
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      togglePlanMode()
      return
    }
    // 中文输入法组词期间的 Enter 只上屏，不触发发送/选择
    if (e.nativeEvent.isComposing) return

    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIdx((i) => (i + 1) % filteredCommands.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIdx((i) => (i - 1 + filteredCommands.length) % filteredCommands.length)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        pickCommand(filteredCommands[slashIdx])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashDismissed(true)
        return
      }
    }

    if (refOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setRefIdx((i) => (i + 1) % filteredFiles.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setRefIdx((i) => (i - 1 + filteredFiles.length) % filteredFiles.length)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        pickFile(filteredFiles[refIdx])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setRefDismissed(true)
        return
      }
    }

    if (e.key === 'Escape' && activeSession?.phase !== 'new') {
      e.preventDefault()
      abortCurrent()
      return
    }

    // Enter 发送，Shift+Enter 换行
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const canSend = (draft.trim().length > 0 || attachments.length > 0) && !sending && activeSession?.phase === 'new'
  const accountModels = (account?.models ?? [])
    .filter((item) => !account?.activeProviderId || item.providerId === account.activeProviderId)
    .map((item) => ({
      id: item.id,
      label: item.label,
      contextWindow: item.contextWindow,
      multimodal: item.capabilities.includes('vision'),
      note: `${Math.round(item.contextWindow / 1024)}K 上下文${item.capabilities.length ? ` · ${item.capabilities.join(' · ')}` : ''}`
    }))
  const availableModels = accountModels.length > 0 ? accountModels : MODELS
  const currentModel = availableModels.find((m) => m.id === model)

  return (
    <div style={{ padding: '0 20px 16px', flexShrink: 0 }}>
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={(e) => {
          // 进入子元素也会触发 dragleave，确认真的离开卡片再收边框
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          void handleFiles(e.dataTransfer.files)
        }}
        style={{
          position: 'relative',
          maxWidth: 760,
          margin: '0 auto',
          borderRadius: 10,
          padding: '10px 12px 8px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
          // dragover 时边框换成 1px prism hairline（双层背景：内层盖底色，外层光谱描边）
          ...(dragOver
            ? {
                border: '1px solid transparent',
                background:
                  'linear-gradient(var(--regolith), var(--regolith)) padding-box, var(--prism) border-box'
              }
            : { background: 'var(--regolith)', border: '1px solid var(--line)' })
        }}
      >
        {/* ── 斜杠命令补全 ── */}
        {slashOpen ? (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 'calc(100% + 6px)',
              zIndex: 30,
              background: 'var(--mare)',
              border: '1px solid var(--line-hi)',
              borderRadius: 10,
              boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
              overflow: 'hidden'
            }}
          >
            <div
              style={{
                padding: '8px 12px 4px',
                fontSize: 11,
                letterSpacing: '0.08em',
                color: 'var(--faint)'
              }}
            >
              {locale === 'en-US' ? 'Slash commands · ↑↓ Select · Enter Insert · Esc Close' : '斜杠命令 · ↑↓ 选择 · Enter 填入 · Esc 关闭'}
            </div>
            <div ref={slashListRef} style={{ maxHeight: 252, overflowY: 'auto', padding: 4 }}>
              {filteredCommands.map((cmd, i) => (
                <button
                  key={cmd.name}
                  data-active={i === slashIdx || undefined}
                  onClick={() => pickCommand(cmd)}
                  onMouseEnter={() => setSlashIdx(i)}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 12,
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 10px',
                    borderRadius: 6,
                    background: i === slashIdx ? 'var(--crater)' : 'transparent'
                  }}
                >
                  <span
                    className="mono"
                    style={{
                      fontSize: 12.5,
                      color: i === slashIdx ? 'var(--moonlight)' : 'var(--dust)'
                    }}
                  >
                    /{cmd.name}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--faint)', flexShrink: 0 }}>
                    {t(cmd.desc)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* ── @ 文件引用补全 ── */}
        {refOpen ? (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 'calc(100% + 6px)',
              zIndex: 30,
              background: 'var(--mare)',
              border: '1px solid var(--line-hi)',
              borderRadius: 10,
              boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
              overflow: 'hidden'
            }}
          >
            <div
              style={{
                padding: '8px 12px 4px',
                fontSize: 11,
                letterSpacing: '0.08em',
                color: 'var(--faint)'
              }}
            >
              {locale === 'en-US' ? 'File reference · ↑↓ Select · Enter Insert · Esc Close' : '引用文件 · ↑↓ 选择 · Enter 插入 · Esc 关闭'}
            </div>
            <div ref={refListRef} style={{ maxHeight: 252, overflowY: 'auto', padding: 4 }}>
              {filteredFiles.map((path, i) => (
                <button
                  key={path}
                  data-active={i === refIdx || undefined}
                  onClick={() => pickFile(path)}
                  onMouseEnter={() => setRefIdx(i)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 10px',
                    borderRadius: 6,
                    background: i === refIdx ? 'var(--crater)' : 'transparent'
                  }}
                >
                  <span
                    className="mono"
                    style={{
                      fontSize: 12,
                      color: i === refIdx ? 'var(--moonlight)' : 'var(--dust)'
                    }}
                  >
                    <span style={{ color: 'var(--faint)' }}>@</span>
                    {path}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* ── 引用文件 pill（输入区前缀）── */}
        {refs.length > 0 ? (
          <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
            {refs.map((r) => (
              <span
                key={r.id}
                className="mono"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 11,
                  color: 'var(--dust)',
                  background: 'var(--crater)',
                  border: '1px solid var(--line)',
                  borderRadius: 999,
                  padding: '3px 6px 3px 10px'
                }}
              >
                <span style={{ color: 'var(--faint)' }}>@</span>
                {r.path}
                <button
                  aria-label={`移除引用 ${r.path}`}
                  onClick={() => setRefs((list) => list.filter((x) => x.id !== r.id))}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    color: 'var(--faint)',
                    padding: 2
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--moonlight)')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--faint)')}
                >
                  <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden>
                    <path
                      d="M1 1 8 8M8 1 1 8"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {/* ── 图片使用可辨认缩略图；视频保持紧凑附件条。── */}
        {attachments.length > 0 ? (
          <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
            {attachments.map((a) => {
              const image = a.mimeType.startsWith('image/') && a.dataBase64
              return (
              <span
                key={a.id}
                className="mono"
                title={a.name}
                style={{
                  position: 'relative',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: image ? 8 : 6,
                  minWidth: image ? 126 : undefined,
                  maxWidth: 190,
                  fontSize: 11,
                  color: 'var(--dust)',
                  background: 'var(--crater)',
                  border: '1px solid var(--line)',
                  borderRadius: image ? 7 : 999,
                  padding: image ? 4 : '3px 6px 3px 10px',
                  overflow: 'hidden'
                }}
              >
                {image ? (
                  <img
                    src={`data:${a.mimeType};base64,${a.dataBase64}`}
                    alt=""
                    style={{ width: 38, height: 38, flexShrink: 0, objectFit: 'cover', borderRadius: 4, background: 'var(--mare)' }}
                  />
                ) : a.mimeType.startsWith('video/') ? (
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                    <rect
                      x="0.5"
                      y="1.5"
                      width="9"
                      height="7"
                      rx="1.5"
                      fill="none"
                      stroke="currentColor"
                    />
                    <path d="M4 3.5v3l2.5-1.5Z" fill="currentColor" />
                  </svg>
                ) : (
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                    <rect
                      x="0.5"
                      y="0.5"
                      width="9"
                      height="9"
                      rx="2"
                      fill="none"
                      stroke="currentColor"
                    />
                    <circle cx="3.4" cy="3.6" r="1" fill="currentColor" />
                    <path d="M1 8.5 4 5.5 6 7.5 7.4 6 9 8.5Z" fill="currentColor" />
                  </svg>
                )}
                <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                {a.vision ? (
                  <span
                    style={{
                      color: 'var(--faint)',
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase'
                    }}
                  >
                    vision
                  </span>
                ) : null}
                <button
                  aria-label={locale === 'en-US' ? `Remove attachment ${a.name}` : `移除附件 ${a.name}`}
                  onClick={() => removeAttachment(a.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    color: 'var(--faint)',
                    padding: 2
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--moonlight)')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--faint)')}
                >
                  <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden>
                    <path
                      d="M1 1 8 8M8 1 1 8"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </span>
            )})}
          </div>
        ) : null}
        {attachmentError ? (
          <div role="alert" style={{ margin: '-2px 0 8px', fontSize: 10.5, color: 'var(--redshift)' }}>
            {attachmentError}
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          value={draft}
          rows={1}
          onChange={(e) => {
            setDraft(e.target.value)
            setSlashDismissed(false)
            setRefDismissed(false)
          }}
          onKeyDown={onTextareaKeyDown}
          onPaste={handlePaste}
          placeholder={locale === 'en-US' ? 'Send an instruction…  Paste or drop an image · / commands · @ files' : '向月背发送指令…  粘贴或拖入图片 · / 斜杠命令 · @ 引用文件'}
          style={{
            display: 'block',
            width: '100%',
            resize: 'none',
            overflowY: 'auto',
            fontSize: 14,
            lineHeight: 1.6,
            padding: '6px 0',
            color: 'var(--moonlight)',
            background: 'transparent',
            boxSizing: 'border-box'
          }}
        />

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            borderTop: '1px solid var(--line)',
            paddingTop: 8
          }}
        >
          {/* ── 模型选择器（自绘下拉，向上展开）── */}
          <button
            onClick={() => setModelOpen((v) => !v)}
            aria-label={t('模型选择')}
            className="mono"
            title={currentModel?.note}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: 'var(--dust)',
              background: 'var(--crater)',
              border: '1px solid var(--line)',
              borderRadius: 6,
              padding: '4px 8px'
            }}
          >
            {currentModel?.label ?? model}
            <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
              <path
                d="M1.5 3 4 5.5 6.5 3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {modelOpen ? (
            <>
              {/* 点击任意处收起 */}
              <div
                onClick={() => setModelOpen(false)}
                style={{ position: 'fixed', inset: 0, zIndex: 39 }}
              />
              <div
                style={{
                  position: 'absolute',
                  left: 12,
                  bottom: 'calc(100% + 6px)',
                  zIndex: 40,
                  width: 260,
                  background: 'var(--mare)',
                  border: '1px solid var(--line-hi)',
                  borderRadius: 10,
                  boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
                  overflow: 'hidden',
                  padding: 4
                }}
              >
                {availableModels.map((m) => {
                  const active = m.id === model
                  return (
                    <button
                      key={m.id}
                      onClick={() => {
                        setModel(m.id)
                        setModelOpen(false)
                      }}
                      onMouseEnter={(e) => {
                        if (!active) e.currentTarget.style.background = 'var(--crater)'
                      }}
                      onMouseLeave={(e) => {
                        if (!active) e.currentTarget.style.background = 'transparent'
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'stretch',
                        gap: 10,
                        width: '100%',
                        textAlign: 'left',
                        padding: '7px 10px',
                        borderRadius: 6,
                        background: 'transparent'
                      }}
                    >
                      {/* 当前项一道 prism 左边线，其余留 1px 占位对齐 */}
                      {active ? <PrismLine direction="vertical" /> : <span style={{ width: 1 }} />}
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span
                          style={{
                            display: 'flex',
                            alignItems: 'baseline',
                            justifyContent: 'space-between',
                            gap: 8
                          }}
                        >
                          <span
                            style={{
                              fontSize: 12.5,
                              color: active ? 'var(--moonlight)' : 'var(--dust)'
                            }}
                          >
                            {m.label}
                          </span>
                          <span className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>
                            {formatContextWindow(m.contextWindow)}
                          </span>
                        </span>
                        <span
                          style={{
                            display: 'block',
                            fontSize: 11,
                            color: 'var(--faint)',
                            marginTop: 2
                          }}
                        >
                          {m.note}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </>
          ) : null}

          {/* ── 权限档位（点击循环；yolo 用 flare 色）── */}
          <button
            onClick={cyclePermissionMode}
            title={t('权限档位：逐项批准 → 自动 → 放开')}
            style={{
              fontSize: 12,
              color: permissionMode === 'yolo' ? 'var(--flare)' : 'var(--dust)',
              border: '1px solid var(--line)',
              borderRadius: 6,
              padding: '4px 10px',
              letterSpacing: '0.02em',
              transition: 'background 150ms var(--ease-farside), color 150ms var(--ease-farside)'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--crater)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            {locale === 'en-US' ? (permissionMode === 'manual' ? 'Manual' : permissionMode === 'auto' ? 'Auto' : 'YOLO') : PERMISSION_MODE_LABELS[permissionMode]}
          </button>

          {/* ── 计划模式独立开关（Shift+Tab）── */}
          <button
            onClick={togglePlanMode}
            title={`${t('计划模式')} (Shift+Tab)`}
            style={{
              fontSize: 12,
              color: planMode ? 'var(--moonlight)' : 'var(--faint)',
              border: planMode ? '1px solid var(--line-hi)' : '1px solid var(--line)',
              background: planMode ? 'var(--crater)' : 'transparent',
              borderRadius: 6,
              padding: '4px 10px',
              letterSpacing: '0.02em',
              transition: 'background 150ms var(--ease-farside), color 150ms var(--ease-farside)'
            }}
          >
            {t('计划')}
          </button>

          {activeSession?.phase !== 'new' ? (
            <button
              onClick={abortCurrent}
              title={locale === 'en-US' ? 'Stop the current response (Esc)' : '终止当前响应（Esc）'}
              style={{ fontSize: 11.5, color: 'var(--redshift)', border: '1px solid color-mix(in srgb, var(--redshift) 35%, var(--line))', borderRadius: 6, padding: '4px 8px' }}
            >
              {locale === 'en-US' ? 'Stop' : '终止'}
            </button>
          ) : null}

          <div style={{ flex: 1 }} />

          {/* ── 曲别针：选择图片/视频附件；输入区也支持 Ctrl+V 图片。── */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,video/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              void handleFiles(e.target.files)
              e.target.value = '' // 允许重复选同一文件
            }}
          />
          <button
            aria-label={t('添加附件')}
            title={t('添加图片或视频附件')}
            onClick={() => fileInputRef.current?.click()}
            style={{
              width: 30,
              height: 30,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 999,
              color: 'var(--dust)',
              transition: 'background 150ms var(--ease-farside)'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--crater)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
              <path
                d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {/* ── 发送：发送中变为呼吸的峨眉月 ── */}
          <button
            aria-label={t('发送')}
            title={`${t('发送')} (Enter)`}
            disabled={!canSend}
            onClick={handleSend}
            style={{
              width: 30,
              height: 30,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 999,
              color: canSend ? 'var(--void)' : 'var(--ghost)',
              background: canSend ? 'var(--moonlight)' : 'var(--crater)',
              transition: 'background 150ms var(--ease-farside), color 150ms var(--ease-farside)',
              cursor: canSend ? 'pointer' : 'default'
            }}
          >
            {sending ? (
              // 复用 base.css 的 caret-breathe 关键帧做月相呼吸
              <span
                style={{
                  display: 'flex',
                  animation: 'caret-breathe 1.2s var(--ease-farside) infinite'
                }}
              >
                <MoonPhase phase="waxing" size={15} title={t('信号传输中')} active />
              </span>
            ) : (
              <svg width="13" height="13" viewBox="0 0 12 12" aria-hidden>
                <path
                  d="M6 11V1.5M6 1.5 2 5.5M6 1.5 10 5.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
