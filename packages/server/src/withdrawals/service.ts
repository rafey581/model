import type { Prisma } from '@prisma/client'
import { prisma } from '../db/index.js'
import { config } from '../config.js'
import { runInTransaction, ledger, round, InsufficientBalanceError } from '../wallet/service.js'
import type { Tx } from '../wallet/service.js'
import { notify, notifyAdmins } from '../notifications/service.js'
import { pushToAdmins } from '../push/adminPush.js'

/**
 * Manual USDT (Solana) withdrawals.
 *
 * Flow: the player asks to cash out — they post an amount plus their own Solana
 * address. The amount is held at once (moved from available to locked), so it can
 * neither be staked nor requested twice while the request waits. The request,
 * carrying a snapshot of their last finished matches so the admin can see the
 * games that funded the balance, lands in the admins' inbox. The admin approves —
 * which takes the held amount for good — and then pays the USDT out of band.
 * Rejecting, or the player cancelling, releases the hold back to available.
 * Nothing here moves real money: the payout itself is a manual, off-platform act
 * by the operator, proven by the approval trail.
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

/** A player tried to cancel a request that is not theirs or no longer pending. */
export class WithdrawalNotCancellableError extends Error {
  constructor() {
    super('withdrawal can no longer be cancelled')
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
  const history = await lastMatches(input.userId)

  let created: { id: string }
  try {
    created = await runInTransaction(async (tx) => {
      const row = await tx.cryptoWithdrawal.create({
        data: {
          userId: input.userId,
          network: config.WITHDRAW_NETWORK,
          address: input.address,
          currency: config.WITHDRAW_CURRENCY,
          channel: 'MANUAL',
          amount: input.amountUsdt,
          heldAmount: requiredUsdt,
          matchHistory: history as unknown as Prisma.InputJsonValue
        },
        select: { id: true }
      })
      // The wallet row is locked FOR UPDATE inside the ledger, so two requests racing
      // each other are serialised and the second sees the first one's hold.
      await ledger.freezeForMatch(tx, {
        userId: input.userId,
        amount: requiredUsdt,
        type: 'WITHDRAWAL_HOLD',
        currency: 'USDT',
        refId: row.id,
        meta: { address: input.address, network: config.WITHDRAW_NETWORK }
      })
      return row
    })
  } catch (error) {
    if (error instanceof InsufficientBalanceError) {
      throw new InsufficientWithdrawBalanceError(requiredUsdt, await walletAvailable(input.userId))
    }
    throw error
  }

  await notifyAdmins(
    'WITHDRAW_PENDING',
    'New withdrawal request',
    `${input.amountUsdt} ${config.WITHDRAW_CURRENCY} (${config.WITHDRAW_NETWORK}) awaits verification`
  )
  // Ring the staff phones. Not awaited: the player's request is done either way.
  void prisma.user
    .findUnique({ where: { id: input.userId }, select: { username: true } })
    .then((user) =>
      pushToAdmins({
        title: `New withdrawal: ${input.amountUsdt} ${config.WITHDRAW_CURRENCY}`,
        body: `${user?.username ?? 'A player'} wants ${input.amountUsdt} ${config.WITHDRAW_CURRENCY} paid out. Review the request.`,
        href: '/withdrawals',
        kind: 'WITHDRAW_PENDING',
        ring: true
      })
    )
    .catch(() => undefined)
  return created
}

/** Returns a held amount to available. No-op for a request made before holds existed. */
async function releaseHold(
  tx: Tx,
  withdrawal: { id: string; userId: string; heldAmount: Prisma.Decimal | null },
  reason: 'rejected' | 'cancelled'
): Promise<number> {
  if (withdrawal.heldAmount === null) return 0
  const held = round(Number(withdrawal.heldAmount))
  if (held <= 0) return 0
  await ledger.unfreezeFromMatch(tx, {
    userId: withdrawal.userId,
    amount: held,
    type: 'WITHDRAWAL_RELEASE',
    currency: 'USDT',
    refId: withdrawal.id,
    meta: { reason }
  })
  return held
}

export interface WithdrawalApproval {
  deducted: number
}

/**
 * Approves a PENDING withdrawal and takes the money within one transaction. The
 * `updateMany` on `status: 'PENDING'` is the concurrency gate (only the first
 * approval matches). A held request consumes its hold, which cannot fail: the
 * money has been set aside since the request. A request from before holds existed
 * is debited from available instead, and if the player spent that balance in the
 * meantime the ledger throws and the whole transaction rolls back.
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

    const entry = {
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
        held: withdrawal.heldAmount !== null,
        adminId
      }
    }
    if (withdrawal.heldAmount !== null) await ledger.consumeLocked(tx, entry)
    else await ledger.debitAvailable(tx, entry)

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
  let released = 0

  await runInTransaction(async (tx) => {
    const gated = await tx.cryptoWithdrawal.updateMany({
      where: { id: withdrawalId, status: 'PENDING' },
      data: { status: 'REJECTED', rejectReason, reviewedById: adminId, reviewedAt }
    })
    if (gated.count !== 1) throw new WithdrawalAlreadyReviewedError()
    released = await releaseHold(tx, withdrawal, 'rejected')

    await tx.adminAction.create({
      data: {
        adminId,
        action: 'WITHDRAW_REJECT',
        targetType: 'USER',
        targetId: withdrawal.userId,
        meta: { withdrawalId: withdrawal.id, amountUsdt: Number(withdrawal.amount), reason: rejectReason, released }
      }
    })
  })

  await notify(
    withdrawal.userId,
    'WITHDRAW_REJECTED',
    'Withdrawal rejected',
    `Your ${withdrawal.amount} ${withdrawal.currency} withdrawal could not be approved. ${rejectReason}` +
      (released > 0 ? ` The ${released} USDT held for it is back in your balance.` : '')
  )

  return { id: withdrawalId }
}

/** The player withdraws their own pending request; the hold goes back to their balance. */
export async function cancelWithdrawal(withdrawalId: string, userId: string): Promise<{ id: string; released: number }> {
  const withdrawal = await prisma.cryptoWithdrawal.findUnique({ where: { id: withdrawalId } })
  if (!withdrawal || withdrawal.userId !== userId) throw new WithdrawalNotFoundError()
  if (withdrawal.status !== 'PENDING') throw new WithdrawalNotCancellableError()

  let released = 0
  await runInTransaction(async (tx) => {
    const gated = await tx.cryptoWithdrawal.updateMany({
      where: { id: withdrawalId, userId, status: 'PENDING' },
      data: { status: 'CANCELLED', cancelledAt: new Date() }
    })
    if (gated.count !== 1) throw new WithdrawalNotCancellableError()
    released = await releaseHold(tx, withdrawal, 'cancelled')
  })
  return { id: withdrawalId, released }
}

// Re-exported so routes can map the ledger refusal at approval time.
export { InsufficientBalanceError }