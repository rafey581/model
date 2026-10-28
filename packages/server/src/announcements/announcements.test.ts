import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import bcrypt from 'bcryptjs'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../db/index.js'
import { buildApp } from '../app.js'
import { signToken } from '../auth/guards.js'
import { resetLockouts, revokeAllAdminSessions } from '../admin/auth.js'
import { setAnnouncementBroadcaster, type AnnouncementData } from './service.js'

/** Announcements over HTTP: staff send, every player reads, live broadcast, withdraw. */

const TAG = `ann${Date.now() % 1000000}`
const ADMIN_EMAIL = `admin-${TAG}@test.local`
const ADMIN_PASSWORD = 'announce-desk-password'

let app: FastifyInstance
let adminId: string
let playerId: string
let adminToken: string
let playerAuth: string
const created: string[] = []
const broadcasts: AnnouncementData[] = []

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  const admin = await prisma.user.create({
    data: { email: ADMIN_EMAIL, username: `ad${TAG}`, passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 10), role: 'SUPERADMIN', status: 'ACTIVE', wallet: { create: { available: 0 } } }
  })
  adminId = admin.id
  const player = await prisma.user.create({
    data: { email: `p-${TAG}@test.local`, username: `p${TAG}`, passwordHash: '!', role: 'PLAYER', status: 'ACTIVE', wallet: { create: { available: 0 } } }
  })
  playerId = player.id
  playerAuth = `Bearer ${signToken({ id: player.id, username: player.username, role: player.role, status: player.status })}`
  resetLockouts()
  const login = await app.inject({ method: 'POST', url: '/api/admin/auth/login', payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  expect(login.statusCode).toBe(200)
  adminToken = (login.json() as { data: { token: string } }).data.token
  setAnnouncementBroadcaster((a) => broadcasts.push(a))
})

afterAll(async () => {
  setAnnouncementBroadcaster(null)
  await prisma.announcement.deleteMany({ where: { id: { in: created } } })
  await revokeAllAdminSessions(adminId)
  await prisma.adminAction.deleteMany({ where: { adminId } })
  await prisma.user.deleteMany({ where: { id: { in: [adminId, playerId] } } })
  await app.close()
})

const asAdmin = () => ({ authorization: `Bearer ${adminToken}` })

describe('announcements', () => {
  it('only staff can send one', async () => {
    const anon = await app.inject({ method: 'POST', url: '/api/admin/announcements', payload: { title: 'x', body: 'y' } })
    expect(anon.statusCode).toBe(401)
    const asPlayer = await app.inject({ method: 'POST', url: '/api/admin/announcements', headers: { authorization: playerAuth }, payload: { title: 'x', body: 'y' } })
    expect([401, 403]).toContain(asPlayer.statusCode)
  })

  it('refuses an empty title or message', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/announcements', headers: asAdmin(), payload: { title: '  ', body: 'hello' } })
    expect(res.statusCode).toBe(400)
    const res2 = await app.inject({ method: 'POST', url: '/api/admin/announcements', headers: asAdmin(), payload: { title: 'Hi', body: '' } })
    expect(res2.statusCode).toBe(400)
  })

  it('is broadcast live, shown to players, audited, and gone once withdrawn', async () => {
    const before = broadcasts.length
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/announcements',
      headers: asAdmin(),
      payload: { title: `Weekend tournament ${TAG}`, body: 'Double prizes this Saturday.' }
    })
    expect(res.statusCode).toBe(201)
    const sent = (res.json() as { data: AnnouncementData }).data
    created.push(sent.id)
    expect(broadcasts.length).toBe(before + 1)
    expect(broadcasts[broadcasts.length - 1]!.id).toBe(sent.id)

    const forPlayer = await app.inject({ method: 'GET', url: '/api/announcements', headers: { authorization: playerAuth } })
    expect(forPlayer.statusCode).toBe(200)
    const list = (forPlayer.json() as { data: AnnouncementData[] }).data
    expect(list.find((a) => a.id === sent.id)?.body).toBe('Double prizes this Saturday.')

    const anon = await app.inject({ method: 'GET', url: '/api/announcements' })
    expect(anon.statusCode).toBe(401)

    const audit = await prisma.adminAction.findFirst({ where: { adminId, action: 'ANNOUNCEMENT_SEND', targetId: sent.id } })
    expect(audit).not.toBeNull()

    const withdraw = await app.inject({ method: 'POST', url: `/api/admin/announcements/${sent.id}/withdraw`, headers: asAdmin() })
    expect(withdraw.statusCode).toBe(200)
    const after = await app.inject({ method: 'GET', url: '/api/announcements', headers: { authorization: playerAuth } })
    expect((after.json() as { data: AnnouncementData[] }).data.find((a) => a.id === sent.id)).toBeUndefined()

    const staffList = await app.inject({ method: 'GET', url: '/api/admin/announcements', headers: asAdmin() })
    const row = (staffList.json() as { data: AnnouncementData[] }).data.find((a) => a.id === sent.id)
    expect(row?.withdrawnAt).not.toBeNull()
  })

  it('answers 404 for withdrawing one that does not exist', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/announcements/nope/withdraw', headers: asAdmin() })
    expect(res.statusCode).toBe(404)
  })
})
