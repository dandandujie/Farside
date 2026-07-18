import type { FarsideApi } from '@shared/ipc'
import type { WebviewTag } from 'electron'

declare global {
  interface Window {
    /** preload 经 contextBridge 注入；纯浏览器调试（无 preload）时可能不存在 */
    api?: FarsideApi
  }

  namespace React.JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<WebviewTag>, WebviewTag> & {
        src: string
        partition?: string
        webpreferences?: string
      }
    }
  }
}

export {}
