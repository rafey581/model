import { prisma } from '../db/index.js'
import { config } from '../config.js'

/**
 * Push alerts to staff phones through the Expo push service.
 *
 * Money requests (a deposit to verify, a payout to review) ring: they go out at high
 * priority on the admin app's "money-requests" Android channel, whose sound is a
 * 24-second ringtone, so a phone in a pocket rings like a call. Other alerts use the
 * default channel and a normal notification sound.
 *
 * Best-effort by design. A failed push is logged and dropped; it must never fail the
 * deposit or withdrawal that triggered it. Tokens Expo reports as no longer
 * registered (app uninstalled, notifications revoked) are deleted.
 */

const ADMIN_ROLES = ['ADMIN', 'SUPERADMIN'] as const

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
export const RING_CHANNEL_ID = 'money-requests'
export const RING_SOUND = 'ring.wav'

export interface AdminAlert {
  title: string
  body: string
  /** Where the app should open when the alert is tapped. */
  href: string
  kind: string
  ring: boolean
}

export interface ExpoMessage {
  to: string
  title: string
  body: string
  data: Record<string, unknown>
  sound: string
  priority: 'default' | 'normal' | 'high'
  channelId?: string
  ttl: number
}

type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

let fetcher: Fetcher = (url, init) => fetch(url, init)

/** Test seam: replace the HTTP call to Expo. */
export function setPushFetcher(next: Fetcher | null): void {
  fetcher = next ?? ((url, init) => fetch(url, init))
}

export function buildMessages(tokens: string[], alert: AdminAlert): ExpoMessage[] {
  return tokens.map((to) => ({
    to,
    title: alert.title,
    body: alert.body,
    data: { kind: alert.kind, href: alert.href, ring: alert.ring },
    sound: alert.ring ? RING_SOUND : 'default',
    priority: alert.ring ? 'high' : 'default',
    channelId: alert.ring ? RING_CHANNEL_ID : 'default',
    // A money request is still worth ringing for an hour later; after that the
    // dashboard badge carries it.
    ttl: 3600
  }))
}

interface ExpoTicket {
  status: 'ok' | 'error'
  message?: string
  details?: { error?: string }
}

/** Sends an alert to every registered phone of every active staff account. Returns how many were accepted. */
export async function pushToAdmins(
  alert: AdminAlert,
  log: (msg: string, err?: unknown) => void = () => undefined,
  onlyUserId?: string
): Promise<number> {
  if (!config.ADMIN_PUSH_ENABLED) return 0
  try {
    const devices = await prisma.adminDevice.findMany({
      where: {
        ...(onlyUserId ? { userId: onlyUserId } : {}),
        user: { role: { in: [...ADMIN_ROLES] }, status: 'ACTIVE' }
      },
      select: { token: true }
    })
    if (devices.length === 0) return 0
    const messages = buildMessages(
      devices.map((d) => d.token),
      alert
    )
    let accepted = 0
    const dead: string[] = []
    // Expo accepts up to 100 messages per request.
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100)
      const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' }
      if (config.EXPO_ACCESS_TOKEN) headers.authorization = `Bearer ${config.EXPO_ACCESS_TOKEN}`
      const res = await fetcher(EXPO_PUSH_URL, { method: 'POST', headers, body: JSON.stringify(chunk) })
      if (!res.ok) {
        log(`expo push rejected the request (${res.status})`)
        continue
      }
      const payload = (await res.json()) as { data?: ExpoTicket[] }
      const tickets = payload.data ?? []
      tickets.forEach((ticket, index) => {
        if (ticket.status === 'ok') accepted += 1
        else if (ticket.details?.error === 'DeviceNotRegistered') dead.push(chunk[index]!.to)
        else log(`expo push ticket error: ${ticket.message ?? ticket.details?.error ?? 'unknown'}`)
      })
    }
    if (dead.length) await prisma.adminDevice.deleteMany({ where: { token: { in: dead } } })
    return accepted
  } catch (error) {
    log('admin push failed', error)
    return 0
  }
}

/** Expo push tokens look like ExponentPushToken[xxxx] (or ExpoPushToken[xxxx]). */
export function isExpoPushToken(token: string): boolean {
  return /^Expo(nent)?PushToken\[[^\]]+\]$/.test(token)
}
