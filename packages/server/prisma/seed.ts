import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { config } from '../src/config.js'

const prisma = new PrismaClient()

/**
 * Every wallet needs a matching ledger entry, not just a balance.
 *
 * `checkLedgerInvariance` recomputes each wallet's position from its transactions
 * and compares it to `available + locked`. Seeding a wallet with a non-zero
 * balance and no transaction therefore registers as a violation - and it is a real
 * one, not a test artifact: the audit that settlement relies on cannot distinguish
 * "this money arrived" from "this number was typed in". The runtime register route
 * has always written the entry; this brings the seed in line.
 */
async function ensureOpeningLedger(userId: string, amount: number, description: string): Promise<void> {
  if (amount === 0) return
  const existing = await prisma.walletTransaction.count({ where: { userId, type: 'START_BALANCE' } })
  if (existing > 0) return
  await prisma.walletTransaction.create({
    data: {
      userId,
      type: 'START_BALANCE',
      amount,
      currency: 'CR',
      status: 'COMPLETED',
      balanceBefore: 0,
      balanceAfter: amount,
      meta: { description }
    }
  })
}

async function main(): Promise<void> {
  const seedPassword = process.env.SEED_ADMIN_PASSWORD ?? 'admin123'
  const passwordHash = bcrypt.hashSync(seedPassword, 10)

  const admin = await prisma.user.upsert({
    where: { email: 'admin@snooker.test' },
    update: {},
    create: {
      email: 'admin@snooker.test',
      username: 'admin',
      passwordHash,
      role: 'SUPERADMIN',
      wallet: { create: { available: 0 } }
    }
  })

  const player = await prisma.user.upsert({
    where: { email: 'player@snooker.test' },
    update: {},
    create: {
      email: 'player@snooker.test',
      username: 'player',
      passwordHash,
      role: 'PLAYER',
      wallet: { create: { available: config.CR_START_BALANCE } }
    }
  })

  const player2 = await prisma.user.upsert({
    where: { email: 'player2@snooker.test' },
    update: {},
    create: {
      email: 'player2@snooker.test',
      username: 'player2',
      passwordHash,
      role: 'PLAYER',
      wallet: { create: { available: config.CR_START_BALANCE } }
    }
  })

  await ensureOpeningLedger(player.id, config.CR_START_BALANCE, 'welcome virtual balance')
  await ensureOpeningLedger(player2.id, config.CR_START_BALANCE, 'welcome virtual balance')

  console.log('seeded:', { admin: admin.username, player: player.username, player2: player2.username, usesDefaultPassword: seedPassword === 'admin123' })
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())