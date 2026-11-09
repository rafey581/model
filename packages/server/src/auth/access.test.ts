import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import bcrypt from 'bcryptjs'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../db/index.js'
import { buildApp } from '../app.js'
import { bindOwnerUserIds } from './owners.js'
import { resetLoginThrottles } from './loginThrottle.js'
import { revokeAllAdminSessions } from '../admin/auth.js'
import { BOT_USER_EMAIL, PLATFORM_USER_EMAIL } from '../matches/service.js'

/**
 * Owner-only staff access, and the sign-in cooldown.
 *
 * These run through HTTP. A helper that forgot to consult OWNER_USER_IDS, or a
 * role field the route still writes, would not survive them.
 */

const TAG = `own${Date.now() % 1000000}`
const PASSWORD = 'owner-access-password'

let app: FastifyInstance
const userIds: string[] = []

async function makeUser(name: string, role = 'PLAYER'): Promise<{ id: string; email: string; username: string }> {
  const user = await prisma.user.create({
    data: {
      email: `${name}-${TAG}@test.local`,
      username: `${name}${TAG}`.slice(0, 24),
      passwordHash: bcrypt.hashSync(PASSWORD, 4),
      role,
      status: 'ACTIVE',
      wallet: { create: { available: 0 } }
    }
  })
  userIds.push(user.id)
  if (!user.email) throw new Error('test account is missing an email')
  return { id: user.id, email: user.email, username: user.username }
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  bindOwnerUserIds([])
  await resetLoginThrottles()
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.adminAction.deleteMany({ where: { adminId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await app.close()
})

async function staffLogin(email: string, password = PASSWORD) {
  return app.inject({ method: 'POST', url: '/api/admin/auth/login', payload: { email, password } })
}

describe('staff access is the owner list', () => {
  it('rejects a role change and still allows a player status change', async () => {
    const owner = await makeUser('owner', 'SUPERADMIN')
    const player = await makeUser('player')
    bindOwnerUserIds([owner.id])
    await resetLoginThrottles()
    const login = await staffLogin(owner.email)
    expect(login.statusCode).toBe(200)
    const token = (login.json() as { data: { token: string } }).data.token
    const auth = { authorization: `Bearer ${token}` }

    const promote = await app.inject({
      method: 'PATCH',
      url: '/api/admin/users',
      headers: auth,
      payload: { userId: player.id, role: 'ADMIN' }
    })
    expect(promote.statusCode).toBe(400)
    expect((promote.json() as { error: string }).error).toMatch(/role/i)

    const both = await app.inject({
      method: 'PATCH',
      url: '/api/admin/users',
      headers: auth,
      payload: { userId: player.id, status: 'BANNED', role: 'ADMIN' }
    })
    expect(both.statusCode).toBe(400)
    expect((await prisma.user.findUnique({ where: { id: player.id } }))?.role).toBe('PLAYER')
    expect((await prisma.user.findUnique({ where: { id: player.id } }))?.status).toBe('ACTIVE')

    const ban = await app.inject({
      method: 'PATCH',
      url: '/api/admin/users',
      headers: auth,
      payload: { userId: player.id, status: 'BANNED' }
    })
    expect(ban.statusCode).toBe(200)
    expect((await prisma.user.findUnique({ where: { id: player.id } }))?.status).toBe('BANNED')
    await prisma.user.update({ where: { id: player.id }, data: { status: 'ACTIVE' } })
  })

  it('does not let a non-owner admin session keep calling the API', async () => {
    const owner = await makeUser('keeper', 'SUPERADMIN')
    const stranger = await makeUser('stranger', 'ADMIN')
    bindOwnerUserIds([owner.id, stranger.id])
    await resetLoginThrottles()
    const login = await staffLogin(stranger.email)
    expect(login.statusCode).toBe(200)
    const token = (login.json() as { data: { token: string } }).data.token

    const before = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { authorization: `Bearer ${token}` } })
    expect(before.statusCode).toBe(200)

    bindOwnerUserIds([owner.id])
    const after = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { authorization: `Bearer ${token}` } })
    expect(after.statusCode).toBe(401)
    expect(await prisma.session.count({ where: { userId: stranger.id, purpose: 'ADMIN' } })).toBe(0)

    const ownerLogin = await staffLogin(owner.email)
    expect(ownerLogin.statusCode).toBe(200)
    const ownerToken = (ownerLogin.json() as { data: { token: string } }).data.token
    const still = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: { authorization: `Bearer ${ownerToken}` } })
    expect(still.statusCode).toBe(200)
    await revokeAllAdminSessions(owner.id)
  })

  it('refuses staff sign-in for an admin who is not on the list, with the same body as a bad password', async () => {
    const owner = await makeUser('real', 'PLAYER')
    const admin = await makeUser('legacy', 'ADMIN')
    bindOwnerUserIds([owner.id])
    await resetLoginThrottles()
    const wrong = await staffLogin(owner.email, 'not-the-password')
    const outsider = await staffLogin(admin.email)
    expect(wrong.statusCode).toBe(401)
    expect(outsider.statusCode).toBe(401)
    expect(outsider.json()).toEqual(wrong.json())
    expect(JSON.stringify(outsider.json())).not.toContain('token')
  })

  it('lets a non-owner with an admin role play, and refuses the owner on the game sign-in', async () => {
    const owner = await makeUser('boss', 'SUPERADMIN')
    const legacy = await makeUser('legacyplay', 'ADMIN')
    bindOwnerUserIds([owner.id])
    await resetLoginThrottles()
    const asOwner = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: owner.username, password: PASSWORD }
    })
    expect(asOwner.statusCode).toBe(403)
    const asPlayer = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: legacy.username, password: PASSWORD }
    })
    expect(asPlayer.statusCode).toBe(200)
  })

  it('refuses to suspend the owner or an internal account', async () => {
    const owner = await makeUser('solo', 'SUPERADMIN')
    const otherOwner = await makeUser('partner', 'PLAYER')
    const player = await makeUser('victim')
    bindOwnerUserIds([owner.id, otherOwner.id])
    await resetLoginThrottles()
    const token = (await staffLogin(owner.email)).json() as { data: { token: string } }
    const auth = { authorization: `Bearer ${token.data.token}` }

    const self = await app.inject({
      method: 'PATCH',
      url: '/api/admin/users',
      headers: auth,
      payload: { userId: owner.id, status: 'BANNED' }
    })
    expect(self.statusCode).toBe(403)
    expect((await prisma.user.findUnique({ where: { id: owner.id } }))?.status).toBe('ACTIVE')

    const partner = await app.inject({
      method: 'PATCH',
      url: '/api/admin/users',
      headers: auth,
      payload: { userId: otherOwner.id, status: 'SUSPENDED' }
    })
    expect(partner.statusCode).toBe(403)
    expect((await prisma.user.findUnique({ where: { id: otherOwner.id } }))?.status).toBe('ACTIVE')

    const platform = await prisma.user.findUnique({ where: { email: PLATFORM_USER_EMAIL } })
    const bot = await prisma.user.findUnique({ where: { email: BOT_USER_EMAIL } })
    expect(platform).toBeTruthy()
    expect(bot).toBeTruthy()
    for (const internal of [platform!, bot!]) {
      const status = await app.inject({
        method: 'PATCH',
        url: '/api/admin/users',
        headers: auth,
        payload: { userId: internal.id, status: 'BANNED' }
      })
      expect(status.statusCode).toBe(403)
      const adjust = await app.inject({
        method: 'POST',
        url: '/api/admin/wallet/adjust',
        headers: auth,
        payload: { userId: internal.id, amount: 5, reason: 'should not apply' }
      })
      expect(adjust.statusCode).toBe(403)
      expect((await prisma.user.findUnique({ where: { id: internal.id } }))?.status).toBe(internal.status)
    }

    const listed = await app.inject({ method: 'GET', url: '/api/admin/users?q=platform', headers: auth })
    const rows = (listed.json() as { data: Array<{ email: string | null }> }).data
    expect(rows.some((row) => row.email === PLATFORM_USER_EMAIL)).toBe(false)

    const ok = await app.inject({
      method: 'PATCH',
      url: '/api/admin/users',
      headers: auth,
      payload: { userId: player.id, status: 'SUSPENDED' }
    })
    expect(ok.statusCode).toBe(200)
  })
})

describe('sign-in cooldown', () => {
  it('cools an identifier down, then accepts the right password once the window has passed', async () => {
    const player = await makeUser('cooler')
    bindOwnerUserIds([])
    await resetLoginThrottles()
    for (let i = 0; i < 4; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: player.username, password: 'wrong-pass' }
      })
      expect(res.statusCode).toBe(401)
    }
    const locked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: player.username, password: 'still-wrong' }
    })
    expect(locked.statusCode).toBe(429)
    expect(locked.headers['retry-after']).toBeDefined()
    expect((locked.json() as { error: string }).error).toMatch(/try again in/i)

    // A correct password during the cooldown does not open a session.
    const during = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: player.username, password: PASSWORD }
    })
    expect(during.statusCode).toBe(429)

    await prisma.loginThrottle.updateMany({
      data: { lockedUntil: new Date(Date.now() - 1000), windowStart: new Date(Date.now() - 16 * 60 * 1000) }
    })
    const after = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: player.username, password: PASSWORD }
    })
    expect(after.statusCode).toBe(200)
  })

  it('clears the identifier counter after a successful sign-in and does not clear the address', async () => {
    const player = await makeUser('resetme')
    await resetLoginThrottles()
    for (let i = 0; i < 4; i += 1) {
      expect(
        (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: player.username, password: 'nope' } })).statusCode
      ).toBe(401)
    }
    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: player.username, password: PASSWORD }
    })
    expect(ok.statusCode).toBe(200)
    for (let i = 0; i < 4; i += 1) {
      expect(
        (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: player.username, password: 'nope' } })).statusCode
      ).toBe(401)
    }
  })

  it('locks an address across many identifiers, and ignores a spoofed forwarding header', async () => {
    await resetLoginThrottles()
    const address = '203.0.113.10'
    for (let i = 0; i < 14; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: address,
        headers: { 'x-forwarded-for': '198.51.100.20' },
        payload: { username: `spray${i}${TAG}`, password: 'wrong' }
      })
      expect(res.statusCode).toBe(401)
    }
    const locked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: address,
      payload: { username: `spray-last${TAG}`, password: 'wrong' }
    })
    expect(locked.statusCode).toBe(429)

    const other = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '203.0.113.11',
      headers: { 'x-forwarded-for': '198.51.100.20' },
      payload: { username: `fresh${TAG}`, password: 'wrong' }
    })
    expect(other.statusCode).toBe(401)
  })

  it('counts concurrent failures once each and does not pass the limit', async () => {
    const player = await makeUser('race')
    await resetLoginThrottles()
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        app.inject({
          method: 'POST',
          url: '/api/auth/login',
          remoteAddress: `198.51.100.${i + 1}`,
          payload: { username: player.username, password: `wrong-${i}` }
        })
      )
    )
    const codes = results.map((res) => res.statusCode).sort()
    expect(codes.filter((code) => code === 401).length).toBe(4)
    expect(codes.filter((code) => code === 429).length).toBe(4)
    const follow = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '198.51.100.50',
      payload: { username: player.username, password: PASSWORD }
    })
    expect(follow.statusCode).toBe(429)
  })
})
