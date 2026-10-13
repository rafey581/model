import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { prisma } from '../db/index.js'
import {
  FriendError,
  listFriends,
  respondToFriendRequest,
  searchFriends,
  sendFriendRequest
} from './service.js'

const TAG = `fr${Date.now() % 1000000}`
const USERS: string[] = []

async function createUser(role = 'PLAYER'): Promise<{ id: string; username: string }> {
  const username = `f${USERS.length}-${TAG}`
  const user = await prisma.user.create({
    data: {
      email: `${TAG}-${USERS.length}@test.local`,
      username,
      passwordHash: '!',
      role,
      status: 'ACTIVE'
    }
  })
  USERS.push(user.id)
  return { id: user.id, username }
}

async function cleanup(): Promise<void> {
  await prisma.user.deleteMany({ where: { id: { in: USERS } } })
  USERS.length = 0
}

beforeAll(async () => {
  await prisma.$connect()
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('friends', () => {
  it('sends a request, which lists as outgoing for the sender and incoming for the addressee, and notifies them', async () => {
    const alice = await createUser()
    const bob = await createUser()

    const sent = await sendFriendRequest(alice.id, alice.username, bob.username)
    expect(sent.target.username).toBe(bob.username)

    const edge = await prisma.friend.findUnique({ where: { id: sent.requestId } })
    expect(edge!.requesterId).toBe(alice.id)
    expect(edge!.addresseeId).toBe(bob.id)
    expect(edge!.status).toBe('PENDING')

    const aliceList = await listFriends(alice.id)
    expect(aliceList.outgoing.map((r) => r.username)).toEqual([bob.username])
    expect(aliceList.friends).toEqual([])

    const bobList = await listFriends(bob.id)
    expect(bobList.incoming.map((r) => r.username)).toEqual([alice.username])
    expect(bobList.outgoing).toEqual([])

    const notice = await prisma.notification.findFirst({
      where: { userId: bob.id, kind: 'FRIEND_REQUEST' },
      orderBy: { createdAt: 'desc' }
    })
    expect(notice?.title).toContain('friend request')
  })

  it('search finds a player by a case-insensitive username prefix and excludes the caller', async () => {
    const alice = await createUser()
    const bob = await createUser()

    const results = await searchFriends(alice.id, bob.username.toUpperCase().slice(0, 4))
    expect(results.map((r) => r.username)).toContain(bob.username)
    expect(results.some((r) => r.id === alice.id)).toBe(false)
    expect(results.find((r) => r.id === bob.id)!.relation).toBe('none')

    await sendFriendRequest(alice.id, alice.username, bob.username)
    const after = await searchFriends(alice.id, bob.username)
    expect(after.find((r) => r.id === bob.id)!.relation).toBe('pending-out')
  })

  it('rejects adding yourself or a username nobody has', async () => {
    const alice = await createUser()
    await expect(sendFriendRequest(alice.id, alice.username, alice.username)).rejects.toThrow(FriendError)
    await expect(sendFriendRequest(alice.id, alice.username, 'definitely-not-a-user')).rejects.toThrow(FriendError)
    await expect(sendFriendRequest(alice.id, alice.username, '')).rejects.toThrow(FriendError)
  })

  it('will not stack a duplicate request or a reverse pendant', async () => {
    const alice = await createUser()
    const bob = await createUser()

    await sendFriendRequest(alice.id, alice.username, bob.username)
    await expect(sendFriendRequest(alice.id, alice.username, bob.username)).rejects.toThrow(/already sent/)
    await expect(sendFriendRequest(bob.id, bob.username, alice.username)).rejects.toThrow(/accept it instead/)
  })

  it('accepting turns both lists into friends and notifies the requester; only the addressee may answer', async () => {
    const alice = await createUser()
    const bob = await createUser()

    const sent = await sendFriendRequest(alice.id, alice.username, bob.username)

    // The requester cannot accept their own request.
    await expect(respondToFriendRequest({ actorId: alice.id, actorUsername: alice.username, requestId: sent.requestId, action: 'accept' })).rejects.toThrow(
      FriendError
    )

    const accepted = await respondToFriendRequest({ actorId: bob.id, actorUsername: bob.username, requestId: sent.requestId, action: 'accept' })
    expect(accepted.status).toBe('ACCEPTED')

    const edge = await prisma.friend.findUnique({ where: { id: sent.requestId } })
    expect(edge!.status).toBe('ACCEPTED')
    expect(edge!.respondedAt).not.toBeNull()

    const aliceList = await listFriends(alice.id)
    expect(aliceList.friends.map((f) => f.username)).toEqual([bob.username])
    const bobList = await listFriends(bob.id)
    expect(bobList.friends.map((f) => f.username)).toEqual([alice.username])

    const notice = await prisma.notification.findFirst({
      where: { userId: alice.id, kind: 'FRIEND_REQUEST' },
      orderBy: { createdAt: 'desc' }
    })
    expect(notice?.title).toContain('accepted your friend request')
  })

  it('a rejection can be asked again: the old edge is replaced by a fresh pending one', async () => {
    const alice = await createUser()
    const bob = await createUser()

    const first = await sendFriendRequest(alice.id, alice.username, bob.username)
    await respondToFriendRequest({ actorId: bob.id, actorUsername: bob.username, requestId: first.requestId, action: 'reject' })

    const rejected = await prisma.friend.findUnique({ where: { id: first.requestId } })
    expect(rejected!.status).toBe('REJECTED')

    const again = await sendFriendRequest(alice.id, alice.username, bob.username)
    const edge = await prisma.friend.findUnique({ where: { id: again.requestId } })
    expect(edge!.status).toBe('PENDING')
    expect(edge!.respondedAt).toBeNull()
    expect((await prisma.friend.count({ where: { requesterId: alice.id, addresseeId: bob.id } }))).toBe(1)

    const bobList = await listFriends(bob.id)
    expect(bobList.incoming.map((r) => r.username)).toEqual([alice.username])
  })

  it('an answered request cannot be answered twice, and unknown requests are refused', async () => {
    const alice = await createUser()
    const bob = await createUser()

    const sent = await sendFriendRequest(alice.id, alice.username, bob.username)
    await respondToFriendRequest({ actorId: bob.id, actorUsername: bob.username, requestId: sent.requestId, action: 'accept' })
    await expect(
      respondToFriendRequest({ actorId: bob.id, actorUsername: bob.username, requestId: sent.requestId, action: 'reject' })
    ).rejects.toThrow(/already answered/)

    await expect(respondToFriendRequest({ actorId: bob.id, actorUsername: bob.username, requestId: 'does-not-exist', action: 'accept' })).rejects.toThrow(
      FriendError
    )
  })
})