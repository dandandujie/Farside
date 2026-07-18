import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

export interface KimiRuntime {
  command: string
  bundled: boolean
}

function runtimeName(): string {
  return process.platform === 'win32' ? 'kimi.exe' : 'kimi'
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 优先使用安装包内随附的 Kimi Code 单文件 runtime；开发环境使用 resources 下同一布局。
 * 仅在 runtime 未准备好时才回退系统 PATH，保证普通用户安装 Farside 后无需另装 CLI。
 */
export async function resolveKimiRuntime(): Promise<KimiRuntime> {
  const target = `${process.platform}-${process.arch}`
  const name = runtimeName()
  const explicit = process.env['FARSIDE_KIMI_BINARY']?.trim()
  const candidates = [
    explicit,
    join(process.resourcesPath, 'runtime', target, name),
    join(app.getAppPath(), 'resources', 'runtime', target, name)
  ].filter((value): value is string => Boolean(value))

  for (const command of [...new Set(candidates)]) {
    if (await executable(command)) return { command, bundled: true }
  }
  return { command: 'kimi', bundled: false }
}
