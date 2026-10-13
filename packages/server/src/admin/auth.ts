import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import bcrypt from 'bcryptjs'
import { SignJWT, jwtVerify } from 'jose'
import { prisma } from '../db/index.js'
import { adminAllowedIps, config } from '../config.js'
import { verifyCode } from '../auth/totp.js'

/**
 * Admin authentication: email + password + TOTP, on a route the public app never
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
 *  4. **Brute-force resistant.** Failures are counted per account *and* per IP with
 *     a lockout, so neither spraying one account from many IPs nor one IP against
 *     many accounts gets an unlimited number of TOTP guesses.
 *  5. **Audited.** Every attempt, successful or not, lands in `AdminAction`.
 */

export const ADMIN_COOKIE = 'admin_session'
const ADMIN_ROLES = new Set(['ADMIN', 'SUPERADMIN'])

/**
 * A real bcrypt hash of a value nobody knows, compared against when the account
 * does not exist. Without it, "no such user" returns in microseconds while a wrong
 * password takes ~100ms of bcrypt work, which is a reliable account-enumeration
 * oracle even though the error message is identical.
 */
const DUMMY_HASH = '$2b$10$C6UzMDM.H6dfI/f/IKcEe.iaWs1JOwuijCzFvJcF1aF8b5K2PnO7TC'

// ---------------------------------------------------------------------------
// Lockout tracking
// ---------------------------------------------------------------------------

interface AttemptState {
  failures: number
  lockedUntil: number
  lastAt: number
}

const byAccount = new Map<string, AttemptState>()
const byIp = new Map<string, AttemptState>()

/** Bounded so an attacker cannot grow the map without limit by rotating IPs. */
const MAX_TRACKED_KEYS = 10_000

function stateFor(map: Map<string, AttemptState>, key: string): AttemptState {
  let s = map.get(key)
  if (!s) {
    if (map.size >= MAX_TRACKED_KEYS) {
      // Evict the least recently touched rather than refusing to track: silently
      // dropping a new key would hand an attacker a free reset by flooding.
      let oldestKey: string | undefined
      let oldest = Infinity
      for (const [k, v] of map) {
        if (v.lastAt < oldest) {
          oldest = v.lastAt
          oldestKey = k
        }
      }
      if (oldestKey !== undefined) map.delete(oldestKey)
    }
    s = { failures: 0, lockedUntil: 0, lastAt: Date.now() }
    map.set(key, s)
  }
  return s
}

export function lockoutRemainingMs(key: string, map: Map<string, AttemptState>): number {
  const s = map.get(key)
  if (!s) return 0
  return Math.max(0, s.lockedUntil - Date.now())
}

export function accountLockRemainingMs(email: string): number {
  return lockoutRemainingMs(email.toLowerCase(), byAccount)
}

export function ipLockRemainingMs(ip: string): number {
  return lockoutRemainingMs(ip, byIp)
}

function recordFailure(key: string, map: Map<string, AttemptState>, threshold: number): void {
  const s = stateFor(map, key)
  s.failures += 1
  s.lastAt = Date.now()
  if (s.failures >= threshold) {
    // Lockout grows with the failure count so a long-running guess is slower than
    // a first one, instead of every N failures costing the same.
    const over = s.failures - threshold
    const minutes = config.ADMIN_LOCKOUT_MIN * (1 + Math.floor(over / threshold))
    s.lockedUntil = Date.now() + minutes * 60_000
  }
}

/**
 * Failures tolerated per IP, which is deliberately several times the per-account
 * budget.
 *
 * An IP is a much weaker signal than an account: it is shared by an office, a
 * mobile carrier or a NAT gateway, so locking an address after as few failures as
 * it takes to lock an account would let one fumbled password lock every admin
 * behind that NAT out of the panel. It still stops the things an IP limit is
 * actually for - a single host spraying many accounts, and hammering one account
 * faster than the account counter reacts.
 */
function ipThreshold(): number {
  return config.ADMIN_MAX_FAILED_ATTEMPTS * 3
}

function clearFailures(key: string, map: Map<string, AttemptState>): void {
  map.delete(key)
}

/** Exposed for tests; production never needs to reach in here. */
export function resetLockouts(): void {
  byAccount.clear()
  byIp.clear()
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
  // Re-read the user every request: demotion or suspension has to take effect on
  // the next call, not whenever the session happens to expire.
  if (session.user.status !== 'ACTIVE' || !ADMIN_ROLES.has(session.user.role)) return null

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

export type AdminLoginFailure = 'ip_blocked' | 'locked' | 'invalid'

export interface AdminLoginResult {
  ok: boolean
  failure?: AdminLoginFailure
  retryAfterSec?: number
  user?: AdminSessionUser
  requiresTotp?: boolean
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
 * account" from "wrong password" from "wrong TOTP" would let an attacker confirm
 * the first two, which is most of the work of an online attack.
 */
export async function loginAdmin(
  request: FastifyRequest,
  email: string,
  password: string,
  totp: string | undefined
): Promise<AdminLoginResult> {
  const ip = normalizeIp(request.ip)
  const key = email.trim().toLowerCase()

  if (!isIpAllowed(request.ip)) {
    await audit(request, 'admin.login.ip_blocked', key, {})
    return { ok: false, failure: 'ip_blocked' }
  }

  const accountWait = accountLockRemainingMs(key)
  const ipWait = ipLockRemainingMs(ip)
  const waitMs = Math.max(accountWait, ipWait)
  if (waitMs > 0) {
    await audit(request, 'admin.login.locked', key, { retryAfterSec: Math.ceil(waitMs / 1000) })
    return { ok: false, failure: 'locked', retryAfterSec: Math.ceil(waitMs / 1000) }
  }

  const user = await prisma.user.findFirst({ where: { email: key, role: { in: ['ADMIN', 'SUPERADMIN'] } } })

  // Always run a bcrypt comparison, even with no user, to keep the timing flat.
  const passwordOk = bcrypt.compareSync(password, user?.passwordHash ?? DUMMY_HASH)

  if (!user || !passwordOk || user.status !== 'ACTIVE') {
    recordFailure(key, byAccount, config.ADMIN_MAX_FAILED_ATTEMPTS)
    recordFailure(ip, byIp, ipThreshold())
    await audit(request, 'admin.login.failed', key, { reason: 'credentials' })
    return { ok: false, failure: 'invalid' }
  }

  // TOTP is required unless an operator has explicitly turned it off. When it is
  // on but not yet enrolled, the caller is told to enrol rather than being let in
  // with a password alone - otherwise a fresh admin account would silently be the
  // weakest account on the platform.
  if (config.ADMIN_REQUIRE_TOTP) {
    if (!user.totpEnabled || !user.totpSecret) {
      await audit(request, 'admin.login.totp_enrollment_required', key, {})
      return { ok: false, failure: 'invalid', requiresTotp: true }
    }
    if (!totp || !verifyCode(user.totpSecret, totp)) {
      recordFailure(key, byAccount, config.ADMIN_MAX_FAILED_ATTEMPTS)
      recordFailure(ip, byIp, ipThreshold())
      await audit(request, 'admin.login.failed', key, { reason: 'totp' })
      return { ok: false, failure: 'invalid' }
    }
  }

  clearFailures(key, byAccount)
  clearFailures(ip, byIp)
  await audit(request, 'admin.login.success', key, { userId: user.id })
  return {
    ok: true,
    user: { id: user.id, username: user.username, role: user.role, status: user.status }
  }
}

// ---------------------------------------------------------------------------
// TOTP enrollment bootstrap
// ---------------------------------------------------------------------------

const ENROLL_TTL_SEC = 300

/**
 * A password-verified but not yet second-factor-verified admin.
 *
 * This token is what makes "password in, TOTP out" safe. It is issued only after a
 * correct password, it lives five minutes, and it is signed over a *newly
 * generated* secret that exists nowhere in the database yet. So it can enable TOTP
 * and nothing else, and the stored secret is only ever written after a code for it
 * comes back - which is what proves the admin actually has the authenticator.
 */
export interface EnrollGrant {
  userId: string
  email: string
  secret: string
}

export async function signEnrollGrant(grant: EnrollGrant): Promise<string> {
  return new SignJWT({
    aud: 'admin-totp-enroll',
    sub: grant.userId,
    email: grant.email,
    secret: grant.secret
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ENROLL_TTL_SEC}s`)
    .sign(Buffer.from(config.JWT_SECRET, 'utf8'))
}

export async function verifyEnrollGrant(token: string): Promise<EnrollGrant | null> {
  try {
    const { payload } = await jwtVerify(token, Buffer.from(config.JWT_SECRET, 'utf8'), {
      audience: 'admin-totp-enroll'
    })
    const userId = payload.sub
    const email = payload.email
    const secret = payload.secret
    if (typeof userId !== 'string' || typeof email !== 'string' || typeof secret !== 'string') return null
    return { userId, email, secret }
  } catch {
    return null
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
