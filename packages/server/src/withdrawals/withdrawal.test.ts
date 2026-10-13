import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { prisma } from '../db/index.js'
import { runInTransaction, ledger } from '../wallet/service.js'
import {
  createWithdrawal,
  approveWithdrawal,
  rejectWithdrawal,
  InsufficientWithdrawBalanceError
} from './service.js'
import { checkLedgerInvariance } from '../fraud/index.js'

const TAG = `withdraw${Date.now() % 1000000}`
const START = new Date()
const USERS: string[] = []
const MATCH_IDS: string[] = []

async function createUser(role = 'PLAYER', usdt = 0): Promise<string> {
  const email = `${TAG}-${USERS.length}@test.local`
  const user = await prisma.user.create({
    data: {
      email,
      username: `w${USERS.length}-${TAG}`,
      passwordHash: '!',
      role,
      status: 'ACTIVE',
      wallet: { create: { available: 0 } }
    }
  })
  USERS.push(user.id)
  // Fund through the ledger so the balance is always backed by entries.
  if (usdt > 0) {
    await runInTransaction((tx) =>
      ledger.creditAvailable(tx, { userId: user.id, amount: usdt, type: 'START_BALANCE', meta: { test: TAG } })
    )
  }
  return user.id
}

async function finishedMatch(userId: string, opponentId: string, winnerId: string, dayOffset: number): Promise<void> {
  const finishedAt = new Date(Date.now() - dayOffset * 86_400_000)
  const match = await prisma.match.create({
    data: {
      matchType: 'ONE_V_ONE',
      status: 'PRIZE_SETTLED',
      stakePerPlayer: 10,
      currency: 'USDT',
      format: 'BO1',
      winnerId,
      startedAt: new Date(finishedAt.getTime() - 3_600_000),
      finishedAt,
      players: {
        create: [
          { userId, seat: 0, result: winnerId === userId ? 'WIN' : 'LOSS' },
          { userId: opponentId, seat: 1, result: winnerId === userId ? 'LOSS' : 'WIN' }
        ]
      }
    }
  })
  MATCH_IDS.push(match.id)
}

async function cleanup(): Promise<void> {
  await prisma.adminAction.deleteMany({ where: { adminId: { in: USERS } } })
  await prisma.notification.deleteMany({
    where: {
      kind: { in: ['WITHDRAW_PENDING', 'WITHDRAW_APPROVED', 'WITHDRAW_REJECTED'] },
      createdAt: { gte: START }
    }
  })
  await prisma.gameEvent.deleteMany({ where: { matchId: { in: MATCH_IDS } } })
  await prisma.match.deleteMany({ where: { id: { in: MATCH_IDS } } })
  await prisma.user.deleteMany({ where: { id: { in: USERS } } })
  USERS.length = 0
  MATCH_IDS.length = 0
}

beforeAll(async () => {
  await prisma.$connect()
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('manual withdrawals', () => {
  it('refuses a request the player cannot cover', async () => {
    const player = await createUser('PLAYER', 2) // 2 USDT balance
    await expect(
      createWithdrawal({ userId: player, amountUsdt: 10, address: 'D1nhYBCDFpEjc3Hnz9ZhjGyMMqkpk3qNcZJmQHcYyXqG' })
    ).rejects.toThrow(InsufficientWithdrawBalanceError)
  })

  it('approving a withdrawal debits the balance exactly once and keeps the ledger invariant', async () => {
    const player = await createUser('PLAYER', 100)
    const admin = await createUser('SUPERADMIN')
    const opponent = await createUser('PLAYER')

    // Three finished matches — the snapshot the admin will see with the request.
    await finishedMatch(player, opponent, player, 1)
    await finishedMatch(player, opponent, opponent, 2)
    await finishedMatch(player, opponent, player, 3)

    const withdrawal = await createWithdrawal({
      userId: player,
      amountUsdt: 10, // debits 10 USDT at 1:1
      address: 'D1nhYBCDFpEjc3Hnz9ZhjGyMMqkpk3qNcZJmQHcYyXqG'
    })

    const row = await prisma.cryptoWithdrawal.findUnique({ where: { id: withdrawal.id } })
    const history = (row!.matchHistory ?? []) as Array<{ matchId: string; result: string; opponent: string | null }>
    expect(history.length).toBe(3)
    expect(history[0]!.matchId).toBe(MATCH_IDS[0])
    expect(history[0]!.result).toBe('WIN')
    expect(history[2]!.opponent).toBeTruthy()

    const approved = await approveWithdrawal(withdrawal.id, admin)
    expect(approved.deducted).toBe(10)

    const wallet = await prisma.wallet.findUnique({ where: { userId: player } })
    expect(Number(wallet!.available)).toBe(90)

    const reviewed = await prisma.cryptoWithdrawal.findUnique({ where: { id: withdrawal.id } })
    expect(reviewed!.status).toBe('APPROVED')
    expect(Number(reviewed!.deducted)).toBe(10)
    expect(reviewed!.reviewedById).toBe(admin)
    expect(reviewed!.completedAt).toBeTruthy()

    // Double approval must not double-debit.
    await expect(approveWithdrawal(withdrawal.id, admin)).rejects.toThrow(/already reviewed/)
    const after = await prisma.wallet.findUnique({ where: { userId: player } })
    expect(Number(after!.available)).toBe(90)

    const result = await checkLedgerInvariance()
    expect(result.ok).toBe(true)
    expect(result.violations.length).toBe(0)
  }, 30_000)

  it('cannot approve against a balance spent while the request waited', async () => {
    const player = await createUser('PLAYER', 50)
    const admin = await createUser('SUPERADMIN')

    const withdrawal = await createWithdrawal({
      userId: player,
      amountUsdt: 10, // 10 USDT needed
      address: 'D1nhYBCDFpEjc3Hnz9ZhjGyMMqkpk3qNcZJmQHcYyXqG'
    })

    // The player spends the balance out from under the pending request.
    await runInTransaction((tx) =>
      ledger.debitAvailable(tx, { userId: player, amount: 50, type: 'TEST_SPEND', meta: { test: TAG } })
    )

    await expect(approveWithdrawal(withdrawal.id, admin)).rejects.toThrow(/insufficient balance/)
    const row = await prisma.cryptoWithdrawal.findUnique({ where: { id: withdrawal.id } })
    expect(row!.status).toBe('PENDING') // the gate rolled back
  }, 30_000)

  it('rejecting a withdrawal leaves the wallet untouched', async () => {
    const player = await createUser('PLAYER', 100)
    const admin = await createUser('ADMIN')

    const withdrawal = await createWithdrawal({
      userId: player,
      amountUsdt: 20, // 20 USDT
      address: 'D1nhYBCDFpEjc3Hnz9ZhjGyMMqkpk3qNcZJmQHcYyXqG'
    })
    await rejectWithdrawal(withdrawal.id, admin, 'account could not be verified')

    const row = await prisma.cryptoWithdrawal.findUnique({ where: { id: withdrawal.id } })
    expect(row!.status).toBe('REJECTED')
    expect(row!.rejectReason).toBe('account could not be verified')
    expect(row!.reviewedById).toBe(admin)

    const wallet = await prisma.wallet.findUnique({ where: { userId: player } })
    expect(Number(wallet!.available)).toBe(100)

    await expect(rejectWithdrawal(withdrawal.id, admin)).rejects.toThrow(/already reviewed/)
  }, 30_000)
})