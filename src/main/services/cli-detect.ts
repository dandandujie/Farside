import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CliStatus } from '@shared/ipc'
import { resolveKimiRuntime, type KimiRuntime } from './kimi-runtime'

const TIMEOUT_MS = 5_000

function run(command: string, bundled: boolean, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: TIMEOUT_MS,
        windowsHide: true,
        // Windows 上全局安装的 CLI 多为 .cmd shim，不经 shell 无法 execFile
        shell: process.platform === 'win32' && !bundled
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }
        const out = (stdout || stderr).trim()
        resolve(out)
      }
    )
  })
}

/**
 * 登录态兜底判定：~/.kimi-code/config.toml 存在视为已登录（登录时落盘），
 * 明确不存在视为未登录；其他读取异常保持「无法判定」。
 */
async function detectLoginByConfig(): Promise<boolean | null> {
  try {
    await fs.access(join(homedir(), '.kimi-code', 'config.toml'))
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null
  }
}

/**
 * 探测本机 kimi CLI：`kimi --version` 与登录态。
 * 任何一步失败都优雅降级，绝不抛出——渲染端据此展示「链路未建立」而非报错。
 */
export async function detectCli(resolvedRuntime?: KimiRuntime): Promise<CliStatus> {
  let runtime: KimiRuntime
  try {
    runtime = resolvedRuntime ?? await resolveKimiRuntime()
  } catch (error) {
    return {
      installed: false,
      loggedIn: null,
      error: error instanceof Error ? error.message : 'Kimi Code runtime 校验失败'
    }
  }
  let version: string
  try {
    version = await run(runtime.command, runtime.bundled, ['--version'])
  } catch (error) {
    return {
      installed: false,
      loggedIn: null,
      error: error instanceof Error ? error.message : 'kimi CLI 探测失败'
    }
  }

  // 登录态：先尽力而为地尝试 `kimi auth status`（CLI 尚无统一查询命令），
  // 命令不支持时回退到 config.toml 存在性判定；两者都不行就是 null。
  let loggedIn: boolean | null = null
  try {
    const out = await run(runtime.command, runtime.bundled, ['auth', 'status'])
    loggedIn = !/not\s+logged\s+in|unauthorized|未登录/i.test(out)
  } catch {
    loggedIn = await detectLoginByConfig()
  }

  return { installed: true, version, loggedIn, bundled: runtime.bundled }
}
