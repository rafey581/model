import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { prisma } from '../db/index.js'
import { requireAdminSession } from '../admin/auth.js'
import {
  withdrawInfo,
  createWithdrawal,
  approveWithdrawal,
  rejectWithdrawal,
  cancelWithdrawal,
  WithdrawalNotCancellableError,
  WithdrawalNotFoundError,
  WithdrawalAlreadyReviewedError,
  InsufficientWithdrawBalanceError,
  InsufficientBalanceError
} from './service.js'

const createWithdrawalSchema = z.object({
  amountUsdt: z.number({ errorMap: () => ({ message: 'amount is required' }) }).positive('amount must be greater than 0'),
  // The player's own Solana address — where the payout goes. Real addresses are
  // 32-44 base58 chars; be permissive (the admin verifies the account before any
  // payout) but short enough to reject obvious junk.
  address: z.string().trim().min(20, 'enter the wallet address that should receive the funds').max(120, 'that address looks too long'),
  // The account password, asked again for every payout: a stolen login or an unlocked
  // phone is not enough to send the balance away.
  password: z.string({ errorMap: () => ({ message: 'enter your password to confirm the withdrawal' }) }).min(1).max(72)
})

const rejectSchema = z.object({
  reason: z.string().trim().max(200).optional()
})

function pagination(request: { url: string }): { take: number; skip: number } {
  const url = new URL(request.url, 'http://localhost')
  const take = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100)
  const skip = Math.max(Number(url.searchParams.get('offset')) || 0, 0)
  return { take, skip }
}

/** Player-facing withdrawal routes (authed player path). */
export async function registerWithdrawalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/withdraw/info', async (_request, reply) => {
    return reply.send({ ok: true, data: withdrawInfo() })
  })

  app.post('/api/withdrawals', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const parsed = createWithdrawalSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() })

    const { amountUsdt, address, password } = parsed.data
    const account = await prisma.user.findUnique({ where: { id: request.authUser!.id }, select: { passwordHash: true } })
    if (!account?.passwordHash || !bcrypt.compareSync(password, account.passwordHash)) {
      return reply.code(403).send({ ok: false, error: 'Wrong password. The withdrawal was not requested.', code: 'wrong_password' })
    }
    const info = withdrawInfo()

    if (!info.enabled) return reply.code(403).send({ ok: false, error: 'withdrawals are currently disabled' })
    if (amountUsdt < info.minUsdt || amountUsdt > info.maxUsdt) {
      return reply.code(400).send({
        ok: false,
        error: `amount must be between ${info.minUsdt} and ${info.maxUsdt} ${info.currency}`
      })
    }

    try {
      const created = await createWithdrawal({ userId: request.authUser!.id, amountUsdt, address })
      return reply.code(201).send({ ok: true, data: created })
    } catch (error) {
      if (error instanceof InsufficientWithdrawBalanceError) {
        return reply.code(400).send({
          ok: false,
          error: `you need ${error.requiredUsdt} USDT to withdraw ${amountUsdt} ${info.currency}, but your available balance is ${error.availableUsdt} USDT`
        })
      }
      throw error
    }
  })

  app.post('/api/withdrawals/:id/cancel', async (request, reply) => {
    const id = (request.params as { id: string }).id
    try {
      const result = await cancelWithdrawal(id, request.authUser!.id)
      return reply.send({ ok: true, data: result })
    } catch (error) {
      if (error instanceof WithdrawalNotFoundError) return reply.code(404).send({ ok: false, error: 'withdrawal not found' })
      if (error instanceof WithdrawalNotCancellableError) {
        return reply.code(400).send({ ok: false, error: 'this request has already been reviewed and can no longer be cancelled' })
      }
      throw error
    }
  })

  app.get('/api/withdrawals', async (request, reply) => {
    const { take, skip } = pagination(request)
    const [items, total] = await Promise.all([
      prisma.cryptoWithdrawal.findMany({
        where: { userId: request.authUser!.id },
        orderBy: { createdAt: 'desc' },
        take,
        skip
      }),
      prisma.cryptoWithdrawal.count({ where: { userId: request.authUser!.id } })
    ])
    return reply.send({ ok: true, data: { items, total } })
  })
}

/**
 * Admin withdrawal routes. Same gating contract as the rest of the admin API:
 * public at the hook level, guarded by the revocable admin session.
 */
export async function registerAdminWithdrawalRoutes(app: FastifyInstance): Promise<void> {
  const adminGuard = requireAdminSession
  const reviewedError = (error: unknown, reply: { code: (n: number) => { send: (o: object) => void } }) => {
    if (error instanceof WithdrawalNotFoundError) return reply.code(404).send({ ok: false, error: 'withdrawal not found' })
    if (error instanceof WithdrawalAlreadyReviewedError) {
      return reply.code(400).send({ ok: false, error: 'this withdrawal has already been reviewed' })
    }
    if (error instanceof InsufficientBalanceError) {
      return reply.code(400).send({ ok: false, error: 'the player no longer has enough balance to cover this withdrawal' })
    }
    throw error
  }

  app.get('/api/admin/withdrawals', { config: { public: true }, preHandler: adminGuard }, async (request, reply) => {
    const url = new URL(request.url, 'http://localhost')
    const status = url.searchParams.get('status') ?? undefined
    const { take } = pagination(request)

    const where = status && ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(status) ? { status } : {}
    const items = await prisma.cryptoWithdrawal.findMany({
      where,
      include: {
        user: { select: { id: true, username: true, email: true } },
        reviewedBy: { select: { id: true, username: true } }
      },
      orderBy: { createdAt: 'desc' },
      take
    })
    const pending = await prisma.cryptoWithdrawal.count({ where: { status: 'PENDING' } })
    return reply.send({ ok: true, data: { items, pending } })
  })

  app.post(
    '/api/admin/withdrawals/:id/approve',
    { config: { public: true }, preHandler: adminGuard },
    async (request, reply) => {
      const id = (request.params as { id: string }).id
      try {
        const result = await approveWithdrawal(id, request.authUser!.id)
        return reply.send({ ok: true, data: result })
      } catch (error) {
        return reviewedError(error, reply)
      }
    }
  )

  app.post(
    '/api/admin/withdrawals/:id/reject',
    { config: { public: true }, preHandler: adminGuard },
    async (request, reply) => {
      const parsed = rejectSchema.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid input' })
      const id = (request.params as { id: string }).id
      try {
        const result = await rejectWithdrawal(id, request.authUser!.id, parsed.data.reason)
        return reply.send({ ok: true, data: result })
      } catch (error) {
        return reviewedError(error, reply)
      }
    }
  )
}