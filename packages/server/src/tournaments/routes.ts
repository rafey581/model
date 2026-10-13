import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db/index.js'
import { createTournament, joinTournament } from './service.js'
import { MatchError } from '../matches/service.js'

const createSchema = z.object({
  name: z.string().max(64).default('8-Player Cup')
})

const joinSchema = z.object({
  tournamentId: z.string()
})

export async function registerTournamentRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/tournaments', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body ?? { name: '8-Player Cup' })
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid input' })
    const tournament = await createTournament(parsed.data.name)
    return reply.send({ ok: true, data: tournament })
  })

  app.get('/api/tournaments/open', async (_request, reply) => {
    const open = await prisma.tournament.findMany({
      where: { status: { in: ['OPEN', 'DRAFT'] } },
      include: { _count: { select: { players: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50
    })
    return reply.send({ ok: true, data: open })
  })

  app.get('/api/tournaments/mine', async (request, reply) => {
    const list = await prisma.tournament.findMany({
      where: {
        players: { some: { userId: request.authUser!.id } },
        status: { in: ['DRAFT', 'OPEN', 'IN_PROGRESS'] }
      },
      select: {
        id: true,
        name: true,
        status: true,
        createdAt: true,
        _count: { select: { players: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: 50
    })
    return reply.send({ ok: true, data: list })
  })

  app.post('/api/tournaments/join', async (request, reply) => {
    const parsed = joinSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid input' })
    try {
      const result = await joinTournament(parsed.data.tournamentId, request.authUser!.id)
      return reply.send({ ok: true, data: result })
    } catch (error) {
      if (error instanceof MatchError) return reply.code(400).send({ ok: false, error: error.message })
      throw error
    }
  })

  app.get('/api/tournaments/:id', async (request, reply) => {
    const tournament = await prisma.tournament.findUnique({
      where: { id: (request.params as { id: string }).id },
      include: {
        players: { include: { user: { select: { id: true, username: true } } }, orderBy: { seed: 'asc' } },
        matches: { include: { players: { include: { user: { select: { id: true, username: true } } } } } }
      }
    })
    if (!tournament) return reply.code(404).send({ ok: false, error: 'tournament not found' })
    return reply.send({ ok: true, data: tournament })
  })

  app.get('/api/tournaments/history', async (_request, reply) => {
    const tournaments = await prisma.tournament.findMany({
      where: { status: 'COMPLETED' },
      include: {
        _count: { select: { players: true } },
        players: {
          where: { status: 'CHAMPION' },
          include: { user: { select: { id: true, username: true } } },
          take: 1
        }
      },
      orderBy: { finishedAt: 'desc' },
      take: 50
    })
    return reply.send({ ok: true, data: tournaments })
  })
}