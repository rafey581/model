import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest'
import bcrypt from 'bcryptjs'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../db/index.js'
import { buildApp } from '../app.js'
import { currentCode } from '../auth/totp.js'
import { resetLockouts, revokeAllAdminSessions } from './auth.js'

/**
 * Admin access, asserted through the real HTTP surface.
 *
 * These are the properties that make the admin panel safe rather than merely
 * private, so they are tested end to end with app.inject() rather than by calling
 * helpers directly - a guard that is never registered, or a route that forgot
 * `config: { public: true }`, passes every unit test and fails all of these.
 */

const TAG = `adm${Date.now() % 1000000}`
const ADMIN_EMAIL = `admin-${TAG}@test.local`
const ADMIN_PASSWORD = 'correct-horse-battery'
const PLAYER_EMAIL = `player-${TAG}@test.local`
const PLAYER_PASSWORD = 'player-password-1'

let app: FastifyInstance
let adminId: string
let playerId: string

function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string | null {
  const raw = res.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  for (const c of list) {
    if (typeof c === 'string' && c.startsWith(`${name}=`)) return c.split(';')[0] ?? null
  }
  return null
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()

  const admin = await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      username: `root${TAG}`,
      passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 10),
      role: 'SUPERADMIN',
      status: 'ACTIVE',
      wallet: { create: { available: 0 } }
    }
  })
  adminId = admin.id

  const player = await prisma.user.create({
    data: {
      email: PLAYER_EMAIL,
      username: `plyr${TAG}`,
      passwordHash: bcrypt.hashSync(PLAYER_PASSWORD, 10),
      role: 'PLAYER',
      status: 'ACTIVE',
      wallet: { create: { available: 0 } }
    }
  })
  playerId = player.id
})

// Lockout state is module-global by design (it has to survive across requests), so
// every test starts from a clean slate. Without this the lockout test would leave
// 127.0.0.1 locked and take the rest of the suite down with it - which is the
// behaviour working as intended, just not what these other tests want.
beforeEach(() => {
  resetLockouts()
})

afterAll(async () => {
  await revokeAllAdminSessions(adminId)
  await prisma.adminAction.deleteMany({ where: { meta: { path: ['email'], equals: ADMIN_EMAIL } } })
  await prisma.user.deleteMany({ where: { id: { in: [adminId, playerId] } } })
  await app.close()
})

/**
 * Obtains an admin session cookie, whichever state the account is in.
 *
 * The account is unenrolled to begin with, so the first call walks the enrollment
 * bootstrap. Once a test has activated TOTP, the account is enrolled and a
 * password-only login is correctly refused - so the helper falls back to a full
 * password + TOTP login. Encoding both paths here is what keeps the session tests
 * independent of the order the login tests happened to run in.
 */
async function enrollAndLogin(email = ADMIN_EMAIL, password = ADMIN_PASSWORD): Promise<string | null> {
  const start = await app.inject({ method: 'POST', url: '/api/admin/auth/login', payload: { email, password } })
  if (start.statusCode === 200) {
    const body = start.json() as { data?: { requiresTotp?: boolean; enrollToken?: string; secret?: string } }
    if (!body.data?.requiresTotp || !body.data.enrollToken || !body.data.secret) return null
    const activate = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/totp/activate',
      payload: { enrollToken: body.data.enrollToken, totp: currentCode(body.data.secret) }
    })
    if (activate.statusCode !== 200) return null
    return cookieFrom(activate, 'admin_session')
  }

  // Already enrolled: log in with a live code.
  const row = await prisma.user.findUnique({ where: { id: adminId }, select: { totpSecret: true } })
  if (!row?.totpSecret) return null
  const full = await app.inject({
    method: 'POST',
    url: '/api/admin/auth/login',
    payload: { email, password, totp: currentCode(row.totpSecret) }
  })
  if (full.statusCode !== 200) return null
  return cookieFrom(full, 'admin_session')
}

describe('admin login', () => {
  it('rejects a wrong password without revealing whether the account exists', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { email: ADMIN_EMAIL, password: 'nope' }
    })
    const noSuchAccount = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { email: `ghost-${TAG}@test.local`, password: 'nope' }
    })
    expect(wrongPassword.statusCode).toBe(401)
    expect(noSuchAccount.statusCode).toBe(401)
    // Identical bodies, so the endpoint is not an account-enumeration oracle.
    expect(wrongPassword.json()).toEqual(noSuchAccount.json())
  })

  it('does not hand out a session to a password-only admin - it demands TOTP enrollment', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }
    })
    expect(res.statusCode).toBe(200)
    const data = (res.json() as { data: Record<string, unknown> }).data
    expect(data.requiresTotp).toBe(true)
    // The critical assertion: no session cookie, only an enrollment grant.
    expect(cookieFrom(res, 'admin_session')).toBeNull()
    expect(data.enrollToken).toBeTruthy()
    expect(data.secret).toBeTruthy()
  })

  it('refuses to activate with a wrong TOTP code', async () => {
    const start = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }
    })
    const { enrollToken } = (start.json() as { data: { enrollToken: string } }).data
    const bad = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/totp/activate',
      payload: { enrollToken, totp: '000000' }
    })
    expect(bad.statusCode).toBe(401)
    // And nothing was committed: the admin is still unenrolled.
    const row = await prisma.user.findUnique({ where: { id: adminId }, select: { totpEnabled: true } })
    expect(row?.totpEnabled).toBe(false)
  })

  it('activates TOTP and issues a session in one step', async () => {
    const start = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }
    })
    const { enrollToken, secret } = (start.json() as { data: { enrollToken: string; secret: string } }).data
    const ok = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/totp/activate',
      payload: { enrollToken, totp: currentCode(secret) }
    })
    expect(ok.statusCode).toBe(200)
    expect(cookieFrom(ok, 'admin_session')).toBeTruthy()
    const row = await prisma.user.findUnique({ where: { id: adminId }, select: { totpEnabled: true, totpSecret: true } })
    expect(row?.totpEnabled).toBe(true)
    expect(row?.totpSecret).toBe(secret)
  })

  it('now requires the TOTP code on subsequent logins', async () => {
    const noCode = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }
    })
    expect(noCode.statusCode).toBe(401)
    const badCode = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, totp: '000000' }
    })
    expect(badCode.statusCode).toBe(401)
  })

  it('accepts the correct password and TOTP together', async () => {
    const row = await prisma.user.findUnique({ where: { id: adminId }, select: { totpSecret: true } })
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, totp: currentCode(row!.totpSecret!) }
    })
    expect(res.statusCode).toBe(200)
    expect(cookieFrom(res, 'admin_session')).toBeTruthy()
  })
})

describe('lockout', () => {
  it('locks the account after the configured number of failures', async () => {
    const email = `lock-${TAG}@test.local`
    let lastStatus = 0
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/auth/login',
        payload: { email, password: `wrong-${i}` }
      })
      lastStatus = res.statusCode
    }
    expect(lastStatus).toBe(401)
    // The 6th attempt is refused regardless of the password, with a retry hint.
    const locked = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { email, password: 'wrong-again' }
    })
    expect(locked.statusCode).toBe(429)
    expect(locked.headers['retry-after']).toBeDefined()
  })
})

describe('session enforcement', () => {
  it('gates admin routes behind a session', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/admin/stats' })
    expect(anon.statusCode).toBe(401)
  })

  it('admits a valid admin session', async () => {
    const cookie = await enrollAndLogin()
    expect(cookie).toBeTruthy()
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: { cookie: cookie! }
    })
    expect(res.statusCode).toBe(200)
  })

  it('does not accept a player token as an admin credential', async () => {
    // A normal player login first...
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: PLAYER_EMAIL, password: PLAYER_PASSWORD }
    })
    expect(login.statusCode).toBe(200)
    const playerToken = (login.json() as { data: { token: string } }).data.token
    // ...then presented to the admin API, in both header and cookie positions.
    const asHeader = await app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: { authorization: `Bearer ${playerToken}` }
    })
    expect(asHeader.statusCode).toBe(401)
    const asPlayerCookie = await app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: { cookie: `token=${playerToken}` }
    })
    expect(asPlayerCookie.statusCode).toBe(401)
  })

  it('refuses the player login route for an admin account, even with the right password', async () => {
    const row = await prisma.user.findUnique({ where: { id: adminId }, select: { totpSecret: true } })
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, totp: currentCode(row!.totpSecret!) }
    })
    expect(res.statusCode).toBe(403)
    expect((res.json() as { error: string }).error).toMatch(/admin sign-in/i)
    expect(cookieFrom(res, 'token')).toBeNull()
  })

  it('revokes a session immediately when the row is deleted', async () => {
    const cookie = await enrollAndLogin()
    expect(cookie).toBeTruthy()
    const before = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { cookie: cookie! } })
    expect(before.statusCode).toBe(200)

    // This is the property a stateless JWT cannot offer.
    await revokeAllAdminSessions(adminId)

    const after = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { cookie: cookie! } })
    expect(after.statusCode).toBe(401)
  })

  it('ends a single session on logout', async () => {
    const cookie = await enrollAndLogin()
    const out = await app.inject({ method: 'POST', url: '/api/admin/auth/logout', headers: { cookie: cookie! } })
    expect(out.statusCode).toBe(200)
    const after = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { cookie: cookie! } })
    expect(after.statusCode).toBe(401)
  })

  it('honours suspension immediately, without waiting for expiry', async () => {
    const cookie = await enrollAndLogin()
    const ok = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { cookie: cookie! } })
    expect(ok.statusCode).toBe(200)

    await prisma.user.update({ where: { id: adminId }, data: { status: 'SUSPENDED' } })
    const suspended = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { cookie: cookie! } })
    expect(suspended.statusCode).toBe(401)
    await prisma.user.update({ where: { id: adminId }, data: { status: 'ACTIVE' } })
  })
})

describe('provider registry', () => {
  it('advertises only usable providers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/providers' })
    expect(res.statusCode).toBe(200)
    const providers = (res.json() as { data: { providers: Array<{ id: string }> } }).data.providers
    const ids = providers.map((p) => p.id)

    // Binance is deferred with no verified public flow, so it must never be offered.
    expect(ids).not.toContain('binance')
    // Google has no credentials in this environment, and the whole point of the
    // registry is that the login screen never offers a button that will fail.
    expect(ids).not.toContain('google')
    // Phantom needs no credentials, so it is the one provider that must be there -
    // otherwise a fresh checkout boots to a login screen with no way in.
    expect(ids).toContain('phantom')
  })

  it('refuses to start a flow for a disabled provider', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/google' })
    expect(res.statusCode).toBe(404)
  })
})
