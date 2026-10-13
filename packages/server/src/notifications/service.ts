import { prisma } from '../db/index.js'

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

/** Admin roles that receive deposit (and future ops) notifications. */
const ADMIN_ROLES = ['ADMIN', 'SUPERADMIN'] as const

/**
 * Sends the same notification to every active admin account and returns how many
 * rows were created. Admin users only read these from the admin app (the mobile
 * admin app is wired later) - but writing them here means no other system has to
 * be reachable for a deposit request to raise a flag.
 */
export async function notifyAdmins(kind: string, title: string, body?: string): Promise<number> {
  const admins = await prisma.user.findMany({
    where: { role: { in: [...ADMIN_ROLES] }, status: 'ACTIVE' },
    select: { id: true }
  })
  for (const admin of admins) await notify(admin.id, kind, title, body)
  return admins.length
}