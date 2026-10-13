import { prisma } from '../db/index.js'
import { notify } from '../notifications/service.js'

export class FriendError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FriendError'
  }
}

/** The relationship between a user and another user, from the caller's point of view. */
export type RelationStatus = 'none' | 'pending-out' | 'pending-in' | 'friends'

export interface FriendSearchRow {
  id: string
  username: string
  relation: RelationStatus
}

export interface FriendListItem {
  /** The friend's user id. */
  userId: string
  username: string
  /** When the friendship began. */
  since: string
}

export interface FriendRequestRow {
  requestId: string
  userId: string
  username: string
  createdAt: string
}

export interface FriendList {
  friends: FriendListItem[]
  /** Requests sent to me, awaiting my answer. */
  incoming: FriendRequestRow[]
  /** Requests I sent while they are unanswered. */
  outgoing: FriendRequestRow[]
}

/**
 * Search active players by username (prefix, case-insensitive) and annotate each
 * result with the search — not the target — account's relationship to it.
 */
export async function searchFriends(callerId: string, raw: string): Promise<FriendSearchRow[]> {
  const q = raw.trim()
  if (!q) return []
  const users = await prisma.user.findMany({
    where: { username: { contains: q, mode: 'insensitive' }, status: 'ACTIVE', NOT: { id: callerId } },
    select: { id: true, username: true },
    orderBy: { username: 'asc' },
    take: 10
  })
  if (users.length === 0) return []

  const edges = await prisma.friend.findMany({
    where: {
      OR: [
        { requesterId: callerId, addresseeId: { in: users.map((u) => u.id) } },
        { addresseeId: callerId, requesterId: { in: users.map((u) => u.id) } }
      ]
    }
  })
  const edgeByOther = new Map<string, (typeof edges)[number]>()
  for (const edge of edges) {
    if (!edgeByOther.has(edge.requesterId === callerId ? edge.addresseeId : edge.requesterId)) {
      edgeByOther.set(edge.requesterId === callerId ? edge.addresseeId : edge.requesterId, edge)
    }
  }

  return users.map((u) => {
    const edge = edgeByOther.get(u.id)
    let relation: RelationStatus = 'none'
    if (edge) {
      if (edge.status === 'ACCEPTED') relation = 'friends'
      else if (edge.requesterId === callerId) relation = 'pending-out'
      else relation = 'pending-in'
    }
    return { id: u.id, username: u.username, relation }
  })
}

export async function listFriends(callerId: string): Promise<FriendList> {
  const [accepted, incoming, outgoing] = await Promise.all([
    prisma.friend.findMany({
      where: { status: 'ACCEPTED', OR: [{ requesterId: callerId }, { addresseeId: callerId }] },
      include: {
        requester: { select: { id: true, username: true } },
        addressee: { select: { id: true, username: true } }
      },
      orderBy: { respondedAt: 'desc' }
    }),
    prisma.friend.findMany({
      where: { addresseeId: callerId, status: 'PENDING' },
      include: { requester: { select: { id: true, username: true } } },
      orderBy: { createdAt: 'desc' }
    }),
    prisma.friend.findMany({
      where: { requesterId: callerId, status: 'PENDING' },
      include: { addressee: { select: { id: true, username: true } } },
      orderBy: { createdAt: 'desc' }
    })
  ])

  const other = (edge: { requesterId: string; addresseeId: string }): string =>
    edge.requesterId === callerId ? edge.addresseeId : edge.requesterId

  return {
    friends: accepted.map((edge) => {
      const isRequester = edge.requesterId === callerId
      const user = isRequester ? edge.addressee : edge.requester
      return { userId: other(edge), username: user.username, since: (edge.respondedAt ?? edge.createdAt).toISOString() }
    }),
    incoming: incoming.map((edge) => ({
      requestId: edge.id,
      userId: edge.requester.id,
      username: edge.requester.username,
      createdAt: edge.createdAt.toISOString()
    })),
    outgoing: outgoing.map((edge) => ({
      requestId: edge.id,
      userId: edge.addressee.id,
      username: edge.addressee.username,
      createdAt: edge.createdAt.toISOString()
    }))
  }
}

/**
 * Send a friend request by the target's unique username.
 *
 * The edge between the pair is a small state machine:
 *  - no edge: a PENDING edge is created, requester -> addressee.
 *  - a PENDING edge in either direction is reported as such (the reverse case is
 *    "they already asked you", which the player should answer rather than re-ask).
 *  - a REJECTED edge in either direction is allowed to be asked again: the old
 *    edge is discarded and a fresh PENDING one is started, so a "no" is never
 *    permanent and no duplicate rows can stack up.
 */
export async function sendFriendRequest(
  requesterId: string,
  requesterUsername: string,
  byUsername: string
): Promise<{ requestId: string; target: { id: string; username: string } }> {
  const username = byUsername.trim()
  if (!username) throw new FriendError('enter a username')
  if (username.length > 24) throw new FriendError('that username is too long')

  const target = await prisma.user.findUnique({
    where: { username },
    select: { id: true, username: true, status: true }
  })
  if (!target || target.status !== 'ACTIVE') throw new FriendError('no active player with that username')
  if (target.id === requesterId) throw new FriendError('you cannot add yourself')

  const request = await prisma.$transaction(async (tx) => {
    const forward = await tx.friend.findUnique({
      where: { requesterId_addresseeId: { requesterId, addresseeId: target.id } }
    })
    if (forward) {
      if (forward.status === 'ACCEPTED') throw new FriendError('you are already friends')
      if (forward.status === 'PENDING') throw new FriendError('friend request already sent')
      // REJECTED: ask again.
      return tx.friend.update({
        where: { id: forward.id },
        data: { status: 'PENDING', respondedAt: null, createdAt: new Date() }
      })
    }

    const reverse = await tx.friend.findUnique({
      where: { requesterId_addresseeId: { requesterId: target.id, addresseeId: requesterId } }
    })
    if (reverse) {
      if (reverse.status === 'ACCEPTED') throw new FriendError('you are already friends')
      if (reverse.status === 'PENDING')
        throw new FriendError('they already sent you a friend request — accept it instead')
      // Reverse REJECTED: drop it and ask fresh the other way round.
      await tx.friend.delete({ where: { id: reverse.id } })
    }

    return tx.friend.create({
      data: { requesterId, addresseeId: target.id, status: 'PENDING' }
    })
  })

  await notify(target.id, 'FRIEND_REQUEST', 'New friend request', `${requesterUsername} sent you a friend request. Accept it from your friends screen.`)
  return { requestId: request.id, target: { id: target.id, username: target.username } }
}

export type FriendResponseAction = 'accept' | 'reject'

/** Accept or reject an incoming request. Only the addressee may answer it. */
export async function respondToFriendRequest(opts: {
  actorId: string
  actorUsername: string
  requestId: string
  action: FriendResponseAction
}): Promise<{ requestId: string; status: string; target: { id: string; username: string } }> {
  const { actorId, actorUsername, requestId, action } = opts
  const next = action === 'accept' ? 'ACCEPTED' : 'REJECTED'
  const updated = await prisma.friend.updateMany({
    where: { id: requestId, addresseeId: actorId, status: 'PENDING' },
    data: { status: next, respondedAt: new Date() }
  })
  if (updated.count === 0) {
    const row = await prisma.friend.findUnique({ where: { id: requestId } })
    if (!row) throw new FriendError('friend request not found')
    if (row.addresseeId !== actorId) throw new FriendError('you cannot answer someone else’s request')
    if (row.status !== 'PENDING') throw new FriendError('that request was already answered')
    throw new FriendError('friend request not found')
  }
  const row = await prisma.friend.findUniqueOrThrow({
    where: { id: requestId },
    include: { requester: { select: { id: true, username: true } } }
  })
  await notify(
    row.requester.id,
    'FRIEND_REQUEST',
    action === 'accept' ? `${actorUsername} accepted your friend request` : `${actorUsername} declined your friend request`,
    action === 'accept' ? 'You are now friends — find them in your friends list.' : undefined
  )
  return { requestId, status: next, target: { id: row.requester.id, username: row.requester.username } }
}