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
import {
  createOtpChallenge,
  isEmail,
  isPhone,
  maskIdentifier,
  normalizeEmail,
  normalizePhone,
  secondsUntilResendAllowed,
  verifyOtpChallenge,
  type OtpChannel,
  type OtpPurpose
} from './otp.js'
import { sendOtpCode } from './delivery.js'
import { notify } from '../notifications/service.js'
import { assertValidReferralCode, pickReferralCode, ReferralError } from '../referrals/service.js'

/**
 * Player authentication.
 *
 * There is one way in: a local account with a username and a password. The email
 * address and the WhatsApp number captured at signup are both unique and both
 * proof-of-contact, but only one of them - whichever the player chooses - is verified
 * with a one-time code before the account is created. Login is username + password,
 * and a forgotten password is reset with another code sent to the email or number.
 *
 * The account is created only after the code is verified, so an unverified signup never
 * leaves a half-built user behind. The signup payload is held server-side on the OTP
 * challenge for exactly that reason: the password hash and date of birth are never
 * handed back to the browser in a token it could edit.
 */

const signupStartSchema = z.object({
  name: z.string().trim().min(2).max(80),
  username: z.string().trim().min(3).max(24),
  email: z.string().trim().email().max(160),
  phone: z.string().trim().min(6).max(24),
  dateOfBirth: z.string().trim().min(4).max(40),
  password: z.string().min(6).max(72),
  verifyVia: z.enum(['email', 'whatsapp']),
  // Optional inviter code, from the `?ref=` link or typed by hand.
  ref: z.string().trim().max(32).optional()
})

const verifySchema = z.object({
  challengeId: z.string().min(10).max(200),
  code: z.string().trim().min(4).max(10)
})

const resendSchema = z.object({ challengeId: z.string().min(10).max(200) })

const loginSchema = z
  .object({
    username: z.string().trim().min(1).max(160).optional(),
    email: z.string().trim().min(1).max(160).optional(),
    password: z.string().min(1)
  })
  .refine((value) => Boolean(value.username || value.email), { message: 'username or email is required' })

const forgotSchema = z.object({ identifier: z.string().trim().min(3).max(160) })

const resetSchema = z.object({
  challengeId: z.string().min(10).max(200),
  code: z.string().trim().min(4).max(10),
  password: z.string().min(6).max(72)
})

const registerSchema = z.object({
  email: z.string().email(),
  username: z.string().min(3).max(24),
  password: z.string().min(6).max(72),
  ref: z.string().trim().max(32).optional()
})

/** The signup form, parked untouched until the code proves the address. */
interface SignupPayload {
  name: string
  username: string
  email: string | null
  phone: string | null
  dateOfBirth: string
  passwordHash: string
  verifyVia: 'email' | 'whatsapp'
  /** The inviter resolved from the code at signup/start; null when none was given. */
  referredById?: string | null
}

interface ResetPayload {
  userId: string | null
}

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

/**
 * The address (email or number) and channel a signup or reset will verify.
 *
 * Normalised here so the string a code is minted for is byte-for-byte the string that
 * is later compared - spaces or a missing `+` would otherwise silently never match.
 */
function destinationFor(verifyVia: 'email' | 'whatsapp', email: string, phone: string): { channel: OtpChannel; identifier: string } {
  return verifyVia === 'email'
    ? { channel: 'EMAIL', identifier: normalizeEmail(email) }
    : { channel: 'WHATSAPP', identifier: normalizePhone(phone) }
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
   * POST /api/auth/signup/start
   *
   * Validates the whole signup form, checks that the email, phone and username are all
   * free, mints a code against whichever address the player chose to verify, and stashes
   * the form on the challenge. Nothing is created yet.
   */
  app.post('/api/auth/signup/start', { config: { public: true } }, async (request, reply) => {
    const parsed = signupStartSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() })
    const { name, username, email, phone, dateOfBirth, password, verifyVia, ref } = parsed.data

    const value = username.trim()
    if (!isValidUsernameFormat(value)) {
      const check = await checkUsername(value)
      return reply.code(400).send({ ok: false, error: check.message ?? 'invalid username' })
    }
    const availability = await checkUsername(value)
    if (!availability.available) {
      return reply.code(409).send({ ok: false, error: availability.message ?? 'username taken' })
    }

    if (!isEmail(email)) return reply.code(400).send({ ok: false, error: 'that does not look like an email address' })
    if (!isPhone(phone)) return reply.code(400).send({ ok: false, error: 'that does not look like a phone number' })

    const dob = new Date(dateOfBirth)
    if (Number.isNaN(dob.getTime())) return reply.code(400).send({ ok: false, error: 'that date of birth is not valid' })
    if (dob.getTime() > Date.now()) return reply.code(400).send({ ok: false, error: 'date of birth cannot be in the future' })

    const normalizedEmail = normalizeEmail(email)
    const normalizedPhone = normalizePhone(phone)

    const emailTaken = await prisma.user.findUnique({ where: { email: normalizedEmail } })
    if (emailTaken) return reply.code(409).send({ ok: false, error: 'That email address is already registered.' })
    const phoneTaken = await prisma.user.findUnique({ where: { phone: normalizedPhone } })
    if (phoneTaken) return reply.code(409).send({ ok: false, error: 'That WhatsApp number is already registered.' })

    // A code the player typed must be valid: an unknown one is answered now, while
    // they are still on the form, rather than silently dropping the invitation.
    let referredById: string | null = null
    if (ref) {
      try {
        const referrer = await assertValidReferralCode(ref, value)
        referredById = referrer.id
      } catch (error) {
        if (error instanceof ReferralError) return reply.code(400).send({ ok: false, error: error.message })
        throw error
      }
    }

    const { channel, identifier } = destinationFor(verifyVia, email, phone)

    const cooldown = await secondsUntilResendAllowed(identifier, 'SIGNUP')
    if (cooldown > 0) {
      return reply.code(429).send({ ok: false, error: `Please wait ${cooldown}s before requesting another code.` })
    }

    const payload: SignupPayload = {
      name: name.trim(),
      username: value,
      email: normalizedEmail,
      phone: normalizedPhone,
      dateOfBirth: dob.toISOString(),
      passwordHash: bcrypt.hashSync(password, 10),
      verifyVia,
      referredById
    }

    let challenge
    try {
      challenge = await createOtpChallenge({ identifier, channel, purpose: 'SIGNUP', payload: payload as unknown as Prisma.InputJsonValue })
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ ok: false, error: 'That email address or number is already registered.' })
      }
      throw error
    }

    await sendOtpCode({ channel, identifier, code: challenge.code, purpose: 'SIGNUP', log: request.log })

    return reply.send({
      ok: true,
      data: {
        challengeId: challenge.challengeId,
        channel,
        destination: maskIdentifier(identifier),
        expiresIn: config.OTP_TTL_SEC
      }
    })
  })

  /**
   * POST /api/auth/signup/verify
   *
   * Checks the code, then creates the account from the payload that has been sitting on
   * the challenge. Only now does a `User` row exist.
   */
  app.post('/api/auth/signup/verify', { config: { public: true } }, async (request, reply) => {
    const parsed = verifySchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid request' })

    const result = await verifyOtpChallenge(parsed.data.challengeId, parsed.data.code, 'SIGNUP')
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.message })

    const payload = result.payload as SignupPayload | null
    if (!payload || typeof payload !== 'object' || !payload.passwordHash) {
      return reply.code(400).send({ ok: false, error: 'That signup has expired. Please start again.' })
    }

    const verifiedByEmail = payload.verifyVia === 'email'
    const referralCode = await pickReferralCode()
    try {
      const user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            name: payload.name,
            email: payload.email,
            phone: payload.phone,
            emailVerified: verifiedByEmail,
            phoneVerified: !verifiedByEmail,
            dateOfBirth: new Date(payload.dateOfBirth),
            username: payload.username,
            passwordHash: payload.passwordHash,
            role: 'PLAYER',
            authProvider: 'PASSWORD',
            referralCode,
            referredById: payload.referredById ?? null,
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
        await tx.adminAction.create({
          data: {
            adminId: created.id,
            action: 'auth.signup.registered',
            targetType: 'User',
            targetId: created.id,
            meta: { username: created.username, verifyVia: payload.verifyVia, email: payload.email, phone: payload.phone }
          }
        })
        return created
      })

      const token = issueSession(reply, user)
      if (payload.referredById) {
        void notify(
          payload.referredById,
          'REFERRAL_JOIN',
          'Someone joined with your invite',
          `${user.username} created an account with your invite code. You earn ${config.REFERRAL_BONUS_USDT} USDT when they play their first match.`
        )
      }
      return reply.send({ ok: true, data: { user: toPublicUser(user), token, created: true } })
    } catch (error) {
      if (isUniqueViolation(error, 'email')) {
        return reply.code(409).send({ ok: false, error: 'That email address is already registered.' })
      }
      if (isUniqueViolation(error, 'phone')) {
        return reply.code(409).send({ ok: false, error: 'That WhatsApp number is already registered.' })
      }
      if (isUniqueViolation(error, 'username')) {
        return reply.code(409).send({ ok: false, error: 'That username is already taken.' })
      }
      throw error
    }
  })

  /**
   * POST /api/auth/otp/resend
   *
   * Mints a fresh code on the same destination as an in-flight challenge. Returns the
   * new challenge id, because the previous one is spent by the resend.
   */
  app.post('/api/auth/otp/resend', { config: { public: true } }, async (request, reply) => {
    const parsed = resendSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid request' })

    const existing = await prisma.otpChallenge.findUnique({ where: { id: parsed.data.challengeId } })
    if (!existing || existing.consumedAt || existing.expiresAt.getTime() < Date.now()) {
      return reply.code(400).send({ ok: false, error: 'That request has expired. Please start again.' })
    }

    const cooldown = await secondsUntilResendAllowed(existing.identifier, existing.purpose as OtpPurpose)
    if (cooldown > 0) {
      return reply.code(429).send({ ok: false, error: `Please wait ${cooldown}s before requesting another code.` })
    }

    const challenge = await createOtpChallenge({
      identifier: existing.identifier,
      channel: existing.channel as OtpChannel,
      purpose: existing.purpose as OtpPurpose,
      payload: (existing.payload ?? undefined) as Prisma.InputJsonValue | undefined
    })
    await prisma.otpChallenge.update({ where: { id: existing.id }, data: { consumedAt: new Date() } })
    await sendOtpCode({
      channel: existing.channel as OtpChannel,
      identifier: existing.identifier,
      code: challenge.code,
      purpose: existing.purpose as OtpPurpose,
      log: request.log
    })

    return reply.send({
      ok: true,
      data: {
        challengeId: challenge.challengeId,
        channel: existing.channel,
        destination: maskIdentifier(existing.identifier),
        expiresIn: config.OTP_TTL_SEC
      }
    })
  })

  /**
   * POST /api/auth/login
   *
   * Username + password. An email address is accepted in place of the username for the
   * seeded/internal accounts and the e2e suite, but the public screen sends a username.
   * An admin account is refused here outright - the only way to an admin session is the
   * hardened route that also demands TOTP.
   */
  app.post('/api/auth/login', { config: { public: true } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid input' })

    const { username, email, password } = parsed.data
    const user = username
      ? await prisma.user.findFirst({ where: { username: { equals: username, mode: 'insensitive' } } })
      : await prisma.user.findUnique({ where: { email: normalizeEmail(email ?? '') } })

    if (!user?.passwordHash || !bcrypt.compareSync(password, user.passwordHash)) {
      return reply.code(401).send({ ok: false, error: 'invalid credentials' })
    }
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

  /**
   * POST /api/auth/password/forgot
   *
   * Starts a password reset. The response is identical whether or not the address is
   * known, so this cannot be used to enumerate accounts - a challenge is minted either
   * way, and one that has no user behind it simply never receives a code.
   */
  app.post('/api/auth/password/forgot', { config: { public: true } }, async (request, reply) => {
    const parsed = forgotSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid request' })
    const raw = parsed.data.identifier
    const asEmail = isEmail(raw)
    const identifier = asEmail ? normalizeEmail(raw) : normalizePhone(raw)
    const channel: OtpChannel = asEmail ? 'EMAIL' : 'WHATSAPP'

    const user = asEmail
      ? await prisma.user.findUnique({ where: { email: identifier } })
      : await prisma.user.findUnique({ where: { phone: identifier } })

    const cooldown = await secondsUntilResendAllowed(identifier, 'PASSWORD_RESET')
    if (cooldown > 0) {
      return reply.code(429).send({ ok: false, error: `Please wait ${cooldown}s before requesting another code.` })
    }

    const payload: ResetPayload = { userId: user?.id ?? null }
    const challenge = await createOtpChallenge({
      identifier,
      channel,
      purpose: 'PASSWORD_RESET',
      payload: payload as unknown as Prisma.InputJsonValue
    })

    // Only deliver when there is somebody to deliver to; otherwise the code stays on the
    // challenge, unseen, and verification will fail for anyone who guessed the address.
    if (user) {
      await sendOtpCode({ channel, identifier, code: challenge.code, purpose: 'PASSWORD_RESET', log: request.log })
    }

    return reply.send({
      ok: true,
      data: {
        challengeId: challenge.challengeId,
        channel,
        destination: maskIdentifier(identifier),
        expiresIn: config.OTP_TTL_SEC
      }
    })
  })

  /** POST /api/auth/password/reset - verify the code and set the new password. */
  app.post('/api/auth/password/reset', { config: { public: true } }, async (request, reply) => {
    const parsed = resetSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid request' })

    const result = await verifyOtpChallenge(parsed.data.challengeId, parsed.data.code, 'PASSWORD_RESET')
    if (!result.ok) return reply.code(400).send({ ok: false, error: result.message })

    const payload = result.payload as ResetPayload | null
    if (!payload?.userId) {
      return reply.code(400).send({ ok: false, error: 'That reset request could not be completed.' })
    }
    const user = await prisma.user.findUnique({ where: { id: payload.userId } })
    if (!user || user.status !== 'ACTIVE') {
      return reply.code(400).send({ ok: false, error: 'That account is not available.' })
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: bcrypt.hashSync(parsed.data.password, 10) }
    })
    return reply.send({ ok: true, data: { reset: true } })
  })

  /**
   * POST /api/auth/register
   *
   * Internal only - tests, e2e and the seed. It skips OTP entirely, so it is switched
   * off with `AUTH_ALLOW_DIRECT_REGISTER`, always creates a PLAYER, and never reads a
   * role from the body.
   */
  app.post('/api/auth/register', { config: { public: true } }, async (request, reply) => {
    if (!config.AUTH_ALLOW_DIRECT_REGISTER) {
      return reply.code(403).send({ ok: false, error: 'direct registration is disabled' })
    }
    const parsed = registerSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: parsed.error.flatten() })
    const { email, username, password, ref } = parsed.data
    const value = username.trim()
    if (!isValidUsernameFormat(value)) {
      const check = await checkUsername(value)
      return reply.code(400).send({ ok: false, error: check.message ?? 'invalid username' })
    }
    const availability = await checkUsername(value)
    if (!availability.available) {
      return reply.code(409).send({ ok: false, error: availability.message ?? 'username taken' })
    }
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
    try {
      const user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email: normalizeEmail(email),
            emailVerified: true,
            name: value,
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
      return reply.send({ ok: true, data: { user: toPublicUser(user), token } })
    } catch (error) {
      if (isUniqueViolation(error, 'email') || isUniqueViolation(error, 'username')) {
        return reply.code(409).send({ ok: false, error: 'email or username already taken' })
      }
      throw error
    }
  })

  /**
   * POST /api/auth/guest
   *
   * TEMPORARY. Makes a throwaway player account and signs it in, with no email, phone,
   * password or one-time code, so the game can be played while the OTP signup is not
   * yet working on the phone. Switched off with `AUTH_ALLOW_GUEST=false`. A guest is an
   * ordinary PLAYER (so every game path works for it) marked by `authProvider: 'GUEST'`,
   * and the withdrawal route refuses it.
   */
  app.post('/api/auth/guest', { config: { public: true } }, async (_request, reply) => {
    if (!config.AUTH_ALLOW_GUEST) {
      return reply.code(403).send({ ok: false, error: 'guest play is switched off' })
    }
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
    for (let attempt = 0; attempt < 5; attempt++) {
      let suffix = ''
      for (let i = 0; i < 6; i++) suffix += alphabet[Math.floor(Math.random() * alphabet.length)]
      const username = `guest_${suffix}`
      const referralCode = await pickReferralCode()
      try {
        const user = await prisma.$transaction(async (tx) => {
          const created = await tx.user.create({
            data: {
              name: 'Guest',
              username,
              role: 'PLAYER',
              authProvider: 'GUEST',
              referralCode,
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
              meta: { description: 'guest balance (USDT)' }
            }
          })
          return created
        })
        const token = issueSession(reply, user)
        return reply.send({ ok: true, data: { user: toPublicUser(user), token } })
      } catch (error) {
        // A name that happened to be taken: roll another one.
        if (isUniqueViolation(error, 'username') || isUniqueViolation(error, 'referralCode')) continue
        throw error
      }
    }
    return reply.code(503).send({ ok: false, error: 'could not start a guest session, try again' })
  })

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie('token', { path: '/' })
    return reply.send({ ok: true })
  })

  app.get('/api/auth/status', async (request, reply) => {
    if (!request.authUser) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' })
    }
    return reply.send({ ok: true, data: { user: request.authUser } })
  })

  /**
   * GET /api/auth/session
   *
   * Exchanges the httpOnly cookie for a socket token, so a client that reloads can pick
   * up its session without a token ever appearing in a URL.
   */
  app.get('/api/auth/session', { config: { public: true } }, async (request, reply) => {
    const header = request.headers.authorization
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined
    const raw = bearer ?? request.cookies.token
    if (!raw) return reply.code(401).send({ ok: false, error: 'unauthorized' })
    const user = await prisma.user.findUnique({ where: { id: verifyToken(raw)?.id ?? '' } })
    if (!user || user.status !== 'ACTIVE') {
      return reply.code(401).send({ ok: false, error: 'unauthorized' })
    }
    const token = issueSession(reply, user)
    return reply.send({ ok: true, data: { user: toPublicUser(user), token } })
  })
}
