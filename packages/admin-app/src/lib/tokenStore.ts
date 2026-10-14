import { Platform } from 'react-native'
import * as SecureStore from 'expo-secure-store'

/**
 * Where the admin session token lives between launches.
 *
 * On a device it goes into SecureStore (Keychain / Keystore), never AsyncStorage,
 * because the token is a live admin credential. The web build - the only place
 * SecureStore is unavailable - falls back to localStorage.
 */
const TOKEN_KEY = 'snooker.admin.token'

function webStorage(): Storage | null {
  try {
    return typeof globalThis !== 'undefined' && 'localStorage' in globalThis
      ? (globalThis as unknown as { localStorage: Storage }).localStorage
      : null
  } catch {
    return null
  }
}

export async function readToken(): Promise<string | null> {
  if (Platform.OS === 'web') return webStorage()?.getItem(TOKEN_KEY) ?? null
  return SecureStore.getItemAsync(TOKEN_KEY)
}

export async function writeToken(token: string | null): Promise<void> {
  if (Platform.OS === 'web') {
    const storage = webStorage()
    if (!storage) return
    if (token) storage.setItem(TOKEN_KEY, token)
    else storage.removeItem(TOKEN_KEY)
    return
  }
  if (token) await SecureStore.setItemAsync(TOKEN_KEY, token)
  else await SecureStore.deleteItemAsync(TOKEN_KEY)
}
