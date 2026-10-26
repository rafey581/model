import { prisma } from '../db/index.js'
import { threadsAwaitingReply } from '../support/service.js'

/**
 * The admin dashboard's numbers: money in, money out, what the platform earned,
 * and how many players are around.
 *
 * Periods are calendar days in the caller's timezone (the admin app sends its own),
 * so "today" starts at the staff member's midnight rather than the server's.
 *
 * Profit is reported the way the ledger defines it. Commission is what matches paid
 * the platform; bonuses (welcome balances, referral rewards) and admin balance
 * adjustments are money the platform handed out without a deposit behind it. So
 *   net profit = commission - bonuses - adjustments
 * which is also deposits - withdrawals - what players currently hold.
 */

export type PeriodKey = 'today' | 'week' | 'month' | 'all'

export interface PeriodTotals {
  today: number
  week: number
  month: number
  all: number
}

export interface DashboardFinance {
  deposits: PeriodTotals & { countAll: number }
  withdrawals: PeriodTotals & { countAll: number }
  commission: PeriodTotals
  bonuses: PeriodTotals
  adjustments: PeriodTotals
  netProfit: PeriodTotals
  /** Deposits minus withdrawals: the cash the operator's wallet should have gained. */
  netFlow: PeriodTotals
  /** What players hold right now (available + locked): owed back on request. */
  playerBalances: number
}

export interface DashboardUsers {
  total: number
  activeWeek: number
  activeToday: number
  newToday: number
  suspended: number
  banned: number
  /** Temporary guest sessions started today (not counted as players above). */
  guestsToday: number
}

const BONUS_TYPES = ['START_BALANCE', 'REFERRAL_BONUS']

/** Accepts an IANA zone the runtime knows; anything else falls back to UTC. */
export function safeTimeZone(tz: string | null | undefined): string {
  if (!tz) return 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return 'UTC'
  }
}

/** The instant local midnight began on the day `now` falls on in `tz`, `daysBack` days earlier. */
export function startOfDay(tz: string, now: Date = new Date(), daysBack = 0): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now)
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value)
  const y = get('year')
  const m = get('month') - 1
  const d = get('day')
  // How far the zone's wall clock is ahead of UTC at this instant.
  const wallAsUtc = Date.UTC(y, m, d, get('hour'), get('minute'), get('second'))
  const offsetMs = wallAsUtc - Math.floor(now.getTime() / 1000) * 1000
  return new Date(Date.UTC(y, m, d - daysBack) - offsetMs)
}

function num(value: { toNumber(): number } | number | null | undefined): number {
  if (value === null || value === undefined) return 0
  return typeof value === 'number' ? value : value.toNumber()
}

function round2(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

async function periods(sum: (since: Date | null) => Promise<number>, starts: Record<Exclude<PeriodKey, 'all'>, Date>): Promise<PeriodTotals> {
  const [today, week, month, all] = await Promise.all([sum(starts.today), sum(starts.week), sum(starts.month), sum(null)])
  return { today: round2(today), week: round2(week), month: round2(month), all: round2(all) }
}

function combine(a: PeriodTotals, f: (x: number, k: PeriodKey) => number): PeriodTotals {
  return { today: round2(f(a.today, 'today')), week: round2(f(a.week, 'week')), month: round2(f(a.month, 'month')), all: round2(f(a.all, 'all')) }
}

export async function dashboardStats(tzInput?: string | null, now: Date = new Date()) {
  const tz = safeTimeZone(tzInput)
  const starts = { today: startOfDay(tz, now), week: startOfDay(tz, now, 6), month: startOfDay(tz, now, 29) }

  const deposits = await periods(async (since) => {
    const r = await prisma.cryptoDeposit.aggregate({
      where: { status: 'APPROVED', ...(since ? { creditedAt: { gte: since } } : {}) },
      _sum: { creditedAmount: true }
    })
    return num(r._sum.creditedAmount)
  }, starts)
  const withdrawals = await periods(async (since) => {
    const r = await prisma.cryptoWithdrawal.aggregate({
      where: { status: 'APPROVED', ...(since ? { reviewedAt: { gte: since } } : {}) },
      _sum: { deducted: true }
    })
    return num(r._sum.deducted)
  }, starts)
  const ledgerSum = (types: string[]) => async (since: Date | null) => {
    const r = await prisma.walletTransaction.aggregate({
      where: { type: { in: types }, ...(since ? { createdAt: { gte: since } } : {}) },
      _sum: { amount: true }
    })
    return num(r._sum.amount)
  }
  const commission = await periods(ledgerSum(['PLATFORM_FEE']), starts)
  const bonuses = await periods(ledgerSum(BONUS_TYPES), starts)
  // An adjustment's `amount` is what staff asked for; a removal larger than the
  // balance is clamped by the ledger, so the real effect is balanceAfter - balanceBefore.
  const adjustments = await periods(async (since) => {
    const rows = await prisma.walletTransaction.findMany({
      where: { type: 'ADJUSTMENT', ...(since ? { createdAt: { gte: since } } : {}) },
      select: { balanceBefore: true, balanceAfter: true }
    })
    return rows.reduce((acc, r) => acc + num(r.balanceAfter) - num(r.balanceBefore), 0)
  }, starts)

  const [depositCount, withdrawalCount, balances] = await Promise.all([
    prisma.cryptoDeposit.count({ where: { status: 'APPROVED' } }),
    prisma.cryptoWithdrawal.count({ where: { status: 'APPROVED' } }),
    prisma.wallet.aggregate({ where: { user: { role: 'PLAYER' } }, _sum: { available: true, locked: true } })
  ])

  const netProfit = combine(commission, (c, k) => c - bonuses[k] - adjustments[k])
  const netFlow = combine(deposits, (d, k) => d - withdrawals[k])

  // Real accounts only: a guest session is a throwaway account that would otherwise
  // inflate every player figure. Guests are counted on their own.
  const players = { role: 'PLAYER', authProvider: { not: 'GUEST' } }
  const [total, activeWeek, activeToday, newToday, suspended, banned, guestsToday] = await Promise.all([
    prisma.user.count({ where: players }),
    prisma.user.count({ where: { ...players, lastSeenAt: { gte: starts.week } } }),
    prisma.user.count({ where: { ...players, lastSeenAt: { gte: starts.today } } }),
    prisma.user.count({ where: { ...players, createdAt: { gte: starts.today } } }),
    prisma.user.count({ where: { ...players, status: 'SUSPENDED' } }),
    prisma.user.count({ where: { ...players, status: 'BANNED' } }),
    prisma.user.count({ where: { role: 'PLAYER', authProvider: 'GUEST', createdAt: { gte: starts.today } } })
  ])

  const [activeMatches, completedMatches, pendingDeposits, pendingWithdrawals, supportAwaiting] = await Promise.all([
    prisma.match.count({ where: { status: { in: ['MATCH_STARTED', 'MATCH_IN_PROGRESS'] } } }),
    prisma.match.count({ where: { status: 'PRIZE_SETTLED' } }),
    prisma.cryptoDeposit.count({ where: { status: 'PENDING' } }),
    prisma.cryptoWithdrawal.count({ where: { status: 'PENDING' } }),
    threadsAwaitingReply()
  ])

  const finance: DashboardFinance = {
    deposits: { ...deposits, countAll: depositCount },
    withdrawals: { ...withdrawals, countAll: withdrawalCount },
    commission,
    bonuses,
    adjustments,
    netProfit,
    netFlow,
    playerBalances: round2(num(balances._sum.available) + num(balances._sum.locked))
  }
  const users: DashboardUsers = { total, activeWeek, activeToday, newToday, suspended, banned, guestsToday }

  return {
    timeZone: tz,
    periodStarts: { today: starts.today.toISOString(), week: starts.week.toISOString(), month: starts.month.toISOString() },
    finance,
    userActivity: users,
    // The original flat fields, unchanged, for admin app builds already installed.
    users: total,
    activeMatches,
    completedMatches,
    pendingDeposits,
    pendingWithdrawals,
    supportAwaiting,
    deposits: depositCount,
    withdrawals: withdrawalCount,
    platformRevenue: commission.all
  }
}
