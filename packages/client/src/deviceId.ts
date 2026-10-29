import { Capacitor } from '@capacitor/core'
import { Device } from '@capacitor/device'

/**
 * Which phone this is, for the one-account-per-phone rule.
 *
 * In the Android app it is the system's ANDROID_ID, which is the same for this app on
 * this phone across reinstalls (it changes on a factory reset, or if the app is signed
 * with a different key). In a browser there is no such thing, so a random id is kept in
 * local storage instead: weaker, since clearing site data makes a new one.
 *
 * Prefixed with the platform so the server can tell a strong id from a weak one.
 */

const WEB_KEY = 'snooker_device_id'
let cached: Promise<string> | null = null

export function getDeviceId(): Promise<string> {
  cached ??= read()
  return cached
}

async function read(): Promise<string> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { identifier } = await Device.getId()
      const clean = identifier.replace(/[^A-Za-z0-9_-]/g, '')
      if (clean.length >= 6) return `${Capacitor.getPlatform()}:${clean}`.slice(0, 120)
    } catch {
      // Fall through to the stored id rather than leaving the request without one.
    }
  }
  return `web:${webId()}`
}

function webId(): string {
  try {
    const existing = localStorage.getItem(WEB_KEY)
    if (existing && /^[A-Za-z0-9_-]{6,100}$/.test(existing)) return existing
  } catch {
    // Storage blocked: a fresh id for this session only.
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  try {
    localStorage.setItem(WEB_KEY, id)
  } catch {
    // Kept in memory only.
  }
  return id
}
