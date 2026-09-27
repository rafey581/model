import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db/index.js'

const markReadSchema = z.object({
  ids: z.array(z.string()).max(100).optional()
})

export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/notifications', async (request, reply) => {
    const userId = request.authUser!.id
    const [items, unread] = await Promise.all([
      prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.notification.count({ where: { userId, read: false } })
    ])
    return reply.send({ ok: true, data: { items, unread } })
  })

  app.post('/api/notifications/read', async (request, reply) => {
    const parsed = markReadSchema.safeParse((request.body as object | undefined) ?? {})
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid input' })
    const userId = request.authUser!.id
    const ids = parsed.data.ids
    const updated = await prisma.notification.updateMany({
      where: ids && ids.length > 0 ? { userId, id: { in: ids } } : { userId, read: false },
      data: { read: true }
    })
    return reply.send({ ok: true, data: { updated: updated.count } })
  })
}