import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { prisma } from '../db/index.js'
import { config } from '../config.js'
import { signToken } from './guards.js'
import { toPublicUser } from '../users/types.js'
import { isMaintenance } from '../settings/index.js'

const registerSchema = z.object({
  email: z.string().email(),
  username: z.string().min(3).max(24).regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(6).max(72)
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
})

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/register', { config: { public: true } }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() })
    }
    const { email, username, password } = parsed.data
    const existing = await prisma.user.findFirst({ where: { OR: [{ email }, { username }] } })
    if (existing) {
      return reply.code(409).send({ ok: false, error: 'email or username already taken' })
    }
    const passwordHash = bcrypt.hashSync(password, 10)
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          username,
          passwordHash,
          profile: { create: {} },
          wallet: { create: { available: config.CR_START_BALANCE } }
        }
      })
      await tx.walletTransaction.create({
        data: {
          userId: created.id,
          type: 'START_BALANCE',
          amount: config.CR_START_BALANCE,
          currency: 'CR',
          status: 'COMPLETED',
          balanceBefore: 0,
          balanceAfter: config.CR_START_BALANCE,
          meta: { description: 'welcome virtual balance' }
        }
      })
      return created
    })
    const token = signToken({ id: user.id, username: user.username, role: user.role, status: user.status })
    reply.setCookie('token', token, { httpOnly: true, sameSite: 'lax', path: '/' })
    return reply.send({ ok: true, data: { user: toPublicUser(user), token } })
  })

  app.post('/api/auth/login', { config: { public: true } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: 'invalid input' })
    }
    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } })
    if (!user || !bcrypt.compareSync(parsed.data.password, user.passwordHash)) {
      return reply.code(401).send({ ok: false, error: 'invalid credentials' })
    }
    if (user.status !== 'ACTIVE') {
      return reply.code(403).send({ ok: false, error: 'account not active' })
    }
    if ((await isMaintenance()) && user.role !== 'ADMIN' && user.role !== 'SUPERADMIN') {
      return reply.code(503).send({ ok: false, error: 'maintenance in progress' })
    }
    const token = signToken({ id: user.id, username: user.username, role: user.role, status: user.status })
    reply.setCookie('token', token, { httpOnly: true, sameSite: 'lax', path: '/' })
    return reply.send({ ok: true, data: { user: toPublicUser(user), token } })
  })

  app.post('/api/auth/logout', async (request, reply) => {
    reply.clearCookie('token', { path: '/' })
    return reply.send({ ok: true })
  })

  app.get('/api/auth/status', async (request, reply) => {
    if (!request.authUser) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' })
    }
    return reply.send({ ok: true, data: { user: request.authUser } })
  })
}