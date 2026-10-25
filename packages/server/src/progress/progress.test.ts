import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { XP_ONLINE_LOSS, XP_ONLINE_WIN, XP_PRACTICE_WIN, XP_TOURNAMENT_CHAMPION } from '@snooker/shared'
import { prisma } from '../db/index.js'
import { settleMatch, getBotUserId } from '../matches/service.js'
import { applyTournamentChampion, getUserProgress } from './service.js'

const TAG = `prog${Date.now() % 1000000}`
const USERS: string[] = []
const MATCHES: string[] = []

async function createUser(): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${TAG}-${USERS.length}@test.local`,
      username: `p${USERS.length}-${TAG}`,
      passwordHash: '!',
      status: 'ACTIVE',
      wallet: { create: { available: 0 } }
    }
  })
  USERS.push(user.id)
  return user.id
}

async function startedMatch(a: string, b: string, opts: { practice?: boolean; aiLevel?: string } = {}): Promise<string> {
  const match = await prisma.match.create({
    data: {
      matchType: opts.practice ? 'PRACTICE' : 'ONE_V_ONE',
      stakePerPlayer: 0,
      format: 'BO1',
      status: 'MATCH_STARTED',
      aiLevel: opts.aiLevel,
      startedAt: new Date(),
      players: { create: [{ userId: a, seat: 0 }, { userId: b, seat: 1 }] }
    }
  })
  MATCHES.push(match.id)
  return match.id
}

async function play(winner: string, loser: string, reason = 'frames'): Promise<void> {
  const matchId = await startedMatch(winner, loser)
  await settleMatch({ matchId, winnerId: winner, reason })
}

async function badgeCodes(userId: string): Promise<string[]> {
  const rows = await prisma.userBadge.findMany({ where: { userId }, include: { badge: true } })
  return rows.map((r) => r.badge.code).sort()
}

beforeAll(async () => {
  await prisma.$connect()
})

afterAll(async () => {
  await prisma.tournament.updateMany({ where: { championId: { in: USERS } }, data: { championId: null } })
  await prisma.tournament.deleteMany({ where: { name: { startsWith: TAG } } })
  await prisma.match.deleteMany({ where: { id: { in: MATCHES } } })
  await prisma.user.deleteMany({ where: { id: { in: USERS } } })
  await prisma.$disconnect()
})

describe('match progression', () => {
  it('awards XP, the first-win badge and a streak to the winner, and loss XP to the loser', async () => {
    const a = await createUser()
    const b = await createUser()
    await play(a, b)

    const ua = await prisma.user.findUniqueOrThrow({ where: { id: a } })
    const ub = await prisma.user.findUniqueOrThrow({ where: { id: b } })
    expect(ua.xp).toBe(XP_ONLINE_WIN)
    expect(ua.winStreak).toBe(1)
    expect(ub.xp).toBe(XP_ONLINE_LOSS)
    expect(ub.winStreak).toBe(0)
    expect(await badgeCodes(a)).toEqual(['FIRST_WIN'])
    expect(await badgeCodes(b)).toEqual([])
  })

  it('awards exactly once when the same match is settled twice', async () => {
    const a = await createUser()
    const b = await createUser()
    const matchId = await startedMatch(a, b)
    await settleMatch({ matchId, winnerId: a, reason: 'frames' })
    await settleMatch({ matchId, winnerId: a, reason: 'frames' })
    const ua = await prisma.user.findUniqueOrThrow({ where: { id: a } })
    expect(ua.xp).toBe(XP_ONLINE_WIN)
    expect(await prisma.userBadge.count({ where: { userId: a } })).toBe(1)
  })

  it('levels up after two wins, notifies, and builds a streak badge; a loss resets the streak', async () => {
    const a = await createUser()
    const b = await createUser()
    await play(a, b)
    await play(a, b)
    let ua = await prisma.user.findUniqueOrThrow({ where: { id: a } })
    expect(ua.level).toBe(2)
    // Notifications are fire-and-forget after the commit, so give them a moment to land.
    let levelUps = 0
    for (let i = 0; i < 20 && levelUps === 0; i++) {
      levelUps = await prisma.notification.count({ where: { userId: a, kind: 'LEVEL_UP' } })
      if (levelUps === 0) await new Promise((r) => setTimeout(r, 50))
    }
    expect(levelUps).toBe(1)

    await play(a, b)
    ua = await prisma.user.findUniqueOrThrow({ where: { id: a } })
    expect(ua.winStreak).toBe(3)
    expect(await badgeCodes(a)).toEqual(['FIRST_WIN', 'STREAK_3'])

    await play(b, a)
    ua = await prisma.user.findUniqueOrThrow({ where: { id: a } })
    expect(ua.winStreak).toBe(0)
    expect(ua.bestWinStreak).toBe(3)
  })

  it('gives no XP to a player who abandoned', async () => {
    const a = await createUser()
    const b = await createUser()
    await play(a, b, 'abandon')
    const ub = await prisma.user.findUniqueOrThrow({ where: { id: b } })
    expect(ub.xp).toBe(0)
  })

  it('practice: beating the HARD robot pays practice XP and the robot badge, and the robot does not level', async () => {
    const a = await createUser()
    const bot = await getBotUserId()
    const botBefore = await prisma.user.findUniqueOrThrow({ where: { id: bot } })
    const matchId = await startedMatch(a, bot, { practice: true, aiLevel: 'HARD' })
    await settleMatch({ matchId, winnerId: a, reason: 'frames' })

    const ua = await prisma.user.findUniqueOrThrow({ where: { id: a } })
    expect(ua.xp).toBe(XP_PRACTICE_WIN)
    expect(ua.winStreak).toBe(0)
    expect(await badgeCodes(a)).toEqual(['AI_HARD'])
    const botAfter = await prisma.user.findUniqueOrThrow({ where: { id: bot } })
    expect(botAfter.xp).toBe(botBefore.xp)
  })

  it('tournament champion gets the bonus XP and the champion badge', async () => {
    const a = await createUser()
    await prisma.tournament.create({ data: { name: `${TAG}-cup`, status: 'COMPLETED', championId: a } })
    await applyTournamentChampion(a)
    const ua = await prisma.user.findUniqueOrThrow({ where: { id: a } })
    expect(ua.xp).toBe(XP_TOURNAMENT_CHAMPION)
    expect(await badgeCodes(a)).toContain('TOURNAMENT_CHAMPION')
  })

  it('reports level, rank, XP bar and the badge catalogue with earned dates', async () => {
    const a = await createUser()
    const b = await createUser()
    await play(a, b)
    const p = await getUserProgress(a)
    expect(p).not.toBeNull()
    expect(p!.level).toBe(1)
    expect(p!.levelXp).toBe(XP_ONLINE_WIN)
    expect(p!.percent).toBe(50)
    expect(p!.rank.id).toBe('BRONZE')
    const first = p!.badges.find((x) => x.code === 'FIRST_WIN')
    expect(first?.earnedAt).not.toBeNull()
    expect(p!.badges.find((x) => x.code === 'WINS_10')?.earnedAt).toBeNull()
  })
})
