import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db/index.js'
import { requireAdminSession } from '../admin/auth.js'

export async function registerSupportRoutes(app: FastifyInstance): Promise<void> {
  // Get or create user's support thread
  app.get('/api/support/thread', async (request: any, reply) => {
    const userId = request.user.id
    let thread = await prisma.supportThread.findUnique({
      where: { userId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          include: { sender: { select: { id: true, username: true, role: true } } }
        }
      }
    })
    if (!thread) {
      thread = await prisma.supportThread.create({
        data: { userId },
        include: {
          messages: {
            orderBy: { createdAt: 'asc' },
            include: { sender: { select: { id: true, username: true, role: true } } }
          }
        }
      })
    }
    // Mark admin messages as read
    await prisma.supportMessage.updateMany({
      where: { threadId: thread.id, senderRole: 'ADMIN', read: false },
      data: { read: true }
    })
    return reply.send({ ok: true, data: thread })
  })

  // Send message as user
  app.post('/api/support/message', async (request: any, reply) => {
    const userId = request.user.id
    const schema = z.object({ body: z.string().trim().min(1).max(2000) })
    const parsed = schema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'Message is required' })

    let thread = await prisma.supportThread.findUnique({ where: { userId } })
    if (!thread) {
      thread = await prisma.supportThread.create({ data: { userId } })
    }

    const message = await prisma.supportMessage.create({
      data: {
        threadId: thread.id,
        senderId: userId,
        senderRole: 'USER',
        body: parsed.data.body
      },
      include: { sender: { select: { id: true, username: true, role: true } } }
    })

    await prisma.supportThread.update({
      where: { id: thread.id },
      data: { lastMessageAt: new Date(), status: 'OPEN' }
    })

    return reply.send({ ok: true, data: message })
  })
}

export async function registerAdminSupportRoutes(app: FastifyInstance): Promise<void> {
  // List all support threads
  app.get('/api/admin/support/threads', { preHandler: requireAdminSession }, async (_request, reply) => {
    const threads = await prisma.supportThread.findMany({
      orderBy: { lastMessageAt: 'desc' },
      include: {
        user: { select: { id: true, username: true, email: true } },
        assignedTo: { select: { id: true, username: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    })
    // Count unread messages from users
    const threadsWithUnread = await Promise.all(
      threads.map(async (thread) => {
        const unreadCount = await prisma.supportMessage.count({
          where: { threadId: thread.id, senderRole: 'USER', read: false }
        })
        return { ...thread, unreadCount }
      })
    )
    return reply.send({ ok: true, data: threadsWithUnread })
  })

  // Get thread with messages
  app.get('/api/admin/support/thread/:id', { preHandler: requireAdminSession }, async (request: any, reply) => {
    const { id } = request.params
    const thread = await prisma.supportThread.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, username: true, email: true, phone: true } },
        assignedTo: { select: { id: true, username: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
          include: { sender: { select: { id: true, username: true, role: true } } }
        }
      }
    })
    if (!thread) return reply.code(404).send({ ok: false, error: 'Thread not found' })
    
    // Mark user messages as read
    await prisma.supportMessage.updateMany({
      where: { threadId: thread.id, senderRole: 'USER', read: false },
      data: { read: true }
    })
    
    return reply.send({ ok: true, data: thread })
  })

  // Reply as admin
  app.post('/api/admin/support/thread/:id/reply', { preHandler: requireAdminSession }, async (request: any, reply) => {
    const { id } = request.params
    const schema = z.object({ body: z.string().trim().min(1).max(2000) })
    const parsed = schema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'Message is required' })

    const thread = await prisma.supportThread.findUnique({ where: { id } })
    if (!thread) return reply.code(404).send({ ok: false, error: 'Thread not found' })

    const message = await prisma.supportMessage.create({
      data: {
        threadId: thread.id,
        senderId: request.admin.id,
        senderRole: 'ADMIN',
        body: parsed.data.body
      },
      include: { sender: { select: { id: true, username: true, role: true } } }
    })

    await prisma.supportThread.update({
      where: { id: thread.id },
      data: { 
        lastMessageAt: new Date(),
        assignedToId: thread.assignedToId || request.admin.id
      }
    })

    // Notify user
    await prisma.notification.create({
      data: {
        userId: thread.userId,
        kind: 'SUPPORT_REPLY',
        title: 'Support reply',
        body: 'You have a new reply from support.'
      }
    })

    return reply.send({ ok: true, data: message })
  })

  // Close thread
  app.post('/api/admin/support/thread/:id/close', { preHandler: requireAdminSession }, async (request: any, reply) => {
    const { id } = request.params
    await prisma.supportThread.update({
      where: { id },
      data: { status: 'CLOSED' }
    })
    return reply.send({ ok: true })
  })
}
