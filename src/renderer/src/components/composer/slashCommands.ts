/**
 * 斜杠命令清单：Composer 补全与 CommandPalette 共用（与官方 CLI 对齐）。
 * 每条带一句中文功能简述，地面站口吻。
 */
export interface SlashCommand {
  /** 不带斜杠 */
  name: string
  desc: string
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'login', desc: '登录账号，建立链路' },
  { name: 'logout', desc: '断开链路，退出登录' },
  { name: 'provider', desc: '切换模型供应商' },
  { name: 'model', desc: '切换模型' },
  { name: 'settings', desc: '打开设置' },
  { name: 'experiments', desc: '查看实验功能' },
  { name: 'permission', desc: '调整权限档位' },
  { name: 'theme', desc: '切换界面主题' },
  { name: 'new', desc: '新建会话' },
  { name: 'sessions', desc: '浏览历史会话' },
  { name: 'tasks', desc: '查看后台任务' },
  { name: 'fork', desc: '从当前节点分叉新会话' },
  { name: 'title', desc: '重命名当前会话' },
  { name: 'compact', desc: '压缩上下文，回收燃料' },
  { name: 'undo', desc: '撤销上一轮操作' },
  { name: 'reload', desc: '重载当前会话' },
  { name: 'init', desc: '生成项目指引文件 AGENTS.md' },
  { name: 'export', desc: '导出会话与诊断日志为 ZIP' },
  { name: 'add-dir', desc: '追加工作目录' },
  { name: 'yolo', desc: '切到放开档，全部自动批准' },
  { name: 'auto', desc: '切到自动档' },
  { name: 'plan', desc: '切换计划模式' },
  { name: 'swarm', desc: '派出并行子代理' },
  { name: 'goal', desc: '设定自主目标，长线巡航' },
  { name: 'help', desc: '查看全部指令' },
  { name: 'btw', desc: '补一句旁注，不中断当前任务' },
  { name: 'usage', desc: '查看配额用量' },
  { name: 'status', desc: '查看链路状态' },
  { name: 'mcp', desc: '管理 MCP 服务器' },
  { name: 'plugins', desc: '管理插件' },
  { name: 'version', desc: '查看版本号' },
  { name: 'feedback', desc: '提交使用反馈' },
  { name: 'exit', desc: '关闭 Farside' },
  { name: 'mcp-config', desc: '编辑 MCP 配置' },
  { name: 'update-config', desc: '编辑 config.toml 配置' },
  { name: 'check-kimi-code-docs', desc: '查阅 Kimi Code 官方文档' },
  { name: 'import-from-cc-codex', desc: '从 Claude Code / Codex 迁移配置' }
]
