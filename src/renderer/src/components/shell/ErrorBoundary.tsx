import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
  /** app=整窗兜底（双语降级，不依赖 i18n Provider）；region=局部区域（失败只影响该区域）。 */
  variant?: 'app' | 'region'
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * 渲染层兜底边界：任何组件抛错不再白屏整窗。
 * app 级提供"重新加载"（整页刷新，重新建立链路）；region 级提供"继续"（清除错误态，
 * 尝试渲染后续内容），让畸形事件只损失自己那块视图。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[farside] 渲染异常', error, info.componentStack)
  }

  private readonly reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.variant !== 'app') {
      return (
        <div
          role="alert"
          style={{
            margin: '12px 24px', padding: '10px 12px', border: '1px solid color-mix(in srgb, var(--redshift) 45%, var(--line))',
            borderRadius: 7, background: 'var(--regolith)', fontSize: 12, color: 'var(--dust)', display: 'flex',
            alignItems: 'center', gap: 10
          }}
        >
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {error.message || '渲染异常 · Render error'}
          </span>
          <button
            type="button"
            onClick={this.reset}
            style={{ flexShrink: 0, color: 'var(--moonlight)', border: '1px solid var(--line-hi)', borderRadius: 5, padding: '2px 9px', fontSize: 11 }}
          >
            继续 · Resume
          </button>
        </div>
      )
    }
    const detail = [error.message, error.stack].filter(Boolean).join('\n\n').slice(0, 2000)
    return (
      <div
        role="alert"
        style={{
          height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 14, background: 'var(--void)', color: 'var(--moonlight)', padding: 32, textAlign: 'center'
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 500, letterSpacing: '0.02em' }}>
          界面遇到异常 · Unexpected interface error
        </div>
        <div style={{ fontSize: 12, color: 'var(--dust)', maxWidth: 560, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {detail || String(error)}
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            padding: '7px 18px', borderRadius: 7, background: 'var(--moonlight)', color: 'var(--void)',
            fontSize: 12.5, border: 0, cursor: 'pointer'
          }}
        >
          重新加载 · Reload
        </button>
      </div>
    )
  }
}
