import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { STAKE_TIER_IDS, MATCH_FORMATS } from '@snooker/shared'
import { ChallengeError, acceptChallenge, cancelChallenge, createChallenge, declineChallenge, listIncomingChallenges } from './service.js'

const createSchema = z.object({
  stakeTier: z.enum(STAKE_TIER_IDS),
  format: z.enum(MATCH_FORMATS).default('BO3'),
  targetUsername: z.string().min(1).max(24).optional()
})

export async function registerChallengeRoutes(app: FastifyInstance): Promise<void> {
  // What is open for me right now. The live popups arrive by socket; this is for
  // a fresh page load or a reconnect that missed them.
  app.get('/api/challenges/incoming', async (request, reply) => {
    const data = await listIncomingChallenges(request.authUser!.id)
    return reply.send({ ok: true, data })
  })

  app.post('/api/challenges', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid input' })
    try {
      const data = await createChallenge({
        challengerId: request.authUser!.id,
        stakeTier: parsed.data.stakeTier,
        format: parsed.data.format,
        targetUsername: parsed.data.targetUsername
      })
      return reply.send({ ok: true, data })
    } catch (error) {
      if (error instanceof ChallengeError) return reply.code(400).send({ ok: false, error: error.message })
      throw error
    }
  })

  app.post('/api/challenges/:id/accept', async (request, reply) => {
    const id = (request.params as { id: string }).id
    try {
      const data = await acceptChallenge({ challengeId: id, userId: request.authUser!.id })
      return reply.send({ ok: true, data })
    } catch (error) {
      if (error instanceof ChallengeError) return reply.code(400).send({ ok: false, error: error.message })
      throw error
    }
  })

  app.post('/api/challenges/:id/decline', async (request, reply) => {
    const id = (request.params as { id: string }).id
    try {
      await declineChallenge({ challengeId: id, userId: request.authUser!.id })
      return reply.send({ ok: true, data: { declined: true } })
    } catch (error) {
      if (error instanceof ChallengeError) return reply.code(400).send({ ok: false, error: error.message })
      throw error
    }
  })

  app.post('/api/challenges/:id/cancel', async (request, reply) => {
    const id = (request.params as { id: string }).id
    try {
      await cancelChallenge({ challengeId: id, userId: request.authUser!.id })
      return reply.send({ ok: true, data: { cancelled: true } })
    } catch (error) {
      if (error instanceof ChallengeError) return reply.code(400).send({ ok: false, error: error.message })
      throw error
    }
  })
}
