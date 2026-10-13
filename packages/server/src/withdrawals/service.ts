import type { Prisma } from '@prisma/client'
import { prisma } from '../db/index.js'
import { config } from '../config.js'
import { runInTransaction, ledger, round, InsufficientBalanceError } from '../wallet/service.js'
import { notify, notifyAdmins } from '../notifications/service.js'

/**
 * Manual USDT (Solana) withdrawals.
 *
 * Flow: the player asks to cash out — they post an amount plus their own Solana
 * address. The request, carrying a snapshot of their last finished matches so the
 * admin can see the games that funded the balance, lands in the admins' inbox.
 * The admin verifies the account, pays the USDT out of band, and approves, which
 * debits the same amount in USDT (1 USDT = 1 unit) from the player's wallet in
 * one transaction. Nothing here moves real money: the payout itself is a manual,
 * off-platform act by the operator, proven by the approval trail.
 */

export interface WithdrawInfo {
  enabled: boolean
  network: string
  currency: string
  minUsdt: number
  maxUsdt: number
  matchSnapshotCount: number
}

export function withdrawInfo(): WithdrawInfo {
  return {
    enabled: config.WITHDRAW_ENABLED,
    network: config.WITHDRAW_NETWORK,
    currency: config.WITHDRAW_CURRENCY,
    minUsdt: config.WITHDRAW_MIN_USDT,
    maxUsdt: config.WITHDRAW_MAX_USDT,
    matchSnapshotCount: config.WITHDRAW_MATCH_SNAPSHOT_COUNT
  }
}

export class WithdrawalNotFoundError extends Error {
  constructor() {
    super('withdrawal not found')
  }
}

export class WithdrawalAlreadyReviewedError extends Error {
  constructor() {
    super('withdrawal already reviewed')
  }
}

/** Raised when the player does not hold enough USDT to cover the request. */
export class InsufficientWithdrawBalanceError extends Error {
  readonly requiredUsdt: number
  readonly availableUsdt: number
  constructor(requiredUsdt: number, availableUsdt: number) {
    super('insufficient balance for this withdrawal')
    this.requiredUsdt = requiredUsdt
    this.availableUsdt = availableUsdt
  }
}

export interface CreateWithdrawalInput {
  userId: string
  amountUsdt: number
  address: string
}

export interface WithdrawalMatchRecord {
  matchId: string
  mode: string
  format: string
  stake: number
  status: string
  finishedAt: string | null
  result: 'WIN' | 'LOSS' | 'UNKNOWN'
  opponent: string | null
}

/**
 * The player's most recent finished (non-practice) matches. This is the snapshot
 * an admin reviews before approving a cash-out — the record of the games that
 * funded the balance.
 */
export async function lastMatches(userId: string, count = config.WITHDRAW_MATCH_SNAPSHOT_COUNT): Promise<WithdrawalMatchRecord[]> {
  const matches = await prisma.match.findMany({
    where: {
      matchType: { not: 'PRACTICE' },
      status: { in: ['PRIZE_SETTLED', 'MATCH_COMPLETED', 'RESULT_VERIFIED', 'REFUNDED'] },
      players: { some: { userId } }
    },
    include: { players: { include: { user: { select: { id: true, username: true } } } } },
    orderBy: { finishedAt: 'desc' },
    take: Math.min(Math.max(count, 1), 50)
  })
  return matches.map((m) => {
    const other = m.players.find((p) => p.userId !== userId)
    let result: WithdrawalMatchRecord['result'] = 'UNKNOWN'
    if (m.winnerId === userId) result = 'WIN'
    else if (m.winnerId && m.winnerId !== userId) result = 'LOSS'
    return {
      matchId: m.id,
      mode: m.matchType,
      format: m.format,
      stake: Number(m.stakePerPlayer),
      status: m.status,
      finishedAt: m.finishedAt ? m.finishedAt.toISOString() : null,
      result,
      opponent: other?.user.username ?? null
    }
  })
}

async function walletAvailable(userId: string): Promise<number> {
  const wallet = await prisma.wallet.findUnique({ where: { userId }, select: { available: true } })
  return wallet ? Number(wallet.available) : 0
}

export async function createWithdrawal(input: CreateWithdrawalInput): Promise<{ id: string }> {
  const requiredUsdt = round(input.amountUsdt)
  const available = await walletAvailable(input.userId)
  if (available < requiredUsdt) {
    throw new InsufficientWithdrawBalanceError(requiredUsdt, available)
  }

  const history = await lastMatches(input.userId)

  const created = await prisma.cryptoWithdrawal.create({
    data: {
      userId: input.userId,
      network: config.WITHDRAW_NETWORK,
      address: input.address,
      currency: config.WITHDRAW_CURRENCY,
      channel: 'MANUAL',
      amount: input.amountUsdt,
      matchHistory: history as unknown as Prisma.InputJsonValue
    },
    select: { id: true }
  })

  // The mobile admin app is wired up later; until then the request lands in each
  // admin's notification inbox, with the match snapshot visible in Admin → Withdrawals.
  await notifyAdmins(
    'WITHDRAW_PENDING',
    'New withdrawal request',
    `${input.amountUsdt} ${config.WITHDRAW_CURRENCY} (${config.WITHDRAW_NETWORK}) awaits verification`
  )
  return created
}

export interface WithdrawalApproval {
  deducted: number
}

/**
 * Approves a PENDING withdrawal and debits the player's wallet within one
 * transaction. The `updateMany` on `status: 'PENDING'` is the concurrency gate
 * (only the first approval matches). The ledger `debitAvailable` is the second
 * gate: if the player spent their balance while the request sat in the queue,
 * it throws and the whole transaction rolls back — a withdrawal can never be
 * approved against a balance that no longer exists.
 */
export async function approveWithdrawal(withdrawalId: string, adminId: string): Promise<WithdrawalApproval> {
  const withdrawal = await prisma.cryptoWithdrawal.findUnique({ where: { id: withdrawalId } })
  if (!withdrawal) throw new WithdrawalNotFoundError()
  if (withdrawal.status !== 'PENDING') throw new WithdrawalAlreadyReviewedError()

  const deducted = round(Number(withdrawal.amount))
  const reviewedAt = new Date()

  await runInTransaction(async (tx) => {
    const gated = await tx.cryptoWithdrawal.updateMany({
      where: { id: withdrawalId, status: 'PENDING' },
      data: { status: 'APPROVED', deducted, reviewedById: adminId, reviewedAt, completedAt: reviewedAt }
    })
    if (gated.count !== 1) throw new WithdrawalAlreadyReviewedError()

    await ledger.debitAvailable(tx, {
      userId: withdrawal.userId,
      amount: deducted,
      type: 'WITHDRAWAL',
      currency: 'USDT',
      refId: withdrawal.id,
      meta: {
        amountUsdt: Number(withdrawal.amount),
        network: withdrawal.network,
        address: withdrawal.address,
        currency: withdrawal.currency,
        adminId
      }
    })

    await tx.adminAction.create({
      data: {
        adminId,
        action: 'WITHDRAW_APPROVE',
        targetType: 'USER',
        targetId: withdrawal.userId,
        meta: {
          withdrawalId: withdrawal.id,
          amountUsdt: Number(withdrawal.amount),
          deducted,
          address: withdrawal.address
        }
      }
    })
  })

  await notify(
    withdrawal.userId,
    'WITHDRAW_APPROVED',
    'Withdrawal approved',
    `Your ${withdrawal.amount} ${withdrawal.currency} withdrawal was approved and sent to ${withdrawal.address}.`
  )

  return { deducted }
}

export interface WithdrawalRejection {
  id: string
}

export async function rejectWithdrawal(withdrawalId: string, adminId: string, reason?: string): Promise<WithdrawalRejection> {
  const withdrawal = await prisma.cryptoWithdrawal.findUnique({ where: { id: withdrawalId } })
  if (!withdrawal) throw new WithdrawalNotFoundError()
  if (withdrawal.status !== 'PENDING') throw new WithdrawalAlreadyReviewedError()

  const reviewedAt = new Date()
  const rejectReason = (reason ?? '').trim() || 'rejected by admin'

  await runInTransaction(async (tx) => {
    const gated = await tx.cryptoWithdrawal.updateMany({
      where: { id: withdrawalId, status: 'PENDING' },
      data: { status: 'REJECTED', rejectReason, reviewedById: adminId, reviewedAt }
    })
    if (gated.count !== 1) throw new WithdrawalAlreadyReviewedError()

    await tx.adminAction.create({
      data: {
        adminId,
        action: 'WITHDRAW_REJECT',
        targetType: 'USER',
        targetId: withdrawal.userId,
        meta: { withdrawalId: withdrawal.id, amountUsdt: Number(withdrawal.amount), reason: rejectReason }
      }
    })
  })

  await notify(
    withdrawal.userId,
    'WITHDRAW_REJECTED',
    'Withdrawal rejected',
    `Your ${withdrawal.amount} ${withdrawal.currency} withdrawal could not be approved. ${rejectReason}`
  )

  return { id: withdrawalId }
}

// Re-exported so routes can map the ledger refusal at approval time.
export { InsufficientBalanceError }