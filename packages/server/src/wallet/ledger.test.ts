import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { prisma } from '../db/index.js'
import { ledger, runInTransaction } from './service.js'
import { checkLedgerInvariance } from '../fraud/index.js'
import { createOneVsOneMatch, joinOneVsOneMatch, settleMatch } from '../matches/service.js'

const TAG = `ledger${Date.now() % 1000000}`
const USERS: Array<{ id: string; email: string }> = []
const MATCH_IDS: string[] = []

async function createUser(role = 'PLAYER', balance = 1000): Promise<string> {
  const email = `${TAG}-${USERS.length}@test.local`
  const user = await prisma.user.create({
    data: {
      email,
      username: `user${USERS.length}-${TAG}`,
      passwordHash: '!',
      role,
      status: 'ACTIVE',
      wallet: { create: { available: balance } }
    }
  })
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
  USERS.push({ id: user.id, email })
  return user.id
}

async function cleanup(): Promise<void> {
  const userIds = USERS.map((u) => u.id)
  await prisma.gameEvent.deleteMany({ where: { matchId: { in: MATCH_IDS } } })
  await prisma.match.deleteMany({ where: { id: { in: MATCH_IDS } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.fraudFlag.deleteMany({ where: { userId: { in: userIds } } })
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

describe('ledger invariants', () => {
  it('holds across a full match lifecycle (create, join, settle)', async () => {
    const owner = await createUser()
    const joiner = await createUser()
    const created = await createOneVsOneMatch(owner, 'TIER_1', 'BO1')
    MATCH_IDS.push(created.id)
    await joinOneVsOneMatch(created.id, joiner)
    await settleMatch({ matchId: created.id, winnerId: owner, reason: 'frames' })

    const result = await checkLedgerInvariance()
    expect(result.ok).toBe(true)
    expect(result.violations.length).toBe(0)

    const ownerWallet = await prisma.wallet.findUnique({ where: { userId: owner } })
    const joinerWallet = await prisma.wallet.findUnique({ where: { userId: joiner } })
    expect(Number(ownerWallet!.available)).toBe(1080)
    expect(Number(ownerWallet!.locked)).toBe(0)
    expect(Number(joinerWallet!.available)).toBe(900)
    expect(Number(joinerWallet!.locked)).toBe(0)
  })

  it('holds under adversarial ledger operations including clamped adjustments', async () => {
    await runInTransaction(async (tx) => {
      const alice = await createUser()
      const bob = await createUser()
      const aliceId = alice
      await ledger.creditAvailable(tx, { userId: aliceId, amount: 50, type: 'TEST_CREDIT', meta: { stage: 'credit' } })
      await ledger.debitAvailable(tx, { userId: aliceId, amount: 25, type: 'TEST_DEBIT', meta: { stage: 'debit' } })
      await ledger.freezeForMatch(tx, { userId: aliceId, amount: 100, type: 'TEST_FREEZE', meta: { stage: 'freeze' } })
      await ledger.unfreezeFromMatch(tx, { userId: aliceId, amount: 40, type: 'TEST_UNFREEZE', meta: { stage: 'unfreeze' } })
      await ledger.consumeLocked(tx, { userId: aliceId, amount: 60, type: 'TEST_CONSUME', meta: { stage: 'consume' } })
      await ledger.adjust(tx, { userId: aliceId, amount: -9999, type: 'TEST_ADJUST_OVERRUN', meta: { stage: 'clamp' } })
      await ledger.adjust(tx, { userId: bob, amount: 33, type: 'TEST_ADJUST_IN', meta: { stage: 'adjust' } })
      void aliceId
    })

    const result = await checkLedgerInvariance()
    expect(result.ok).toBe(true)
    expect(result.violations.length).toBe(0)
  })

  it('settle is idempotent: settling twice settles exactly once', async () => {
    const owner = await createUser()
    const joiner = await createUser()
    const created = await createOneVsOneMatch(owner, 'TIER_1', 'BO1')
    MATCH_IDS.push(created.id)
    await joinOneVsOneMatch(created.id, joiner)
    await settleMatch({ matchId: created.id, winnerId: owner, reason: 'frames' })

    const before = await getLedgerDeltas(created.id, [owner, joiner])
    await settleMatch({ matchId: created.id, winnerId: owner, reason: 'concede' })

    const match = await prisma.match.findUnique({ where: { id: created.id } })
    expect(match!.status).toBe('PRIZE_SETTLED')
    expect((match!.resultJson as { reason?: string } | null)?.reason).toBe('frames')

    const after = await getLedgerDeltas(created.id, [owner, joiner])
    expect(after).toEqual(before)

    const txnCount = await prisma.walletTransaction.count({
      where: { refId: created.id, type: { in: ['PRIZE', 'MATCH_ENTRY', 'PLATFORM_FEE'] } }
    })
    expect(txnCount).toBe(6)
    const ownerWallet = await prisma.wallet.findUnique({ where: { userId: owner } })
    expect(Number(ownerWallet!.available)).toBe(1080)
    expect(Number(ownerWallet!.locked)).toBe(0)
  }, 30_000)
})

async function getLedgerDeltas(matchId: string, userIds: string[]): Promise<Record<string, number>> {
  const txns = await prisma.walletTransaction.findMany({
    where: { refId: matchId, userId: { in: userIds } },
    select: { userId: true, balanceBefore: true, balanceAfter: true, meta: true }
  })
  const sums: Record<string, number> = {}
  for (const t of txns) {
    const before = Number(t.balanceBefore)
    const after = Number(t.balanceAfter)
    sums[t.userId] = (sums[t.userId] ?? 0) + (after - before)
  }
  return sums
}