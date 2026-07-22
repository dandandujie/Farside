import { useFarsideStore, type MissionTab } from '../../lib/store'
import { PrismLine } from '../../design-system/PrismLine'
import { DiffTab } from './DiffTab'
import { TelemetryTab } from './TelemetryTab'
import { FilesTab } from './FilesTab'
import { PreviewTab } from './PreviewTab'
import { ResizeHandle, usePersistentWidth } from '../shell/ResizeHandle'
import { usePreferences } from '../../lib/preferences'

const TABS: { id: MissionTab; label: string }[] = [
  { id: 'diff', label: '改动' },
  { id: 'telemetry', label: '遥测' },
  { id: 'files', label: '文件' },
  { id: 'preview', label: '预览' }
]

/** MissionPanel：常规读数保持紧凑，预览页适度加宽。 */
export function MissionPanel() {
  const { locale } = usePreferences()
  const tab = useFarsideStore((s) => s.missionTab)
  const setTab = useFarsideStore((s) => s.setMissionTab)
  const [width, setWidth] = usePersistentWidth('mission', tab === 'preview' ? 460 : 360, 300, 760)

  return (
    <aside
      style={{
        width,
        position: 'relative',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--mare)',
        borderLeft: '1px solid var(--line)',
        minHeight: 0,
        transition: 'border-color 150ms var(--ease-farside)'
      }}
    >
      <ResizeHandle edge="left" onDrag={(delta) => setWidth(width - delta)} />
      {/* tab 行 hover，全模块共用这一份样式 */}
      <style>{`
        .mission-row { transition: background 120ms var(--ease-farside) }
        .mission-row:hover { background: var(--crater) }
        @media (prefers-reduced-motion: reduce) {
          .mission-row { transition: none }
        }
      `}</style>
      <div
        style={{
          display: 'flex',
          gap: 2,
          padding: '10px 12px 0',
          borderBottom: '1px solid var(--line)',
          flexShrink: 0
        }}
      >
        {TABS.map((t) => {
          const activeTab = tab === t.id
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                position: 'relative',
                fontSize: 12.5,
                letterSpacing: '0.04em',
                color: activeTab ? 'var(--moonlight)' : 'var(--faint)',
                padding: '6px 12px 10px',
                borderBottom: '1px solid transparent',
                transition: 'color 150ms var(--ease-farside)'
              }}
            >
              {locale === 'en-US' ? ({ diff: 'Changes', telemetry: 'Telemetry', files: 'Files', preview: 'Preview' } as Record<MissionTab, string>)[t.id] : t.label}
              {/* DESIGN.md：active 导航用 1px prism hairline（盖住容器底线） */}
              {activeTab ? (
                <div style={{ position: 'absolute', left: 0, right: 0, bottom: -1 }}>
                  <PrismLine />
                </div>
              ) : null}
            </button>
          )
        })}
      </div>
      {/* 所有 tab 保持挂载，切换只改可见性：状态与已取数据不丢，切回不重新加载 */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <div style={{ display: tab === 'diff' ? 'contents' : 'none' }}><DiffTab /></div>
        <div style={{ display: tab === 'telemetry' ? 'contents' : 'none' }}><TelemetryTab /></div>
        <div style={{ display: tab === 'files' ? 'contents' : 'none' }}><FilesTab /></div>
        <div style={{ display: tab === 'preview' ? 'contents' : 'none' }}><PreviewTab /></div>
      </div>
    </aside>
  )
}
