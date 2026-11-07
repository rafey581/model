/**
 * Site URL and player-APK URL.
 *
 * Empty means "not configured". A configured value is checked here so the build
 * cannot emit a localhost or example.com canonical, and cannot link the staff app.
 * Lenient mode (the browser, reading a replaced site-config.json) drops a bad
 * value and records a warning. Strict mode (the build) throws.
 */

export interface SiteConfigInput {
  siteUrl?: unknown
  apkUrl?: unknown
}

export interface SiteConfig {
  siteUrl: string | null
  apkUrl: string | null
  warnings: readonly string[]
}

interface Parsed {
  value: string | null
  error: string | null
}

const BLOCKED_EXACT = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  'example.com',
  'example.org',
  'example.net'
])

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (BLOCKED_EXACT.has(host)) return true
  if (host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host.endsWith('.example.com') || host.endsWith('.example.org') || host.endsWith('.example.net')) return true
  if (host.endsWith('.test') || host.endsWith('.invalid')) return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  return false
}

function readUrl(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

export function parseSiteUrl(raw: string): Parsed {
  const trimmed = raw.trim()
  if (!trimmed) return { value: null, error: null }
  const url = readUrl(trimmed)
  if (!url) return { value: null, error: 'siteUrl is not a valid URL.' }
  if (url.username || url.password) return { value: null, error: 'siteUrl must not include a username or password.' }
  if (url.protocol !== 'https:') return { value: null, error: 'siteUrl must use https.' }
  if (isBlockedHost(url.hostname)) {
    return { value: null, error: 'siteUrl must be the real public origin, not localhost, an IP, or an example domain.' }
  }
  if (url.search || url.hash) return { value: null, error: 'siteUrl must be the origin only, with no query or hash.' }
  if (url.pathname !== '/' && url.pathname !== '') {
    return { value: null, error: 'siteUrl must be the origin only, for example https://play.yourdomain.' }
  }
  return { value: url.origin, error: null }
}

const STAFF_MARKERS = ['snookerarena', 'com.snookerarena', 'admin-app', 'snooker-admin', 'snookeradmin']

export function parseApkUrl(raw: string): Parsed {
  const trimmed = raw.trim()
  if (!trimmed) return { value: null, error: null }
  if (trimmed.length > 2000) return { value: null, error: 'apkUrl is too long.' }
  const url = readUrl(trimmed)
  if (!url) return { value: null, error: 'apkUrl is not a valid URL.' }
  if (url.username || url.password) return { value: null, error: 'apkUrl must not include a username or password.' }
  if (url.protocol !== 'https:') return { value: null, error: 'apkUrl must use https.' }
  if (isBlockedHost(url.hostname)) {
    return { value: null, error: 'apkUrl must be a public https file, not localhost, an IP, or an example domain.' }
  }
  if (!url.pathname.toLowerCase().endsWith('.apk')) {
    return { value: null, error: 'apkUrl must point at a file whose path ends in .apk.' }
  }
  const haystack = `${url.hostname}${url.pathname}`.toLowerCase()
  if (STAFF_MARKERS.some((marker) => haystack.includes(marker))) {
    return {
      value: null,
      error: 'apkUrl looks like the staff app. Refusing to link it. Publish the player APK for com.snookerx.game.'
    }
  }
  return { value: url.toString(), error: null }
}

function asString(value: unknown, key: string): Parsed {
  if (value === undefined || value === null) return { value: '', error: null }
  if (typeof value !== 'string') return { value: '', error: `${key} must be a string.` }
  return { value, error: null }
}

export function resolveSiteConfig(input: SiteConfigInput, opts?: { strict?: boolean }): SiteConfig {
  const siteRaw = asString(input.siteUrl, 'siteUrl')
  const apkRaw = asString(input.apkUrl, 'apkUrl')
  const site = siteRaw.error ? { value: null, error: siteRaw.error } : parseSiteUrl(siteRaw.value ?? '')
  const apk = apkRaw.error ? { value: null, error: apkRaw.error } : parseApkUrl(apkRaw.value ?? '')
  const warnings = [site.error, apk.error].filter((item): item is string => Boolean(item))
  if (opts?.strict && warnings.length > 0) {
    throw new Error(warnings.join(' '))
  }
  return {
    siteUrl: site.error ? null : site.value,
    apkUrl: apk.error ? null : apk.value,
    warnings
  }
}

/** JSON written to dist/site-config.json. Blank strings mean "not set". */
export function publicConfigJson(config: SiteConfig): string {
  return `${JSON.stringify({ siteUrl: config.siteUrl ?? '', apkUrl: config.apkUrl ?? '' }, null, 2)}\n`
}
