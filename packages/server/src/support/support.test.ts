import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest'
import bcrypt from 'bcryptjs'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../db/index.js'
import { buildApp } from '../app.js'
import { signToken } from '../auth/guards.js'
import { resetLockouts, revokeAllAdminSessions } from '../admin/auth.js'

/**
 * Customer support over HTTP. Driven through app.inject() on purpose: the bugs this
 * guards against (a player route reading the wrong request field, an admin route
 * missing `config: { public: true }`) live in the route wiring, which a service-level
 * test never touches.
 */

const TAG = `sup${Date.now() % 1000000}`
const ADMIN_EMAIL = `admin-${TAG}@test.local`
const ADMIN_PASSWORD = 'support-desk-password'

let app: FastifyInstance
let adminId: string
let playerId: string
let otherPlayerId: string
let adminToken: string
let playerAuth: string
let otherAuth: string

async function player(name: string): Promise<{ id: string; auth: string }> {
  const user = await prisma.user.create({
    data: {
      email: `${name}-${TAG}@test.local`,
      username: `${name}${TAG}`,
      passwordHash: '!',
      role: 'PLAYER',
      status: 'ACTIVE',
      wallet: { create: { available: 0 } }
    }
  })
  const token = signToken({ id: user.id, username: user.username, role: user.role, status: user.status })
  return { id: user.id, auth: `Bearer ${token}` }
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const admin = await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      username: `desk${TAG}`,
      passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 10),
      role: 'SUPERADMIN',
      status: 'ACTIVE',
      wallet: { create: { available: 0 } }
    }
  })
  adminId = admin.id
  const a = await player('ann')
  const b = await player('bob')
  playerId = a.id
  playerAuth = a.auth
  otherPlayerId = b.id
  otherAuth = b.auth

  resetLockouts()
  const login = await app.inject({ method: 'POST', url: '/api/admin/auth/login', payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(login.statusCode).toBe(200)
  adminToken = (login.json() as { data: { token: string } }).data.token
})

beforeEach(() => {
  resetLockouts()
})

afterAll(async () => {
  await revokeAllAdminSessions(adminId)
  await prisma.adminAction.deleteMany({ where: { adminId } })
  await prisma.user.deleteMany({ where: { id: { in: [adminId, playerId, otherPlayerId] } } })
  await app.close()
})

const asAdmin = () => ({ authorization: `Bearer ${adminToken}` })

async function threadIdFor(userId: string): Promise<string> {
  const thread = await prisma.supportThread.findUniqueOrThrow({ where: { userId } })
  return thread.id
}

async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let value = await read()
  for (let i = 0; i < 20 && !ok(value); i++) {
    await new Promise((r) => setTimeout(r, 50))
    value = await read()
  }
  return value
}

describe('player support routes', () => {
  it('opens an empty thread on first visit', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/support/thread', headers: { authorization: playerAuth } })
    expect(res.statusCode).toBe(200)
    const thread = (res.json() as { data: { userId: string; status: string; messages: unknown[] } }).data
    expect(thread.userId).toBe(playerId)
    expect(thread.status).toBe('OPEN')
    expect(thread.messages).toEqual([])
  })

  it('refuses a request with no player session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/support/thread' })
    expect(res.statusCode).toBe(401)
  })

  it('posts a message, rejects an empty one, and alerts staff once per burst', async () => {
    const empty = await app.inject({ method: 'POST', url: '/api/support/message', headers: { authorization: playerAuth }, payload: { body: '   ' } })
    expect(empty.statusCode).toBe(400)

    const first = await app.inject({ method: 'POST', url: '/api/support/message', headers: { authorization: playerAuth }, payload: { body: 'My deposit is missing' } })
    expect(first.statusCode).toBe(201)
    const second = await app.inject({ method: 'POST', url: '/api/support/message', headers: { authorization: playerAuth }, payload: { body: 'tx id abc123' } })
    expect(second.statusCode).toBe(201)

    const alerts = await eventually(
      () => prisma.notification.count({ where: { userId: adminId, kind: 'SUPPORT_MESSAGE' } }),
      (n) => n > 0
    )
    expect(alerts).toBe(1)
  })
})

describe('admin support routes', () => {
  it('refuses a player token and an anonymous caller', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/admin/support/threads' })
    expect(anon.statusCode).toBe(401)
    const asPlayer = await app.inject({ method: 'GET', url: '/api/admin/support/threads', headers: { authorization: playerAuth } })
    expect(asPlayer.statusCode).toBe(401)
  })

  it('lists threads with the latest message and the unread count', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/support/threads', headers: asAdmin() })
    expect(res.statusCode).toBe(200)
    const rows = (res.json() as { data: Array<{ userId: string; unreadCount: number; lastMessage: { body: string } | null }> }).data
    const mine = rows.find((r) => r.userId === playerId)
    expect(mine?.unreadCount).toBe(2)
    expect(mine?.lastMessage?.body).toBe('tx id abc123')

    const stats = await app.inject({ method: 'GET', url: '/api/admin/stats', headers: asAdmin() })
    expect((stats.json() as { data: { supportAwaiting: number } }).data.supportAwaiting).toBeGreaterThanOrEqual(1)
  })

  it('opening a thread marks the player messages read', async () => {
    const id = await threadIdFor(playerId)
    const res = await app.inject({ method: 'GET', url: `/api/admin/support/thread/${id}`, headers: asAdmin() })
    expect(res.statusCode).toBe(200)
    const thread = (res.json() as { data: { messages: unknown[]; user: { username: string } } }).data
    expect(thread.messages).toHaveLength(2)
    expect(thread.user.username).toBe(`ann${TAG}`)
    expect(await prisma.supportMessage.count({ where: { threadId: id, senderRole: 'USER', read: false } })).toBe(0)
  })

  it('a reply reaches the player, notifies them, and assigns the thread', async () => {
    const id = await threadIdFor(playerId)
    const res = await app.inject({ method: 'POST', url: `/api/admin/support/thread/${id}/reply`, headers: asAdmin(), payload: { body: 'Found it, credited now.' } })
    expect(res.statusCode).toBe(201)

    const unread = await app.inject({ method: 'GET', url: '/api/support/unread', headers: { authorization: playerAuth } })
    expect((unread.json() as { data: { unread: number } }).data.unread).toBe(1)

    const notes = await eventually(
      () => prisma.notification.count({ where: { userId: playerId, kind: 'SUPPORT_REPLY' } }),
      (n) => n > 0
    )
    expect(notes).toBe(1)
    const thread = await prisma.supportThread.findUniqueOrThrow({ where: { id } })
    expect(thread.assignedToId).toBe(adminId)

    // The player reading the thread clears their unread count.
    const view = await app.inject({ method: 'GET', url: '/api/support/thread', headers: { authorization: playerAuth } })
    const msgs = (view.json() as { data: { messages: Array<{ senderRole: string; body: string }> } }).data.messages
    expect(msgs.at(-1)).toMatchObject({ senderRole: 'ADMIN', body: 'Found it, credited now.' })
    const after = await app.inject({ method: 'GET', url: '/api/support/unread', headers: { authorization: playerAuth } })
    expect((after.json() as { data: { unread: number } }).data.unread).toBe(0)
  })

  it('closes and reopens with an audit trail; the player writing reopens a closed thread', async () => {
    const id = await threadIdFor(playerId)
    const close = await app.inject({ method: 'POST', url: `/api/admin/support/thread/${id}/close`, headers: asAdmin() })
    expect(close.statusCode).toBe(200)
    expect((await prisma.supportThread.findUniqueOrThrow({ where: { id } })).status).toBe('CLOSED')

    const closedList = await app.inject({ method: 'GET', url: '/api/admin/support/threads?status=CLOSED', headers: asAdmin() })
    expect((closedList.json() as { data: Array<{ id: string }> }).data.map((t) => t.id)).toContain(id)

    await app.inject({ method: 'POST', url: '/api/support/message', headers: { authorization: playerAuth }, payload: { body: 'One more thing' } })
    expect((await prisma.supportThread.findUniqueOrThrow({ where: { id } })).status).toBe('OPEN')

    await app.inject({ method: 'POST', url: `/api/admin/support/thread/${id}/close`, headers: asAdmin() })
    const reopen = await app.inject({ method: 'POST', url: `/api/admin/support/thread/${id}/reopen`, headers: asAdmin() })
    expect(reopen.statusCode).toBe(200)
    expect((await prisma.supportThread.findUniqueOrThrow({ where: { id } })).status).toBe('OPEN')

    const actions = await prisma.adminAction.findMany({ where: { adminId, action: { in: ['SUPPORT_CLOSE', 'SUPPORT_REOPEN'] } } })
    expect(actions.map((a) => a.action).sort()).toEqual(['SUPPORT_CLOSE', 'SUPPORT_CLOSE', 'SUPPORT_REOPEN'])
  })

  it('answers 404 for a thread that does not exist', async () => {
    for (const [method, url] of [
      ['GET', '/api/admin/support/thread/nope'],
      ['POST', '/api/admin/support/thread/nope/close'],
      ['POST', '/api/admin/support/thread/nope/reopen']
    ] as const) {
      const res = await app.inject({ method, url, headers: asAdmin() })
      expect(res.statusCode).toBe(404)
    }
    const reply = await app.inject({ method: 'POST', url: '/api/admin/support/thread/nope/reply', headers: asAdmin(), payload: { body: 'hi' } })
    expect(reply.statusCode).toBe(404)
  })

  it("keeps players' threads apart", async () => {
    await app.inject({ method: 'POST', url: '/api/support/message', headers: { authorization: otherAuth }, payload: { body: 'bob here' } })
    const bob = await app.inject({ method: 'GET', url: '/api/support/thread', headers: { authorization: otherAuth } })
    const msgs = (bob.json() as { data: { messages: Array<{ body: string }> } }).data.messages
    expect(msgs.map((m) => m.body)).toEqual(['bob here'])
  })
})
