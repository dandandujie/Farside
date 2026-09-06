import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app, net, shell } from 'electron'
import type { AppReleaseHistory, AppReleaseInfo, AppUpdateInfo } from '@shared/ipc'

const RELEASE_API = 'https://api.github.com/repos/dandandujie/Farside/releases/latest'
const RELEASES_API = 'https://api.github.com/repos/dandandujie/Farside/releases?per_page=12'
const RELEASE_ROOT = 'https://github.com/dandandujie/Farside/releases/'
const RELEASE_LATEST = `${RELEASE_ROOT}latest`
const REQUEST_TIMEOUT_MS = 8_000
// 安装包远小于此值；上限只是防止异常响应撑爆磁盘。
const MAX_UPDATE_BYTES = 1024 * 1024 * 1024
// 下载停滞判定：连续这么久没有任何新字节即取消（弱网/断网自愈）。
const DOWNLOAD_STALL_TIMEOUT_MS = 60_000
const MAC_APP_BUNDLE = '/Applications/Farside.app'

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
  const extension =
    platform === 'win32' ? '.exe'
    : platform === 'darwin' ? '.dmg'
    : platform === 'linux' ? '.appimage'
    : null
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

function monitorMacInstallation(targetVersion: string): void {
  const script = `
bundle="$1"
target_version="$2"
app_pid="$3"
plist="$bundle/Contents/Info.plist"
app_binary="$bundle/Contents/MacOS/Farside"
app_archive="$bundle/Contents/Resources/app.asar"
attempt=0

while [ "$attempt" -lt 1800 ]; do
  if [ -f "$plist" ] && [ -x "$app_binary" ] && [ -f "$app_archive" ]; then
    installed_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist" 2>/dev/null || true)
    installed_size=$(/usr/bin/du -sk "$bundle" 2>/dev/null | /usr/bin/awk '{print $1}')
    if [ "$installed_version" = "$target_version" ] && [ -n "$installed_size" ]; then
      # GOTCHA: Finder 可能先复制 Info.plist；体积稳定后再修改属性和重启。
      /bin/sleep 2
      confirmed_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist" 2>/dev/null || true)
      confirmed_size=$(/usr/bin/du -sk "$bundle" 2>/dev/null | /usr/bin/awk '{print $1}')
      if [ "$confirmed_version" != "$target_version" ] || [ "$confirmed_size" != "$installed_size" ]; then
        attempt=$((attempt + 1))
        continue
      fi

      /usr/bin/xattr -r -d com.apple.quarantine "$bundle" >/dev/null 2>&1 || true
      if /usr/bin/xattr -lr "$bundle" 2>/dev/null | /usr/bin/grep -q 'com.apple.quarantine'; then
        /usr/bin/osascript \
          -e 'on run argv' \
          -e 'do shell script "/usr/bin/xattr -r -d com.apple.quarantine " & quoted form of item 1 of argv with administrator privileges' \
          -e 'end run' \
          "$bundle" >/dev/null 2>&1 || exit 2
      fi

      /bin/kill -TERM "$app_pid" 2>/dev/null || true
      wait_attempt=0
      while /bin/kill -0 "$app_pid" 2>/dev/null && [ "$wait_attempt" -lt 50 ]; do
        /bin/sleep 0.1
        wait_attempt=$((wait_attempt + 1))
      done
      /usr/bin/open -n "$bundle"
      exit 0
    fi
  fi
  /bin/sleep 1
  attempt=$((attempt + 1))
done
`
  // WHY: DMG 拖拽安装没有完成回调。独立系统进程确认目标版本复制完成，
  // 清除 quarantine（必要时请求管理员授权），再关闭旧进程并拉起新版本。
  const monitor = spawn('/bin/sh', [
    '-c',
    script,
    'farside-update-monitor',
    MAC_APP_BUNDLE,
    targetVersion,
    String(process.pid)
  ], {
    detached: true,
    stdio: 'ignore'
  })
  monitor.once('error', () => {
    // 安装包已经打开；监视器失败时仍可由用户手动完成安装。
  })
  monitor.unref()
}

/** 仅负责官方 Farside GitHub Release；网络失败时静默降级为“无可用更新”。 */
export class UpdateService {
  private lastOpenUrl: string | null = null
  private lastAsset: { url: string; name: string; version: string } | null = null
  private historyCache: { at: number; releases: AppReleaseInfo[] } | null = null

  async check(currentVersion: string): Promise<AppUpdateInfo> {
    let primaryError = ''
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
      if (!response.ok) throw new Error(`GitHub Release API 返回 HTTP ${response.status}`)

      const release = await response.json() as GitHubRelease
      if (release.draft === true || release.prerelease === true || typeof release.tag_name !== 'string') {
        throw new Error('GitHub Release API 未返回可发布的稳定版本')
      }
      const latestVersion = release.tag_name.replace(/^v/i, '')
      if (!isNewerVersion(latestVersion, currentVersion)) {
        return { updateAvailable: false, currentVersion, latestVersion }
      }
      if (typeof release.html_url !== 'string' || !isTrustedReleaseUrl(release.html_url)) {
        throw new Error('GitHub Release 返回了未通过校验的地址')
      }

      const assets = Array.isArray(release.assets) ? release.assets as GitHubAsset[] : []
      const asset = selectAsset(assets, process.platform, process.arch)
      const assetUrl = typeof asset?.browser_download_url === 'string' ? asset.browser_download_url : null
      this.lastOpenUrl = assetUrl ?? release.html_url
      this.lastAsset = assetUrl && typeof asset?.name === 'string'
        ? { url: assetUrl, name: asset.name, version: latestVersion }
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
    } catch (error) {
      primaryError = error instanceof Error ? error.message : 'GitHub Release API 检查失败'
    }

    // WHY: GitHub API 可能被企业网络拦截或触发匿名限流；/releases/latest 的
    // 302 最终地址仍能提供可信版本号，至少不能因此让旧客户端永远收不到更新。
    try {
      const response = await net.fetch(RELEASE_LATEST, {
        headers: {
          'User-Agent': `Farside/${currentVersion}`,
          'Cache-Control': 'no-cache'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      if (!response.ok || !isTrustedReleaseUrl(response.url)) {
        throw new Error(`GitHub Release 页面返回 HTTP ${response.status}`)
      }
      const match = new URL(response.url).pathname.match(/\/releases\/tag\/v?([^/?#]+)$/i)
      const latestVersion = match?.[1] ? decodeURIComponent(match[1]) : ''
      if (!latestVersion || !parseVersion(latestVersion)) {
        throw new Error('无法从 GitHub Release 页面识别版本号')
      }
      if (!isNewerVersion(latestVersion, currentVersion)) {
        return { updateAvailable: false, currentVersion, latestVersion }
      }
      this.lastOpenUrl = response.url
      this.lastAsset = null
      return {
        updateAvailable: true,
        currentVersion,
        latestVersion,
        releaseName: `Farside v${latestVersion}`
      }
    } catch (error) {
      const fallbackError = error instanceof Error ? error.message : 'GitHub Release 页面检查失败'
      return {
        updateAvailable: false,
        currentVersion,
        error: `${primaryError}；${fallbackError}`
      }
    }
  }

  async history(): Promise<AppReleaseHistory> {
    if (this.historyCache && Date.now() - this.historyCache.at < 5 * 60_000) {
      return { ok: true, releases: this.historyCache.releases }
    }
    try {
      const response = await net.fetch(RELEASES_API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': `Farside/${app.getVersion()}`,
          'Cache-Control': 'no-cache'
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      if (!response.ok) {
        throw new Error(`GitHub Release 历史返回 HTTP ${response.status}`)
      }
      const payload = await response.json() as unknown
      if (!Array.isArray(payload)) throw new Error('GitHub Release 历史响应格式无效')
      const releases = payload
        .filter((item): item is GitHubRelease => typeof item === 'object' && item !== null)
        .filter((release) =>
          release.draft !== true &&
          typeof release.tag_name === 'string' &&
          typeof release.html_url === 'string' &&
          isTrustedReleaseUrl(release.html_url)
        )
        .map((release): AppReleaseInfo => ({
          version: (release.tag_name as string).replace(/^v/i, '').slice(0, 80),
          name: typeof release.name === 'string' ? release.name.slice(0, 160) : undefined,
          notes: typeof release.body === 'string' ? release.body.slice(0, 20_000) : undefined,
          publishedAt: typeof release.published_at === 'string' ? release.published_at : undefined,
          url: release.html_url as string,
          prerelease: release.prerelease === true
        }))
      this.historyCache = { at: Date.now(), releases }
      return { ok: true, releases }
    } catch (error) {
      return {
        ok: false,
        releases: this.historyCache?.releases ?? [],
        error: error instanceof Error ? error.message : '更新历史读取失败'
      }
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
        const readWithWatchdog = () => {
          let timer: NodeJS.Timeout | undefined
          return Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('安装包下载停滞，已取消（连接 60 秒无进展）')),
                DOWNLOAD_STALL_TIMEOUT_MS
              )
            })
          ]).finally(() => clearTimeout(timer))
        }
        for (;;) {
          const { done, value } = await readWithWatchdog()
          if (done) break
          if (!value) continue
          received += value.byteLength
          if (received > MAX_UPDATE_BYTES) throw new Error('安装包体积异常，已取消下载')
          await handle.write(value)
          onProgress?.(received, total)
        }
      } catch (error) {
        // 任何中断都清掉半截安装包，避免下次误开
        await fs.rm(filePath, { force: true }).catch(() => undefined)
        throw error
      } finally {
        await handle.close()
      }
      if (total > 0 && received !== total) {
        await fs.rm(filePath, { force: true })
        return { ok: false, error: '安装包下载不完整，请重试' }
      }

      const openError = await shell.openPath(filePath)
      if (openError) return { ok: false, error: `安装包已下载但无法打开：${openError}` }
      if (process.platform === 'darwin') {
        monitorMacInstallation(asset.version)
      } else if (process.platform === 'win32') {
        // NSIS 需在当前进程退出后替换文件，并会按 runAfterFinish 拉起新版本。
        setTimeout(() => app.quit(), 750)
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '安装包下载失败' }
    }
  }
}
