import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import bcrypt from 'bcryptjs'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../db/index.js'
import { buildApp } from '../app.js'
import { signToken } from '../auth/guards.js'
import { resetLockouts, revokeAllAdminSessions } from '../admin/auth.js'
import { createDeposit } from '../deposits/service.js'
import { createWithdrawal } from '../withdrawals/service.js'
import { runInTransaction, ledger } from '../wallet/service.js'
import { EXPO_PUSH_URL, RING_CHANNEL_ID, RING_SOUND, setPushFetcher, type ExpoMessage } from './adminPush.js'

/**
 * Staff phone alerts. The Expo push service is replaced with a recorder, so these
 * tests check exactly what would be sent (to whom, on which channel, with which
 * sound) without touching the network.
 */

const TAG = `push${Date.now() % 1000000}`
const PASSWORD = 'push-alert-password'
const TOKEN_A = `ExponentPushToken[${TAG}-a]`
const TOKEN_B = `ExponentPushToken[${TAG}-b]`

let app: FastifyInstance
let adminId: string
let playerId: string
let adminAuth: string
let playerAuth: string
let sent: Array<{ url: string; messages: ExpoMessage[] }> = []
let nextTickets: (messages: ExpoMessage[]) => unknown[] = (m) => m.map(() => ({ status: 'ok', id: 'x' }))

async function waitForPush(count = 1): Promise<void> {
  for (let i = 0; i < 40 && sent.length < count; i++) await new Promise((r) => setTimeout(r, 25))
}

beforeAll(async () => {
  setPushFetcher(async (url, init) => {
    const messages = JSON.parse(init.body) as ExpoMessage[]
    sent.push({ url, messages })
    return { ok: true, status: 200, json: async () => ({ data: nextTickets(messages) }) }
  })
  app = await buildApp()
  await app.ready()
  const admin = await prisma.user.create({
    data: { email: `admin-${TAG}@test.local`, username: `ring${TAG}`, passwordHash: bcrypt.hashSync(PASSWORD, 10), role: 'ADMIN', status: 'ACTIVE', wallet: { create: { available: 0 } } }
  })
  adminId = admin.id
  const player = await prisma.user.create({
    data: { email: `p-${TAG}@test.local`, username: `payer${TAG}`, passwordHash: '!', role: 'PLAYER', status: 'ACTIVE', wallet: { create: { available: 0 } } }
  })
  playerId = player.id
  await runInTransaction((tx) => ledger.creditAvailable(tx, { userId: playerId, amount: 50, type: 'START_BALANCE' }))
  playerAuth = `Bearer ${signToken({ id: player.id, username: player.username, role: 'PLAYER', status: 'ACTIVE' })}`
  resetLockouts()
  const login = await app.inject({ method: 'POST', url: '/api/admin/auth/login', payload: { email: `admin-${TAG}@test.local`, password: PASSWORD } })
  adminAuth = `Bearer ${(login.json() as { data: { token: string } }).data.token}`
})

beforeEach(() => {
  sent = []
  nextTickets = (m) => m.map(() => ({ status: 'ok', id: 'x' }))
})

afterAll(async () => {
  setPushFetcher(null)
  await revokeAllAdminSessions(adminId)
  await prisma.adminDevice.deleteMany({ where: { token: { in: [TOKEN_A, TOKEN_B] } } })
  await prisma.adminAction.deleteMany({ where: { adminId } })
  await prisma.user.deleteMany({ where: { id: { in: [adminId, playerId] } } })
  await app.close()
})

describe('registering a staff phone', () => {
  it('accepts an Expo token from an admin session, idempotently', async () => {
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'POST', url: '/api/admin/devices', headers: { authorization: adminAuth }, payload: { token: TOKEN_A, platform: 'android' } })
      expect(res.statusCode).toBe(200)
    }
    expect(await prisma.adminDevice.count({ where: { token: TOKEN_A, userId: adminId } })).toBe(1)
  })

  it('refuses a junk token and a player session', async () => {
    const junk = await app.inject({ method: 'POST', url: '/api/admin/devices', headers: { authorization: adminAuth }, payload: { token: 'hello', platform: 'android' } })
    expect(junk.statusCode).toBe(400)
    const asPlayer = await app.inject({ method: 'POST', url: '/api/admin/devices', headers: { authorization: playerAuth }, payload: { token: TOKEN_B, platform: 'android' } })
    expect(asPlayer.statusCode).toBe(401)
  })
})

describe('ringing on money requests', () => {
  it('a new deposit rings every staff phone on the ring channel with the ring sound', async () => {
    await createDeposit({ userId: playerId, amountUsdt: 25, txHash: `${TAG}-dep`, screenshot: 'data:image/png;base64,AAAA' })
    await waitForPush()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe(EXPO_PUSH_URL)
    const mine = sent[0]!.messages.find((m) => m.to === TOKEN_A)
    expect(mine).toMatchObject({
      sound: RING_SOUND,
      channelId: RING_CHANNEL_ID,
      priority: 'high',
      title: 'New deposit: 25 USDT',
      data: { kind: 'DEPOSIT_PENDING', href: '/deposits', ring: true }
    })
    expect(mine!.body).toContain(`payer${TAG}`)
  })

  it('a new withdrawal rings too', async () => {
    await createWithdrawal({ userId: playerId, amountUsdt: 10, address: 'D1nhYBCDFpEjc3Hnz9ZhjGyMMqkpk3qNcZJmQHcYyXqG' })
    await waitForPush()
    const mine = sent[0]?.messages.find((m) => m.to === TOKEN_A)
    expect(mine).toMatchObject({ sound: RING_SOUND, channelId: RING_CHANNEL_ID, data: { kind: 'WITHDRAW_PENDING', href: '/withdrawals' } })
  })

  it('a support message is a normal notification, not a ring', async () => {
    await app.inject({ method: 'POST', url: '/api/support/message', headers: { authorization: playerAuth }, payload: { body: 'hello support' } })
    await waitForPush()
    const mine = sent[0]?.messages.find((m) => m.to === TOKEN_A)
    expect(mine).toMatchObject({ sound: 'default', channelId: 'default', data: { kind: 'SUPPORT_MESSAGE', ring: false } })
  })

  it('drops a phone Expo says is no longer registered', async () => {
    await app.inject({ method: 'POST', url: '/api/admin/devices', headers: { authorization: adminAuth }, payload: { token: TOKEN_B, platform: 'ios' } })
    nextTickets = (m) => m.map((msg) => (msg.to === TOKEN_B ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' }))
    await createDeposit({ userId: playerId, amountUsdt: 5, txHash: `${TAG}-dep2`, screenshot: 'data:image/png;base64,AAAA' })
    await waitForPush()
    for (let i = 0; i < 20 && (await prisma.adminDevice.count({ where: { token: TOKEN_B } })) > 0; i++) await new Promise((r) => setTimeout(r, 25))
    expect(await prisma.adminDevice.count({ where: { token: TOKEN_B } })).toBe(0)
    expect(await prisma.adminDevice.count({ where: { token: TOKEN_A } })).toBe(1)
  })

  it('a suspended admin is not rung', async () => {
    await prisma.user.update({ where: { id: adminId }, data: { status: 'SUSPENDED' } })
    try {
      await createDeposit({ userId: playerId, amountUsdt: 6, txHash: `${TAG}-dep3`, screenshot: 'data:image/png;base64,AAAA' })
      await new Promise((r) => setTimeout(r, 300))
      const toMe = sent.flatMap((s) => s.messages).filter((m) => m.to === TOKEN_A)
      expect(toMe).toHaveLength(0)
    } finally {
      await prisma.user.update({ where: { id: adminId }, data: { status: 'ACTIVE' } })
    }
  })
})

describe('test ring and sign-out', () => {
  it('the test button rings only the caller', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/devices/test', headers: { authorization: adminAuth } })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { data: { accepted: number } }).data.accepted).toBe(1)
    expect(sent[0]!.messages.map((m) => m.to)).toEqual([TOKEN_A])
  })

  it('removing the phone on sign-out stops it ringing', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/admin/devices', headers: { authorization: adminAuth }, payload: { token: TOKEN_A } })
    expect(res.statusCode).toBe(200)
    expect(await prisma.adminDevice.count({ where: { token: TOKEN_A } })).toBe(0)
    const none = await app.inject({ method: 'POST', url: '/api/admin/devices/test', headers: { authorization: adminAuth } })
    expect(none.statusCode).toBe(400)
  })
})
