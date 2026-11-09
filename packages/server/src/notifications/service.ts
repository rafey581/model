import { prisma } from '../db/index.js'
import { ownerUserIds } from '../auth/owners.js'

export interface NotificationData {
  id: string
  kind: string
  title: string
  body: string | null
  read: boolean
  createdAt: Date
}

let push: ((userId: string, notification: NotificationData) => void) | null = null

export function setNotificationPusher(fn: ((userId: string, notification: NotificationData) => void) | null): void {
  push = fn
}

/**
 * Best-effort notification: writing one must never break the money path that
 * triggered it. Callers often fire this without awaiting (a settled match
 * notifies both players), so a failure (e.g. the account was removed) is logged
 * and swallowed rather than surfacing as an unhandled rejection.
 */
export async function notify(userId: string, kind: string, title: string, body?: string): Promise<void> {
  try {
    const notification = await prisma.notification.create({
      data: { userId, kind, title, body: body ?? null }
    })
    push?.(userId, notification)
  } catch (error) {
    console.warn(`notification ${kind} for ${userId} was not stored:`, error instanceof Error ? error.message : error)
  }
}

/**
 * Sends the same notification to every active owner account and returns how many
 * rows were created. Owner accounts read these from the admin app. Writing them
 * here means no other system has to be reachable for a deposit request to raise a flag.
 */
export async function notifyAdmins(kind: string, title: string, body?: string): Promise<number> {
  const ids = ownerUserIds()
  if (ids.length === 0) return 0
  const admins = await prisma.user.findMany({
    where: { id: { in: ids }, status: 'ACTIVE' },
    select: { id: true }
  })
  for (const admin of admins) await notify(admin.id, kind, title, body)
  return admins.length
}