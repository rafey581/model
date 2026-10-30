import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db/index.js'
import {
  ADMIN_COOKIE,
  createAdminSession,
  isIpAllowed,
  loginAdmin,
  requireAdminSession,
  resolveAdminSession,
  revokeAdminSession,
  revokeAllAdminSessions,
  setAdminCookie
} from './auth.js'
import { authConfigWarnings } from '../auth/warnings.js'

/**
 * The admin login surface.
 *
 * Deliberately separate from `/api/auth/*`: a different prefix, a different cookie,
 * a different credential, and no link to it from the player app. The player auth
 * screen has no way to reach any of this.
 */

const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200)
})

export async function registerAdminAuthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/admin/auth/config
   *
   * Enough for the admin app to render itself: whether the caller's IP is on the
   * allowlist. Deliberately reveals nothing about which accounts exist.
   */
  app.get('/api/admin/auth/config', { config: { public: true } }, async (request, reply) => {
    if (!isIpAllowed(request.ip)) {
      return reply.code(403).send({ ok: false, error: 'not allowed from this address' })
    }
    return reply.send({ ok: true, data: { ipAllowed: true } })
  })

  /**
   * POST /api/admin/auth/login
   *
   * Email + password, and nothing else. Every failure is reported as the same
   * "invalid credentials" so the endpoint cannot be used to enumerate accounts.
   */
  app.post('/api/admin/auth/login', { config: { public: true, rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body)
    if (!parsed.success) {
      // Not audited: a malformed body is noise, not an attack worth a row.
      return reply.code(400).send({ ok: false, error: 'invalid request' })
    }
    const { email, password } = parsed.data

    const result = await loginAdmin(request, email, password)

    if (result.ok && result.user) {
      const session = await createAdminSession(result.user.id, request.ip, request.headers['user-agent'])
      setAdminCookie(reply, session.token)
      // `token` is returned alongside the cookie so a native client (the mobile admin
      // app), which has no cookie jar, can present the session as `Authorization:
      // Bearer`. The web panel is gone; the only caller of this route is the app.
      return reply.send({
        ok: true,
        data: { user: result.user, expiresAt: session.expiresAt, token: session.token }
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
    if (result.failure === 'default_password') {
      return reply.code(403).send({
        ok: false,
        error: 'This account still uses the default password, which is disabled. Reset it on the server first (DEPLOY.md, "Staff password").'
      })
    }
    return reply.code(401).send({ ok: false, error: 'invalid credentials' })
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
    const bearer = (request.headers.authorization ?? '').startsWith('Bearer ')
      ? (request.headers.authorization ?? '').slice(7)
      : undefined
    const token = request.cookies[ADMIN_COOKIE] ?? bearer
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
  app.post('/api/admin/auth/logout-all', { config: { public: true, admin: true }, preHandler: requireAdminSession }, async (request, reply) => {
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
   * IP allowlist is the kind of thing that gets set once during setup and then
   * forgotten for the life of the deployment.
   */
  app.get('/api/admin/auth/warnings', { config: { public: true, admin: true }, preHandler: requireAdminSession }, async (_request, reply) => {
    return reply.send({ ok: true, data: { warnings: authConfigWarnings() } })
  })
}
