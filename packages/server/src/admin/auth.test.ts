import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest'
import bcrypt from 'bcryptjs'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../db/index.js'
import { buildApp } from '../app.js'
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
 * Logs in over HTTP and returns both credentials the response carries.
 *
 * The mobile app has no cookie jar, so it keeps the `token` from the body and
 * sends it as `Authorization: Bearer`; a browser would keep the cookie. Both are
 * the same revocable session row.
 */
async function loginForSession(
  email = ADMIN_EMAIL,
  password = ADMIN_PASSWORD
): Promise<{ cookie: string | null; token: string | null }> {
  const res = await app.inject({ method: 'POST', url: '/api/admin/auth/login', payload: { email, password } })
  if (res.statusCode !== 200) return { cookie: null, token: null }
  return {
    cookie: cookieFrom(res, 'admin_session'),
    token: (res.json() as { data: { token?: string } }).data.token ?? null
  }
}

async function adminCookie(): Promise<string | null> {
  return (await loginForSession()).cookie
}

async function adminToken(): Promise<string | null> {
  return (await loginForSession()).token
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

  it('issues a session for the correct email and password, with no second factor', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { data: { user?: { id: string }; token?: string } }
    expect(body.data.user?.id).toBe(adminId)
    expect(body.data.token).toBeTruthy()
    expect(cookieFrom(res, 'admin_session')).toBeTruthy()
  })

  it('has no authenticator enrollment endpoint left to call', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/totp/activate',
      payload: { enrollToken: 'x'.repeat(20), totp: '000000' }
    })
    // The route is gone. The global auth hook answers before the router's 404, so
    // the exact code is 401 - what matters is that it does not hand out a session.
    expect(res.statusCode).not.toBe(200)
    expect(cookieFrom(res, 'admin_session')).toBeNull()
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
    const cookie = await adminCookie()
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
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }
    })
    expect(res.statusCode).toBe(403)
    expect((res.json() as { error: string }).error).toMatch(/admin sign-in/i)
    expect(cookieFrom(res, 'token')).toBeNull()
  })

  it('revokes a session immediately when the row is deleted', async () => {
    const cookie = await adminCookie()
    expect(cookie).toBeTruthy()
    const before = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { cookie: cookie! } })
    expect(before.statusCode).toBe(200)

    // This is the property a stateless JWT cannot offer.
    await revokeAllAdminSessions(adminId)

    const after = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { cookie: cookie! } })
    expect(after.statusCode).toBe(401)
  })

  it('ends a single session on logout', async () => {
    const cookie = await adminCookie()
    const out = await app.inject({ method: 'POST', url: '/api/admin/auth/logout', headers: { cookie: cookie! } })
    expect(out.statusCode).toBe(200)
    const after = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { cookie: cookie! } })
    expect(after.statusCode).toBe(401)
  })

  it('honours suspension immediately, without waiting for expiry', async () => {
    const cookie = await adminCookie()
    const ok = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { cookie: cookie! } })
    expect(ok.statusCode).toBe(200)

    await prisma.user.update({ where: { id: adminId }, data: { status: 'SUSPENDED' } })
    const suspended = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { cookie: cookie! } })
    expect(suspended.statusCode).toBe(401)
    await prisma.user.update({ where: { id: adminId }, data: { status: 'ACTIVE' } })
  })
})

describe('mobile admin app bearer auth', () => {
  // The mobile app has no cookie jar, so it stores the session token from the login
  // body and sends it as `Authorization: Bearer`. The guard already accepted a
  // bearer token; these tests pin the two halves the app depends on: the token is
  // issued, and it is the same revocable session the cookie would have carried.
  it('issues a bearer token that the admin API accepts', async () => {
    const token = await adminToken()
    expect(token).toBeTruthy()
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: { authorization: `Bearer ${token}` }
    })
    expect(res.statusCode).toBe(200)
  })

  it('revokes the session when logout is called with the bearer token', async () => {
    const token = await adminToken()
    expect(token).toBeTruthy()
    const before = await app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: { authorization: `Bearer ${token}` }
    })
    expect(before.statusCode).toBe(200)

    const out = await app.inject({
      method: 'POST',
      url: '/api/admin/auth/logout',
      headers: { authorization: `Bearer ${token}` }
    })
    expect(out.statusCode).toBe(200)

    const after = await app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: { authorization: `Bearer ${token}` }
    })
    expect(after.statusCode).toBe(401)
  })
})
