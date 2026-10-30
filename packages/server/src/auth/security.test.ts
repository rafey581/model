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
      name: 'Test Person',
      dateOfBirth: new Date(Date.UTC(1990, 4, 20)),
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
      payload: { email: owner.email, username: owner.username, phone: owner.phone, name: 'Test Person', dateOfBirth: '1990-05-20' }
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
      payload: { email: staff.email, username: staff.username, phone: staff.phone, name: 'Test Person', dateOfBirth: '1990-05-20' }
    })
    expect(forgot.statusCode).toBe(400)
    expect(JSON.stringify(forgot.json())).not.toContain('resetToken')
  })
})

describe('forgot password needs every detail', () => {
  it('refuses when any one detail is wrong or missing, and works when all match', async () => {
    const owner = await player('dob')
    const all = { email: owner.email, username: owner.username, phone: owner.phone, name: 'Test Person', dateOfBirth: '1990-05-20' }
    const attempts: Array<Record<string, unknown>> = [
      { ...all, dateOfBirth: '1990-05-21' },
      { ...all, name: 'Someone Else' },
      { ...all, phone: '+10000000000' },
      { ...all, dateOfBirth: undefined },
      { ...all, name: undefined },
      { ...all, dateOfBirth: '1990-02-30' }
    ]
    for (const payload of attempts) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/password/forgot', payload })
      expect(res.statusCode).toBe(400)
      expect(JSON.stringify(res.json())).not.toContain('resetToken')
    }
    // Capitals and extra spaces in the name do not matter.
    const ok = await app.inject({ method: 'POST', url: '/api/auth/password/forgot', payload: { ...all, name: '  test   PERSON ' } })
    expect(ok.statusCode).toBe(200)
    expect((ok.json() as { data: { resetToken: string } }).data.resetToken).toBeTruthy()
  })

  it('cannot reset an account with no date of birth saved, which can set it once', async () => {
    const old = await prisma.user.create({
      data: { email: `old-${TAG}@test.local`, username: `old${TAG}`.slice(0, 24), phone: `+1777${String(Date.now()).slice(-6)}`, name: 'Old Timer', passwordHash: bcrypt.hashSync(PASSWORD, 4), role: 'PLAYER', status: 'ACTIVE', wallet: { create: { available: 0 } } }
    })
    userIds.push(old.id)
    const payload = { email: old.email, username: old.username, phone: old.phone, name: 'Old Timer', dateOfBirth: '1980-01-01' }
    const res = await app.inject({ method: 'POST', url: '/api/auth/password/forgot', payload })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'no_dob' })

    const token = ((await login(old.username)).json() as { data: { token: string } }).data.token
    const auth = { authorization: `Bearer ${token}` }
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: auth })
    expect((me.json() as { data: { user: { needsDateOfBirth: boolean } } }).data.user.needsDateOfBirth).toBe(true)

    const young = await app.inject({ method: 'POST', url: '/api/me/date-of-birth', headers: auth, payload: { dateOfBirth: `${new Date().getUTCFullYear() - 10}-01-01` } })
    expect(young.statusCode).toBe(400)
    const set = await app.inject({ method: 'POST', url: '/api/me/date-of-birth', headers: auth, payload: { dateOfBirth: '1980-01-01' } })
    expect(set.statusCode).toBe(200)
    const again = await app.inject({ method: 'POST', url: '/api/me/date-of-birth', headers: auth, payload: { dateOfBirth: '1999-09-09' } })
    expect(again.statusCode).toBe(409)
    const meAfter = await app.inject({ method: 'GET', url: '/api/me', headers: auth })
    expect(JSON.stringify(meAfter.json())).not.toContain('1980')

    const works = await app.inject({ method: 'POST', url: '/api/auth/password/forgot', payload })
    expect(works.statusCode).toBe(200)
  })
})

describe('sign-up asks for the date of birth', () => {
  it('refuses a missing, impossible or under-age date', async () => {
    const base = (n: string) => ({ email: `su${n}-${TAG}@test.local`, username: `su${n}${TAG}`.slice(0, 24), password: 'Password-123', phone: `+1555${String(Date.now()).slice(-6)}${n}`, name: 'New Player', deviceId: `web:${TAG}${n}xyz` })
    const year = new Date().getUTCFullYear()
    for (const [n, dateOfBirth] of [['a', undefined], ['b', '2001-13-01'], ['c', `${year - 17}-06-01`], ['d', `${year + 1}-01-01`]] as const) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { ...base(n), ...(dateOfBirth ? { dateOfBirth } : {}) } })
      expect(res.statusCode).toBe(400)
    }
    const ok = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { ...base('e'), dateOfBirth: '2000-02-29' } })
    expect(ok.statusCode).toBe(200)
    const created = await prisma.user.findUniqueOrThrow({ where: { username: base('e').username } })
    userIds.push(created.id)
    expect(created.dateOfBirth?.toISOString().slice(0, 10)).toBe('2000-02-29')
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
