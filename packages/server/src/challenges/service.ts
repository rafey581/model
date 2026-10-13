import { prisma } from '../db/index.js'
import { ledger, runInTransaction, InsufficientBalanceError } from '../wallet/service.js'
import { getSettings } from '../settings/index.js'
import { assertNotBot, assertViableFormat, resolveStakeTier, MatchError } from '../matches/service.js'
import { STAKE_TIERS } from '@snooker/shared'
import type { StakeTierId } from '@snooker/shared'

/**
 * Match challenges — the matchmaking layer over the create/join table flow.
 *
 * A player opens a table and it becomes a challenge: either a PUBLIC broadcast
 * that every connected player is offered, or a FRIEND invite delivered only to
 * one person. Nothing is staked while the challenge is open; the accept path
 * freezes both players and creates the match in a single transaction, so no
 * USDT is ever held on an invitation nobody took.
 *
 * Challenges are short-lived (they expire) and one per challenger: opening a
 * new table quietly retires the previous one, so a player cannot leave a trail
 * of live invitations behind them.
 */

export const CHALLENGE_TTL_MS = 90_000

export class ChallengeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChallengeError'
  }
}

export interface ChallengeView {
  id: string
  challengerId: string
  challengerUsername: string
  kind: 'PUBLIC' | 'FRIEND'
  targetUserId: string | null
  targetUsername: string | null
  stakeTier: string
  stakePerPlayer: number
  stakeLabel: string
  format: string
  expiresAt: string
}

/**
 * The socket edge this service speaks through. The game server installs these
 * (it owns the io object); without them the money/DB logic still works and the
 * events are simply dropped, which is what tests and any non-socket caller get.
 */
export interface ChallengeSenders {
  toUser: (userId: string, event: string, payload: unknown) => void
  toAll: (event: string, payload: unknown, exceptUserId?: string) => void
}

let senders: ChallengeSenders | null = null

export function setChallengeSenders(next: ChallengeSenders | null): void {
  senders = next
}

function emitNew(view: ChallengeView): void {
  if (!senders) return
  if (view.kind === 'FRIEND' && view.targetUserId) senders.toUser(view.targetUserId, 'challenge:new', view)
  else senders.toAll('challenge:new', view, view.challengerId)
}

function emitClosed(challengeId: string, reason: string): void {
  senders?.toAll('challenge:closed', { challengeId, reason })
}

function emitMatched(userId: string, payload: Record<string, unknown>): void {
  senders?.toUser(userId, 'challenge:matched', payload)
}

/** Re-throws the match-layer validation errors as ones this module's routes speak. */
async function validateForChallenge(challengerId: string, stakeTier: StakeTierId, format: string): Promise<{ id: string; usdt: number; label: string }> {
  try {
    await assertNotBot(challengerId)
    await assertViableFormat(format)
    return await resolveStakeTier(stakeTier)
  } catch (error) {
    if (error instanceof MatchError) throw new ChallengeError(error.message)
    throw error
  }
}

function stakeLabelFor(tierId: string): string {
  return STAKE_TIERS.find((t) => t.id === tierId)?.label ?? tierId
}

function serialize(
  row: {
    id: string
    challengerId: string
    targetUserId: string | null
    kind: string
    stakeTier: string
    stakePerPlayer: unknown
    format: string
    expiresAt: Date
  },
  challengerUsername: string,
  targetUsername: string | null = null
): ChallengeView {
  return {
    id: row.id,
    challengerId: row.challengerId,
    challengerUsername,
    kind: row.kind === 'FRIEND' ? 'FRIEND' : 'PUBLIC',
    targetUserId: row.targetUserId,
    targetUsername,
    stakeTier: row.stakeTier,
    stakePerPlayer: Number(row.stakePerPlayer),
    stakeLabel: stakeLabelFor(row.stakeTier),
    format: row.format,
    expiresAt: row.expiresAt.toISOString()
  }
}

export async function createChallenge(opts: {
  challengerId: string
  stakeTier: StakeTierId
  format: string
  targetUsername?: string
}): Promise<ChallengeView> {
  const { challengerId } = opts
  const tier = await validateForChallenge(challengerId, opts.stakeTier, opts.format)

  // Soft check only: the hard freeze happens at accept. Refusing here keeps a
  // table nobody could cover off everyone else's screen.
  const wallet = await prisma.wallet.findUnique({ where: { userId: challengerId } })
  const available = wallet ? Number(wallet.available) : 0
  if (available < tier.usdt) throw new ChallengeError(`you need at least ${tier.usdt} USDT to open this table`)

  let targetUserId: string | null = null
  let targetUsername: string | null = null
  let kind: 'PUBLIC' | 'FRIEND' = 'PUBLIC'
  const username = opts.targetUsername?.trim()
  if (username) {
    const target = await prisma.user.findFirst({
      where: { username: { equals: username, mode: 'insensitive' }, status: 'ACTIVE' },
      select: { id: true, username: true }
    })
    if (!target) throw new ChallengeError('no active player with that username')
    if (target.id === challengerId) throw new ChallengeError('you cannot challenge yourself')
    const friendship = await prisma.friend.findFirst({
      where: {
        status: 'ACCEPTED',
        OR: [
          { requesterId: challengerId, addresseeId: target.id },
          { requesterId: target.id, addresseeId: challengerId }
        ]
      }
    })
    if (!friendship) throw new ChallengeError('you can only invite a friend to play')
    targetUserId = target.id
    targetUsername = target.username
    kind = 'FRIEND'
  }

  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS)
  const { row, cancelled } = await runInTransaction(async (tx) => {
    // One live table per player: retire any earlier open challenge.
    const previous = await tx.matchChallenge.findMany({ where: { challengerId, status: 'OPEN' }, select: { id: true } })
    if (previous.length > 0) {
      await tx.matchChallenge.updateMany({ where: { id: { in: previous.map((p) => p.id) } }, data: { status: 'CANCELLED' } })
    }
    const created = await tx.matchChallenge.create({
      data: {
        challengerId,
        targetUserId,
        kind,
        stakeTier: tier.id,
        stakePerPlayer: tier.usdt,
        format: opts.format,
        status: 'OPEN',
        expiresAt
      }
    })
    return { row: created, cancelled: previous.map((p) => p.id) }
  })

  for (const id of cancelled) emitClosed(id, 'cancelled')
  const challenger = await prisma.user.findUnique({ where: { id: challengerId }, select: { username: true } })
  const view = serialize(row, challenger?.username ?? 'A player', targetUsername)
  emitNew(view)
  return view
}

/** Open challenges this user can see right now: public ones plus friend invites to them. */
export async function listIncomingChallenges(userId: string): Promise<ChallengeView[]> {
  const rows = await prisma.matchChallenge.findMany({
    where: {
      status: 'OPEN',
      expiresAt: { gt: new Date() },
      challengerId: { not: userId },
      OR: [{ kind: 'PUBLIC' }, { kind: 'FRIEND', targetUserId: userId }]
    },
    include: { challenger: { select: { username: true } } },
    orderBy: { createdAt: 'asc' }
  })
  return rows.map((row) => serialize(row, row.challenger.username))
}

export interface AcceptedChallenge {
  matchId: string
  opponentUsername: string
}

/**
 * Accept an invitation. The status gate (`updateMany` on OPEN) is what makes a
 * challenge single-use under a race: two players accepting at once, or an
 * accept racing a cancel, can only ever produce one match. Both stakes are
 * frozen and the match is created inside the same transaction, so an accept
 * that cannot be covered leaves nothing behind.
 */
export async function acceptChallenge(opts: { challengeId: string; userId: string }): Promise<AcceptedChallenge> {
  const { challengeId, userId } = opts
  const now = new Date()
  const settings = await getSettings()

  let outcome: AcceptedChallenge & { challengerId: string; format: string; stakeTier: string; stake: number }
  try {
    outcome = await runInTransaction(async (tx) => {
      const challenge = await tx.matchChallenge.findUnique({
        where: { id: challengeId },
        include: { challenger: { select: { id: true, username: true } } }
      })
      if (!challenge) throw new ChallengeError('that challenge no longer exists')
      if (challenge.status !== 'OPEN') throw new ChallengeError('that challenge is no longer open')
      if (challenge.expiresAt <= now) throw new ChallengeError('that challenge has expired')
      if (challenge.challengerId === userId) throw new ChallengeError('you cannot accept your own challenge')
      if (challenge.kind === 'FRIEND' && challenge.targetUserId !== userId) throw new ChallengeError('that invitation is not for you')
      const tier = STAKE_TIERS.find((t) => t.id === challenge.stakeTier)
      if (!tier) throw new ChallengeError('unknown stake tier')

      const gate = await tx.matchChallenge.updateMany({
        where: { id: challengeId, status: 'OPEN', expiresAt: { gt: now } },
        data: { status: 'ACCEPTED', responderId: userId }
      })
      if (gate.count === 0) throw new ChallengeError('that challenge is no longer open')

      const match = await tx.match.create({
        data: {
          matchType: 'ONE_V_ONE',
          stakeTier: tier.id,
          stakePerPlayer: tier.usdt,
          format: challenge.format,
          status: 'MATCH_STARTED',
          startedAt: now,
          platformFeePct: settings.commissionPct
        }
      })
      await tx.matchPlayer.create({ data: { matchId: match.id, userId: challenge.challengerId, seat: 0 } })
      await tx.matchPlayer.create({ data: { matchId: match.id, userId, seat: 1 } })
      await ledger.freezeForMatch(tx, {
        userId: challenge.challengerId,
        amount: tier.usdt,
        type: 'MATCH_ENTRY',
        refId: match.id,
        meta: { stage: 'challenge', challengeId }
      })
      await ledger.freezeForMatch(tx, {
        userId,
        amount: tier.usdt,
        type: 'MATCH_ENTRY',
        refId: match.id,
        meta: { stage: 'challenge-accept', challengeId }
      })
      await tx.matchChallenge.update({ where: { id: challengeId }, data: { matchId: match.id } })
      return {
        matchId: match.id,
        opponentUsername: challenge.challenger.username,
        challengerId: challenge.challengerId,
        format: challenge.format,
        stakeTier: tier.id,
        stake: tier.usdt
      }
    })
  } catch (error) {
    if (error instanceof InsufficientBalanceError) throw new ChallengeError('this table could not be covered right now')
    throw error
  }

  const responder = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } })
  // Dismiss it everywhere, then hand the challenger the table they just won.
  emitClosed(challengeId, 'accepted')
  emitMatched(outcome.challengerId, {
    challengeId,
    matchId: outcome.matchId,
    opponentUsername: responder?.username ?? 'Opponent',
    stakeTier: outcome.stakeTier,
    stakePerPlayer: outcome.stake,
    format: outcome.format
  })
  return { matchId: outcome.matchId, opponentUsername: outcome.opponentUsername }
}

/** A friend declines a targeted invite. Public popups are dismissed client-side. */
export async function declineChallenge(opts: { challengeId: string; userId: string }): Promise<void> {
  const { challengeId, userId } = opts
  const gate = await prisma.matchChallenge.updateMany({
    where: { id: challengeId, status: 'OPEN', targetUserId: userId },
    data: { status: 'DECLINED', responderId: userId }
  })
  if (gate.count === 0) {
    const row = await prisma.matchChallenge.findUnique({ where: { id: challengeId } })
    if (!row) throw new ChallengeError('that challenge no longer exists')
    if (row.targetUserId !== userId) throw new ChallengeError('that invitation is not for you')
    throw new ChallengeError('that challenge is no longer open')
  }
  emitClosed(challengeId, 'declined')
}

/** The challenger pulls their own open table. */
export async function cancelChallenge(opts: { challengeId: string; userId: string }): Promise<void> {
  const { challengeId, userId } = opts
  const gate = await prisma.matchChallenge.updateMany({
    where: { id: challengeId, status: 'OPEN', challengerId: userId },
    data: { status: 'CANCELLED' }
  })
  if (gate.count === 0) {
    const row = await prisma.matchChallenge.findUnique({ where: { id: challengeId } })
    if (!row) throw new ChallengeError('that challenge no longer exists')
    if (row.challengerId !== userId) throw new ChallengeError('you cannot cancel someone else’s challenge')
    throw new ChallengeError('that challenge is no longer open')
  }
  emitClosed(challengeId, 'cancelled')
}

/** Retires every open challenge past its deadline and tells each client to drop it. */
export async function expireStaleChallenges(): Promise<number> {
  const stale = await prisma.matchChallenge.findMany({
    where: { status: 'OPEN', expiresAt: { lt: new Date() } },
    select: { id: true }
  })
  if (stale.length === 0) return 0
  await prisma.matchChallenge.updateMany({ where: { id: { in: stale.map((s) => s.id) } }, data: { status: 'EXPIRED' } })
  for (const row of stale) emitClosed(row.id, 'expired')
  return stale.length
}
