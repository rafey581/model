import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { prisma } from '../db/index.js'
import { runInTransaction, ledger } from '../wallet/service.js'
import {
  createWithdrawal,
  approveWithdrawal,
  rejectWithdrawal,
  cancelWithdrawal,
  InsufficientWithdrawBalanceError,
  WithdrawalNotCancellableError,
  WithdrawalNotFoundError
} from './service.js'
import { checkLedgerInvariance } from '../fraud/index.js'

const TAG = `withdraw${Date.now() % 1000000}`
const START = new Date()
const ADDRESS = 'D1nhYBCDFpEjc3Hnz9ZhjGyMMqkpk3qNcZJmQHcYyXqG'

async function balances(userId: string): Promise<{ available: number; locked: number }> {
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } })
  return { available: Number(wallet.available), locked: Number(wallet.locked) }
}
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
      createWithdrawal({ userId: player, amountUsdt: 10, address: ADDRESS })
    ).rejects.toThrow(InsufficientWithdrawBalanceError)
    expect(await balances(player)).toEqual({ available: 2, locked: 0 })
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

    // The request holds the amount at once: it leaves available and sits in locked.
    expect(await balances(player)).toEqual({ available: 90, locked: 10 })
    expect(Number(row!.heldAmount)).toBe(10)

    const approved = await approveWithdrawal(withdrawal.id, admin)
    expect(approved.deducted).toBe(10)

    // Approval takes the held amount; available is not touched a second time.
    expect(await balances(player)).toEqual({ available: 90, locked: 0 })

    const reviewed = await prisma.cryptoWithdrawal.findUnique({ where: { id: withdrawal.id } })
    expect(reviewed!.status).toBe('APPROVED')
    expect(Number(reviewed!.deducted)).toBe(10)
    expect(reviewed!.reviewedById).toBe(admin)
    expect(reviewed!.completedAt).toBeTruthy()

    // Double approval must not double-debit.
    await expect(approveWithdrawal(withdrawal.id, admin)).rejects.toThrow(/already reviewed/)
    expect(await balances(player)).toEqual({ available: 90, locked: 0 })

    const result = await checkLedgerInvariance()
    expect(result.ok).toBe(true)
    expect(result.violations.length).toBe(0)
  }, 30_000)

  it('holds the amount so it cannot be spent while the request waits', async () => {
    const player = await createUser('PLAYER', 50)
    const admin = await createUser('SUPERADMIN')

    const withdrawal = await createWithdrawal({ userId: player, amountUsdt: 10, address: ADDRESS })
    expect(await balances(player)).toEqual({ available: 40, locked: 10 })

    // Spending the whole original balance is refused: 10 of it is held.
    await expect(
      runInTransaction((tx) => ledger.debitAvailable(tx, { userId: player, amount: 50, type: 'TEST_SPEND', meta: { test: TAG } }))
    ).rejects.toThrow(/insufficient balance/)

    // Spending everything that is still available does not touch the hold...
    await runInTransaction((tx) => ledger.debitAvailable(tx, { userId: player, amount: 40, type: 'TEST_SPEND', meta: { test: TAG } }))
    // ...so the payout can still be approved in full.
    await approveWithdrawal(withdrawal.id, admin)
    expect(await balances(player)).toEqual({ available: 0, locked: 0 })
    expect((await checkLedgerInvariance()).ok).toBe(true)
  }, 30_000)

  it('refuses a second request that the remaining balance cannot cover', async () => {
    const player = await createUser('PLAYER', 11)
    await createWithdrawal({ userId: player, amountUsdt: 6, address: ADDRESS })
    await expect(createWithdrawal({ userId: player, amountUsdt: 6, address: ADDRESS })).rejects.toThrow(InsufficientWithdrawBalanceError)
    expect(await balances(player)).toEqual({ available: 5, locked: 6 })
    // The refused request left no row behind.
    expect(await prisma.cryptoWithdrawal.count({ where: { userId: player } })).toBe(1)
  }, 30_000)

  it('serialises racing requests: two at once cannot overspend', async () => {
    const player = await createUser('PLAYER', 10)
    const results = await Promise.allSettled([
      createWithdrawal({ userId: player, amountUsdt: 7, address: ADDRESS }),
      createWithdrawal({ userId: player, amountUsdt: 7, address: ADDRESS })
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(await balances(player)).toEqual({ available: 3, locked: 7 })
  }, 30_000)

  it('a request from before holds existed is debited from available, and refused if that was spent', async () => {
    const player = await createUser('PLAYER', 50)
    const admin = await createUser('SUPERADMIN')
    // Shaped like a pre-hold row: nothing held, heldAmount null.
    const legacy = await prisma.cryptoWithdrawal.create({
      data: { userId: player, network: 'SOL', address: ADDRESS, currency: 'USDT', amount: 10 }
    })
    await runInTransaction((tx) => ledger.debitAvailable(tx, { userId: player, amount: 45, type: 'TEST_SPEND', meta: { test: TAG } }))

    await expect(approveWithdrawal(legacy.id, admin)).rejects.toThrow(/insufficient balance/)
    expect((await prisma.cryptoWithdrawal.findUniqueOrThrow({ where: { id: legacy.id } })).status).toBe('PENDING')

    // Rejecting a legacy row releases nothing (nothing was held).
    await rejectWithdrawal(legacy.id, admin)
    expect(await balances(player)).toEqual({ available: 5, locked: 0 })

    const legacy2 = await prisma.cryptoWithdrawal.create({
      data: { userId: player, network: 'SOL', address: ADDRESS, currency: 'USDT', amount: 5 }
    })
    await approveWithdrawal(legacy2.id, admin)
    expect(await balances(player)).toEqual({ available: 0, locked: 0 })
    expect((await checkLedgerInvariance()).ok).toBe(true)
  }, 30_000)

  it('rejecting a withdrawal releases the hold back to available', async () => {
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

    expect(await balances(player)).toEqual({ available: 100, locked: 0 })

    await expect(rejectWithdrawal(withdrawal.id, admin)).rejects.toThrow(/already reviewed/)
    expect(await balances(player)).toEqual({ available: 100, locked: 0 })
    expect((await checkLedgerInvariance()).ok).toBe(true)
  }, 30_000)

  it('the player can cancel their own pending request, once, and nobody else can', async () => {
    const player = await createUser('PLAYER', 30)
    const stranger = await createUser('PLAYER', 0)
    const admin = await createUser('SUPERADMIN')

    const withdrawal = await createWithdrawal({ userId: player, amountUsdt: 12, address: ADDRESS })
    await expect(cancelWithdrawal(withdrawal.id, stranger)).rejects.toThrow(WithdrawalNotFoundError)

    const cancelled = await cancelWithdrawal(withdrawal.id, player)
    expect(cancelled.released).toBe(12)
    expect(await balances(player)).toEqual({ available: 30, locked: 0 })
    const row = await prisma.cryptoWithdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } })
    expect(row.status).toBe('CANCELLED')
    expect(row.cancelledAt).toBeTruthy()

    await expect(cancelWithdrawal(withdrawal.id, player)).rejects.toThrow(WithdrawalNotCancellableError)
    await expect(approveWithdrawal(withdrawal.id, admin)).rejects.toThrow(/already reviewed/)
    expect(await balances(player)).toEqual({ available: 30, locked: 0 })

    // An approved request can no longer be cancelled.
    const second = await createWithdrawal({ userId: player, amountUsdt: 5, address: ADDRESS })
    await approveWithdrawal(second.id, admin)
    await expect(cancelWithdrawal(second.id, player)).rejects.toThrow(WithdrawalNotCancellableError)
    expect(await balances(player)).toEqual({ available: 25, locked: 0 })
    expect((await checkLedgerInvariance()).ok).toBe(true)
  }, 30_000)
})