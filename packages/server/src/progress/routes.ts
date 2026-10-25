import type { FastifyInstance } from 'fastify'
import { BADGES, RANKS, summarizeProgress } from '@snooker/shared'
import { prisma } from '../db/index.js'
import { getUserProgress } from './service.js'

export async function registerProgressRoutes(app: FastifyInstance): Promise<void> {
  /** The signed-in player's level, XP bar, rank, streak and badge collection. */
  app.get('/api/progress/me', async (request, reply) => {
    const userId = request.authUser?.id
    if (!userId) return reply.code(401).send({ ok: false, error: 'unauthorized' })
    const progress = await getUserProgress(userId)
    if (!progress) return reply.code(404).send({ ok: false, error: 'user not found' })
    return reply.send({ ok: true, data: progress })
  })

  /** The rank ladder and the badge catalogue. */
  app.get('/api/progress/catalog', async (_request, reply) => {
    return reply.send({ ok: true, data: { ranks: RANKS, badges: BADGES } })
  })

  /** Top players by level, then XP. */
  app.get('/api/progress/leaderboard', async (_request, reply) => {
    const users = await prisma.user.findMany({
      where: { role: 'PLAYER', status: 'ACTIVE' },
      select: { id: true, username: true, xp: true, _count: { select: { badges: true } } },
      orderBy: [{ level: 'desc' }, { xp: 'desc' }],
      take: 50
    })
    const data = users.map((u, i) => {
      const p = summarizeProgress(u.xp)
      return { position: i + 1, userId: u.id, username: u.username, level: p.level, totalXp: p.totalXp, rank: p.rank, badges: u._count.badges }
    })
    return reply.send({ ok: true, data })
  })
}
