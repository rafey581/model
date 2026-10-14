/**
 * Where the app finds the game server.
 *
 * Kept as a pure function (no `expo-constants`, no globals) so the resolution
 * rules - explicit override, then the Expo dev host, then localhost - can be
 * tested without a device. `config.ts` is the thin adapter that supplies the
 * environment values.
 */

/** Drops trailing slashes so `.../api/` and `.../api` cannot both end up in a URL. */
export function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * Turns the Expo dev server's `host:port` (for example `192.168.1.10:8081`) into
 * just the host. The game server runs on the same machine as Metro, so reaching
 * that host on port 4000 is what makes a physical phone work without anyone
 * typing an IP by hand.
 */
export function hostFromUri(hostUri: string | null | undefined): string | null {
  if (!hostUri) return null
  const host = hostUri.trim().split(':')[0]
  return host.length > 0 ? host : null
}

export const DEFAULT_API_BASE = 'http://localhost:4000/api'

export function resolveApiBaseUrl(explicit: string | null | undefined, devHost: string | null): string {
  const override = (explicit ?? '').trim()
  if (override.length > 0) return stripTrailingSlashes(override)
  if (devHost) return `http://${devHost}:4000/api`
  return DEFAULT_API_BASE
}
