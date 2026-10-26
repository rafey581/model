import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { prisma } from '../db/index.js'
import { createDeposit, approveDeposit, rejectDeposit, depositInfo, DuplicateDepositTxError, UnsupportedDepositCurrencyError } from './service.js'
import { checkLedgerInvariance } from '../fraud/index.js'

const TAG = `deposit${Date.now() % 1000000}`
const USERS: string[] = []

async function createUser(role = 'PLAYER', balance = 0): Promise<string> {
  const email = `${TAG}-${USERS.length}@test.local`
  // Wallet and its backing entry in one transaction (see ledger.test.ts).
  const user = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email,
        username: `d${USERS.length}-${TAG}`,
        passwordHash: '!',
        role,
        status: 'ACTIVE',
        wallet: { create: { available: balance } }
      }
    })
    if (balance > 0) {
      await tx.walletTransaction.create({
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
    return user
  })
  USERS.push(user.id)
  return user.id
}

async function cleanup(): Promise<void> {
  // CryptoDeposit, WalletTransaction and Notification all cascade on user delete.
  await prisma.user.deleteMany({ where: { id: { in: USERS } } })
  USERS.length = 0
}

beforeAll(async () => {
  await prisma.$connect()
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('manual deposits', () => {
  it('approving a pending deposit credits the player exactly once and keeps the ledger invariant', async () => {
    const player = await createUser()
    const admin = await createUser('SUPERADMIN')

    const deposit = await createDeposit({
      userId: player,
      amountUsdt: 25,
      txHash: `${TAG}-tx-1`,
      screenshot: 'data:image/png;base64,AAAA'
    })

    const approved = await approveDeposit(deposit.id, admin)
    expect(approved.credited).toBe(25)

    const wallet = await prisma.wallet.findUnique({ where: { userId: player } })
    expect(Number(wallet!.available)).toBe(25)

    const row = await prisma.cryptoDeposit.findUnique({ where: { id: deposit.id } })
    expect(row!.status).toBe('APPROVED')
    expect(Number(row!.creditedAmount)).toBe(25)
    expect(row!.reviewedById).toBe(admin)

    // A second approval must not double-credit.
    await expect(approveDeposit(deposit.id, admin)).rejects.toThrow(/already reviewed/)
    const after = await prisma.wallet.findUnique({ where: { userId: player } })
    expect(Number(after!.available)).toBe(25)

    const txns = await prisma.walletTransaction.count({ where: { refId: deposit.id, type: 'DEPOSIT' } })
    expect(txns).toBe(1)

    const result = await checkLedgerInvariance()
    expect(result.ok).toBe(true)
    expect(result.violations.length).toBe(0)
  }, 30_000)

  it('rejects a deposit request whose transaction id is already in use', async () => {
    const player = await createUser()
    await createDeposit({
      userId: player,
      amountUsdt: 10,
      txHash: `${TAG}-dup`,
      screenshot: 'data:image/png;base64,AAAA'
    })
    await expect(
      createDeposit({
        userId: player,
        amountUsdt: 20,
        txHash: `${TAG}-dup`,
        screenshot: 'data:image/png;base64,BBBB'
      })
    ).rejects.toThrow(DuplicateDepositTxError)
  })

  it('rejecting a deposit leaves the wallet untouched', async () => {
    const player = await createUser('PLAYER', 100)
    const admin = await createUser('ADMIN')

    const deposit = await createDeposit({
      userId: player,
      amountUsdt: 15,
      txHash: `${TAG}-rej`,
      screenshot: 'data:image/png;base64,CCCC'
    })
    await rejectDeposit(deposit.id, admin, 'transaction not found on chain')

    const row = await prisma.cryptoDeposit.findUnique({ where: { id: deposit.id } })
    expect(row!.status).toBe('REJECTED')
    expect(row!.rejectReason).toBe('transaction not found on chain')
    expect(row!.reviewedById).toBe(admin)

    const wallet = await prisma.wallet.findUnique({ where: { userId: player } })
    expect(Number(wallet!.available)).toBe(100)

    await expect(rejectDeposit(deposit.id, admin)).rejects.toThrow(/already reviewed/)
  }, 30_000)

  it('accepts USDC on Solana as well as USDT, records the coin, and credits it 1:1', async () => {
    const player = await createUser()
    const admin = await createUser('SUPERADMIN')
    expect(depositInfo().currencies).toEqual(['USDT', 'USDC'])
    expect(depositInfo().network).toBe('SOL')
    expect(depositInfo().walletAddress).toBe('7oK51mdQkub5kMsZoTMFRVpcsfcNvrGKTigu9wWbvMyR')

    const deposit = await createDeposit({ userId: player, amountUsdt: 40, currency: 'usdc', txHash: `${TAG}-usdc`, screenshot: 'data:image/png;base64,AAAA' })
    const row = await prisma.cryptoDeposit.findUniqueOrThrow({ where: { id: deposit.id } })
    expect(row.currency).toBe('USDC')
    expect(row.address).toBe('7oK51mdQkub5kMsZoTMFRVpcsfcNvrGKTigu9wWbvMyR')

    const approved = await approveDeposit(deposit.id, admin)
    expect(approved.credited).toBe(40)
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: player } })
    expect(Number(wallet.available)).toBe(40)

    const usdt = await createDeposit({ userId: player, amountUsdt: 5, txHash: `${TAG}-usdt-default`, screenshot: 'data:image/png;base64,AAAA' })
    expect((await prisma.cryptoDeposit.findUniqueOrThrow({ where: { id: usdt.id } })).currency).toBe('USDT')
  }, 30_000)

  it('refuses any other coin', async () => {
    const player = await createUser()
    await expect(
      createDeposit({ userId: player, amountUsdt: 10, currency: 'ETH', txHash: `${TAG}-eth`, screenshot: 'data:image/png;base64,AAAA' })
    ).rejects.toThrow(UnsupportedDepositCurrencyError)
    expect(await prisma.cryptoDeposit.count({ where: { userId: player } })).toBe(0)
  }, 30_000)
})
