/**
 * 斜杠命令清单：Composer 补全与 CommandPalette 共用。
 * 只收录 Farside 桌面端真正实现了的命令；官方 CLI 独有、
 * 桌面端由对应设置页承担的命令分别见下方两个名单。
 * 每条带一句中文功能简述，地面站口吻。
 */
export interface SlashCommand {
  /** 不带斜杠 */
  name: string
  desc: string
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'login', desc: '前往设置登录 Kimi 账户' },
  { name: 'logout', desc: '断开链路，退出登录' },
  { name: 'provider', desc: '前往设置切换模型供应商' },
  { name: 'model', desc: '切换模型' },
  { name: 'settings', desc: '打开设置' },
  { name: 'permission', desc: '调整权限档位' },
  { name: 'theme', desc: '切换界面主题' },
  { name: 'new', desc: '新建会话' },
  { name: 'sessions', desc: '浏览历史会话' },
  { name: 'fork', desc: '从当前节点分叉新会话' },
  { name: 'title', desc: '重命名当前会话' },
  { name: 'compact', desc: '压缩上下文，回收燃料' },
  { name: 'undo', desc: '撤销上一轮操作' },
  { name: 'reload', desc: '重载当前会话' },
  { name: 'export', desc: '导出会话与诊断日志为 ZIP' },
  { name: 'yolo', desc: '切到放开档，全部自动批准' },
  { name: 'auto', desc: '切到自动档' },
  { name: 'plan', desc: '切换计划模式' },
  { name: 'swarm', desc: '派出并行子代理' },
  { name: 'goal', desc: '设定自主目标，长线巡航' },
  { name: 'help', desc: '查看全部指令' },
  { name: 'usage', desc: '查看配额用量' },
  { name: 'status', desc: '查看链路状态' },
  { name: 'mcp', desc: '管理 MCP 服务器' },
  { name: 'plugins', desc: '管理插件' },
  { name: 'mcp-config', desc: '编辑 mcp.json 配置' },
  { name: 'update-config', desc: '编辑 config.toml 配置' },
  { name: 'exit', desc: '关闭 Farside' }
]

/**
 * 官方 CLI 提供但 Farside 桌面端未实现的命令。用户手动输入时给出明确
 * 提示，而不是把命令文本当作普通提示词静默发送给模型。
 */
export const UNSUPPORTED_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  'experiments', 'tasks', 'init', 'add-dir', 'btw', 'version', 'feedback',
  'check-kimi-code-docs', 'import-from-cc-codex'
])
