import { Prisma } from '@prisma/client'
import { prisma } from '../db/index.js'
import { config } from '../config.js'
import { runInTransaction, ledger, round } from '../wallet/service.js'
import { notify, notifyAdmins } from '../notifications/service.js'

/**
 * Manual USDT (Solana) deposits.
 *
 * Flow: the player sends USDT to the operator's external wallet address, then
 * posts a transaction id + a proof screenshot here. An admin verifies the
 * transaction and approves, which credits the player the same amount in USDT
 * (1 USDT = 1 unit). No crypto ever moves through this server — the address
 * lives on a wallet the operator controls — so this module is pure bookkeeping
 * plus an auditable approval trail.
 */

export interface DepositInfo {
  enabled: boolean
  network: string
  currency: string
  walletAddress: string
  minUsdt: number
  maxUsdt: number
  screenshotMaxBytes: number
}

export function depositInfo(): DepositInfo {
  return {
    enabled: config.DEPOSIT_ENABLED,
    network: config.DEPOSIT_NETWORK,
    currency: config.DEPOSIT_CURRENCY,
    walletAddress: config.DEPOSIT_WALLET_ADDRESS,
    minUsdt: config.DEPOSIT_MIN_USDT,
    maxUsdt: config.DEPOSIT_MAX_USDT,
    screenshotMaxBytes: config.DEPOSIT_SCREENSHOT_MAX_BYTES
  }
}

export class DepositNotFoundError extends Error {
  constructor() {
    super('deposit not found')
  }
}

export class DepositAlreadyReviewedError extends Error {
  constructor() {
    super('deposit already reviewed')
  }
}

export class DuplicateDepositTxError extends Error {
  constructor() {
    super('transaction id already used')
  }
}

export interface CreateDepositInput {
  userId: string
  amountUsdt: number
  txHash: string
  screenshot: string
}

export async function createDeposit(input: CreateDepositInput): Promise<{ id: string }> {
  try {
    const created = await prisma.cryptoDeposit.create({
      data: {
        userId: input.userId,
        network: config.DEPOSIT_NETWORK,
        address: config.DEPOSIT_WALLET_ADDRESS,
        currency: config.DEPOSIT_CURRENCY,
        channel: 'MANUAL',
        amount: input.amountUsdt,
        txHash: input.txHash,
        screenshot: input.screenshot
      },
      select: { id: true }
    })
    // Raise the flag for the admin side. The admin mobile app is wired up later;
    // until then the row lands in each admin's notification inbox.
    await notifyAdmins(
      'DEPOSIT_PENDING',
      'New deposit request',
      `${input.amountUsdt} ${config.DEPOSIT_CURRENCY} (${config.DEPOSIT_NETWORK}) awaits verification`
    )
    return created
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new DuplicateDepositTxError()
    }
    throw error
  }
}

export interface DepositApproval {
  credited: number
}

/**
 * Approves a PENDING deposit and credits the player's wallet within one
 * transaction. The `updateMany` on `status: 'PENDING'` is the concurrency gate:
 * if a second admin approves at the same time, only the first update matches and
 * the second transaction rolls back before any credits are applied.
 */
export async function approveDeposit(depositId: string, adminId: string): Promise<DepositApproval> {
  const deposit = await prisma.cryptoDeposit.findUnique({ where: { id: depositId } })
  if (!deposit) throw new DepositNotFoundError()
  if (deposit.status !== 'PENDING') throw new DepositAlreadyReviewedError()

  const credited = round(Number(deposit.amount))
  const reviewedAt = new Date()

  await runInTransaction(async (tx) => {
    const gated = await tx.cryptoDeposit.updateMany({
      where: { id: depositId, status: 'PENDING' },
      data: {
        status: 'APPROVED',
        creditedAmount: credited,
        creditedAt: reviewedAt,
        reviewedById: adminId,
        reviewedAt
      }
    })
    if (gated.count !== 1) throw new DepositAlreadyReviewedError()

    await ledger.creditAvailable(tx, {
      userId: deposit.userId,
      amount: credited,
      type: 'DEPOSIT',
      currency: 'USDT',
      refId: deposit.id,
      meta: {
        amountUsdt: Number(deposit.amount),
        network: deposit.network,
        currency: deposit.currency,
        txHash: deposit.txHash,
        adminId
      }
    })

    await tx.adminAction.create({
      data: {
        adminId,
        action: 'DEPOSIT_APPROVE',
        targetType: 'USER',
        targetId: deposit.userId,
        meta: {
          depositId: deposit.id,
          amountUsdt: Number(deposit.amount),
          credited,
          txHash: deposit.txHash
        }
      }
    })
  })

  await notify(
    deposit.userId,
    'DEPOSIT_APPROVED',
    'Deposit approved',
    `${deposit.amount} ${deposit.currency} verified and ${credited} USDT added to your balance.`
  )

  return { credited }
}

export interface DepositRejection {
  id: string
}

export async function rejectDeposit(depositId: string, adminId: string, reason?: string): Promise<DepositRejection> {
  const deposit = await prisma.cryptoDeposit.findUnique({ where: { id: depositId } })
  if (!deposit) throw new DepositNotFoundError()
  if (deposit.status !== 'PENDING') throw new DepositAlreadyReviewedError()

  const reviewedAt = new Date()
  const rejectReason = (reason ?? '').trim() || 'rejected by admin'

  await runInTransaction(async (tx) => {
    const gated = await tx.cryptoDeposit.updateMany({
      where: { id: depositId, status: 'PENDING' },
      data: { status: 'REJECTED', rejectReason, reviewedById: adminId, reviewedAt }
    })
    if (gated.count !== 1) throw new DepositAlreadyReviewedError()

    await tx.adminAction.create({
      data: {
        adminId,
        action: 'DEPOSIT_REJECT',
        targetType: 'USER',
        targetId: deposit.userId,
        meta: { depositId: deposit.id, amountUsdt: Number(deposit.amount), reason: rejectReason }
      }
    })
  })

  await notify(
    deposit.userId,
    'DEPOSIT_REJECTED',
    'Deposit rejected',
    `Your ${deposit.amount} ${deposit.currency} deposit could not be verified. ${rejectReason}`
  )

  return { id: depositId }
}