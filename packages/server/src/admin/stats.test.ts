import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { prisma } from '../db/index.js'
import { runInTransaction, ledger } from '../wallet/service.js'
import { createDeposit, approveDeposit } from '../deposits/service.js'
import { createWithdrawal, approveWithdrawal } from '../withdrawals/service.js'
import { createOneVsOneMatch, joinOneVsOneMatch, settleMatch } from '../matches/service.js'
import { touchLastSeen } from '../users/activity.js'
import { dashboardStats, safeTimeZone, startOfDay } from './stats.js'

const TAG = `stats${Date.now() % 1000000}`
const USERS: string[] = []
const MATCHES: string[] = []

async function player(balance = 0, role = 'PLAYER'): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${TAG}-${USERS.length}@test.local`,
      username: `st${USERS.length}${TAG}`,
      passwordHash: '!',
      role,
      status: 'ACTIVE',
      wallet: { create: { available: 0 } }
    }
  })
  USERS.push(user.id)
  if (balance > 0) {
    await runInTransaction((tx) => ledger.creditAvailable(tx, { userId: user.id, amount: balance, type: 'START_BALANCE' }))
  }
  return user.id
}

afterAll(async () => {
  await prisma.adminAction.deleteMany({ where: { adminId: { in: USERS } } })
  await prisma.match.deleteMany({ where: { id: { in: MATCHES } } })
  await prisma.user.deleteMany({ where: { id: { in: USERS } } })
})

beforeAll(async () => {
  await prisma.$connect()
})

describe('day boundaries', () => {
  it('starts "today" at local midnight in the given zone', () => {
    const now = new Date('2026-10-25T02:00:00Z') // 07:30 on the 25th in India
    expect(startOfDay('Asia/Kolkata', now).toISOString()).toBe('2026-10-24T18:30:00.000Z')
    expect(startOfDay('UTC', now).toISOString()).toBe('2026-10-25T00:00:00.000Z')
    expect(startOfDay('America/New_York', now).toISOString()).toBe('2026-10-24T04:00:00.000Z') // 22:00 on the 24th there
    expect(startOfDay('UTC', now, 6).toISOString()).toBe('2026-10-19T00:00:00.000Z')
  })

  it('falls back to UTC for an unknown zone', () => {
    expect(safeTimeZone('Not/AZone')).toBe('UTC')
    expect(safeTimeZone(undefined)).toBe('UTC')
    expect(safeTimeZone('Asia/Kolkata')).toBe('Asia/Kolkata')
  })
})

describe('dashboard figures', () => {
  it('moves each figure by exactly what happened, and net profit equals commission minus bonuses', async () => {
    const before = await dashboardStats('UTC')

    const admin = await player(0, 'SUPERADMIN')
    const a = await player(1) // 1 USDT welcome bonus each
    const b = await player(1)

    const dep = await createDeposit({ userId: a, amountUsdt: 20, txHash: `${TAG}-tx`, screenshot: 'data:image/png;base64,AAAA' })
    await approveDeposit(dep.id, admin)

    // A 1 USDT staked match: pool 2, the platform keeps its commission.
    const match = await createOneVsOneMatch(a, 'TIER_1', 'BO1')
    MATCHES.push(match.id)
    await joinOneVsOneMatch(match.id, b)
    await settleMatch({ matchId: match.id, winnerId: a, reason: 'frames' })
    const settled = await prisma.match.findUniqueOrThrow({ where: { id: match.id } })
    const fee = (settled.resultJson as { fee: number }).fee
    expect(fee).toBeGreaterThan(0)

    const wd = await createWithdrawal({ userId: a, amountUsdt: 5, address: 'D1nhYBCDFpEjc3Hnz9ZhjGyMMqkpk3qNcZJmQHcYyXqG' })
    await approveWithdrawal(wd.id, admin)

    const after = await dashboardStats('UTC')
    const d = (x: number, y: number) => Math.round((x - y) * 1e6) / 1e6

    expect(d(after.finance.deposits.today, before.finance.deposits.today)).toBe(20)
    expect(d(after.finance.deposits.all, before.finance.deposits.all)).toBe(20)
    expect(after.finance.deposits.countAll - before.finance.deposits.countAll).toBe(1)
    expect(d(after.finance.withdrawals.today, before.finance.withdrawals.today)).toBe(5)
    expect(d(after.finance.commission.today, before.finance.commission.today)).toBe(fee)
    expect(d(after.finance.bonuses.today, before.finance.bonuses.today)).toBe(2)
    expect(d(after.finance.netProfit.today, before.finance.netProfit.today)).toBe(d(fee, 2))
    expect(d(after.finance.netFlow.today, before.finance.netFlow.today)).toBe(15)
    // Players gained the deposit and bonuses, lost the withdrawal and the commission.
    expect(d(after.finance.playerBalances, before.finance.playerBalances)).toBe(d(20 + 2 - 5, fee))

    // The accounting identity holds on the deltas: net profit = net flow - change in what players hold.
    expect(d(after.finance.netProfit.all, before.finance.netProfit.all)).toBe(
      d(d(after.finance.netFlow.all, before.finance.netFlow.all), d(after.finance.playerBalances, before.finance.playerBalances))
    )

    expect(after.userActivity.total - before.userActivity.total).toBe(2) // the admin is not a player
    expect(after.userActivity.newToday - before.userActivity.newToday).toBe(2)
    // Legacy flat fields are still there for installed app builds.
    expect(typeof after.users).toBe('number')
    expect(after.pendingDeposits).toBeGreaterThanOrEqual(0)
  }, 30_000)

  it('does not count a guest session as a player', async () => {
    const before = await dashboardStats('UTC')
    const guest = await prisma.user.create({
      data: { email: `${TAG}-guest@guest.local`, username: `g${TAG}`, passwordHash: '!', role: 'PLAYER', authProvider: 'GUEST', status: 'ACTIVE' }
    })
    USERS.push(guest.id)
    touchLastSeen({ id: guest.id, lastSeenAt: null })
    await new Promise((r) => setTimeout(r, 150))
    const after = await dashboardStats('UTC')
    expect(after.userActivity.total).toBe(before.userActivity.total)
    expect(after.userActivity.newToday).toBe(before.userActivity.newToday)
    expect(after.userActivity.activeToday).toBe(before.userActivity.activeToday)
    expect(after.userActivity.guestsToday - before.userActivity.guestsToday).toBe(1)
  }, 30_000)

  it('counts a player active today once they are seen, and not before', async () => {
    const before = await dashboardStats('UTC')
    const id = await player()
    const mid = await dashboardStats('UTC')
    expect(mid.userActivity.activeToday).toBe(before.userActivity.activeToday)

    touchLastSeen({ id, lastSeenAt: null })
    let after = await dashboardStats('UTC')
    for (let i = 0; i < 20 && after.userActivity.activeToday === mid.userActivity.activeToday; i++) {
      await new Promise((r) => setTimeout(r, 50))
      after = await dashboardStats('UTC')
    }
    expect(after.userActivity.activeToday - mid.userActivity.activeToday).toBe(1)
    expect(after.userActivity.activeWeek - mid.userActivity.activeWeek).toBe(1)

    // Seen a minute ago: no second write inside the window.
    const seen = await prisma.user.findUniqueOrThrow({ where: { id }, select: { lastSeenAt: true } })
    touchLastSeen({ id, lastSeenAt: seen.lastSeenAt }, new Date(seen.lastSeenAt!.getTime() + 60_000))
    await new Promise((r) => setTimeout(r, 100))
    const again = await prisma.user.findUniqueOrThrow({ where: { id }, select: { lastSeenAt: true } })
    expect(again.lastSeenAt!.getTime()).toBe(seen.lastSeenAt!.getTime())
  }, 30_000)
})
