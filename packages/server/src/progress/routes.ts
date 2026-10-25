import type { FastifyInstance } from 'fastify'
import { prisma } from '../db/index.js'
import { getUserProgress } from './service.js'

export async function registerProgressRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/progress/me', async (request: any, reply) => {
    const userId = request.authUser?.id
    if (!userId) return reply.code(401).send({ ok: false, error: 'unauthorized' })
    const progress = await getUserProgress(userId)
    return reply.send({ ok: true, data: progress })
  })

  app.get('/api/progress/badges', async (request, reply) => {
    const badges = await prisma.badge.findMany({ orderBy: { createdAt: 'asc' } })
    return reply.send({ ok: true, data: badges })
  })

  app.get('/api/progress/leaderboard', async (_request, reply) => {
    const users = await prisma.user.findMany({
      where: { role: 'PLAYER', status: 'ACTIVE' },
      select: {
        id: true,
        username: true,
        level: true,
        xp: true,
        _count: {
          select: {
            matchEntries: true
          }
        }
      },
      orderBy: [{ level: 'desc' }, { xp: 'desc' }],
      take: 50
    })
    return reply.send({ ok: true, data: users })
  })
}
