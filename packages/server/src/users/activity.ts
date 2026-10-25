import { prisma } from '../db/index.js'

/**
 * "Last seen" bookkeeping for the admin dashboard's active-user counts.
 *
 * Called with the user row the caller already loaded, so the common case (seen a
 * moment ago) costs nothing; the write happens at most once per window per user,
 * and never blocks or fails the request that triggered it.
 */
export const ACTIVITY_WINDOW_MS = 5 * 60 * 1000

export function touchLastSeen(user: { id: string; lastSeenAt: Date | null }, now: Date = new Date()): void {
  if (user.lastSeenAt && now.getTime() - user.lastSeenAt.getTime() < ACTIVITY_WINDOW_MS) return
  void prisma.user
    .update({ where: { id: user.id }, data: { lastSeenAt: now }, select: { id: true } })
    .catch(() => undefined)
}
