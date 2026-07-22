import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app, net, shell } from 'electron'
import type { AppUpdateInfo } from '@shared/ipc'

const RELEASE_API = 'https://api.github.com/repos/dandandujie/Farside/releases/latest'
const RELEASE_ROOT = 'https://github.com/dandandujie/Farside/releases/'
const REQUEST_TIMEOUT_MS = 8_000
// 安装包远小于此值；上限只是防止异常响应撑爆磁盘。
const MAX_UPDATE_BYTES = 1024 * 1024 * 1024

interface GitHubAsset {
  name?: unknown
  browser_download_url?: unknown
}

interface GitHubRelease {
  tag_name?: unknown
  name?: unknown
  body?: unknown
  html_url?: unknown
  published_at?: unknown
  draft?: unknown
  prerelease?: unknown
  assets?: unknown
}

interface ParsedVersion {
  core: number[]
  prerelease: boolean
}

function parseVersion(value: string): ParsedVersion | null {
  const match = value.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  return {
    core: [match[1], match[2] ?? '0', match[3] ?? '0', match[4] ?? '0'].map(Number),
    prerelease: Boolean(match[5])
  }
}

function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate)
  const installed = parseVersion(current)
  if (!next || !installed) return false
  for (let index = 0; index < next.core.length; index += 1) {
    if (next.core[index] !== installed.core[index]) {
      return next.core[index] > installed.core[index]
    }
  }
  return installed.prerelease && !next.prerelease
}

function isTrustedReleaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.href.startsWith(RELEASE_ROOT)
  } catch {
    return false
  }
}

function selectAsset(assets: GitHubAsset[], platform: NodeJS.Platform, arch: string): GitHubAsset | undefined {
  const extension = platform === 'win32' ? '.exe' : platform === 'darwin' ? '.dmg' : null
  if (!extension) return undefined
  const candidates = assets.filter((asset) =>
    typeof asset.name === 'string' &&
    typeof asset.browser_download_url === 'string' &&
    asset.name.toLowerCase().endsWith(extension) &&
    isTrustedReleaseUrl(asset.browser_download_url)
  )
  const architectureMatch = candidates.find((asset) =>
    typeof asset.name === 'string' && asset.name.toLowerCase().includes(arch.toLowerCase())
  )
  if (architectureMatch) return architectureMatch
  const hasArchitectureSpecificAsset = candidates.some((asset) =>
    typeof asset.name === 'string' && /(?:arm64|aarch64|x64|x86_64)/i.test(asset.name)
  )
  return hasArchitectureSpecificAsset ? undefined : candidates[0]
}

/** 仅负责官方 Farside GitHub Release；网络失败时静默降级为“无可用更新”。 */
export class UpdateService {
  private lastOpenUrl: string | null = null
  private lastAsset: { url: string; name: string } | null = null

  async check(currentVersion: string): Promise<AppUpdateInfo> {
    const fallback: AppUpdateInfo = { updateAvailable: false, currentVersion }
    try {
      const response = await net.fetch(RELEASE_API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': `Farside/${currentVersion}`,
          'Cache-Control': 'no-cache'
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      if (!response.ok) return fallback

      const release = await response.json() as GitHubRelease
      if (release.draft === true || release.prerelease === true || typeof release.tag_name !== 'string') {
        return fallback
      }
      const latestVersion = release.tag_name.replace(/^v/i, '')
      if (!isNewerVersion(latestVersion, currentVersion)) return fallback
      if (typeof release.html_url !== 'string' || !isTrustedReleaseUrl(release.html_url)) return fallback

      const assets = Array.isArray(release.assets) ? release.assets as GitHubAsset[] : []
      const asset = selectAsset(assets, process.platform, process.arch)
      const assetUrl = typeof asset?.browser_download_url === 'string' ? asset.browser_download_url : null
      this.lastOpenUrl = assetUrl ?? release.html_url
      this.lastAsset = assetUrl && typeof asset?.name === 'string'
        ? { url: assetUrl, name: asset.name }
        : null

      return {
        updateAvailable: true,
        currentVersion,
        latestVersion,
        releaseName: typeof release.name === 'string' ? release.name.slice(0, 160) : undefined,
        releaseNotes: typeof release.body === 'string' ? release.body.slice(0, 12_000) : undefined,
        publishedAt: typeof release.published_at === 'string' ? release.published_at : undefined,
        assetName: typeof asset?.name === 'string' ? asset.name : undefined
      }
    } catch {
      return fallback
    }
  }

  async open(): Promise<{ ok: boolean; error?: string }> {
    if (!this.lastOpenUrl || !isTrustedReleaseUrl(this.lastOpenUrl)) {
      return { ok: false, error: '没有可打开的已校验更新地址' }
    }
    try {
      await shell.openExternal(this.lastOpenUrl)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '无法打开更新地址' }
    }
  }

  /**
   * 应用内直接下载最近一次校验过的安装包并自动打开，不经过浏览器。
   * 只接受 check() 校验过的 GitHub Release 资产地址，流式落盘，不整包读进内存。
   */
  async download(
    onProgress?: (received: number, total: number) => void
  ): Promise<{ ok: boolean; error?: string }> {
    const asset = this.lastAsset
    if (!asset || !isTrustedReleaseUrl(asset.url)) {
      return { ok: false, error: '没有可下载的已校验安装包' }
    }
    try {
      const response = await net.fetch(asset.url, {
        headers: { 'User-Agent': `Farside/${app.getVersion()}` }
      })
      if (!response.ok || !response.body) {
        return { ok: false, error: `安装包下载失败（HTTP ${response.status}）` }
      }
      const total = Number(response.headers.get('content-length')) || 0
      if (total > MAX_UPDATE_BYTES) return { ok: false, error: '安装包体积异常，已取消下载' }

      const safeName = asset.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '')
      if (!safeName) return { ok: false, error: '安装包文件名无效' }
      const dir = join(app.getPath('temp'), 'farside-update')
      await fs.mkdir(dir, { recursive: true })
      const filePath = join(dir, safeName)

      const handle = await fs.open(filePath, 'w')
      let received = 0
      try {
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value) continue
          received += value.byteLength
          if (received > MAX_UPDATE_BYTES) throw new Error('安装包体积异常，已取消下载')
          await handle.write(value)
          onProgress?.(received, total)
        }
      } finally {
        await handle.close()
      }
      if (total > 0 && received !== total) {
        await fs.rm(filePath, { force: true })
        return { ok: false, error: '安装包下载不完整，请重试' }
      }

      const openError = await shell.openPath(filePath)
      if (openError) return { ok: false, error: `安装包已下载但无法打开：${openError}` }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '安装包下载失败' }
    }
  }
}
