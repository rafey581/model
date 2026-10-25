import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db/index.js'
import { requireAdminSession } from './auth.js'
import { runInTransaction, ledger } from '../wallet/service.js'
import { invalidateSettingsCache } from '../settings/index.js'
import { listFraudFlags, checkLedgerInvariance } from '../fraud/index.js'
import { dashboardStats, safeTimeZone, startOfDay } from './stats.js'
import { threadsAwaitingReply } from '../support/service.js'

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
  /**
   * Every admin route is `public` at the *hook* level and gated by this guard.
   *
   * Marking them public does not mean unauthenticated - it means the global
   * player-token preHandler steps aside so that `requireAdminSession` is the only
   * thing deciding access. That matters because the two credentials are different:
   * a player JWT must not be able to present itself to the admin API, and an admin
   * session must be revocable independently of any token's expiry.
   */
  const adminGuard = requireAdminSession

  /** Just what is waiting on staff, for the app's tab badges (polled; kept cheap). */
  app.get('/api/admin/pending', { config: { public: true }, preHandler: adminGuard }, async (_request, reply) => {
    const [pendingDeposits, pendingWithdrawals, supportAwaiting] = await Promise.all([
      prisma.cryptoDeposit.count({ where: { status: 'PENDING' } }),
      prisma.cryptoWithdrawal.count({ where: { status: 'PENDING' } }),
      threadsAwaitingReply()
    ])
    return reply.send({ ok: true, data: { pendingDeposits, pendingWithdrawals, supportAwaiting } })
  })

  app.get('/api/admin/stats', { config: { public: true }, preHandler: adminGuard }, async (request, reply) => {
    const tz = new URL(request.url, 'http://localhost').searchParams.get('tz')
    return reply.send({ ok: true, data: await dashboardStats(tz) })
  })

  /**
   * Players for the admin app. Search and filters run in the database, so a player
   * outside the newest page can still be found. Each row carries last-seen activity
   * and lifetime approved deposits/withdrawals, the two numbers staff ask first.
   */
  app.get('/api/admin/users', { config: { public: true }, preHandler: adminGuard }, async (request, reply) => {
    const params = new URL(request.url, 'http://localhost').searchParams
    const q = (params.get('q') ?? '').trim().slice(0, 80)
    const filter = params.get('filter') ?? ''
    const tz = safeTimeZone(params.get('tz'))
    const today = startOfDay(tz)
    const week = startOfDay(tz, new Date(), 6)

    const where: Prisma.UserWhereInput = {}
    if (q) {
      where.OR = [
        { username: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        { id: q }
      ]
    }
    if (filter === 'active') where.lastSeenAt = { gte: week }
    else if (filter === 'today') where.lastSeenAt = { gte: today }
    else if (filter === 'new') where.createdAt = { gte: today }
    else if (filter === 'suspended') where.status = 'SUSPENDED'
    else if (filter === 'banned') where.status = 'BANNED'
    else if (filter === 'staff') where.role = { in: ['ADMIN', 'SUPERADMIN'] }

    const orderBy: Prisma.UserOrderByWithRelationInput[] =
      filter === 'active' || filter === 'today' ? [{ lastSeenAt: 'desc' }] : [{ createdAt: 'desc' }]
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          username: true,
          email: true,
          phone: true,
          role: true,
          status: true,
          createdAt: true,
          lastSeenAt: true,
          lastLoginAt: true,
          level: true,
          wallet: true
        },
        orderBy,
        take: 200
      }),
      prisma.user.count({ where })
    ])
    const ids = users.map((u) => u.id)
    const [dep, wd] = await Promise.all([
      prisma.cryptoDeposit.groupBy({ by: ['userId'], where: { userId: { in: ids }, status: 'APPROVED' }, _sum: { creditedAmount: true } }),
      prisma.cryptoWithdrawal.groupBy({ by: ['userId'], where: { userId: { in: ids }, status: 'APPROVED' }, _sum: { deducted: true } })
    ])
    const deposited = new Map(dep.map((d) => [d.userId, Number(d._sum.creditedAmount ?? 0)]))
    const withdrawn = new Map(wd.map((w) => [w.userId, Number(w._sum.deducted ?? 0)]))
    reply.header('x-total-count', String(total))
    return reply.send({
      ok: true,
      data: users.map((u) => ({ ...u, totalDeposited: deposited.get(u.id) ?? 0, totalWithdrawn: withdrawn.get(u.id) ?? 0 }))
    })
  })

  app.patch('/api/admin/users', { config: { public: true }, preHandler: adminGuard }, async (request, reply) => {
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

  app.post('/api/admin/wallet/adjust', { config: { public: true }, preHandler: adminGuard }, async (request, reply) => {
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

  app.get('/api/admin/matches', { config: { public: true }, preHandler: adminGuard }, async (_request, reply) => {
    const matches = await prisma.match.findMany({
      include: { players: { include: { user: { select: { id: true, username: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 100
    })
    return reply.send({ ok: true, data: matches })
  })

  app.get('/api/admin/matches/:id/events', { config: { public: true }, preHandler: adminGuard }, async (request, reply) => {
    const events = await prisma.gameEvent.findMany({
      where: { matchId: (request.params as { id: string }).id },
      orderBy: { seq: 'asc' },
      take: 20000
    })
    return reply.send({ ok: true, data: events })
  })

  app.get('/api/admin/settings', { config: { public: true }, preHandler: adminGuard }, async (_request, reply) => {
    const settings = await prisma.appSetting.findMany()
    return reply.send({ ok: true, data: Object.fromEntries(settings.map((s) => [s.key, s.value])) })
  })

  app.patch('/api/admin/settings', { config: { public: true }, preHandler: adminGuard }, async (request, reply) => {
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

  app.get('/api/admin/fraud', { config: { public: true }, preHandler: adminGuard }, async (_request, reply) => {
    const flags = await listFraudFlags()
    return reply.send({ ok: true, data: flags })
  })

  app.get('/api/admin/ledger/invariance', { config: { public: true }, preHandler: adminGuard }, async (_request, reply) => {
    const result = await checkLedgerInvariance()
    return reply.send({ ok: true, data: result })
  })

  app.get('/api/admin/actions', { config: { public: true }, preHandler: adminGuard }, async (_request, reply) => {
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