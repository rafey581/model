import {
  BADGES,
  XP_TOURNAMENT_CHAMPION,
  badgesEarned,
  levelForTotalXp,
  rankForLevel,
  summarizeProgress,
  xpForMatch,
  type BadgeDef,
  type RankDef
} from '@snooker/shared'
import { prisma } from '../db/index.js'
import { notify } from '../notifications/service.js'
import type { Tx } from '../wallet/service.js'

/**
 * Player progression on the server.
 *
 * XP, level, win streak and badges are written inside the same transaction that
 * settles the match, so a match that settles once awards exactly once, and a match
 * whose settlement rolls back awards nothing. The rules themselves (how much XP,
 * which level, which rank, which badge) live in @snooker/shared/progression.
 */

export interface ProgressOutcome {
  userId: string
  xpGained: number
  levelBefore: number
  levelAfter: number
  rankBefore: RankDef
  rankAfter: RankDef
  newBadges: BadgeDef[]
}

export interface MatchProgressInput {
  userId: string
  won: boolean
  practice: boolean
  reason?: string
  /** Robot level for a practice match. */
  aiLevel?: string | null
}

const BADGE_BY_CODE = new Map(BADGES.map((b) => [b.code, b]))

/** Awards one settled match. Call inside the settlement transaction, after the result rows are written. */
export async function applyMatchProgress(tx: Tx, input: MatchProgressInput): Promise<ProgressOutcome | null> {
  const xp = xpForMatch({ won: input.won, practice: input.practice, reason: input.reason })
  return applyProgress(tx, input.userId, {
    xp,
    streak: input.practice ? 'keep' : input.won ? 'extend' : 'reset',
    beatAiLevel: input.practice && input.won ? (input.aiLevel ?? undefined) : undefined
  })
}

/** The tournament bonus. Call after the tournament row names this player champion. */
export async function applyTournamentChampion(userId: string): Promise<ProgressOutcome | null> {
  return prisma.$transaction((tx) => applyProgress(tx, userId, { xp: XP_TOURNAMENT_CHAMPION, streak: 'keep' }))
}

async function applyProgress(
  tx: Tx,
  userId: string,
  change: { xp: number; streak: 'extend' | 'reset' | 'keep'; beatAiLevel?: string }
): Promise<ProgressOutcome | null> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { role: true, xp: true, level: true, winStreak: true, bestWinStreak: true }
  })
  // The robot and the platform account are seated in matches too; they do not level.
  if (!user || user.role !== 'PLAYER') return null

  const totalXp = user.xp + change.xp
  const levelBefore = levelForTotalXp(user.xp)
  const levelAfter = levelForTotalXp(totalXp)
  const winStreak = change.streak === 'extend' ? user.winStreak + 1 : change.streak === 'reset' ? 0 : user.winStreak
  const bestWinStreak = Math.max(user.bestWinStreak, winStreak)

  await tx.user.update({
    where: { id: userId },
    data: { xp: totalXp, level: levelAfter, winStreak, bestWinStreak }
  })

  const onlineMatch = { matchType: { not: 'PRACTICE' } }
  const [onlineWins, onlineMatches, tournamentTitles, owned] = await Promise.all([
    tx.matchPlayer.count({ where: { userId, result: 'WIN', match: onlineMatch } }),
    tx.matchPlayer.count({ where: { userId, result: { in: ['WIN', 'LOSS'] }, match: onlineMatch } }),
    tx.tournament.count({ where: { championId: userId } }),
    tx.userBadge.findMany({ where: { userId }, select: { badge: { select: { code: true } } } })
  ])
  const have = new Set(owned.map((o) => o.badge.code))
  const fresh = badgesEarned({ onlineWins, onlineMatches, winStreak, level: levelAfter, tournamentTitles, beatAiLevel: change.beatAiLevel })
    .filter((code) => !have.has(code))
    .map((code) => BADGE_BY_CODE.get(code)!)

  for (const def of fresh) {
    const badge = await tx.badge.upsert({
      where: { code: def.code },
      create: { code: def.code, name: def.name, description: def.description, icon: def.icon, rarity: def.rarity },
      update: { name: def.name, description: def.description, icon: def.icon, rarity: def.rarity }
    })
    await tx.userBadge.create({ data: { userId, badgeId: badge.id } })
  }

  return {
    userId,
    xpGained: change.xp,
    levelBefore,
    levelAfter,
    rankBefore: rankForLevel(levelBefore),
    rankAfter: rankForLevel(levelAfter),
    newBadges: fresh
  }
}

/** Tells the player about a level, a rank or a badge. Call after the transaction commits. */
export function notifyProgress(outcome: ProgressOutcome | null): void {
  if (!outcome) return
  if (outcome.levelAfter > outcome.levelBefore) {
    void notify(outcome.userId, 'LEVEL_UP', `Level up! You reached level ${outcome.levelAfter}`, `+${outcome.xpGained} XP`)
  }
  if (outcome.rankAfter.id !== outcome.rankBefore.id) {
    void notify(outcome.userId, 'RANK_UP', `New rank: ${outcome.rankAfter.name}`, `You climbed from ${outcome.rankBefore.name} to ${outcome.rankAfter.name}.`)
  }
  for (const badge of outcome.newBadges) {
    void notify(outcome.userId, 'BADGE_EARNED', `Badge unlocked: ${badge.name}`, badge.description)
  }
}

export interface UserProgress {
  level: number
  totalXp: number
  levelXp: number
  levelXpNeeded: number
  percent: number
  rank: RankDef
  nextRank: RankDef | null
  winStreak: number
  bestWinStreak: number
  /** The whole catalogue, each with when this player earned it (null if not yet). */
  badges: Array<BadgeDef & { earnedAt: string | null }>
}

export async function getUserProgress(userId: string): Promise<UserProgress | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      xp: true,
      winStreak: true,
      bestWinStreak: true,
      badges: { select: { earnedAt: true, badge: { select: { code: true } } } }
    }
  })
  if (!user) return null
  const earned = new Map(user.badges.map((b) => [b.badge.code, b.earnedAt.toISOString()]))
  return {
    ...summarizeProgress(user.xp),
    winStreak: user.winStreak,
    bestWinStreak: user.bestWinStreak,
    badges: BADGES.map((def) => ({ ...def, earnedAt: earned.get(def.code) ?? null }))
  }
}
