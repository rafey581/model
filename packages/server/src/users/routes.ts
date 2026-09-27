import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db/index.js'
import { getUserStats, getLeaderboard, type LeaderboardPeriod } from './stats.js'

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
        wallet: { select: { available: true } }
      }
    })
    if (!user) return reply.code(404).send({ ok: false, error: 'user not found' })
    const stats = await getUserStats(user.id)
    const available = Number(user.wallet?.available ?? 0)
    return reply.send({ ok: true, data: { user: { ...user, wallet: { available } }, stats } })
  })

  app.get('/api/leaderboard', async (request, reply) => {
    const url = new URL(request.url, 'http://localhost')
    const parsed = periodSchema.safeParse(url.searchParams.get('period') ?? 'all')
    const period: LeaderboardPeriod = parsed.success ? parsed.data : 'all'
    const leaderboard = await getLeaderboard(period, request.authUser!.id)
    return reply.send({ ok: true, data: leaderboard })
  })
}