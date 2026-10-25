import { prisma } from '../db/index.js'
import { notify, notifyAdmins } from '../notifications/service.js'
import { pushToAdmins } from '../push/adminPush.js'

/**
 * Customer support: one conversation per player, answered by staff from the admin app.
 *
 * A player's thread is created on first contact and reused forever after; closing it
 * only marks it resolved, and the player writing again reopens it. Read flags are per
 * side: a USER message is unread until staff open the thread, an ADMIN message until
 * the player does.
 */

export const SUPPORT_STATUSES = ['OPEN', 'CLOSED'] as const
export type SupportStatus = (typeof SUPPORT_STATUSES)[number]

export class SupportThreadNotFoundError extends Error {
  constructor() {
    super('support thread not found')
  }
}

const messageInclude = { sender: { select: { id: true, username: true, role: true } } } as const

/** The player's own thread with every message, created on first visit. Marks staff replies read. */
export async function getPlayerThread(userId: string) {
  const thread = await prisma.supportThread.upsert({
    where: { userId },
    create: { userId },
    update: {},
    include: { messages: { orderBy: { createdAt: 'asc' }, include: messageInclude } }
  })
  await prisma.supportMessage.updateMany({
    where: { threadId: thread.id, senderRole: 'ADMIN', read: false },
    data: { read: true }
  })
  return thread
}

/** Staff replies the player has not opened yet (for a badge on the support button). */
export async function playerUnreadCount(userId: string): Promise<number> {
  return prisma.supportMessage.count({
    where: { senderRole: 'ADMIN', read: false, thread: { userId } }
  })
}

export async function postPlayerMessage(userId: string, body: string) {
  const { message, wasWaiting, username } = await prisma.$transaction(async (tx) => {
    const thread = await tx.supportThread.upsert({ where: { userId }, create: { userId }, update: {} })
    // Staff are alerted once per burst: when the player writes while nothing of theirs
    // is already waiting unread, not on every line of a multi-message explanation.
    const waiting = await tx.supportMessage.count({ where: { threadId: thread.id, senderRole: 'USER', read: false } })
    const created = await tx.supportMessage.create({
      data: { threadId: thread.id, senderId: userId, senderRole: 'USER', body },
      include: messageInclude
    })
    await tx.supportThread.update({ where: { id: thread.id }, data: { lastMessageAt: created.createdAt, status: 'OPEN' } })
    return { message: created, wasWaiting: waiting > 0, username: created.sender.username }
  })
  if (!wasWaiting) {
    const preview = body.length > 80 ? `${body.slice(0, 77)}...` : body
    void notifyAdmins('SUPPORT_MESSAGE', `Support message from ${username}`, preview).catch(() => undefined)
    // A normal notification, not a ring: support is not money waiting.
    void pushToAdmins({ title: `Support: ${username}`, body: preview, href: `/support/${message.threadId}`, kind: 'SUPPORT_MESSAGE', ring: false })
  }
  return message
}

export interface ThreadListFilter {
  status?: SupportStatus
}

/** Every thread, newest activity first, with the latest message and the unread count for staff. */
export async function listThreads(filter: ThreadListFilter = {}) {
  const threads = await prisma.supportThread.findMany({
    where: filter.status ? { status: filter.status } : {},
    orderBy: { lastMessageAt: 'desc' },
    take: 200,
    include: {
      user: { select: { id: true, username: true, email: true } },
      assignedTo: { select: { id: true, username: true } },
      messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, body: true, senderRole: true, createdAt: true } }
    }
  })
  const unread = await prisma.supportMessage.groupBy({
    by: ['threadId'],
    where: { senderRole: 'USER', read: false, threadId: { in: threads.map((t) => t.id) } },
    _count: { _all: true }
  })
  const unreadById = new Map(unread.map((u) => [u.threadId, u._count._all]))
  return threads.map(({ messages, ...thread }) => ({
    ...thread,
    lastMessage: messages[0] ?? null,
    unreadCount: unreadById.get(thread.id) ?? 0
  }))
}

/** Open threads with something from the player still unread by staff (the admin badge). */
export async function threadsAwaitingReply(): Promise<number> {
  return prisma.supportThread.count({
    where: { status: 'OPEN', messages: { some: { senderRole: 'USER', read: false } } }
  })
}

/** One thread for staff, with the player's contact details. Marks the player's messages read. */
export async function getThreadForAdmin(threadId: string) {
  const thread = await prisma.supportThread.findUnique({
    where: { id: threadId },
    include: {
      user: { select: { id: true, username: true, email: true, phone: true, status: true, createdAt: true } },
      assignedTo: { select: { id: true, username: true } },
      messages: { orderBy: { createdAt: 'asc' }, include: messageInclude }
    }
  })
  if (!thread) throw new SupportThreadNotFoundError()
  await prisma.supportMessage.updateMany({
    where: { threadId, senderRole: 'USER', read: false },
    data: { read: true }
  })
  return thread
}

export async function postAdminReply(threadId: string, adminId: string, body: string) {
  const { message, userId } = await prisma.$transaction(async (tx) => {
    const thread = await tx.supportThread.findUnique({ where: { id: threadId } })
    if (!thread) throw new SupportThreadNotFoundError()
    const created = await tx.supportMessage.create({
      data: { threadId, senderId: adminId, senderRole: 'ADMIN', body },
      include: messageInclude
    })
    // Replying means the player's messages have been seen, and that the conversation is live.
    await tx.supportMessage.updateMany({ where: { threadId, senderRole: 'USER', read: false }, data: { read: true } })
    await tx.supportThread.update({
      where: { id: threadId },
      data: { lastMessageAt: created.createdAt, status: 'OPEN', assignedToId: thread.assignedToId ?? adminId }
    })
    return { message: created, userId: thread.userId }
  })
  const preview = body.length > 120 ? `${body.slice(0, 117)}...` : body
  // notify() also pushes over the socket, so an open chat refreshes at once.
  void notify(userId, 'SUPPORT_REPLY', 'Support replied', preview)
  return message
}

export async function setThreadStatus(threadId: string, adminId: string, status: SupportStatus): Promise<{ id: string; status: SupportStatus }> {
  await prisma.$transaction(async (tx) => {
    const thread = await tx.supportThread.findUnique({ where: { id: threadId }, select: { id: true, userId: true, status: true } })
    if (!thread) throw new SupportThreadNotFoundError()
    if (thread.status === status) return
    await tx.supportThread.update({ where: { id: threadId }, data: { status } })
    await tx.adminAction.create({
      data: {
        adminId,
        action: status === 'CLOSED' ? 'SUPPORT_CLOSE' : 'SUPPORT_REOPEN',
        targetType: 'USER',
        targetId: thread.userId,
        meta: { threadId }
      }
    })
  })
  return { id: threadId, status }
}
