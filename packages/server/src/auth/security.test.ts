import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../db/index.js'
import { buildApp } from '../app.js'
import { config } from '../config.js'
import { runInTransaction, ledger } from '../wallet/service.js'

/**
 * Account takeover defences, over HTTP.
 *
 * The reset route used to accept a bare user id with a new password, which let anyone
 * who knew an id (they appear on leaderboards and in matches) take over any account,
 * staff included. These tests pin that shut, along with the rest of the hardening.
 */

const TAG = `sec${Date.now() % 1000000}`
const PASSWORD = 'Original-pass-1'
let app: FastifyInstance
const userIds: string[] = []

async function player(name: string, opts: { role?: string; balance?: number } = {}) {
  const user = await prisma.user.create({
    data: {
      email: `${name}-${TAG}@test.local`,
      username: `${name}${TAG}`.slice(0, 24),
      phone: `+1${String(Date.now()).slice(-9)}${userIds.length}`,
      passwordHash: bcrypt.hashSync(PASSWORD, 4),
      role: opts.role ?? 'PLAYER',
      status: 'ACTIVE',
      wallet: { create: { available: 0 } }
    }
  })
  userIds.push(user.id)
  if (opts.balance) await runInTransaction((tx) => ledger.creditAvailable(tx, { userId: user.id, amount: opts.balance!, type: 'ADJUSTMENT' }))
  return user
}

async function login(username: string, password = PASSWORD) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})

afterAll(async () => {
  await prisma.cryptoWithdrawal.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await app.close()
})

describe('password reset', () => {
  it('refuses a reset that only names the account', async () => {
    const victim = await player('victim')
    const res = await app.inject({ method: 'POST', url: '/api/auth/password/reset', payload: { userId: victim.id, password: 'Hijacked-pass-1' } })
    expect(res.statusCode).toBe(400)
    expect((await login(victim.username)).statusCode).toBe(200)
  })

  it('refuses a token not issued by the forgot step', async () => {
    const victim = await player('victim2')
    const forged = jwt.sign({ sub: victim.id, purpose: 'password-reset', pv: 'guess' }, config.JWT_SECRET, { expiresIn: '10m' })
    const wrongKey = jwt.sign({ sub: victim.id, purpose: 'password-reset' }, 'not-the-server-secret-at-all', { expiresIn: '10m' })
    for (const resetToken of [forged, wrongKey]) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/password/reset', payload: { resetToken, password: 'Hijacked-pass-1' } })
      expect(res.statusCode).toBe(400)
    }
    expect((await login(victim.username)).statusCode).toBe(200)
  })

  it('resets with the forgot-step token once, and signs the account out everywhere', async () => {
    const owner = await player('owner')
    const before = await login(owner.username)
    const oldToken = (before.json() as { data: { token: string } }).data.token
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${oldToken}` } })).statusCode).toBe(200)

    const forgot = await app.inject({
      method: 'POST',
      url: '/api/auth/password/forgot',
      payload: { email: owner.email, username: owner.username, phone: owner.phone }
    })
    expect(forgot.statusCode).toBe(200)
    const data = (forgot.json() as { data: { resetToken: string; userId?: string } }).data
    expect(data.userId).toBeUndefined()

    // A reset token is not a login.
    const asLogin = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${data.resetToken}` } })
    expect(asLogin.statusCode).toBe(401)

    const short = await app.inject({ method: 'POST', url: '/api/auth/password/reset', payload: { resetToken: data.resetToken, password: 'short' } })
    expect(short.statusCode).toBe(400)

    const reset = await app.inject({ method: 'POST', url: '/api/auth/password/reset', payload: { resetToken: data.resetToken, password: 'Brand-new-pass-1' } })
    expect(reset.statusCode).toBe(200)

    // Used once: it no longer works.
    const again = await app.inject({ method: 'POST', url: '/api/auth/password/reset', payload: { resetToken: data.resetToken, password: 'Another-pass-12' } })
    expect(again.statusCode).toBe(400)

    // The login from before the reset is dead; the new password works; the old one does not.
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${oldToken}` } })).statusCode).toBe(401)
    expect((await login(owner.username, 'Brand-new-pass-1')).statusCode).toBe(200)
    expect((await login(owner.username, PASSWORD)).statusCode).toBe(401)
  })

  it('never issues a reset for a staff account', async () => {
    const staff = await player('staffer', { role: 'SUPERADMIN' })
    const forgot = await app.inject({
      method: 'POST',
      url: '/api/auth/password/forgot',
      payload: { email: staff.email, username: staff.username, phone: staff.phone }
    })
    expect(forgot.statusCode).toBe(400)
    expect(JSON.stringify(forgot.json())).not.toContain('resetToken')
  })
})

describe('the public default password', () => {
  it('cannot be used on a player or a staff account', async () => {
    const demo = await prisma.user.create({
      data: { email: `demo-${TAG}@test.local`, username: `demo${TAG}`.slice(0, 24), passwordHash: bcrypt.hashSync('admin123', 4), role: 'PLAYER', status: 'ACTIVE', wallet: { create: { available: 0 } } }
    })
    userIds.push(demo.id)
    const asPlayer = await login(demo.username, 'admin123')
    expect(asPlayer.statusCode).toBe(403)

    const staff = await prisma.user.create({
      data: { email: `boss-${TAG}@test.local`, username: `boss${TAG}`.slice(0, 24), passwordHash: bcrypt.hashSync('admin123', 4), role: 'SUPERADMIN', status: 'ACTIVE', wallet: { create: { available: 0 } } }
    })
    userIds.push(staff.id)
    const asStaff = await app.inject({ method: 'POST', url: '/api/admin/auth/login', payload: { email: staff.email, password: 'admin123' } })
    expect(asStaff.statusCode).toBe(403)
    expect(JSON.stringify(asStaff.json())).not.toContain('token')
    await prisma.adminAction.deleteMany({ where: { adminId: { in: [staff.id] } } })
  })
})

describe('withdrawals need the password', () => {
  it('refuses a payout with the wrong password and creates nothing', async () => {
    const owner = await player('payer', { balance: 50 })
    const token = (await login(owner.username)).json() as { data: { token: string } }
    const auth = { authorization: `Bearer ${token.data.token}` }
    const body = { amountUsdt: 10, address: 'D1nhYBCDFpEjc3Hnz9ZhjGyMMqkpk3qNcZJmQHcYyXqG' }

    const none = await app.inject({ method: 'POST', url: '/api/withdrawals', headers: auth, payload: body })
    expect(none.statusCode).toBe(400)
    const wrong = await app.inject({ method: 'POST', url: '/api/withdrawals', headers: auth, payload: { ...body, password: 'not-it' } })
    expect(wrong.statusCode).toBe(403)
    expect(await prisma.cryptoWithdrawal.count({ where: { userId: owner.id } })).toBe(0)

    const right = await app.inject({ method: 'POST', url: '/api/withdrawals', headers: auth, payload: { ...body, password: PASSWORD } })
    expect(right.statusCode).toBe(201)
  })
})

describe('rate limits', () => {
  it('blocks repeated login attempts from one address', async () => {
    vi.stubEnv('RATE_LIMIT_ENABLED', 'true')
    vi.resetModules()
    const { buildApp: build } = await import('../app.js')
    const limited = await build()
    await limited.ready()
    try {
      const codes: number[] = []
      for (let i = 0; i < 22; i++) {
        const res = await limited.inject({ method: 'POST', url: '/api/auth/login', payload: { username: `nobody${TAG}`, password: 'wrong' } })
        codes.push(res.statusCode)
      }
      expect(codes.slice(0, 20).every((c) => c === 401)).toBe(true)
      expect(codes[21]).toBe(429)
    } finally {
      await limited.close()
      vi.unstubAllEnvs()
    }
  })
})
