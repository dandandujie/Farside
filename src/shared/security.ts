const LOOPBACK_IPV4 = /^127(?:\.\d{1,3}){3}$/

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024
export const MAX_ATTACHMENT_COUNT = 8
export const MAX_PROMPT_CHARS = 200_000
export const MAX_FILE_REFERENCE_COUNT = 100

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized === '::1') {
    return true
  }
  if (!LOOPBACK_IPV4.test(normalized)) return false
  return normalized.split('.').every((part) => Number(part) <= 255)
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

export function normalizePreviewUrl(value: string): string | null {
  const raw = value.trim()
  if (!raw) return null
  const url = parseHttpUrl(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`)
  return url && isLoopbackHostname(url.hostname) ? url.href : null
}

export function isAllowedPreviewUrl(value: string): boolean {
  return normalizePreviewUrl(value) !== null
}

export function isAllowedExternalUrl(value: string): boolean {
  const url = parseHttpUrl(value)
  return Boolean(url && (url.protocol === 'https:' || isLoopbackHostname(url.hostname)))
}

export function isAllowedApiBaseUrl(value: string): boolean {
  const url = parseHttpUrl(value)
  if (!url || url.search || url.hash) return false
  return url.protocol === 'https:' || isLoopbackHostname(url.hostname)
}
