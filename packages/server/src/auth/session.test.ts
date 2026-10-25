import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import bcrypt from 'bcryptjs'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../db/index.js'
import { buildApp } from '../app.js'

/**
 * The player session round trip the client relies on: log in, keep the token, and
 * recover it from the cookie when local storage lost it; log out clears the cookie
 * even for an expired session.
 */

const TAG = `sess${Date.now() % 1000000}`
const PASSWORD = 'session-password-1'
let app: FastifyInstance
let userId: string

function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string | null {
  const raw = res.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  for (const c of list) if (typeof c === 'string' && c.startsWith(`${name}=`)) return c
  return null
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const user = await prisma.user.create({
    data: {
      email: `${TAG}@test.local`,
      username: `s${TAG}`,
      passwordHash: bcrypt.hashSync(PASSWORD, 10),
      role: 'PLAYER',
      status: 'ACTIVE',
      wallet: { create: { available: 0 } }
    }
  })
  userId = user.id
})

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: userId } })
  await app.close()
})

async function login(): Promise<{ token: string; cookie: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: `s${TAG}`, password: PASSWORD } })
  expect(res.statusCode).toBe(200)
  const cookie = cookieFrom(res, 'token')
  expect(cookie).toBeTruthy()
  return { token: (res.json() as { data: { token: string } }).data.token, cookie: cookie!.split(';')[0]! }
}

describe('player session', () => {
  it('the stored token works as a Bearer header on its own (no cookie)', async () => {
    const { token } = await login()
    const res = await app.inject({ method: 'GET', url: '/api/auth/status', headers: { authorization: `Bearer ${token}` } })
    expect(res.statusCode).toBe(200)
    const data = (res.json() as { data: { authenticated: boolean; user: { id: string } } }).data
    expect(data.authenticated).toBe(true)
    expect(data.user.id).toBe(userId)
  })

  it('exchanges a session cookie for the token when local storage lost it', async () => {
    const { token, cookie } = await login()
    const res = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const data = (res.json() as { data: { token: string; user: { id: string; username: string } } }).data
    expect(data.token).toBe(token)
    expect(data.user.id).toBe(userId)
  })

  it('answers 401 without a cookie or with a forged one', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/session' })).statusCode).toBe(401)
    const forged = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: 'token=not-a-real-token' } })
    expect(forged.statusCode).toBe(401)
  })

  it('refuses a suspended account and clears its cookie', async () => {
    const { cookie } = await login()
    await prisma.user.update({ where: { id: userId }, data: { status: 'SUSPENDED' } })
    try {
      const res = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } })
      expect(res.statusCode).toBe(401)
      expect(cookieFrom(res, 'token')).toMatch(/^token=;/)
    } finally {
      await prisma.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } })
    }
  })

  it('logout clears the cookie, even with no valid session', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout', payload: {} })
    expect(res.statusCode).toBe(200)
    expect(cookieFrom(res, 'token')).toMatch(/^token=;/)
  })
})
