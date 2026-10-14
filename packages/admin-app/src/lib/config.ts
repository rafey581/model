import Constants from 'expo-constants'
import { hostFromUri, resolveApiBaseUrl } from './apiConfig'

/**
 * The one place the environment meets the app.
 *
 * `EXPO_PUBLIC_API_URL` (set in .env, inlined by Metro at build time) wins. With
 * no override we point at whatever host is serving the JS bundle, on the game
 * server's port - which is the machine running Metro - so a phone on the same
 * Wi-Fi reaches the API without anyone copying an IP address.
 */
function devHost(): string | null {
  const constants = Constants as unknown as {
    expoConfig?: { hostUri?: string } | null
    expoGoConfig?: { debuggerHost?: string } | null
    manifest2?: { extra?: { expoGo?: { debuggerHost?: string } } } | null
  }
  const hostUri =
    constants.expoConfig?.hostUri ??
    constants.expoGoConfig?.debuggerHost ??
    constants.manifest2?.extra?.expoGo?.debuggerHost ??
    null
  return hostFromUri(hostUri)
}

let cached: string | null = null

export function apiBaseUrl(): string {
  if (cached === null) cached = resolveApiBaseUrl(process.env.EXPO_PUBLIC_API_URL, devHost())
  return cached
}
