import { PrismaClient } from '@prisma/client'
import { Prisma } from '@prisma/client'

export const prisma = new PrismaClient({ log: ['warn', 'error'] })

export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use'>

export type { Prisma }