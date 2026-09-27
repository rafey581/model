import { PrismaClient } from '@prisma/client'
import { Prisma } from '@prisma/client'

export const prisma = new PrismaClient()

export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use'>

export type { Prisma }