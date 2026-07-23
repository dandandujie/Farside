import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import runtimeLock from '../../../runtime.lock.json'
import { readAndVerifyRuntimeManifest, type RuntimeManifest } from './runtime-manifest'

export interface KimiRuntime {
  command: string
  bundled: boolean
  manifest: RuntimeManifest | null
}

const verifiedRuntimes = new Map<string, Promise<RuntimeManifest>>()

interface EmbeddedRuntime {
  enabled: boolean
  kind: 'official' | 'custom'
  version: string
  upstreamVersion: string
  apiVersion: number
  wsProtocolVersion: number
  source: {
    repository: string
    revision: string | null
    manifestUrl: string | null
  }
  artifacts: Record<string, { url: string; sha256: string } | undefined>
}

const embeddedRuntimeLock = runtimeLock as unknown as {
  schemaVersion: number
  runtime: EmbeddedRuntime
}
if (embeddedRuntimeLock.schemaVersion !== 2) throw new Error('应用内嵌 runtime lock schema 不受支持')
const embeddedRuntime = embeddedRuntimeLock.runtime

function assertManifestMatchesEmbeddedLock(manifest: RuntimeManifest): void {
  if (manifest.channel !== 'current' || !embeddedRuntime.enabled) {
    throw new Error('随包 runtime 不是 Farside 唯一的 current 运行时')
  }
  if (
    manifest.kind !== embeddedRuntime.kind ||
    manifest.version !== embeddedRuntime.version ||
    manifest.upstreamVersion !== embeddedRuntime.upstreamVersion ||
    manifest.apiVersion !== embeddedRuntime.apiVersion ||
    manifest.wsProtocolVersion !== embeddedRuntime.wsProtocolVersion ||
    manifest.source !== embeddedRuntime.source.repository ||
    manifest.revision !== embeddedRuntime.source.revision ||
    manifest.manifestUrl !== embeddedRuntime.source.manifestUrl
  ) {
    throw new Error('随包 runtime manifest 与应用内嵌锁文件不一致')
  }
  const artifact = embeddedRuntime.artifacts[manifest.target]
  if (!artifact) throw new Error(`应用锁文件缺少 ${manifest.target} runtime`)
  if (manifest.provenance !== 'local-copy') {
    if (
      manifest.sha256 !== artifact.sha256 ||
      manifest.lockedSha256 !== artifact.sha256 ||
      manifest.artifactUrl !== artifact.url
    ) {
      throw new Error('随包 runtime 与应用内嵌产物校验值不一致')
    }
  }
  if (app.isPackaged && manifest.provenance === 'local-copy') {
    throw new Error('正式安装包拒绝未在 runtime.lock.json 中登记的本地 Runtime')
  }
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
  if (explicit) {
    if (!(await executable(explicit))) throw new Error('FARSIDE_KIMI_BINARY 指向的文件不存在或不可执行')
    return { command: explicit, bundled: true, manifest: null }
  }

  const candidates = [
    join(process.resourcesPath, 'runtime', target, name),
    join(app.getAppPath(), 'resources', 'runtime', target, name)
  ]

  for (const command of [...new Set(candidates)]) {
    if (!(await executable(command))) continue
    let verification = verifiedRuntimes.get(command)
    if (!verification) {
      verification = readAndVerifyRuntimeManifest(command, target, name)
      verifiedRuntimes.set(command, verification)
    }
    try {
      const manifest = await verification
      assertManifestMatchesEmbeddedLock(manifest)
      return { command, bundled: true, manifest }
    } catch (error) {
      verifiedRuntimes.delete(command)
      throw error
    }
  }
  if (app.isPackaged) throw new Error('正式安装包内缺少 Kimi Code runtime，已拒绝回退系统 PATH')
  return { command: 'kimi', bundled: false, manifest: null }
}
