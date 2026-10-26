import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  FriendError,
  listFriends,
  respondToFriendRequest,
  searchFriends,
  sendFriendRequest
} from './service.js'
import { guestStakeMessage } from '../auth/guestGate.js'

const searchSchema = z.object({ q: z.string().max(40) })
const sendSchema = z.object({ username: z.string().min(1).max(24) })

async function blockGuest(userId: string, reply: { code: (n: number) => { send: (body: object) => unknown } }): Promise<boolean> {
  const blocked = await guestStakeMessage(userId)
  if (!blocked) return false
  await reply.code(403).send({ ok: false, error: blocked })
  return true
}

export async function registerFriendRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/friends', async (_request, reply) => {
    if (await blockGuest(_request.authUser!.id, reply)) return
    const data = await listFriends(_request.authUser!.id)
    return reply.send({ ok: true, data })
  })

  app.get('/api/friends/search', async (request, reply) => {
    if (await blockGuest(request.authUser!.id, reply)) return
    const parsed = searchSchema.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'enter a username to search for' })
    const data = await searchFriends(request.authUser!.id, parsed.data.q)
    return reply.send({ ok: true, data })
  })

  app.post('/api/friends/requests', async (request, reply) => {
    if (await blockGuest(request.authUser!.id, reply)) return
    const parsed = sendSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'enter a username' })
    try {
      const data = await sendFriendRequest(request.authUser!.id, request.authUser!.username, parsed.data.username)
      return reply.send({ ok: true, data })
    } catch (error) {
      if (error instanceof FriendError) return reply.code(400).send({ ok: false, error: error.message })
      throw error
    }
  })

  app.post('/api/friends/requests/:id/accept', async (request, reply) => {
    if (await blockGuest(request.authUser!.id, reply)) return
    const id = (request.params as { id: string }).id
    try {
      const data = await respondToFriendRequest({
        actorId: request.authUser!.id,
        actorUsername: request.authUser!.username,
        requestId: id,
        action: 'accept'
      })
      return reply.send({ ok: true, data })
    } catch (error) {
      if (error instanceof FriendError) return reply.code(400).send({ ok: false, error: error.message })
      throw error
    }
  })

  app.post('/api/friends/requests/:id/reject', async (request, reply) => {
    if (await blockGuest(request.authUser!.id, reply)) return
    const id = (request.params as { id: string }).id
    try {
      const data = await respondToFriendRequest({
        actorId: request.authUser!.id,
        actorUsername: request.authUser!.username,
        requestId: id,
        action: 'reject'
      })
      return reply.send({ ok: true, data })
    } catch (error) {
      if (error instanceof FriendError) return reply.code(400).send({ ok: false, error: error.message })
      throw error
    }
  })
}