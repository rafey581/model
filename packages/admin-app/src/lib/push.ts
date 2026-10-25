import { Platform } from 'react-native'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { api } from './api'

/**
 * Staff phone alerts.
 *
 * Money requests arrive on their own Android channel whose sound is a 24-second
 * ringtone at maximum importance, so a new deposit or payout rings the phone even
 * with the app closed. Android fixes a channel's sound when it is first created, so
 * changing the sound later needs a new channel id, here and in the server's
 * RING_CHANNEL_ID (packages/server/src/push/adminPush.ts).
 */
export const RING_CHANNEL_ID = 'money-requests'
export const RING_SOUND = 'ring.wav'

export type PushStatus =
  | { state: 'registered'; token: string }
  | { state: 'unsupported'; reason: string }
  | { state: 'denied' }
  | { state: 'error'; reason: string }

let registeredToken: string | null = null
let lastStatus: PushStatus | null = null

export function pushStatus(): PushStatus | null {
  return lastStatus
}

export async function ensureChannels(): Promise<void> {
  if (Platform.OS !== 'android') return
  await Notifications.setNotificationChannelAsync(RING_CHANNEL_ID, {
    name: 'Deposit and withdrawal requests',
    description: 'Rings when a player submits a deposit or asks for a payout.',
    importance: Notifications.AndroidImportance.MAX,
    sound: RING_SOUND,
    vibrationPattern: [0, 800, 400, 800, 400, 800, 400, 800],
    enableVibrate: true,
    enableLights: true,
    lightColor: '#d29922',
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    // Honoured only if the staff member allows it in the system settings.
    bypassDnd: true
  })
  await Notifications.setNotificationChannelAsync('default', {
    name: 'General',
    importance: Notifications.AndroidImportance.DEFAULT
  })
}

/** Asks for permission, gets this phone's Expo token and registers it with the server. */
export async function registerForPush(): Promise<PushStatus> {
  lastStatus = await register()
  return lastStatus
}

async function register(): Promise<PushStatus> {
  if (Platform.OS === 'web') return { state: 'unsupported', reason: 'Phone alerts work in the Android and iOS app, not the web version.' }
  if (!Device.isDevice) return { state: 'unsupported', reason: 'Phone alerts need a real phone, not an emulator.' }
  try {
    // Android 13+ asks for permission only once a channel exists.
    await ensureChannels()
    const current = await Notifications.getPermissionsAsync()
    let granted = current.granted
    if (!granted && current.canAskAgain) granted = (await Notifications.requestPermissionsAsync()).granted
    if (!granted) return { state: 'denied' }

    const projectId =
      (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ??
      (Constants as unknown as { easConfig?: { projectId?: string } }).easConfig?.projectId
    if (!projectId) return { state: 'error', reason: 'The app was built without an EAS project id.' }

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId })
    await api('/admin/devices', { method: 'POST', body: { token, platform: Platform.OS === 'ios' ? 'ios' : 'android' } })
    registeredToken = token
    return { state: 'registered', token }
  } catch (caught) {
    return { state: 'error', reason: (caught as Error).message || 'Could not register for alerts.' }
  }
}

/** Forgets this phone on the server, so it stops ringing for an account that signed out. */
export async function unregisterPush(): Promise<void> {
  const token = registeredToken
  registeredToken = null
  lastStatus = null
  if (!token) return
  try {
    await api('/admin/devices', { method: 'DELETE', body: { token } })
  } catch {
    // Signing out continues; the server drops dead tokens when Expo reports them.
  }
}

export async function sendTestRing(): Promise<{ devices: number; accepted: number }> {
  return api<{ devices: number; accepted: number }>('/admin/devices/test', { method: 'POST', body: {} })
}
