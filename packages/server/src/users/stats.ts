import { prisma } from '../db/index.js'

export const COMPLETED_STATUSES = ['PRIZE_SETTLED', 'MATCH_COMPLETED', 'RESULT_VERIFIED'] as const

export type LeaderboardPeriod = 'week' | 'month' | 'all'

export interface UserStats {
  matches: number
  wins: number
  losses: number
  winRate: number
  highestBreak: number
}

export interface LeaderboardRow {
  rank: number
  userId: string
  username: string
  matches: number
  wins: number
  losses: number
  winRate: number
  highestBreak: number
}

function ballValue(id: number): number {
  if (id >= 1 && id <= 15) return 1
  if (id >= 16 && id <= 21) return id - 14
  return 0
}

export function bestBreakForEvents(events: Array<{ type: string; data: unknown }>): Record<number, number> {
  const best: Record<number, number> = {}
  let seat: number | undefined
  let points = 0
  for (const ev of events) {
    if (ev.type === 'BALL_POTTED') {
      const d = ev.data as { ballId?: number; bySeat?: number } | null
      const bySeat = d?.bySeat
      if (bySeat === undefined) continue
      if (seat !== bySeat) {
        if (seat !== undefined && points > (best[seat] ?? 0)) best[seat] = points
        seat = bySeat
        points = 0
      }
      points += ballValue(d?.ballId ?? 0)
    } else if (ev.type === 'FOUL' || ev.type === 'TURN_CHANGE' || ev.type === 'FRAME_END') {
      if (seat !== undefined && points > (best[seat] ?? 0)) best[seat] = points
      seat = undefined
      points = 0
    }
  }
  if (seat !== undefined && points > (best[seat] ?? 0)) best[seat] = points
  return best
}

async function bestBreakByMatch(matchIds: string[]): Promise<Map<string, Record<number, number>>> {
  const out = new Map<string, Record<number, number>>()
  if (matchIds.length === 0) return out
  const events = await prisma.gameEvent.findMany({
    where: { matchId: { in: matchIds } },
    orderBy: [{ matchId: 'asc' }, { seq: 'asc' }],
    select: { matchId: true, seq: true, type: true, data: true }
  })
  const grouped = new Map<string, Array<{ type: string; data: unknown }>>()
  for (const ev of events) {
    const list = grouped.get(ev.matchId)
    const item = { type: ev.type, data: ev.data }
    if (list) list.push(item)
    else grouped.set(ev.matchId, [item])
  }
  for (const [matchId, list] of grouped) out.set(matchId, bestBreakForEvents(list))
  return out
}

export async function getUserStats(userId: string): Promise<UserStats> {
  const playerRows = await prisma.matchPlayer.findMany({
    where: {
      userId,
      match: {
        matchType: { not: 'PRACTICE' },
        status: { in: [...COMPLETED_STATUSES] }
      }
    },
    select: { matchId: true, seat: true, result: true }
  })
  let wins = 0
  for (const row of playerRows) if (row.result === 'WIN') wins++
  const matches = playerRows.length
  let highestBreak = 0
  const breaks = await bestBreakByMatch(playerRows.map((r) => r.matchId))
  for (const row of playerRows) {
    highestBreak = Math.max(highestBreak, breaks.get(row.matchId)?.[row.seat] ?? 0)
  }
  return {
    matches,
    wins,
    losses: matches - wins,
    winRate: matches ? Math.round((wins / matches) * 1000) / 10 : 0,
    highestBreak
  }
}

function periodGte(period: LeaderboardPeriod): Date | null {
  if (period === 'all') return null
  const days = period === 'week' ? 7 : 30
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

export async function getLeaderboard(period: LeaderboardPeriod, meId: string): Promise<{ rows: LeaderboardRow[]; me: LeaderboardRow | null }> {
  const gte = periodGte(period)
  const matchWhere = {
    matchType: { not: 'PRACTICE' },
    status: { in: [...COMPLETED_STATUSES] },
    finishedAt: gte ? { gte } : undefined
  }
  const playerRows = await prisma.matchPlayer.findMany({
    where: { match: matchWhere },
    select: { userId: true, result: true }
  })
  const totals = new Map<string, { played: number; wins: number }>()
  for (const row of playerRows) {
    const t = totals.get(row.userId) ?? { played: 0, wins: 0 }
    t.played++
    if (row.result === 'WIN') t.wins++
    totals.set(row.userId, t)
  }
  const entries = [...totals.entries()].map(([userId, t]) => ({
    userId,
    matches: t.played,
    wins: t.wins,
    losses: t.played - t.wins,
    winRate: Math.round((t.wins / t.played) * 1000) / 10
  }))
  entries.sort((a, b) => b.wins - a.wins || b.winRate - a.winRate || b.matches - a.matches)

  const top = entries.slice(0, 20)
  const ids = [...new Set([...top.map((e) => e.userId), meId])]
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, username: true } })
  const username = new Map(users.map((u) => [u.id, u.username]))

  const userMatchRows = await prisma.matchPlayer.findMany({
    where: { userId: { in: ids }, match: matchWhere },
    select: { userId: true, matchId: true, seat: true }
  })
  const breaks = await bestBreakByMatch([...new Set(userMatchRows.map((r) => r.matchId))])
  const bestBreak = new Map<string, number>()
  for (const r of userMatchRows) {
    bestBreak.set(r.userId, Math.max(bestBreak.get(r.userId) ?? 0, breaks.get(r.matchId)?.[r.seat] ?? 0))
  }

  const rows: LeaderboardRow[] = top.map((e, i) => ({
    rank: i + 1,
    userId: e.userId,
    username: username.get(e.userId) ?? '?',
    matches: e.matches,
    wins: e.wins,
    losses: e.losses,
    winRate: e.winRate,
    highestBreak: bestBreak.get(e.userId) ?? 0
  }))

  const myEntryIndex = entries.findIndex((e) => e.userId === meId)
  const me: LeaderboardRow | null =
    myEntryIndex >= 0
      ? {
          rank: myEntryIndex + 1,
          userId: entries[myEntryIndex]!.userId,
          username: username.get(meId) ?? '?',
          matches: entries[myEntryIndex]!.matches,
          wins: entries[myEntryIndex]!.wins,
          losses: entries[myEntryIndex]!.losses,
          winRate: entries[myEntryIndex]!.winRate,
          highestBreak: bestBreak.get(meId) ?? 0
        }
      : null

  return { rows, me }
}