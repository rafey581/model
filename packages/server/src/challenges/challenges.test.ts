import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { prisma } from '../db/index.js'
import {
  ChallengeError,
  acceptChallenge,
  cancelChallenge,
  createChallenge,
  declineChallenge,
  expireStaleChallenges,
  listIncomingChallenges
} from './service.js'
import { createOneVsOneMatch, joinOneVsOneMatch, settleMatch } from '../matches/service.js'

const TAG = `ch${Date.now() % 1000000}`
const USERS: string[] = []
const MATCHES: string[] = []

async function createUser(balance = 10): Promise<{ id: string; username: string }> {
  const username = `c${USERS.length}-${TAG}`
  const user = await prisma.user.create({
    data: {
      email: `${TAG}-${USERS.length}@test.local`,
      username,
      passwordHash: '!',
      role: 'PLAYER',
      status: 'ACTIVE',
      wallet: { create: { available: balance } }
    }
  })
  USERS.push(user.id)
  return { id: user.id, username }
}

async function befriend(a: { id: string }, b: { id: string }): Promise<void> {
  await prisma.friend.create({
    data: { requesterId: a.id, addresseeId: b.id, status: 'ACCEPTED', respondedAt: new Date() }
  })
}

/** Plays and settles a 1-USDT BO1 between two users, returning the match id. */
async function playedOneVsOne(a: { id: string }, b: { id: string }): Promise<string> {
  const open = await createOneVsOneMatch(a.id, 'TIER_1', 'BO1')
  MATCHES.push(open.id)
  await joinOneVsOneMatch(open.id, b.id)
  await settleMatch({ matchId: open.id, winnerId: a.id, reason: 'frames' })
  return open.id
}

async function cleanup(): Promise<void> {
  if (MATCHES.length > 0) await prisma.match.deleteMany({ where: { id: { in: MATCHES } } })
  if (USERS.length > 0) await prisma.user.deleteMany({ where: { id: { in: USERS } } })
  USERS.length = 0
  MATCHES.length = 0
}

beforeAll(async () => {
  await prisma.$connect()
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('match challenges', () => {
  it('broadcasts a public table, only to others, and accepting creates the staked match', async () => {
    const alice = await createUser()
    const bob = await createUser()

    const view = await createChallenge({ challengerId: alice.id, stakeTier: 'TIER_1', format: 'BO1' })
    expect(view.kind).toBe('PUBLIC')
    expect(view.challengerUsername).toBe(alice.username)
    expect(view.stakePerPlayer).toBe(1)
    expect(view.stakeLabel).toBe('1 USDT')

    // The challenger does not see their own broadcast; everyone else does.
    expect((await listIncomingChallenges(alice.id)).map((c) => c.id)).not.toContain(view.id)
    expect((await listIncomingChallenges(bob.id)).map((c) => c.id)).toContain(view.id)

    const accepted = await acceptChallenge({ challengeId: view.id, userId: bob.id })
    MATCHES.push(accepted.matchId)
    expect(accepted.opponentUsername).toBe(alice.username)

    const match = await prisma.match.findUnique({ where: { id: accepted.matchId }, include: { players: true } })
    expect(match!.status).toBe('MATCH_STARTED')
    expect(match!.stakePerPlayer.toNumber()).toBe(1)
    expect(match!.players).toHaveLength(2)
    expect(match!.players.map((p) => p.userId).sort()).toEqual([alice.id, bob.id].sort())

    // Both stakes are frozen, exactly once each.
    for (const user of [alice, bob]) {
      const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
      expect(wallet!.locked.toNumber()).toBe(1)
      expect(wallet!.available.toNumber()).toBe(9)
    }
    const row = await prisma.matchChallenge.findUnique({ where: { id: view.id } })
    expect(row!.status).toBe('ACCEPTED')
    expect(row!.matchId).toBe(accepted.matchId)
    expect(row!.responderId).toBe(bob.id)
  })

  it('refuses a table the challenger cannot cover, and rolls an uncoverable accept all the way back', async () => {
    const brokeOwner = await createUser(0)
    await expect(createChallenge({ challengerId: brokeOwner.id, stakeTier: 'TIER_1', format: 'BO1' })).rejects.toThrow(
      /USDT/
    )

    const alice = await createUser()
    const broke = await createUser(0)
    const view = await createChallenge({ challengerId: alice.id, stakeTier: 'TIER_1', format: 'BO1' })
    await expect(acceptChallenge({ challengeId: view.id, userId: broke.id })).rejects.toThrow(ChallengeError)

    // The failed accept left no match, no frozen stake, and the challenge still open.
    const row = await prisma.matchChallenge.findUnique({ where: { id: view.id } })
    expect(row!.status).toBe('OPEN')
    const wallet = await prisma.wallet.findUnique({ where: { userId: alice.id } })
    expect(wallet!.locked.toNumber()).toBe(0)
    expect(wallet!.available.toNumber()).toBe(10)
    expect(await prisma.match.count({ where: { players: { some: { userId: alice.id } } } })).toBe(0)
  })

  it('is single-use: the second accept of the same table is refused', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const carol = await createUser()

    const view = await createChallenge({ challengerId: alice.id, stakeTier: 'TIER_1', format: 'BO1' })
    const first = await acceptChallenge({ challengeId: view.id, userId: bob.id })
    MATCHES.push(first.matchId)
    await expect(acceptChallenge({ challengeId: view.id, userId: carol.id })).rejects.toThrow(/no longer open/)
  })

  it('delivers a friend invite only to the friend, who can decline it, and others cannot take it', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const carol = await createUser()
    await befriend(alice, bob)

    const view = await createChallenge({
      challengerId: alice.id,
      stakeTier: 'TIER_1',
      format: 'BO1',
      targetUsername: bob.username
    })
    expect(view.kind).toBe('FRIEND')
    expect(view.targetUserId).toBe(bob.id)

    expect((await listIncomingChallenges(bob.id)).map((c) => c.id)).toContain(view.id)
    expect((await listIncomingChallenges(carol.id)).map((c) => c.id)).not.toContain(view.id)

    await expect(acceptChallenge({ challengeId: view.id, userId: carol.id })).rejects.toThrow(/not for you/)

    await declineChallenge({ challengeId: view.id, userId: bob.id })
    const row = await prisma.matchChallenge.findUnique({ where: { id: view.id } })
    expect(row!.status).toBe('DECLINED')
    expect(row!.responderId).toBe(bob.id)
  })

  it('only invites friends, and never yourself', async () => {
    const alice = await createUser()
    const stranger = await createUser()
    const bob = await createUser()
    await befriend(alice, bob)

    await expect(
      createChallenge({ challengerId: alice.id, stakeTier: 'TIER_1', format: 'BO1', targetUsername: stranger.username })
    ).rejects.toThrow(/friend/)
    await expect(
      createChallenge({ challengerId: alice.id, stakeTier: 'TIER_1', format: 'BO1', targetUsername: alice.username })
    ).rejects.toThrow(/yourself/)
    await expect(
      createChallenge({ challengerId: alice.id, stakeTier: 'TIER_1', format: 'BO1', targetUsername: 'ghost-user' })
    ).rejects.toThrow(/no active player/)
  })

  it('can be cancelled by its challenger only, after which it cannot be accepted', async () => {
    const alice = await createUser()
    const bob = await createUser()

    const view = await createChallenge({ challengerId: alice.id, stakeTier: 'TIER_1', format: 'BO1' })
    await expect(cancelChallenge({ challengeId: view.id, userId: bob.id })).rejects.toThrow(/someone else/)
    await cancelChallenge({ challengeId: view.id, userId: alice.id })

    const row = await prisma.matchChallenge.findUnique({ where: { id: view.id } })
    expect(row!.status).toBe('CANCELLED')
    await expect(acceptChallenge({ challengeId: view.id, userId: bob.id })).rejects.toThrow(/no longer open/)
  })

  it('opening a new table retires the previous open one', async () => {
    const alice = await createUser()
    const first = await createChallenge({ challengerId: alice.id, stakeTier: 'TIER_1', format: 'BO1' })
    const second = await createChallenge({ challengerId: alice.id, stakeTier: 'TIER_5', format: 'BO3' })
    expect(second.id).not.toBe(first.id)
    const previous = await prisma.matchChallenge.findUnique({ where: { id: first.id } })
    expect(previous!.status).toBe('CANCELLED')
    const live = await prisma.matchChallenge.findUnique({ where: { id: second.id } })
    expect(live!.status).toBe('OPEN')
  })

  it('expires a table past its deadline and hides it from the list', async () => {
    const alice = await createUser()
    const bob = await createUser()

    const view = await createChallenge({ challengerId: alice.id, stakeTier: 'TIER_1', format: 'BO1' })
    await prisma.matchChallenge.update({ where: { id: view.id }, data: { expiresAt: new Date(Date.now() - 1000) } })

    const expired = await expireStaleChallenges()
    expect(expired).toBeGreaterThanOrEqual(1)

    const row = await prisma.matchChallenge.findUnique({ where: { id: view.id } })
    expect(row!.status).toBe('EXPIRED')
    expect((await listIncomingChallenges(bob.id)).map((c) => c.id)).not.toContain(view.id)
    await expect(acceptChallenge({ challengeId: view.id, userId: bob.id })).rejects.toThrow(/no longer open/)
  })

  it('lets you rematch the opponent of a settled match without being friends, from either side', async () => {
    const alice = await createUser()
    const bob = await createUser()

    await playedOneVsOne(alice, bob)

    const view = await createChallenge({
      challengerId: alice.id,
      stakeTier: 'TIER_1',
      format: 'BO1',
      targetUsername: bob.username,
      rematch: true
    })
    expect(view.kind).toBe('FRIEND')
    expect(view.rematch).toBe(true)
    expect(view.targetUserId).toBe(bob.id)

    // The loser can ask for the rematch too, and it is accepted exactly like any
    // targeted invite — fresh stakes frozen, new match created.
    const reverse = await createChallenge({
      challengerId: bob.id,
      stakeTier: 'TIER_1',
      format: 'BO3',
      targetUsername: alice.username,
      rematch: true
    })
    expect(reverse.rematch).toBe(true)
    expect(reverse.targetUserId).toBe(alice.id)
    const accepted = await acceptChallenge({ challengeId: reverse.id, userId: alice.id })
    MATCHES.push(accepted.matchId)
  })

  it('refuses a rematch to anyone who was not the opponent of a recent match', async () => {
    const alice = await createUser()
    const stranger = await createUser()
    const carol = await createUser()

    // Never played: no rematch.
    await expect(
      createChallenge({
        challengerId: alice.id,
        stakeTier: 'TIER_1',
        format: 'BO1',
        targetUsername: stranger.username,
        rematch: true
      })
    ).rejects.toThrow(/just played/)

    // Played recently, but the invite goes to a third party: still refused.
    await playedOneVsOne(alice, stranger)
    await expect(
      createChallenge({
        challengerId: alice.id,
        stakeTier: 'TIER_1',
        format: 'BO1',
        targetUsername: carol.username,
        rematch: true
      })
    ).rejects.toThrow(/just played/)
  })

  it('only rematches an opponent from the recent window, not an old match', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const matchId = await playedOneVsOne(alice, bob)
    await prisma.match.update({
      where: { id: matchId },
      data: { finishedAt: new Date(Date.now() - 16 * 60_000) }
    })
    await expect(
      createChallenge({
        challengerId: alice.id,
        stakeTier: 'TIER_1',
        format: 'BO1',
        targetUsername: bob.username,
        rematch: true
      })
    ).rejects.toThrow(/just played/)
  })
})
