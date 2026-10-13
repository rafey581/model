import type { FastifyInstance } from 'fastify'
import { getReferralSummary, ReferralError } from './service.js'

/**
 * The inviter's own view of the programme: their code, the shareable link, and
 * how the players they invited are progressing (joined → played).
 */
export async function registerReferralRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/referrals', async (request, reply) => {
    try {
      const data = await getReferralSummary(request.authUser!.id)
      return reply.send({ ok: true, data })
    } catch (error) {
      if (error instanceof ReferralError) return reply.code(400).send({ ok: false, error: error.message })
      throw error
    }
  })
}
