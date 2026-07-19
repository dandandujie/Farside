import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

const BLOCKED_OPEN_EXTENSIONS = new Set([
  '.apk', '.app', '.application', '.appref-ms', '.appx', '.appxbundle', '.bat', '.chm', '.cmd',
  '.com', '.command', '.cpl', '.deb', '.desktop', '.dmg', '.docm', '.dotm', '.exe', '.gadget',
  '.hta', '.inf', '.ins', '.iso', '.jar', '.js', '.jse', '.lnk', '.msc', '.msi', '.msix',
  '.msixbundle', '.msp', '.mst', '.pif', '.pl', '.potm', '.ppam', '.ppsm', '.pptm', '.ps1',
  '.pkg', '.py', '.pyw', '.rb', '.reg', '.rpm', '.scf', '.scr', '.settingcontent-ms', '.sh',
  '.sldm', '.url', '.vb', '.vbe', '.vbs', '.ws', '.wsc', '.wsf', '.wsh', '.xlsm', '.xltm'
])

export function isPathWithin(root: string, candidate: string): boolean {
  if (!root || !candidate || !isAbsolute(root) || !isAbsolute(candidate)) return false
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export function isSafeOpenTarget(path: string): boolean {
  return !BLOCKED_OPEN_EXTENSIONS.has(extname(path).toLowerCase())
}

export function isTrustedRendererUrl(value: string, expected: string): boolean {
  try {
    const current = new URL(value)
    const trusted = new URL(expected)
    if (trusted.protocol === 'file:') {
      const currentPath = process.platform === 'win32' ? current.pathname.toLowerCase() : current.pathname
      const trustedPath = process.platform === 'win32' ? trusted.pathname.toLowerCase() : trusted.pathname
      return current.protocol === 'file:' && current.hostname === trusted.hostname && currentPath === trustedPath
    }
    return current.protocol === trusted.protocol && current.origin === trusted.origin
  } catch {
    return false
  }
}

export function sanitizeZipFileName(value: string, fallback: string): string {
  const leaf = value.replace(/\0/g, '').split(/[\\/]/).pop()?.trim() || fallback
  const cleaned = leaf.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 180)
  const safe = cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback
  return safe.toLowerCase().endsWith('.zip') ? safe : `${safe}.zip`
}
