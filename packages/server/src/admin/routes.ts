import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db/index.js'
import { requireRole } from '../auth/guards.js'
import { runInTransaction, ledger } from '../wallet/service.js'
import { invalidateSettingsCache } from '../settings/index.js'
import { listFraudFlags, checkLedgerInvariance } from '../fraud/index.js'

const adjustSchema = z.object({
  userId: z.string(),
  amount: z.number(),
  reason: z.string().max(200)
})

const userPatchSchema = z.object({
  userId: z.string(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'BANNED']).optional(),
  role: z.enum(['PLAYER', 'ADMIN']).optional()
})

const settingsPatchSchema = z.object({
  key: z.string(),
  value: z.unknown()
})

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  const adminGuard = requireRole(app, ['ADMIN', 'SUPERADMIN'])

  app.get('/api/admin/stats', { preHandler: adminGuard }, async (_request, reply) => {
    const [users, matches, completed, deposits, withdrawals] = await Promise.all([
      prisma.user.count(),
      prisma.match.count({ where: { status: { in: ['MATCH_STARTED', 'MATCH_IN_PROGRESS'] } } }),
      prisma.match.count({ where: { status: 'PRIZE_SETTLED' } }),
      prisma.walletTransaction.count({ where: { type: 'DEPOSIT' } }),
      prisma.walletTransaction.count({ where: { type: 'WITHDRAWAL' } })
    ])
    const revenue = await prisma.walletTransaction.aggregate({
      where: { type: 'PLATFORM_FEE' },
      _sum: { amount: true }
    })
    return reply.send({
      ok: true,
      data: {
        users,
        activeMatches: matches,
        completedMatches: completed,
        deposits,
        withdrawals,
        platformRevenue: revenue._sum.amount ? Number(revenue._sum.amount) : 0
      }
    })
  })

  app.get('/api/admin/users', { preHandler: adminGuard }, async (_request, reply) => {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
        wallet: true
      },
      orderBy: { createdAt: 'desc' },
      take: 200
    })
    return reply.send({ ok: true, data: users })
  })

  app.patch('/api/admin/users', { preHandler: adminGuard }, async (request, reply) => {
    const parsed = userPatchSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid input' })
    const user = await prisma.user.update({
      where: { id: parsed.data.userId },
      data: {
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        ...(parsed.data.role ? { role: parsed.data.role } : {})
      }
    })
    await prisma.adminAction.create({
      data: {
        adminId: request.authUser!.id,
        action: 'UPDATE_USER',
        targetType: 'USER',
        targetId: user.id,
        meta: parsed.data
      }
    })
    return reply.send({ ok: true, data: { id: user.id, status: user.status, role: user.role } })
  })

  app.post('/api/admin/wallet/adjust', { preHandler: adminGuard }, async (request, reply) => {
    const parsed = adjustSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid input' })
    const result = await runInTransaction(async (tx) => {
      await ledger.adjust(tx, {
        userId: parsed.data.userId,
        amount: parsed.data.amount,
        type: 'ADJUSTMENT',
        meta: { adminId: request.authUser!.id, reason: parsed.data.reason }
      })
      await tx.adminAction.create({
        data: {
          adminId: request.authUser!.id,
          action: 'WALLET_ADJUST',
          targetType: 'USER',
          targetId: parsed.data.userId,
          meta: { amount: parsed.data.amount, reason: parsed.data.reason }
        }
      })
      return true
    })
    return reply.send({ ok: true, data: result })
  })

  app.get('/api/admin/matches', { preHandler: adminGuard }, async (_request, reply) => {
    const matches = await prisma.match.findMany({
      include: { players: { include: { user: { select: { id: true, username: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 100
    })
    return reply.send({ ok: true, data: matches })
  })

  app.get('/api/admin/matches/:id/events', { preHandler: adminGuard }, async (request, reply) => {
    const events = await prisma.gameEvent.findMany({
      where: { matchId: (request.params as { id: string }).id },
      orderBy: { seq: 'asc' },
      take: 20000
    })
    return reply.send({ ok: true, data: events })
  })

  app.get('/api/admin/settings', { preHandler: adminGuard }, async (_request, reply) => {
    const settings = await prisma.appSetting.findMany()
    return reply.send({ ok: true, data: Object.fromEntries(settings.map((s) => [s.key, s.value])) })
  })

  app.patch('/api/admin/settings', { preHandler: adminGuard }, async (request, reply) => {
    const parsed = settingsPatchSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid input' })
    await prisma.appSetting.upsert({
      where: { key: parsed.data.key },
      create: { key: parsed.data.key, value: parsed.data.value as unknown as Prisma.InputJsonValue },
      update: { value: parsed.data.value as unknown as Prisma.InputJsonValue }
    })
    invalidateSettingsCache()
    await prisma.adminAction.create({
      data: {
        adminId: request.authUser!.id,
        action: 'SET_SETTING',
        targetType: 'SETTING',
        targetId: parsed.data.key,
        meta: { value: parsed.data.value } as unknown as Prisma.InputJsonValue
      }
    })
    return reply.send({ ok: true })
  })

  app.get('/api/admin/fraud', { preHandler: adminGuard }, async (_request, reply) => {
    const flags = await listFraudFlags()
    return reply.send({ ok: true, data: flags })
  })

  app.get('/api/admin/ledger/invariance', { preHandler: adminGuard }, async (_request, reply) => {
    const result = await checkLedgerInvariance()
    return reply.send({ ok: true, data: result })
  })

  app.get('/api/admin/actions', { preHandler: adminGuard }, async (_request, reply) => {
    const [actions, admins] = await Promise.all([
      prisma.adminAction.findMany({ orderBy: { createdAt: 'desc' }, take: 200 }),
      prisma.user.findMany({ select: { id: true, username: true } })
    ])
    const nameById = new Map(admins.map((a) => [a.id, a.username]))
    const rows = actions.map((a) => ({
      id: a.id,
      adminId: a.adminId,
      adminUsername: nameById.get(a.adminId) ?? null,
      action: a.action,
      targetType: a.targetType,
      targetId: a.targetId,
      meta: a.meta,
      createdAt: a.createdAt
    }))
    return reply.send({ ok: true, data: rows })
  })
}