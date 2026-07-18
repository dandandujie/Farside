import type { MessageEvent } from '@shared/types'
import { Markdown } from '../Markdown'
import { DashMarker, MarkerSlot } from './markers'

/** Message：探测器回传的 markdown 正文；streaming 时末尾带 prism 呼吸光标。 */
export function MessageNode({ event, streaming = false }: { event: MessageEvent; streaming?: boolean }) {
  return (
    <div style={{ position: 'relative' }}>
      <MarkerSlot top={8}>
        <DashMarker />
      </MarkerSlot>
      <Markdown text={event.markdown} />
      {streaming ? <span className="stream-caret" aria-hidden style={{ marginTop: 10 }} /> : null}
    </div>
  )
}
