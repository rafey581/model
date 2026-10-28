import { prisma } from '../db/index.js'

/**
 * Announcements: a message staff send to every player at once.
 *
 * Stored, so a player who was offline sees it the next time they open the game, and
 * pushed live to every connected socket, so a player who is online sees it at once.
 * Withdrawing one stops it being shown; it stays in the staff list for the record.
 */

export interface AnnouncementData {
  id: string
  title: string
  body: string
  createdAt: Date
  withdrawnAt: Date | null
}

/** How far back a player is shown announcements they have not seen yet. */
export const PLAYER_ANNOUNCEMENT_DAYS = 30
const PLAYER_ANNOUNCEMENT_LIMIT = 20

let broadcast: ((announcement: AnnouncementData) => void) | null = null

/** Wired by the socket layer: sends a new announcement to everyone connected. */
export function setAnnouncementBroadcaster(fn: ((announcement: AnnouncementData) => void) | null): void {
  broadcast = fn
}

const SELECT = { id: true, title: true, body: true, createdAt: true, withdrawnAt: true } as const

export async function createAnnouncement(adminId: string, title: string, body: string): Promise<AnnouncementData> {
  const announcement = await prisma.$transaction(async (tx) => {
    const created = await tx.announcement.create({ data: { title, body, createdById: adminId }, select: SELECT })
    await tx.adminAction.create({
      data: { adminId, action: 'ANNOUNCEMENT_SEND', targetType: 'ANNOUNCEMENT', targetId: created.id, meta: { title } }
    })
    return created
  })
  broadcast?.(announcement)
  return announcement
}

export class AnnouncementNotFoundError extends Error {
  constructor() {
    super('announcement not found')
  }
}

export async function withdrawAnnouncement(adminId: string, id: string): Promise<AnnouncementData> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.announcement.findUnique({ where: { id }, select: SELECT })
    if (!existing) throw new AnnouncementNotFoundError()
    if (existing.withdrawnAt) return existing
    const updated = await tx.announcement.update({ where: { id }, data: { withdrawnAt: new Date() }, select: SELECT })
    await tx.adminAction.create({
      data: { adminId, action: 'ANNOUNCEMENT_WITHDRAW', targetType: 'ANNOUNCEMENT', targetId: id, meta: { title: existing.title } }
    })
    return updated
  })
}

/** Everything sent, newest first, for the staff list. */
export async function listAnnouncementsForAdmin(limit = 100): Promise<AnnouncementData[]> {
  return prisma.announcement.findMany({ orderBy: { createdAt: 'desc' }, take: limit, select: SELECT })
}

/** What a player is shown: recent and not withdrawn, newest first. */
export async function listAnnouncementsForPlayer(now: Date = new Date()): Promise<AnnouncementData[]> {
  const since = new Date(now.getTime() - PLAYER_ANNOUNCEMENT_DAYS * 24 * 60 * 60 * 1000)
  return prisma.announcement.findMany({
    where: { withdrawnAt: null, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: PLAYER_ANNOUNCEMENT_LIMIT,
    select: SELECT
  })
}
