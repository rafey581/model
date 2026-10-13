import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { prisma } from '../db/index.js'
import { runInTransaction } from '../wallet/service.js'
import { createOneVsOneMatch, joinOneVsOneMatch, settleMatch } from '../matches/service.js'
import {
  assertValidReferralCode,
  generateReferralCode,
  getOrCreateReferralCode,
  getReferralSummary,
  ReferralError,
  rewardReferralForFirstMatch
} from './service.js'

const TAG = `ref${Date.now() % 1000000}`
const USERS: string[] = []
const MATCH_IDS: string[] = []

async function createUser(opts: { balance?: number; referredById?: string } = {}): Promise<string> {
  const balance = opts.balance ?? 0
  const user = await prisma.user.create({
    data: {
      email: `${TAG}-${USERS.length}@test.local`,
      username: `r${USERS.length}-${TAG}`,
      passwordHash: '!',
      role: 'PLAYER',
      status: 'ACTIVE',
      referredById: opts.referredById ?? null,
      wallet: { create: { available: balance } }
    }
  })
  if (balance > 0) {
    await prisma.walletTransaction.create({
      data: {
        userId: user.id,
        type: 'START_BALANCE',
        amount: balance,
        status: 'COMPLETED',
        balanceBefore: 0,
        balanceAfter: balance,
        meta: { description: 'test welcome balance' }
      }
    })
  }
  USERS.push(user.id)
  return user.id
}

async function cleanup(): Promise<void> {
  await prisma.gameEvent.deleteMany({ where: { matchId: { in: MATCH_IDS } } })
  await prisma.match.deleteMany({ where: { id: { in: MATCH_IDS } } })
  await prisma.user.deleteMany({ where: { id: { in: USERS } } })
  MATCH_IDS.length = 0
  USERS.length = 0
}

beforeAll(async () => {
  await prisma.$connect()
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('referrals', () => {
  it('mints one stable, unique code per account', async () => {
    const user = await createUser()
    const code = await getOrCreateReferralCode(user)
    expect(code).toMatch(/^[A-Z0-9]{8}$/)
    expect(await getOrCreateReferralCode(user)).toBe(code)

    const other = await createUser()
    expect(await getOrCreateReferralCode(other)).not.toBe(code)
  })

  it('generateReferralCode avoids ambiguous characters', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateReferralCode()).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/)
    }
  })

  it('validates a code: accepts a real one, rejects unknown and self', async () => {
    const inviter = await createUser()
    const code = await getOrCreateReferralCode(inviter)

    const resolved = await assertValidReferralCode(code.toLowerCase(), 'someone-new')
    expect(resolved.id).toBe(inviter)

    await expect(assertValidReferralCode('NOPE-NOPE', 'someone-new')).rejects.toThrow(ReferralError)
    const inviterRow = await prisma.user.findUnique({ where: { id: inviter } })
    await expect(assertValidReferralCode(code, inviterRow!.username)).rejects.toThrow(/own invite code/)
  })

  it('summarises invited players and pending/rewarded counts', async () => {
    const inviter = await createUser()
    await createUser({ referredById: inviter })
    const rewarded = await createUser({ referredById: inviter })
    await prisma.user.update({ where: { id: rewarded }, data: { referralRewardedAt: new Date() } })

    const summary = await getReferralSummary(inviter)
    expect(summary.code).toMatch(/^[A-Z0-9]{8}$/)
    expect(summary.link).toContain(`ref=${summary.code}`)
    expect(summary.invitedCount).toBe(2)
    expect(summary.rewardedCount).toBe(1)
    expect(summary.pendingCount).toBe(1)
    expect(summary.earnedUsdt).toBe(1)
    expect(summary.referrals).toHaveLength(2)
  })

  it('pays the inviter once, and only once, when the invitee plays a real match', async () => {
    const inviter = await createUser()
    const invitee = await createUser({ balance: 10, referredById: inviter })
    const opponent = await createUser({ balance: 10 })

    const first = await createOneVsOneMatch(invitee, 'TIER_1', 'BO1')
    MATCH_IDS.push(first.id)
    await joinOneVsOneMatch(first.id, opponent)
    await settleMatch({ matchId: first.id, winnerId: opponent, reason: 'frames' })

    const inviterWallet = await prisma.wallet.findUnique({ where: { userId: inviter } })
    expect(Number(inviterWallet!.available)).toBe(1)

    const inviteeRow = await prisma.user.findUnique({ where: { id: invitee } })
    expect(inviteeRow!.referralRewardedAt).not.toBeNull()

    // A second match must not pay again.
    const second = await createOneVsOneMatch(invitee, 'TIER_1', 'BO1')
    MATCH_IDS.push(second.id)
    await joinOneVsOneMatch(second.id, opponent)
    await settleMatch({ matchId: second.id, winnerId: invitee, reason: 'frames' })

    const after = await prisma.wallet.findUnique({ where: { userId: inviter } })
    expect(Number(after!.available)).toBe(1)
    const paid = await prisma.walletTransaction.count({ where: { userId: inviter, type: 'REFERRAL_BONUS' } })
    expect(paid).toBe(1)
  })

  it('pays nothing for an invitee with no inviter', async () => {
    const player = await createUser({ balance: 10 })
    const reward = await runInTransaction((tx) => rewardReferralForFirstMatch(tx, player))
    expect(reward).toBeNull()
  })

  it('does not count a practice match by default', async () => {
    const inviter = await createUser()
    const invitee = await createUser({ balance: 10, referredById: inviter })
    const bot = await createUser()

    const match = await prisma.match.create({
      data: { matchType: 'PRACTICE', format: 'BO1', status: 'MATCH_STARTED', stakePerPlayer: 0, platformFeePct: 0 }
    })
    MATCH_IDS.push(match.id)
    await prisma.matchPlayer.createMany({
      data: [
        { matchId: match.id, userId: invitee, seat: 0 },
        { matchId: match.id, userId: bot, seat: 1 }
      ]
    })
    await settleMatch({ matchId: match.id, winnerId: invitee, reason: 'frames' })

    const wallet = await prisma.wallet.findUnique({ where: { userId: inviter } })
    expect(Number(wallet!.available)).toBe(0)
    const row = await prisma.user.findUnique({ where: { id: invitee } })
    expect(row!.referralRewardedAt).toBeNull()
  })
})
