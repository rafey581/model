import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { requireAdminSession } from '../admin/auth.js'
import {
  SUPPORT_STATUSES,
  SupportThreadNotFoundError,
  getPlayerThread,
  getThreadForAdmin,
  listThreads,
  playerUnreadCount,
  postAdminReply,
  postPlayerMessage,
  setThreadStatus
} from './service.js'

const messageSchema = z.object({ body: z.string().trim().min(1, 'message is required').max(2000, 'message is too long (2000 characters max)') })
const statusQuery = z.enum(SUPPORT_STATUSES).optional()

function notFound(error: unknown, reply: FastifyReply) {
  if (error instanceof SupportThreadNotFoundError) return reply.code(404).send({ ok: false, error: 'support thread not found' })
  throw error
}

/** Player-facing support routes (authed player path). */
export async function registerSupportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/support/thread', async (request, reply) => {
    const thread = await getPlayerThread(request.authUser!.id)
    return reply.send({ ok: true, data: thread })
  })

  app.get('/api/support/unread', async (request, reply) => {
    return reply.send({ ok: true, data: { unread: await playerUnreadCount(request.authUser!.id) } })
  })

  app.post('/api/support/message', async (request, reply) => {
    const parsed = messageSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.issues[0]?.message ?? 'message is required' })
    const message = await postPlayerMessage(request.authUser!.id, parsed.data.body)
    return reply.code(201).send({ ok: true, data: message })
  })
}

/**
 * Admin support routes. Same gating contract as the rest of the admin API: public at
 * the player-auth hook (an admin session is not a player token), guarded by the
 * revocable admin session.
 */
export async function registerAdminSupportRoutes(app: FastifyInstance): Promise<void> {
  const guarded = { config: { public: true, admin: true }, preHandler: requireAdminSession }

  app.get('/api/admin/support/threads', guarded, async (request, reply) => {
    const url = new URL(request.url, 'http://localhost')
    const status = statusQuery.safeParse(url.searchParams.get('status') ?? undefined)
    const threads = await listThreads({ status: status.success ? status.data : undefined })
    return reply.send({ ok: true, data: threads })
  })

  app.get('/api/admin/support/thread/:id', guarded, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      return reply.send({ ok: true, data: await getThreadForAdmin(id) })
    } catch (error) {
      return notFound(error, reply)
    }
  })

  app.post('/api/admin/support/thread/:id/reply', guarded, async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = messageSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.issues[0]?.message ?? 'message is required' })
    try {
      const message = await postAdminReply(id, request.authUser!.id, parsed.data.body)
      return reply.code(201).send({ ok: true, data: message })
    } catch (error) {
      return notFound(error, reply)
    }
  })

  app.post('/api/admin/support/thread/:id/close', guarded, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      return reply.send({ ok: true, data: await setThreadStatus(id, request.authUser!.id, 'CLOSED') })
    } catch (error) {
      return notFound(error, reply)
    }
  })

  app.post('/api/admin/support/thread/:id/reopen', guarded, async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      return reply.send({ ok: true, data: await setThreadStatus(id, request.authUser!.id, 'OPEN') })
    } catch (error) {
      return notFound(error, reply)
    }
  })
}
