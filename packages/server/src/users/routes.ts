import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { summarizeProgress } from '@snooker/shared'
import { prisma } from '../db/index.js'
import { getUserStats, getLeaderboard, type LeaderboardPeriod } from './stats.js'
import { config } from '../config.js'
import { dateOfBirthProblem, parseDateOfBirth } from '../auth/dob.js'

const periodSchema = z.enum(['week', 'month', 'all'])

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/me', async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.authUser!.id },
      select: {
        id: true,
        username: true,
        createdAt: true,
        profile: true,
        xp: true,
        dateOfBirth: true,
        wallet: { select: { available: true } }
      }
    })
    if (!user) return reply.code(404).send({ ok: false, error: 'user not found' })
    const stats = await getUserStats(user.id)
    const available = Number(user.wallet?.available ?? 0)
    const { xp, dateOfBirth, ...rest } = user
    const { level, rank } = summarizeProgress(xp)
    // Only whether it is saved: the date itself is a recovery detail and is never sent back.
    const needsDateOfBirth = dateOfBirth === null
    return reply.send({ ok: true, data: { user: { ...rest, needsDateOfBirth, wallet: { available } }, stats, progress: { level, rank } } })
  })

  /**
   * POST /api/me/date-of-birth
   *
   * For accounts made before sign-up asked for it. Set once: after that it cannot be
   * changed from the app, or anyone holding a logged-in phone could rewrite the answer
   * "forgot password" checks.
   */
  app.post('/api/me/date-of-birth', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const parsed = z.object({ dateOfBirth: z.string().trim().max(10) }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'Please enter a valid date of birth.' })
    const problem = dateOfBirthProblem(parsed.data.dateOfBirth, config.MIN_SIGNUP_AGE)
    if (problem) return reply.code(400).send({ ok: false, error: problem })
    const updated = await prisma.user.updateMany({
      where: { id: request.authUser!.id, dateOfBirth: null },
      data: { dateOfBirth: parseDateOfBirth(parsed.data.dateOfBirth)! }
    })
    if (updated.count === 0) {
      return reply.code(409).send({ ok: false, error: 'Your date of birth is already saved. Contact customer support to change it.', code: 'dob_set' })
    }
    return reply.send({ ok: true, data: { saved: true } })
  })

  app.get('/api/leaderboard', async (request, reply) => {
    const url = new URL(request.url, 'http://localhost')
    const parsed = periodSchema.safeParse(url.searchParams.get('period') ?? 'all')
    const period: LeaderboardPeriod = parsed.success ? parsed.data : 'all'
    const leaderboard = await getLeaderboard(period, request.authUser!.id)
    return reply.send({ ok: true, data: leaderboard })
  })
}