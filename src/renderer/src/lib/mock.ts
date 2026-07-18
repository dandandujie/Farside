import type { ApprovalRequest, Session } from '@shared/types'

/**
 * 全 App 的「样板间」：一条能展示 K3 全部能力的演示会话。
 * 用户指令 → 深空思考 → 三连仪器读数 → 三颗并行卫星 → 一次审批 → 回传消息 → 遥测。
 * 文案保持地面站口吻，场景是一个真实 React 项目的改造任务。
 */

const T0 = Date.now() - 1000 * 60 * 14 // 14 分钟前开始

export const MOCK_DIFF = `--- a/src/components/TrajectoryView.tsx
+++ b/src/components/TrajectoryView.tsx
@@ -24,11 +24,17 @@
 export function TrajectoryView({ session }: Props) {
   const events = useMemo(() => groupByOrbit(session.events), [session.events])
-  const [collapsed, setCollapsed] = useState(false)
+  const [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>({})
+  const bottomRef = useRef<HTMLDivElement>(null)
+
+  useEffect(() => {
+    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
+  }, [session.events.length])

   return (
-    <div className="orbit">
+    <div className="orbit" role="log" aria-live="polite">
       {events.map(renderNode)}
+      <div ref={bottomRef} />
     </div>
   )
 }`

export const MOCK_APPROVAL: ApprovalRequest = {
  id: 'appr-001',
  sessionId: 'session-demo',
  tool: 'Edit',
  detail:
    'Edit(src/components/TrajectoryView.tsx) — 以每条事件为粒度的折叠状态替换全局折叠开关，新增自动跟随滚动到底部，并为轨道容器补充 aria-live。',
  diff: MOCK_DIFF,
  requestedAt: T0 + 1000 * 60 * 9
}

export const MOCK_SESSION: Session = {
  id: 'session-demo',
  title: '轨道视图按事件粒度折叠',
  project: 'farside',
  cwd: 'D:/Github/kode',
  phase: 'full', // 等待地面站确认
  model: 'kimi-k3',
  updatedAt: T0 + 1000 * 60 * 9,
  contextTokens: 128_410,
  events: [
    {
      id: 'ev-01',
      kind: 'user',
      at: T0,
      text: '把 TrajectoryView 的全局折叠改成按事件粒度折叠，新事件进来时自动滚到底部，顺手补上无障碍语义。'
    },
    {
      id: 'ev-02',
      kind: 'transmission',
      at: T0 + 1000 * 8,
      durationMs: 12_400,
      text: '收到指令。折叠状态需要从 boolean 提升为 Record<eventId, boolean>，改动面集中在 TrajectoryView 与 SessionList 的联动处。自动滚动用 scrollIntoView + smooth，注意 streaming 期间避免抖动。先读现有实现，再派三颗卫星分别核对状态迁移、渲染性能与无障碍语义。'
    },
    {
      id: 'ev-03',
      kind: 'instrument',
      at: T0 + 1000 * 22,
      tool: 'Read',
      argsSummary: 'src/components/TrajectoryView.tsx',
      status: 'done',
      durationMs: 320,
      output: '共 87 行：当前用单一 collapsed boolean 控制全部 Transmission 节点，groupByOrbit 每渲染一次全量重算。'
    },
    {
      id: 'ev-04',
      kind: 'instrument',
      at: T0 + 1000 * 24,
      tool: 'Edit',
      argsSummary: 'src/components/TrajectoryView.tsx (+12 −3)',
      status: 'done',
      durationMs: 540,
      output: 'collapsed → collapsedMap；新增 bottomRef 自动跟随；容器补 role="log" 与 aria-live="polite"。'
    },
    {
      id: 'ev-05',
      kind: 'instrument',
      at: T0 + 1000 * 26,
      tool: 'Bash',
      argsSummary: 'npx tsc --noEmit -p tsconfig.web.json',
      status: 'done',
      durationMs: 4_180,
      output: '零错误。'
    },
    {
      id: 'ev-06',
      kind: 'satellite',
      at: T0 + 1000 * 32,
      satelliteKind: 'coder',
      status: 'done',
      task: '把折叠状态迁移到 zustand store，保持 SessionList 与 TrajectoryView 同步',
      result: '已迁移：collapsedMap 入 store，两处订阅粒度收窄到事件 id。'
    },
    {
      id: 'ev-07',
      kind: 'satellite',
      at: T0 + 1000 * 32,
      satelliteKind: 'explore',
      status: 'done',
      task: '排查 streaming 期间 scrollIntoView 是否引发抖动',
      result: '每 token 触发一次 smooth 滚动会抖动；改为事件数变化时滚动一次即可。'
    },
    {
      id: 'ev-08',
      kind: 'satellite',
      at: T0 + 1000 * 32,
      satelliteKind: 'plan',
      status: 'done',
      task: '核对 aria-live 区域在月相切换时的朗读行为',
      result: 'aria-live="polite" 足够；月相 svg 需 aria-label，已一并补上。'
    },
    {
      id: 'ev-09',
      kind: 'approval',
      at: T0 + 1000 * 60 * 9,
      approvalId: MOCK_APPROVAL.id,
      tool: MOCK_APPROVAL.tool,
      detail: MOCK_APPROVAL.detail,
      diff: MOCK_APPROVAL.diff
    },
    {
      id: 'ev-10',
      kind: 'message',
      at: T0 + 1000 * 60 * 9 + 1000 * 4,
      markdown:
        '改造完成，等待地面站确认最后一次 Edit。\n\n```tsx\nconst [collapsedMap, setCollapsedMap] = useState<Record<string, boolean>>({})\n\nconst toggle = (id: string) =>\n  setCollapsedMap((m) => ({ ...m, [id]: !m[id] }))\n```\n\n三颗卫星均已归位：状态已入 store、滚动抖动已消除、朗读语义已核对。确认后我会补一条回归测试。'
    },
    {
      id: 'ev-11',
      kind: 'telemetry',
      at: T0 + 1000 * 60 * 9 + 1000 * 6,
      tokensPerSecond: 42.6,
      contextTokens: 128_410,
      inputTokens: 28_410,
      cachedInputTokens: 100_000,
      outputTokens: 6_200,
      cacheHitRate: 77.9,
      estimatedCostCny: 1.3882,
      inputCostCny: 0.5682,
      cachedInputCostCny: 0.2,
      outputCostCny: 0.62
    }
  ]
}

/** Sessions 栏演示用的其余会话（少事件，重在分组与月相分布）。 */
export const MOCK_SESSIONS: Session[] = [
  MOCK_SESSION,
  {
    id: 'session-2',
    title: '遥测页燃料环刻度对齐',
    project: 'farside',
    cwd: 'D:/Github/kode',
    phase: 'waning',
    model: 'kimi-for-coding-highspeed',
    updatedAt: T0 - 1000 * 60 * 42,
    contextTokens: 64_208,
    events: []
  },
  {
    id: 'session-3',
    title: 'Composer 权限档位文案校准',
    project: 'farside',
    cwd: 'D:/Github/kode',
    phase: 'gibbous',
    model: 'kimi-k3',
    updatedAt: T0 - 1000 * 60 * 95,
    contextTokens: 812_377,
    events: []
  },
  {
    id: 'session-4',
    title: '月相组件 reduced-motion 兜底',
    project: 'farside',
    cwd: 'D:/Github/kode',
    phase: 'new',
    model: 'kimi-for-coding',
    updatedAt: T0 - 1000 * 60 * 60 * 5,
    contextTokens: 9_860,
    events: []
  },
  {
    id: 'session-5',
    title: '官网落地页月弧动效降级方案',
    project: 'lunara-site',
    cwd: 'D:/Github/lunara-site',
    phase: 'first-quarter',
    model: 'kimi-k3',
    updatedAt: T0 - 1000 * 60 * 60 * 26,
    contextTokens: 47_530,
    events: []
  },
  {
    id: 'session-6',
    title: '迁移博客构建脚本到 vite',
    project: 'ground-station-blog',
    cwd: 'D:/Github/ground-station-blog',
    phase: 'waxing',
    model: 'kimi-for-coding',
    updatedAt: T0 - 1000 * 60 * 60 * 74,
    contextTokens: 21_004,
    events: []
  }
]
