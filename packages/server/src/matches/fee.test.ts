import { describe, expect, it, afterAll } from 'vitest'
import { prisma } from '../db/index.js'
import { runInTransaction, ledger } from '../wallet/service.js'
import { createOneVsOneMatch, joinOneVsOneMatch, settleMatch } from './service.js'

/** The game fee: 10% of the whole pot (both stakes); the winner gets the rest. */

const TAG = `fee${Date.now() % 1000000}`
const users: string[] = []
const matches: string[] = []

async function player(n: number): Promise<string> {
  const u = await prisma.user.create({
    data: { email: `${TAG}${n}@t.local`, username: `${TAG}${n}`, passwordHash: '!', role: 'PLAYER', status: 'ACTIVE', wallet: { create: { available: 0 } } }
  })
  users.push(u.id)
  await runInTransaction((tx) => ledger.creditAvailable(tx, { userId: u.id, amount: 20, type: 'ADJUSTMENT' }))
  return u.id
}

const balance = async (id: string) => Number((await prisma.wallet.findUniqueOrThrow({ where: { userId: id } })).available)

afterAll(async () => {
  await prisma.match.deleteMany({ where: { id: { in: matches } } })
  await prisma.user.deleteMany({ where: { id: { in: users } } })
})

describe('game fee', () => {
  it('takes 10% of a 5 + 5 pot (1) and pays the winner the other 9', async () => {
    const a = await player(1)
    const b = await player(2)
    const match = await createOneVsOneMatch(a, 'TIER_5', 'BO1')
    matches.push(match.id)
    await joinOneVsOneMatch(match.id, b)
    expect(await balance(a)).toBe(15)
    expect(await balance(b)).toBe(15)

    await settleMatch({ matchId: match.id, winnerId: a, reason: 'frames' })
    const settled = await prisma.match.findUniqueOrThrow({ where: { id: match.id } })
    expect(settled.resultJson).toMatchObject({ pool: 10, fee: 1, prize: 9 })
    expect(await balance(a)).toBe(24)
    expect(await balance(b)).toBe(15)
    const fee = await prisma.walletTransaction.findFirst({ where: { type: 'PLATFORM_FEE', refId: match.id } })
    expect(Number(fee?.amount)).toBe(1)
  })
})
