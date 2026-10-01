import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db/index.js'
import { config } from '../config.js'
import {
  ADMIN_COOKIE,
  createAdminSession,
  isIpAllowed,
  loginAdmin,
  requireAdminSession,
  resolveAdminSession,
  revokeAdminSession,
  revokeAllAdminSessions,
  setAdminCookie,
  signEnrollGrant,
  verifyEnrollGrant
} from './auth.js'
import { generateSecret, otpauthUri, verifyCode } from '../auth/totp.js'
import { providerConfigWarnings } from '../auth/providers.js'

/**
 * The admin login surface.
 *
 * Deliberately separate from `/api/auth/*`: a different prefix, a different cookie,
 * a different credential, and no link to it from the player app. The player auth
 * screen has no way to reach any of this.
 */

const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
  totp: z.string().regex(/^\d{6}$/).optional()
})

const activateSchema = z.object({
  enrollToken: z.string().min(10).max(4000),
  totp: z.string().regex(/^\d{6}$/)
})

export async function registerAdminAuthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/admin/auth/config
   *
   * Enough for the admin page to render itself: whether TOTP is mandatory, and
   * whether the caller's IP is on the allowlist. Deliberately reveals nothing about
   * which accounts exist.
   */
  app.get('/api/admin/auth/config', { config: { public: true } }, async (request, reply) => {
    if (!isIpAllowed(request.ip)) {
      return reply.code(403).send({ ok: false, error: 'not allowed from this address' })
    }
    return reply.send({
      ok: true,
      data: {
        requireTotp: config.ADMIN_REQUIRE_TOTP,
        totpEnrolled: false,
        ipAllowed: true
      }
    })
  })

  /**
   * POST /api/admin/auth/login
   *
   * Three outcomes, deliberately hard to tell apart from the outside:
   *   - success            -> a session cookie
   *   - password ok but no
   *     TOTP enrolled yet   -> an enrollment grant (requiresTotp)
   *   - anything else       -> "invalid credentials"
   */
  app.post('/api/admin/auth/login', { config: { public: true } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body)
    if (!parsed.success) {
      // Not audited: a malformed body is noise, not an attack worth a row.
      return reply.code(400).send({ ok: false, error: 'invalid request' })
    }
    const { email, password, totp } = parsed.data

    const result = await loginAdmin(request, email, password, totp)

    if (result.ok && result.user) {
      const session = await createAdminSession(result.user.id, request.ip, request.headers['user-agent'])
      setAdminCookie(reply, session.token)
      return reply.send({ ok: true, data: { user: result.user, expiresAt: session.expiresAt } })
    }

    if (result.requiresTotp) {
      // `loginAdmin` reached this branch only after a correct password, so
      // re-resolving the id here cannot leak account existence: an unknown address
      // or a wrong password never gets here. The secret is NOT written to the user
      // row yet - activation is what commits it.
      const user = await prisma.user.findFirst({
        where: { email: email.trim().toLowerCase(), role: { in: ['ADMIN', 'SUPERADMIN'] } },
        select: { id: true }
      })
      if (!user) return reply.code(401).send({ ok: false, error: 'invalid credentials' })

      const normalizedEmail = email.trim().toLowerCase()
      const secret = generateSecret()
      const real = await signEnrollGrant({ userId: user.id, email: normalizedEmail, secret })
      return reply.send({
        ok: true,
        data: {
          requiresTotp: true,
          enrollToken: real,
          secret,
          otpauth: otpauthUri(secret, normalizedEmail, 'Snooker Arena Admin')
        }
      })
    }

    if (result.failure === 'locked') {
      return reply
        .code(429)
        .header('retry-after', String(result.retryAfterSec ?? 60))
        .send({ ok: false, error: 'invalid credentials', retryAfterSec: result.retryAfterSec })
    }
    if (result.failure === 'ip_blocked') {
      return reply.code(403).send({ ok: false, error: 'not allowed from this address' })
    }
    return reply.code(401).send({ ok: false, error: 'invalid credentials' })
  })

  /**
   * POST /api/admin/auth/totp/activate
   *
   * Commits the enrollment: proves the caller holds the authenticator by returning
   * a live code, then enables TOTP and issues the session in the same request. So
   * the admin is never left in a half-enrolled state.
   */
  app.post('/api/admin/auth/totp/activate', { config: { public: true } }, async (request, reply) => {
    const parsed = activateSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid request' })
    const { enrollToken, totp } = parsed.data

    const grant = await verifyEnrollGrant(enrollToken)
    if (!grant) return reply.code(401).send({ ok: false, error: 'invalid credentials' })

    if (!verifyCode(grant.secret, totp)) {
      return reply.code(401).send({ ok: false, error: 'invalid credentials' })
    }

    const user = await prisma.user.findUnique({ where: { id: grant.userId } })
    if (!user || user.role !== 'ADMIN' && user.role !== 'SUPERADMIN' || user.status !== 'ACTIVE') {
      return reply.code(403).send({ ok: false, error: 'forbidden' })
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { totpSecret: grant.secret, totpEnabled: true }
    })
    await prisma.adminAction.create({
      data: {
        adminId: user.id,
        action: 'admin.totp.enrolled',
        targetType: 'AdminAuth',
        targetId: user.id,
        meta: { ip: request.ip }
      }
    })

    const session = await createAdminSession(user.id, request.ip, request.headers['user-agent'])
    setAdminCookie(reply, session.token)
    return reply.send({
      ok: true,
      data: { user: { id: user.id, username: user.username, role: user.role, status: user.status } }
    })
  })

  /** GET /api/admin/auth/session - who am I, and is this session still good. */
  app.get('/api/admin/auth/session', { config: { public: true } }, async (request, reply) => {
    const token = request.cookies[ADMIN_COOKIE] ?? (request.headers.authorization ?? '').replace('Bearer ', '')
    if (!token) return reply.code(401).send({ ok: false, error: 'unauthorized' })
    const user = await resolveAdminSession(token)
    if (!user) return reply.code(401).send({ ok: false, error: 'unauthorized' })
    return reply.send({ ok: true, data: { user } })
  })

  /** POST /api/admin/auth/logout - ends this session only. */
  app.post('/api/admin/auth/logout', { config: { public: true } }, async (request, reply) => {
    const token = request.cookies[ADMIN_COOKIE]
    if (token) await revokeAdminSession(token)
    reply.clearCookie(ADMIN_COOKIE, { path: '/api/admin' })
    return reply.send({ ok: true })
  })

  /**
   * POST /api/admin/auth/logout-all
   *
   * The panic button. Every admin session for the account is destroyed, which is
   * what you need if a laptop was stolen and you cannot tell which session was live.
   */
  app.post('/api/admin/auth/logout-all', { config: { public: true, admin: true } }, async (request, reply) => {
    const user = request.authUser
    if (!user) return reply.code(401).send({ ok: false, error: 'unauthorized' })
    await revokeAllAdminSessions(user.id)
    await prisma.adminAction.create({
      data: {
        adminId: user.id,
        action: 'admin.sessions.revoked_all',
        targetType: 'AdminAuth',
        targetId: user.id,
        meta: { ip: request.ip }
      }
    })
    reply.clearCookie(ADMIN_COOKIE, { path: '/api/admin' })
    return reply.send({ ok: true })
  })

  /**
   * GET /api/admin/auth/warnings
   *
   * Operator-facing misconfiguration notices, shown on the admin screen. An empty
   * IP allowlist or a disabled second factor is the kind of thing that gets set
   * once during setup and then forgotten for the life of the deployment.
   */
  app.get('/api/admin/auth/warnings', { config: { public: true, admin: true }, preHandler: requireAdminSession }, async (_request, reply) => {
    return reply.send({ ok: true, data: { warnings: providerConfigWarnings() } })
  })
}
