import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAdminSession } from '../admin/auth.js'
import {
  AnnouncementNotFoundError,
  createAnnouncement,
  listAnnouncementsForAdmin,
  listAnnouncementsForPlayer,
  withdrawAnnouncement
} from './service.js'

const createSchema = z.object({
  title: z.string().trim().min(1, 'a title is required').max(80, 'title is too long (80 characters max)'),
  body: z.string().trim().min(1, 'a message is required').max(1000, 'message is too long (1000 characters max)')
})

/** Player side: the announcements currently on show. */
export async function registerAnnouncementRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/announcements', async (_request, reply) => {
    return reply.send({ ok: true, data: await listAnnouncementsForPlayer() })
  })
}

/** Staff side: send, list and withdraw. Same gating as the rest of the admin API. */
export async function registerAdminAnnouncementRoutes(app: FastifyInstance): Promise<void> {
  const guarded = { config: { public: true, admin: true }, preHandler: requireAdminSession }

  app.get('/api/admin/announcements', guarded, async (_request, reply) => {
    return reply.send({ ok: true, data: await listAnnouncementsForAdmin() })
  })

  app.post('/api/admin/announcements', guarded, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.issues[0]?.message ?? 'invalid announcement' })
    const announcement = await createAnnouncement(request.authUser!.id, parsed.data.title, parsed.data.body)
    return reply.code(201).send({ ok: true, data: announcement })
  })

  app.post('/api/admin/announcements/:id/withdraw', guarded, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      return reply.send({ ok: true, data: await withdrawAnnouncement(request.authUser!.id, id) })
    } catch (error) {
      if (error instanceof AnnouncementNotFoundError) return reply.code(404).send({ ok: false, error: error.message })
      throw error
    }
  })
}
