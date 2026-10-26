import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { Prisma } from '@prisma/client'
import { prisma } from '../db/index.js'
import { config } from '../config.js'
import { signToken, verifyToken } from './guards.js'
import { toPublicUser } from '../users/types.js'
import { isMaintenance } from '../settings/index.js'
import { checkUsername, isValidUsernameFormat } from './username.js'
import { normalizeEmail } from './otp.js'
import { notify } from '../notifications/service.js'
import { assertValidReferralCode, pickReferralCode, ReferralError } from '../referrals/service.js'

/**
 * Player authentication.
 *
 * Accounts are created directly with email + username + password. No OTP or
 * email verification is required. Login is username + password.
 */

const registerSchema = z.object({
  email: z.string().trim().email().max(160),
  username: z.string().trim().min(3).max(24),
  password: z.string().min(6).max(72),
  name: z.string().trim().min(2).max(80).optional(),
  phone: z.string().trim().min(7).max(20),
  ref: z.string().trim().max(32).optional()
})

const loginSchema = z
  .object({
    username: z.string().trim().min(1).max(160).optional(),
    email: z.string().trim().min(1).max(160).optional(),
    password: z.string().min(1)
  })
  .refine((value) => Boolean(value.username || value.email), { message: 'username or email is required' })

function issueSession(reply: FastifyReply, user: { id: string; username: string; role: string; status: string }) {
  const token = signToken({ id: user.id, username: user.username, role: user.role, status: user.status })
  reply.setCookie('token', token, { httpOnly: true, sameSite: 'lax', path: '/' })
  return token
}

function isUniqueViolation(error: unknown, field?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false
  if (!field) return true
  const target = (error.meta?.target as string[] | undefined) ?? []
  return target.includes(field)
}

async function createAccount(
  app: FastifyInstance,
  request: any,
  reply: FastifyReply,
  body: z.infer<typeof registerSchema>
): Promise<any> {
  if (!config.AUTH_ALLOW_DIRECT_REGISTER) {
    return reply.code(403).send({ ok: false, error: 'registration is disabled' })
  }

  const { email, username, password, name, phone, ref } = body
  const value = username.trim()
  if (!isValidUsernameFormat(value)) {
    const check = await checkUsername(value)
    return reply.code(400).send({ ok: false, error: check.message ?? 'invalid username' })
  }
  const availability = await checkUsername(value)
  if (!availability.available) {
    return reply.code(409).send({ ok: false, error: availability.message ?? 'username taken' })
  }

  // Basic phone normalization - digits and optional +
  const normalizedPhone = phone.trim().replace(/[^+0-9]/g, '')

  let referredById: string | null = null
  if (ref) {
    try {
      referredById = (await assertValidReferralCode(ref, value)).id
    } catch (error) {
      if (error instanceof ReferralError) return reply.code(400).send({ ok: false, error: error.message })
      throw error
    }
  }

  const passwordHash = bcrypt.hashSync(password, 10)
  const referralCode = await pickReferralCode()
  const normalizedEmail = normalizeEmail(email)

  try {
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: normalizedEmail,
          phone: normalizedPhone,
          emailVerified: true,
          phoneVerified: false,
          name: name?.trim() || value,
          username: value,
          passwordHash,
          role: 'PLAYER',
          authProvider: 'PASSWORD',
          referralCode,
          referredById,
          profile: { create: {} },
          wallet: { create: { available: config.START_BALANCE } }
        }
      })
      await tx.walletTransaction.create({
        data: {
          userId: created.id,
          type: 'START_BALANCE',
          amount: config.START_BALANCE,
          currency: 'USDT',
          status: 'COMPLETED',
          balanceBefore: 0,
          balanceAfter: config.START_BALANCE,
          meta: { description: 'welcome balance (USDT)' }
        }
      })
      return created
    })

    const token = issueSession(reply, user)
    if (referredById) {
      void notify(
        referredById,
        'REFERRAL_JOIN',
        'Someone joined with your invite',
        `${user.username} created an account with your invite code. You earn ${config.REFERRAL_BONUS_USDT} USDT when they play their first match.`
      )
    }
    return reply.send({ ok: true, data: { user: toPublicUser(user), token } })
  } catch (error) {
    if (isUniqueViolation(error, 'email')) {
      return reply.code(409).send({ ok: false, error: 'That email address is already registered.' })
    }
    if (isUniqueViolation(error, 'username')) {
      return reply.code(409).send({ ok: false, error: 'That username is already taken.' })
    }
    if (isUniqueViolation(error, 'phone')) {
      return reply.code(409).send({ ok: false, error: 'That phone number is already registered.' })
    }
    throw error
  }
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  /** GET /api/auth/username/check?username=... - live availability for the signup form. */
  app.get('/api/auth/username/check', { config: { public: true } }, async (request, reply) => {
    const parsed = z.object({ username: z.string().min(1).max(64) }).safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid username' })
    const result = await checkUsername(parsed.data.username)
    return reply.send({ ok: true, data: result })
  })

  /**
   * POST /api/auth/signup
   *
   * Create an account directly with email + username + password. No OTP required.
   */
  app.post('/api/auth/signup', { config: { public: true } }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() })
    return createAccount(app, request, reply, parsed.data)
  })

  /**
   * POST /api/auth/register
   *
   * Create an account directly with email + username + password. No OTP required.
   */
  app.post('/api/auth/register', { config: { public: true } }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() })
    return createAccount(app, request, reply, parsed.data)
  })

  /**
   * POST /api/auth/login
   *
   * Username + password with login attempt limiting.
   */
  app.post('/api/auth/login', { config: { public: true } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid input' })

    const { username, email, password } = parsed.data
    const user = username
      ? await prisma.user.findFirst({ where: { username: { equals: username, mode: 'insensitive' } } })
      : await prisma.user.findUnique({ where: { email: normalizeEmail(email ?? '') } })

    if (!user) {
      return reply.code(401).send({ ok: false, error: 'invalid credentials' })
    }

    // Check if account is locked
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return reply.code(429).send({ ok: false, error: 'Account temporarily locked due to too many failed login attempts. Try again later.' })
    }

    if (!user.passwordHash || !bcrypt.compareSync(password, user.passwordHash)) {
      const attempts = (user.failedLoginAttempts || 0) + 1
      const maxAttempts = 5
      if (attempts >= maxAttempts) {
        const lockMinutes = 15
        await prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginAttempts: attempts,
            lockedUntil: new Date(Date.now() + lockMinutes * 60 * 1000)
          }
        })
        return reply.code(429).send({ ok: false, error: 'Too many failed login attempts. Account locked for 15 minutes.' })
      }
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: attempts }
      })
      return reply.code(401).send({ ok: false, error: 'invalid credentials' })
    }

    // Successful login - reset failed attempts
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        lastLoginIp: request.ip
      }
    })

    if (user.role === 'ADMIN' || user.role === 'SUPERADMIN') {
      await prisma.adminAction.create({
        data: {
          adminId: user.id,
          action: 'auth.admin_login_refused',
          targetType: 'User',
          targetId: user.id,
          meta: { username: user.username, ip: request.ip }
        }
      })
      return reply.code(403).send({ ok: false, error: 'use the admin sign-in' })
    }
    if (user.status !== 'ACTIVE') {
      return reply.code(403).send({ ok: false, error: 'account not active' })
    }
    if ((await isMaintenance()) && user.role !== 'ADMIN' && user.role !== 'SUPERADMIN') {
      return reply.code(503).send({ ok: false, error: 'maintenance in progress' })
    }
    const token = issueSession(reply, user)
    return reply.send({ ok: true, data: { user: toPublicUser(user), token } })
  })

  /** POST /api/auth/password/forgot */
  app.post('/api/auth/password/forgot', { config: { public: true } }, async (request, reply) => {
    const schema = z.object({
      email: z.string().trim().email(),
      phone: z.string().trim().min(7).max(20),
      username: z.string().trim().min(3).max(24),
      name: z.string().trim().min(2).max(80).optional()
    })
    const parsed = schema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: 'Please provide matching account details.' })
    }
    const { email, phone, username } = parsed.data
    const normalizedEmail = normalizeEmail(email)
    const normalizedPhone = phone.trim().replace(/[^+0-9]/g, '')

    const user = await prisma.user.findFirst({
      where: {
        email: normalizedEmail,
        username: { equals: username, mode: 'insensitive' },
        phone: normalizedPhone
      }
    })
    if (!user) {
      return reply.code(400).send({ ok: false, error: 'No account matches the provided details.' })
    }
    return reply.send({ ok: true, data: { userId: user.id, username: user.username } })
  })

  /** POST /api/auth/password/reset */
  app.post('/api/auth/password/reset', { config: { public: true } }, async (request, reply) => {
    const schema = z.object({
      userId: z.string().min(1),
      password: z.string().min(6).max(72)
    })
    const parsed = schema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: 'invalid request' })
    }
    const { userId, password } = parsed.data
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user || user.status !== 'ACTIVE') {
      return reply.code(400).send({ ok: false, error: 'Account not available.' })
    }
    const passwordHash = bcrypt.hashSync(password, 10)
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null }
    })
    return reply.send({ ok: true, data: { reset: true } })
  })

  /**
   * POST /api/auth/guest
   *
   * A short-lived session with no wallet. Practice is free; stakes, cash, and
   * friends are refused with the guest prompt. The client falls back to a local
   * frame when this request cannot reach the server.
   */
  app.post('/api/auth/guest', { config: { public: true } }, async (_request, reply) => {
    if (!config.AUTH_ALLOW_GUEST) {
      return reply.code(403).send({ ok: false, error: 'guest play is disabled' })
    }
    let user: Awaited<ReturnType<typeof prisma.user.create>> | null = null
    for (let attempt = 0; attempt < 3 && !user; attempt++) {
      const suffix = Math.random().toString(36).slice(2, 8)
      try {
        user = await prisma.user.create({
          data: {
            username: `Guest${suffix}`,
            email: `guest-${suffix}@guest.local`,
            passwordHash: '!',
            role: 'PLAYER',
            authProvider: 'GUEST',
            name: 'Guest'
          }
        })
      } catch (error) {
        if (!isUniqueViolation(error) || attempt === 2) throw error
      }
    }
    if (!user) return reply.code(500).send({ ok: false, error: 'guest play is unavailable' })
    const token = signToken(
      { id: user.id, username: user.username, role: user.role, status: user.status },
      4 * 60 * 60
    )
    reply.setCookie('token', token, { httpOnly: true, sameSite: 'lax', path: '/' })
    return reply.send({ ok: true, data: { user: toPublicUser(user), token } })
  })

  /**
   * POST /api/auth/logout
   */
  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie('token', { path: '/' })
    return reply.send({ ok: true })
  })

  /**
   * GET /api/auth/session
   *
   * The page asks for this when it has a cookie but no token in storage, which is
   * how a reload finds a session that was set by the login response. No session is
   * a 401, the same answer as a missing bearer, so the client shows the sign-in card.
   */
  app.get('/api/auth/session', { config: { public: true } }, async (request, reply) => {
    const token = request.cookies?.token || request.headers.authorization?.replace('Bearer ', '')
    if (!token) return reply.code(401).send({ ok: false, error: 'unauthorized' })
    const payload = verifyToken(token)
    if (!payload) return reply.code(401).send({ ok: false, error: 'invalid token' })
    const user = await prisma.user.findUnique({ where: { id: payload.id } })
    if (!user || user.status !== 'ACTIVE') return reply.code(403).send({ ok: false, error: 'account not active' })
    return reply.send({ ok: true, data: { user: toPublicUser(user), token } })
  })

  /**
   * GET /api/auth/status
   */
  app.get('/api/auth/status', async (request, reply) => {
    const token = (request as any).cookies?.token || request.headers.authorization?.replace('Bearer ', '')
    if (!token) return reply.send({ ok: true, data: { authenticated: false } })
    try {
      const payload = verifyToken(token)
      if (!payload) return reply.send({ ok: true, data: { authenticated: false } })
      const user = await prisma.user.findUnique({ where: { id: payload.id } })
      if (!user || user.status !== 'ACTIVE') return reply.send({ ok: true, data: { authenticated: false } })
      return reply.send({ ok: true, data: { authenticated: true, user: toPublicUser(user) } })
    } catch {
      return reply.send({ ok: true, data: { authenticated: false } })
    }
  })
}
