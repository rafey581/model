import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { prisma } from '../db/index.js'

export type Tx = Prisma.TransactionClient

export interface LedgerEntry {
  userId: string
  amount: number
  type: string
  currency?: string
  refId?: string
  meta?: Record<string, unknown>
  counterpartyId?: string
}

export class InsufficientBalanceError extends Error {
  constructor() {
    super('insufficient balance')
  }
}

export async function getWalletRow(tx: Tx, userId: string): Promise<{ available: Prisma.Decimal; locked: Prisma.Decimal; currency: string }> {
  const rows = await tx.$queryRaw<Array<{ available: Prisma.Decimal; locked: Prisma.Decimal; currency: string }>>(
    Prisma.sql`SELECT "available", "locked", "currency" FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`
  )
  const row = rows[0]
  if (!row) throw new Error('wallet not found')
  return row
}

async function mutateBalance(
  tx: Tx,
  entry: Pick<LedgerEntry, 'userId' | 'type' | 'amount' | 'currency' | 'refId' | 'meta' | 'counterpartyId'>,
  apply: (available: number, locked: number) => { available: number; locked: number }
): Promise<{ balanceBefore: number; balanceAfter: number; lockedBefore: number; lockedAfter: number }> {
  const wallet = await getWalletRow(tx, entry.userId)
  const availableBefore = wallet.available.toNumber()
  const lockedBefore = wallet.locked.toNumber()
  const after = apply(availableBefore, lockedBefore)
  if (after.available < 0 || after.locked < 0) {
    throw new InsufficientBalanceError()
  }
  await tx.wallet.update({
    where: { userId: entry.userId },
    data: { available: after.available, locked: after.locked }
  })
  const lockedAfter = after.locked
  await tx.walletTransaction.create({
    data: {
      userId: entry.userId,
      type: entry.type,
      amount: entry.amount,
      currency: entry.currency ?? 'CR',
      status: 'COMPLETED',
      refId: entry.refId,
      balanceBefore: availableBefore,
      balanceAfter: after.available,
      meta: { ...entry.meta, lockedBefore, lockedAfter },
      counterpartyId: entry.counterpartyId
    }
  })
  return { balanceBefore: availableBefore, balanceAfter: after.available, lockedBefore, lockedAfter }
}

export const ledger = {
  async creditAvailable(tx: Tx, entry: LedgerEntry): Promise<void> {
    await mutateBalance(tx, entry, (available, locked) => ({ available: available + entry.amount, locked }))
  },
  async debitAvailable(tx: Tx, entry: LedgerEntry): Promise<void> {
    await mutateBalance(tx, entry, (available, locked) => ({ available: available - entry.amount, locked }))
  },
  async freezeForMatch(tx: Tx, entry: LedgerEntry): Promise<void> {
    await mutateBalance(tx, entry, (available, locked) => ({ available: available - entry.amount, locked: locked + entry.amount }))
  },
  async unfreezeFromMatch(tx: Tx, entry: LedgerEntry): Promise<void> {
    await mutateBalance(tx, entry, (available, locked) => ({ available: available + entry.amount, locked: locked - entry.amount }))
  },
  async consumeLocked(tx: Tx, entry: LedgerEntry): Promise<void> {
    await mutateBalance(tx, entry, (available, locked) => ({ available, locked: locked - entry.amount }))
  },
  async adjust(tx: Tx, entry: LedgerEntry): Promise<void> {
    await mutateBalance(tx, entry, (available, locked) => {
      if (entry.amount >= 0) return { available: available + entry.amount, locked }
      const removal = Math.min(available, -entry.amount)
      return { available: available - removal, locked }
    })
  }
}

export async function runInTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn)
}

export function round(value: number): number {
  return Math.round(value * 1e8) / 1e8
}