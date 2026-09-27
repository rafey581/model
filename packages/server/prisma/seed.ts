import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { config } from '../src/config.js'

const prisma = new PrismaClient()

async function main(): Promise<void> {
  const passwordHash = bcrypt.hashSync('admin123', 10)

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

  console.log('seeded:', { admin: admin.username, player: player.username, player2: player2.username, password: 'admin123' })
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())