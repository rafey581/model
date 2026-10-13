import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { prisma } from '../db/index.js'
import { requireAdminSession } from '../admin/auth.js'
import {
  depositInfo,
  createDeposit,
  approveDeposit,
  rejectDeposit,
  DepositNotFoundError,
  DepositAlreadyReviewedError,
  DuplicateDepositTxError
} from './service.js'

const createDepositSchema = z.object({
  amountUsdt: z.number({ errorMap: () => ({ message: 'amount is required' }) }).positive('amount must be greater than 0'),
  // A Solana signature is 87-88 base58 characters, but be permissive: the admin
  // verifies the actual transaction before anything is credited.
  txHash: z.string().trim().min(8, 'transaction id looks too short').max(200, 'transaction id looks too long'),
  screenshot: z.string().min(1, 'a proof screenshot is required')
})

const rejectSchema = z.object({
  reason: z.string().trim().max(200).optional()
})

const DATA_URL_PREFIX = 'data:image/'

/** Approximate raw byte size of a base64 data URL. */
function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  const b64 = comma === -1 ? dataUrl : dataUrl.slice(comma + 1)
  const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding)
}

function pagination(request: { url: string }): { take: number; skip: number } {
  const url = new URL(request.url, 'http://localhost')
  const take = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100)
  const skip = Math.max(Number(url.searchParams.get('offset')) || 0, 0)
  return { take, skip }
}

/** Player-facing deposit routes. Registered on the authed (player) path. */
export async function registerDepositRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/deposit/info', async (_request, reply) => {
    return reply.send({ ok: true, data: depositInfo() })
  })

  // The proof screenshot travels inside the JSON body (base64 inflates ~4/3),
  // so this route needs a larger body limit than the Fastify default (1 MB).
  // Allow up to double the raw cap so a max-size screenshot always fits and the
  // size check below can answer with a friendly error instead of a 413.
  app.post(
    '/api/deposits',
    { bodyLimit: config.DEPOSIT_SCREENSHOT_MAX_BYTES * 2 + 512 * 1024 },
    async (request, reply) => {
      const parsed = createDepositSchema.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() })

      const { amountUsdt, txHash, screenshot } = parsed.data
      const info = depositInfo()

      if (!info.enabled) return reply.code(403).send({ ok: false, error: 'crypto deposits are currently disabled' })
      if (!info.walletAddress) {
        return reply.code(400).send({ ok: false, error: 'deposits are not configured yet. Please check back later.' })
      }
      if (amountUsdt < info.minUsdt || amountUsdt > info.maxUsdt) {
        return reply.code(400).send({
          ok: false,
          error: `amount must be between ${info.minUsdt} and ${info.maxUsdt} ${info.currency}`
        })
      }
      if (!screenshot.startsWith(DATA_URL_PREFIX)) {
        return reply.code(400).send({ ok: false, error: 'the proof must be an image (PNG/JPG)' })
      }
      if (dataUrlBytes(screenshot) > info.screenshotMaxBytes) {
        return reply.code(400).send({ ok: false, error: 'the proof image is too large' })
      }

      try {
        const created = await createDeposit({ userId: request.authUser!.id, amountUsdt, txHash, screenshot })
        return reply.code(201).send({ ok: true, data: created })
      } catch (error) {
        if (error instanceof DuplicateDepositTxError) {
          return reply.code(400).send({ ok: false, error: 'this transaction id has already been used for a deposit request' })
        }
        throw error
      }
    }
  )

  app.get('/api/deposits', async (request, reply) => {
    const { take, skip } = pagination(request)
    const [items, total] = await Promise.all([
      prisma.cryptoDeposit.findMany({
        where: { userId: request.authUser!.id },
        orderBy: { createdAt: 'desc' },
        take,
        skip
      }),
      prisma.cryptoDeposit.count({ where: { userId: request.authUser!.id } })
    ])
    return reply.send({ ok: true, data: { items, total } })
  })
}

/**
 * Admin deposit routes. Same gating contract as `registerAdminRoutes`: public at
 * the hook level so a player token is never accepted, guarded by the revocable
 * admin session.
 */
export async function registerAdminDepositRoutes(app: FastifyInstance): Promise<void> {
  const adminGuard = requireAdminSession
  const reviewedError = (error: unknown, reply: { code: (n: number) => { send: (o: object) => void } }) => {
    if (error instanceof DepositNotFoundError) return reply.code(404).send({ ok: false, error: 'deposit not found' })
    if (error instanceof DepositAlreadyReviewedError) {
      return reply.code(400).send({ ok: false, error: 'this deposit has already been reviewed' })
    }
    throw error
  }

  app.get('/api/admin/deposits', { config: { public: true }, preHandler: adminGuard }, async (request, reply) => {
    const url = new URL(request.url, 'http://localhost')
    const status = url.searchParams.get('status') ?? undefined
    const { take } = pagination(request)

    const where = status && ['PENDING', 'APPROVED', 'REJECTED'].includes(status) ? { status } : {}
    const items = await prisma.cryptoDeposit.findMany({
      where,
      include: {
        user: { select: { id: true, username: true, email: true } },
        reviewedBy: { select: { id: true, username: true } }
      },
      orderBy: { createdAt: 'desc' },
      take
    })
    const pending = await prisma.cryptoDeposit.count({ where: { status: 'PENDING' } })
    return reply.send({ ok: true, data: { items, pending } })
  })

  app.post(
    '/api/admin/deposits/:id/approve',
    { config: { public: true }, preHandler: adminGuard },
    async (request, reply) => {
      const id = (request.params as { id: string }).id
      try {
        const result = await approveDeposit(id, request.authUser!.id)
        return reply.send({ ok: true, data: result })
      } catch (error) {
        return reviewedError(error, reply)
      }
    }
  )

  app.post(
    '/api/admin/deposits/:id/reject',
    { config: { public: true }, preHandler: adminGuard },
    async (request, reply) => {
      const parsed = rejectSchema.safeParse(request.body)
      if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid input' })
      const id = (request.params as { id: string }).id
      try {
        const result = await rejectDeposit(id, request.authUser!.id, parsed.data.reason)
        return reply.send({ ok: true, data: result })
      } catch (error) {
        return reviewedError(error, reply)
      }
    }
  )
}