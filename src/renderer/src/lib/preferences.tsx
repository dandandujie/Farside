import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type AppLocale = 'zh-CN' | 'en-US'
export type AppTheme = 'dark' | 'light'

const EN: Record<string, string> = {
  '会话': 'Sessions', '终端': 'Terminal', '目标': 'Goals', '设置': 'Settings',
  '账户': 'Account', '扩展中心': 'Extensions', '配置文件': 'Configuration', '偏好与权限': 'Preferences & permissions', '关于': 'About',
  'Provider 与用量': 'Provider & usage', '磁盘双向同步': 'Two-way disk sync', '链路 · 快捷键': 'Runtime · Shortcuts', '版本与运行时': 'Version & runtime',
  '设置控制中心': 'Settings control center', '账户、扩展与磁盘配置分区管理': 'Account, extensions, and disk configuration',
  '界面外观': 'Appearance', '语言': 'Language', '主题': 'Theme', '中文': 'Chinese', '英文': 'English', '暗黑': 'Dark', '明亮': 'Light',
  '默认使用中文与暗黑主题，偏好会保存在本机。': 'Chinese and dark mode are the defaults. Preferences are saved on this device.',
  '内置运行时': 'Bundled runtime', '系统运行时': 'System runtime', '浏览器预览': 'Browser preview', '已安装': 'Installed', '版本未知': 'Unknown version', '未检测到': 'Not detected',
  '登录态': 'Sign-in', '已登录': 'Signed in', '未登录': 'Signed out', '无法判定': 'Unknown', '桌面端': 'Desktop', '运行时': 'Runtime',
  '读类工具自动放行，写入与执行逐项确认。': 'Read operations are allowed; writes and commands require confirmation.',
  '自动处理审批，适合可信工作区。': 'Approvals are handled automatically in trusted workspaces.',
  '跳过常规审批，请只在隔离环境使用。': 'Skips routine approvals. Use only in isolated environments.',
  '命令面板': 'Command palette', '切换侧栏': 'Toggle sidebar', '切换任务面板': 'Toggle mission panel', '计划模式': 'Plan mode', '中断当前任务': 'Abort current task',
  '账户与接入': 'Account & providers', 'OAuth 用量、官方 API 与 OpenAI 兼容服务集中管理': 'Manage OAuth usage, official API, and OpenAI-compatible services',
  '刷新中…': 'Refreshing…', '刷新账户': 'Refresh account', '尚未配置': 'Not configured', '官方套餐与升级 ↗': 'Plans & upgrade ↗',
  '5 小时窗口': '5-hour window', '周周期': 'Weekly cycle', '重置时间未知': 'Reset time unknown', '剩余': 'Remaining',
  'API Key 接入不提供会员周期读数；Kimi OAuth 可显示套餐和限额。': 'API-key providers do not expose subscription windows; Kimi OAuth shows plan and limits.',
  '发现市场': 'Marketplace', '从发现、安装到启停和移除的完整闭环': 'Discover, install, enable, disable, and remove extensions',
  '在资源管理器中打开': 'Open in Explorer', '系统中打开': 'Open on disk', '保存': 'Save', '未保存改动': 'Unsaved changes',
  '本地文件与编辑器双向热同步；外部修改会自动载入': 'Two-way live sync with local files; external edits load automatically',
  'Provider、模型与 Kimi Code 运行参数': 'Provider, model, and Kimi Code runtime settings',
  '用户级 MCP Server 原始配置': 'Raw user-level MCP Server configuration', '所有项目继承的全局 Agent 指令': 'Global Agent instructions inherited by every project',
  '当前链路状态与键盘控制，一屏完成核对': 'Runtime status, appearance, permissions, and keyboard controls',
  '为 Kimi Code 打造的桌面 Agent 工作台': 'A desktop Agent workbench built for Kimi Code', '月之暗面 · Kimi Code 桌面端': 'Moonshot AI · Kimi Code desktop',
  '新项目': 'New project', '搜索项目或会话…': 'Search projects or sessions…', '暂无项目': 'No projects yet', '暂无会话': 'No sessions yet',
  '置顶': 'Pin', '取消置顶': 'Unpin', '归档': 'Archive', '重命名': 'Rename', '移除': 'Remove', '在资源管理器中打开项目': 'Open project in Explorer',
  '向月背发送指令…  / 斜杠命令 · @ 引用文件 · 拖入图片或视频': 'Send an instruction…  / commands · @ file references · drop images or video',
  '模型选择': 'Select model', '添加附件': 'Add attachment', '添加图片或视频附件': 'Add image or video attachment', '发送': 'Send', '信号传输中': 'Transmitting',
  '计划': 'Plan', '权限档位：逐项批准 → 自动 → 放开': 'Permissions: Manual → Auto → YOLO',
  '轨道尚未建立，发出第一条指令。': 'No trajectory yet. Send the first instruction.', '已处理': 'Processed', '分析了请求': 'Analyzed the request',
  '运行了命令': 'Ran a command', '深空思考': 'Thinking', '调用详情': 'Call details', '查看调用详情': 'View call details',
  '运行中': 'Running', '完成': 'Done', '失败': 'Failed', '链路警告': 'Runtime warning',
  '时长未知': 'Duration unknown',
  '系统提醒': 'System reminder', '运行时通知': 'Runtime notification', '环境上下文': 'Environment context', '权限上下文': 'Permission context', 'App 上下文': 'App context', '协作上下文': 'Collaboration context', '能力上下文': 'Capability context', '插件推荐': 'Plugin recommendations', '项目指令': 'Project instructions',
  '入轨中': 'Launching', '在轨': 'In orbit', '已归位': 'Returned', '信号丢失': 'Signal lost', '同步了': 'Synced', '条运行上下文': 'runtime context items', '个子代理参与处理': 'subagents participated',
  '5 小时': '5 hours', '周限额': 'Weekly limit',
  '账户与用量': 'Account & usage', '尚未登录': 'Not signed in', '选择 Provider 以连接 Kimi': 'Choose a Provider to connect Kimi', '刷新': 'Refresh', '退出': 'Sign out', '账户设置': 'Account settings',
  '最小化': 'Minimize', '最大化': 'Maximize', '关闭': 'Close'
  , '登录账号，建立链路': 'Sign in and establish a connection', '断开链路，退出登录': 'Disconnect and sign out', '切换模型供应商': 'Switch model provider', '切换模型': 'Switch model', '打开设置': 'Open settings', '查看实验功能': 'View experiments', '调整权限档位': 'Change permissions', '切换界面主题': 'Switch theme', '新建会话': 'New session', '浏览历史会话': 'Browse session history', '查看后台任务': 'View background tasks', '从当前节点分叉新会话': 'Fork from the current point', '重命名当前会话': 'Rename current session'
  , '可视化维护用户级 mcp.json；运行态来自 Kimi Server。': 'Visually manage user-level mcp.json; runtime status comes from Kimi Server.', '取消': 'Cancel', '+ 添加 MCP': '+ Add MCP', '唯一名称': 'Unique name', '参数，每行一个': 'Arguments, one per line', '待连接': 'Pending', '尚未添加 MCP Server': 'No MCP Servers added',
  '安装': 'Install', '安装中…': 'Installing…', 'GitHub owner/repo、仓库 URL 或本地 Skill 目录': 'GitHub owner/repo, repository URL, or local Skill directory', 'GitHub owner/repo、仓库 URL 或本地 Plugin 目录': 'GitHub owner/repo, repository URL, or local Plugin directory',
  '+ 新建 Skill': '+ New Skill', '取消新建': 'Cancel', '何时使用这个 Skill': 'When should this Skill be used?', '创建': 'Create', '自动调用': 'Auto invoke', '删除': 'Delete', '没有发现用户 Skill': 'No user Skills found',
  '第三方插件可执行代码。安装前请确认来源可信；Farside 会复制到 Kimi 官方 managed 目录。': 'Third-party plugins can execute code. Verify the source before installation; Kimi manages the installed copy.', '尚未安装 Plugin': 'No Plugins installed',
  '搜索扩展，例如 browser automation': 'Search extensions, e.g. browser automation', '跨市场搜索 ↗': 'Search marketplaces ↗', '市场只负责发现。安装仍需在 MCP、Skills 或 Plugins 标签中确认来源，避免未经审查的代码直接进入 Agent 环境。': 'Marketplaces are for discovery. Confirm the source in the MCP, Skills, or Plugins tab before installing code into the Agent environment.',
  'Model Context Protocol 官方注册表': 'Official Model Context Protocol registry', 'MCP Server 发现与配置': 'Discover and configure MCP Servers', '扩展索引与 MCP 目录': 'Extension index and MCP directory', '开放 Agent Skill 市场': 'Open Agent Skill marketplace', '社区 Agent Skill 仓库': 'Community Agent Skill repositories', 'Kimi 官方市场': 'Kimi official marketplace', '由 Kimi /plugins marketplace 提供': 'Powered by Kimi /plugins marketplace'
}

interface PreferencesValue {
  locale: AppLocale
  theme: AppTheme
  setLocale: (locale: AppLocale) => void
  setTheme: (theme: AppTheme) => void
  t: (source: string) => string
}

const PreferencesContext = createContext<PreferencesValue | null>(null)

function readLocale(): AppLocale {
  const shot = new URLSearchParams(window.location.search).get('shot')
  if (shot === 'settings-light') return 'en-US'
  if (shot) return 'zh-CN'
  return localStorage.getItem('farside:locale') === 'en-US' ? 'en-US' : 'zh-CN'
}

function readTheme(): AppTheme {
  const shot = new URLSearchParams(window.location.search).get('shot')
  if (shot === 'settings-light') return 'light'
  if (shot) return 'dark'
  return localStorage.getItem('farside:theme') === 'light' ? 'light' : 'dark'
}

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(readLocale)
  const [theme, setThemeState] = useState<AppTheme>(readTheme)

  useEffect(() => {
    document.documentElement.lang = locale
    localStorage.setItem('farside:locale', locale)
  }, [locale])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    localStorage.setItem('farside:theme', theme)
  }, [theme])

  const t = useCallback((source: string) => locale === 'en-US' ? EN[source] ?? source : source, [locale])
  const value = useMemo(() => ({ locale, theme, setLocale: setLocaleState, setTheme: setThemeState, t }), [locale, theme, t])
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>
}

export function usePreferences(): PreferencesValue {
  const value = useContext(PreferencesContext)
  if (!value) throw new Error('usePreferences must be used inside PreferencesProvider')
  return value
}
