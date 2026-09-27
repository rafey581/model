import type { FastifyInstance } from 'fastify'
import { prisma } from '../db/index.js'

export async function registerWalletRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/wallet', async (request, reply) => {
    const wallet = await prisma.wallet.findUnique({ where: { userId: request.authUser!.id } })
    return reply.send({
      ok: true,
      data: {
        balance: wallet ? Number(wallet.available) : 0,
        locked: wallet ? Number(wallet.locked) : 0,
        total: wallet ? Number(wallet.available.add(wallet.locked)) : 0,
        currency: wallet?.currency ?? 'CR'
      }
    })
  })

  app.get('/api/wallet/transactions', async (request, reply) => {
    const url = new URL(request.url, 'http://localhost')
    const limit = Number(url.searchParams.get('limit') ?? 50)
    const offset = Number(url.searchParams.get('offset') ?? 0)
    const transactions = await prisma.walletTransaction.findMany({
      where: { userId: request.authUser!.id },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
      skip: offset
    })
    return reply.send({ ok: true, data: transactions })
  })
}