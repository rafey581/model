import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { prisma } from '../db/index.js'
import { adminAllowedIps, config } from '../config.js'
import { isOwnerUser, ownerUserIds } from '../auth/owners.js'
import { passwordMatches } from '../auth/passwordCheck.js'
import {
  clearAccountFailures,
  clientIp,
  loginBlock,
  recordLoginFailure,
  resetLoginThrottles
} from '../auth/loginThrottle.js'

/**
 * Admin authentication: email + password, on a route the public app never
 * links to, backed by a revocable server-side session.
 *
 * This is deliberately a different system from the player login rather than a
 * stricter version of it. The properties it relies on:
 *
 *  1. **Revocable.** The player path mints a stateless 7-day JWT: once issued it is
 *     valid until it expires, with no way to cut it short. A compromised admin
 *     session has to be killable, so admin sessions are rows in `Session` and
 *     deleting the row ends the access immediately.
 *  2. **Not a player token.** The admin cookie is a separate name, and the admin
 *     guard requires `purpose = 'ADMIN'`. A stolen player token cannot be
 *     presented as an admin session.
 *  3. **Opaque at rest.** The cookie carries 32 random bytes; only a SHA-256 hash
 *     is stored, so a database leak yields nothing that can be replayed.
 *  4. **Brute-force resistant.** Failures are counted in the database, per identifier
 *     and per client address, with a fixed cooldown. The count survives a restart
 *     and is shared by every process on this database. Guessing does not extend
 *     a cooldown that is already running.
 *  5. **Owner only.** A session is accepted only when the account id is in
 *     `OWNER_USER_IDS`. Role is not consulted. Anyone else's staff session is
 *     deleted.
 *  6. **Audited.** Every attempt, successful or not, lands in `AdminAction`.
 *     Passwords are not written there.
 */

export const ADMIN_COOKIE = 'admin_session'

/** Clears persisted sign-in counters. Tests call this between cases. */
export async function resetLockouts(): Promise<void> {
  await resetLoginThrottles()
}

// ---------------------------------------------------------------------------
// IP allowlist
// ---------------------------------------------------------------------------

function normalizeIp(raw: string | undefined): string {
  if (!raw) return 'unknown'
  // ::ffff:127.0.0.1 and 127.0.0.1 must be treated as the same host, or the
  // allowlist silently fails on whichever address form Node happens to report.
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw
}

function staffAccountKey(email: string): string {
  return `email:${email.trim().toLowerCase()}`
}

export function isIpAllowed(ip: string | undefined): boolean {
  const allowed = adminAllowedIps()
  if (allowed.length === 0) return true
  const candidate = normalizeIp(ip)
  return allowed.some((entry) => candidate === entry || candidate.startsWith(`${entry}.`))
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createAdminSession(
  userId: string,
  ip: string | undefined,
  userAgent: string | undefined
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + config.ADMIN_SESSION_TTL_MIN * 60_000)
  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      purpose: 'ADMIN',
      expiresAt,
      lastSeenAt: new Date(),
      ip: normalizeIp(ip),
      userAgent: userAgent?.slice(0, 300) ?? null
    }
  })
  return { token, expiresAt }
}

export async function revokeAdminSession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } })
}

export async function revokeAllAdminSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId, purpose: 'ADMIN' } })
}

/** Drops expired rows so the table does not grow forever. Called at boot. */
export async function purgeExpiredSessions(): Promise<number> {
  const result = await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } })
  return result.count
}

/**
 * Ends every staff session that is not on the owner list.
 *
 * Called at boot. A session minted while an account was an admin does not survive
 * a deploy that no longer treats that account as staff, including the case where
 * no owner is configured yet.
 */
export async function revokeNonOwnerAdminSessions(): Promise<number> {
  const owners = ownerUserIds()
  const result = await prisma.session.deleteMany({
    where: owners.length === 0 ? { purpose: 'ADMIN' } : { purpose: 'ADMIN', userId: { notIn: [...owners] } }
  })
  return result.count
}

export interface AdminSessionUser {
  id: string
  username: string
  role: string
  status: string
}

export async function resolveAdminSession(token: string): Promise<AdminSessionUser | null> {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true }
  })
  if (!session) return null
  if (session.purpose !== 'ADMIN') return null
  if (session.expiresAt.getTime() <= Date.now()) return null
  // Re-read the account every request. Role is not the gate: only the configured
  // owner ids are, and a session for anyone else is deleted so it cannot be
  // reused if the list later changes.
  if (!isOwnerUser(session.user.id)) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined)
    return null
  }
  if (session.user.status !== 'ACTIVE') return null

  // Constant-time compare is unnecessary here (both are server-held hashes compared
  // by the database) but the timingSafeEqual keeps the habit honest and costs nothing.
  if (session.tokenHash.length !== hashToken(token).length) return null
  if (!timingSafeEqual(Buffer.from(session.tokenHash), Buffer.from(hashToken(token)))) return null

  return { id: session.user.id, username: session.user.username, role: session.user.role, status: session.user.status }
}

export function setAdminCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    // `lax` is required, not preferred: without it the browser withholds the cookie
    // on cross-site navigations and the admin session would drop on refresh.
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/api/admin',
    maxAge: config.ADMIN_SESSION_TTL_MIN * 60
  })
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export type AdminLoginFailure = 'ip_blocked' | 'locked' | 'invalid' | 'default_password'

export interface AdminLoginResult {
  ok: boolean
  failure?: AdminLoginFailure
  retryAfterSec?: number
  user?: AdminSessionUser
}

async function audit(
  request: FastifyRequest,
  action: string,
  targetId: string | undefined,
  meta: Record<string, unknown>
): Promise<void> {
  // Deliberately not awaited: a logging failure must not turn a 401 into a 500, and
  // losing one audit row is far better than leaking the existence of the audit path.
  void prisma.adminAction
    .create({
      data: {
        adminId: targetId ?? 'unknown',
        action,
        targetType: 'AdminAuth',
        targetId: targetId ?? null,
        meta: { ...meta, ip: normalizeIp(request.ip), userAgent: request.headers['user-agent'] ?? null }
      }
    })
    .catch(() => undefined)
}

/**
 * Authenticates an admin.
 *
 * Every failure path returns the same `invalid` reason. Distinguishing "no such
 * account" from "wrong password" would let an attacker confirm the first, which
 * is most of the work of an online attack.
 */
const KNOWN_DEFAULT_PASSWORDS = new Set(['admin123'])

export async function loginAdmin(
  request: FastifyRequest,
  email: string,
  password: string
): Promise<AdminLoginResult> {
  const ip = clientIp(request)
  const key = email.trim().toLowerCase()
  const accountKey = staffAccountKey(key)

  if (!isIpAllowed(request.ip)) {
    await audit(request, 'admin.login.ip_blocked', key, {})
    return { ok: false, failure: 'ip_blocked' }
  }

  const blocked = await loginBlock('staff', ip, accountKey)
  if (blocked.locked) {
    await audit(request, 'admin.login.locked', key, { retryAfterSec: blocked.retryAfterSec })
    return { ok: false, failure: 'locked', retryAfterSec: blocked.retryAfterSec }
  }

  // Any account with this email, not only rows whose role says admin. Access is
  // the owner list. Looking up by role would let a non-owner admin be told apart
  // from everyone else, and would lock the owner out if their role were PLAYER.
  const user = await prisma.user.findFirst({ where: { email: key } })
  const passwordOk = passwordMatches(password, user?.passwordHash)
  const allowed = Boolean(user && passwordOk && user.status === 'ACTIVE' && isOwnerUser(user.id))

  if (!user || !passwordOk || !allowed) {
    const failure = await recordLoginFailure('staff', ip, accountKey)
    await audit(request, 'admin.login.failed', key, { reason: 'credentials' })
    if (failure.locked) return { ok: false, failure: 'locked', retryAfterSec: failure.retryAfterSec }
    return { ok: false, failure: 'invalid' }
  }

  // The seed's fallback password is public (it is in the source). An owner account
  // still on it is refused until its password is reset on the server. This is
  // checked only after the owner test, so the 403 is not a way to discover which
  // other accounts exist.
  if (KNOWN_DEFAULT_PASSWORDS.has(password)) {
    await audit(request, 'admin.login.default_password', key, { userId: user.id })
    return { ok: false, failure: 'default_password' }
  }

  await clearAccountFailures('staff', accountKey)
  await audit(request, 'admin.login.success', key, { userId: user.id })
  return {
    ok: true,
    user: { id: user.id, username: user.username, role: user.role, status: user.status }
  }
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

/**
 * The single gate on every `/api/admin/*` route.
 *
 * Admin routes are registered as `public` so the global player-token hook does not
 * run against them. That is the point: the player hook authenticates *player*
 * tokens, and an admin session has to be a different credential entirely.
 */
export async function requireAdminSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined
  const token = request.cookies[ADMIN_COOKIE] ?? bearer
  if (!token) {
    await reply.code(401).send({ ok: false, error: 'unauthorized' })
    return
  }
  const user = await resolveAdminSession(token)
  if (!user) {
    await reply.code(401).send({ ok: false, error: 'unauthorized' })
    return
  }
  request.authUser = user
}
