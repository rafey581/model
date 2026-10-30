import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { Prisma } from '@prisma/client'
import { prisma } from '../db/index.js'
import { config } from '../config.js'
import { signToken, tokenIsCurrent, verifyToken } from './guards.js'
import { createHash } from 'node:crypto'
import { dateOfBirthProblem, normalizeName, parseDateOfBirth, sameDate } from './dob.js'
import jwt from 'jsonwebtoken'
import { toPublicUser } from '../users/types.js'
import { isMaintenance } from '../settings/index.js'
import { checkUsername, isValidUsernameFormat } from './username.js'
import { normalizeEmail } from './otp.js'
import { notify } from '../notifications/service.js'
import { assertValidReferralCode, pickReferralCode, ReferralError } from '../referrals/service.js'
import { assertDeviceCanSignUp, DEVICE_ID_PATTERN, DeviceIdRequiredError, DeviceLimitError, recordLoginDevice, recordSignupDevice } from '../devices/service.js'

/**
 * Player authentication.
 *
 * Accounts are created directly with email + username + password. No OTP or
 * email verification is required. Login is username + password.
 */

/** Shortest password accepted for a new account or a reset (logins accept older, shorter ones). */
const PASSWORD_MIN = 8
const RESET_TOKEN_TTL = '10m'

/** Changes whenever the password does, so a reset token works once and dies with a new password. */
function passwordFingerprint(passwordHash: string | null): string {
  return createHash('sha256').update(passwordHash ?? '').digest('hex').slice(0, 24)
}

const registerSchema = z.object({
  email: z.string().trim().email().max(160),
  username: z.string().trim().min(3).max(24),
  password: z.string().min(PASSWORD_MIN, `password must be at least ${PASSWORD_MIN} characters`).max(72),
  name: z.string().trim().min(2).max(80).optional(),
  phone: z.string().trim().min(7).max(20),
  ref: z.string().trim().max(32).optional(),
  // Which phone this is (one account per phone). Malformed ids are ignored rather than refused.
  deviceId: z.string().trim().max(130).optional(),
  // "YYYY-MM-DD"; checked (real date, old enough) in createAccount.
  dateOfBirth: z.string({ errorMap: () => ({ message: 'Please enter your date of birth.' }) }).trim().max(10)
})

const loginSchema = z
  .object({
    username: z.string().trim().min(1).max(160).optional(),
    email: z.string().trim().min(1).max(160).optional(),
    password: z.string().min(1),
    deviceId: z.string().trim().max(130).optional()
  })
  .refine((value) => Boolean(value.username || value.email), { message: 'username or email is required' })

function issueSession(reply: FastifyReply, user: { id: string; username: string; role: string; status: string; tokenVersion: number }) {
  const token = signToken({ id: user.id, username: user.username, role: user.role, status: user.status, tv: user.tokenVersion })
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
  const dobProblem = dateOfBirthProblem(body.dateOfBirth, config.MIN_SIGNUP_AGE)
  if (dobProblem) return reply.code(400).send({ ok: false, error: dobProblem })
  const dateOfBirth = parseDateOfBirth(body.dateOfBirth)!
  const deviceId = body.deviceId && DEVICE_ID_PATTERN.test(body.deviceId) ? body.deviceId : undefined
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

  const passwordHash = bcrypt.hashSync(password, 12)
  const referralCode = await pickReferralCode()
  const normalizedEmail = normalizeEmail(email)

  try {
    const user = await prisma.$transaction(async (tx) => {
      await assertDeviceCanSignUp(tx, deviceId)
      const created = await tx.user.create({
        data: {
          email: normalizedEmail,
          phone: normalizedPhone,
          emailVerified: true,
          phoneVerified: false,
          name: name?.trim() || value,
          dateOfBirth,
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
      await recordSignupDevice(tx, deviceId, created.id)
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
    if (error instanceof DeviceLimitError) return reply.code(409).send({ ok: false, error: error.message, code: 'device_limit' })
    if (error instanceof DeviceIdRequiredError) return reply.code(426).send({ ok: false, error: error.message, code: 'update_required' })
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
  app.post('/api/auth/signup', { config: { public: true, rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() })
    return createAccount(app, request, reply, parsed.data)
  })

  /**
   * POST /api/auth/register
   *
   * Create an account directly with email + username + password. No OTP required.
   */
  app.post('/api/auth/register', { config: { public: true, rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() })
    return createAccount(app, request, reply, parsed.data)
  })

  /**
   * POST /api/auth/login
   *
   * Username + password with login attempt limiting.
   */
  app.post('/api/auth/login', { config: { public: true, rateLimit: { max: 20, timeWindow: '5 minutes' } } }, async (request, reply) => {
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

    // The seed's fallback password is public; an account still on it cannot be used.
    if (password === 'admin123') {
      return reply.code(403).send({ ok: false, error: 'This password is no longer allowed. Use "Forgot password" to set a new one.' })
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
        lastSeenAt: new Date(),
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
    const deviceId = parsed.data.deviceId && DEVICE_ID_PATTERN.test(parsed.data.deviceId) ? parsed.data.deviceId : undefined
    await recordLoginDevice(deviceId, user.id)
    const token = issueSession(reply, user)
    return reply.send({ ok: true, data: { user: toPublicUser(user), token } })
  })

  /** POST /api/auth/password/forgot */
  /**
   * POST /api/auth/password/forgot
   *
   * Step one of a reset: the player proves who they are with the email, username and
   * phone on the account, and gets back a reset token. The token is what step two needs;
   * it lasts 10 minutes, works once (it is tied to the current password), and is never
   * issued for a staff account. The same answer is given for "no such account" and for a
   * staff account, so the form cannot be used to find out which details are real.
   */
  app.post('/api/auth/password/forgot', { config: { public: true, rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const schema = z.object({
      email: z.string().trim().email(),
      phone: z.string().trim().min(7).max(20),
      username: z.string().trim().min(3).max(24),
      name: z.string().trim().min(1).max(80),
      dateOfBirth: z.string().trim().max(10)
    })
    const parsed = schema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: 'Please fill in every detail: full name, username, email, phone and date of birth.' })
    }
    const { email, phone, username, name } = parsed.data
    const givenDob = parseDateOfBirth(parsed.data.dateOfBirth)
    const normalizedEmail = normalizeEmail(email)
    const normalizedPhone = phone.trim().replace(/[^+0-9]/g, '')

    const user = await prisma.user.findFirst({
      where: {
        email: normalizedEmail,
        username: { equals: username, mode: 'insensitive' },
        phone: normalizedPhone
      }
    })
    const noMatch = () => reply.code(400).send({ ok: false, error: 'No account matches the provided details.' })
    if (!user || user.role !== 'PLAYER' || user.status !== 'ACTIVE') return noMatch()
    // Every detail has to match, the full name and the date of birth included.
    if (normalizeName(user.name ?? '') !== normalizeName(name)) return noMatch()
    if (!user.dateOfBirth) {
      return reply.code(400).send({
        ok: false,
        error: 'This account has no date of birth saved, so it cannot be reset here. Please contact customer support.',
        code: 'no_dob'
      })
    }
    if (!givenDob || !sameDate(user.dateOfBirth, givenDob)) return noMatch()
    const resetToken = jwt.sign(
      { sub: user.id, purpose: 'password-reset', pv: passwordFingerprint(user.passwordHash) },
      config.JWT_SECRET,
      { expiresIn: RESET_TOKEN_TTL, algorithm: 'HS256' }
    )
    return reply.send({ ok: true, data: { resetToken, username: user.username } })
  })

  /**
   * POST /api/auth/password/reset
   *
   * Step two: a new password, with the reset token from step one. Nothing else is
   * accepted as proof. A successful reset signs the account out everywhere.
   */
  app.post('/api/auth/password/reset', { config: { public: true, rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const schema = z.object({
      resetToken: z.string().min(20).max(1000),
      password: z.string().min(PASSWORD_MIN, `password must be at least ${PASSWORD_MIN} characters`).max(72)
    })
    const parsed = schema.safeParse(request.body)
    if (!parsed.success) {
      const message = parsed.error.issues.find((i) => i.path[0] === 'password')?.message
      return reply.code(400).send({ ok: false, error: message ?? 'This reset link is not valid. Please start again.' })
    }
    const expired = () => reply.code(400).send({ ok: false, error: 'This reset has expired or was already used. Please start again.' })
    let claims: { sub?: string; purpose?: string; pv?: string }
    try {
      claims = jwt.verify(parsed.data.resetToken, config.JWT_SECRET, { algorithms: ['HS256'] }) as typeof claims
    } catch {
      return expired()
    }
    if (claims.purpose !== 'password-reset' || !claims.sub) return expired()
    const user = await prisma.user.findUnique({ where: { id: claims.sub } })
    if (!user || user.status !== 'ACTIVE' || user.role !== 'PLAYER') return expired()
    if (claims.pv !== passwordFingerprint(user.passwordHash)) return expired()

    const passwordHash = bcrypt.hashSync(parsed.data.password, 12)
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null, tokenVersion: { increment: 1 } }
    })
    reply.clearCookie('token', { path: '/' })
    return reply.send({ ok: true, data: { reset: true } })
  })

  /**
   * POST /api/auth/logout
   *
   * Public: clearing the cookie needs no proof of identity, and a player whose token
   * has already expired must still be able to sign out cleanly.
   */
  app.post('/api/auth/logout', { config: { public: true } }, async (_request, reply) => {
    reply.clearCookie('token', { path: '/' })
    return reply.send({ ok: true })
  })

  /**
   * GET /api/auth/session
   *
   * Exchanges a still-valid session cookie for the token the client keeps for its
   * socket and Authorization header, so a page that lost its stored token (cleared
   * storage, a new tab after an older build) does not show a login card to someone
   * who is signed in. 401 when there is no usable session.
   */
  app.get('/api/auth/session', { config: { public: true } }, async (request, reply) => {
    const cookieToken = request.cookies.token
    const payload = cookieToken ? verifyToken(cookieToken) : null
    if (!payload) return reply.code(401).send({ ok: false, error: 'no active session' })
    const user = await prisma.user.findUnique({ where: { id: payload.id } })
    if (!user || user.status !== 'ACTIVE' || !tokenIsCurrent(payload, user)) {
      reply.clearCookie('token', { path: '/' })
      return reply.code(401).send({ ok: false, error: 'no active session' })
    }
    return reply.send({ ok: true, data: { user: toPublicUser(user), token: cookieToken } })
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
      if (!user || user.status !== 'ACTIVE' || !tokenIsCurrent(payload, user)) return reply.send({ ok: true, data: { authenticated: false } })
      // A player who stays signed in never types a password again, so the phone is
      // recorded here too, on the check the app makes every time it opens.
      const deviceId = (request.query as { deviceId?: string } | undefined)?.deviceId
      if (deviceId && DEVICE_ID_PATTERN.test(deviceId)) await recordLoginDevice(deviceId, user.id)
      return reply.send({ ok: true, data: { authenticated: true, user: toPublicUser(user) } })
    } catch {
      return reply.send({ ok: true, data: { authenticated: false } })
    }
  })
}
