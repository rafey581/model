import { describe, expect, it } from 'vitest'
import {
  BADGES,
  MAX_LEVEL,
  RANKS,
  badgesEarned,
  levelForTotalXp,
  rankForLevel,
  summarizeProgress,
  totalXpForLevel,
  xpForMatch,
  xpToNextLevel,
  type BadgeStats
} from './progression.js'

const noStats: BadgeStats = { onlineWins: 0, onlineMatches: 0, winStreak: 0, level: 1, tournamentTitles: 0 }

describe('levels', () => {
  it('starts at level 1 with no XP', () => {
    expect(levelForTotalXp(0)).toBe(1)
    expect(levelForTotalXp(-50)).toBe(1)
  })

  it('needs 100 XP for level 2, then 25 more per level', () => {
    expect(xpToNextLevel(1)).toBe(100)
    expect(xpToNextLevel(2)).toBe(125)
    expect(levelForTotalXp(99)).toBe(1)
    expect(levelForTotalXp(100)).toBe(2)
    expect(levelForTotalXp(224)).toBe(2)
    expect(levelForTotalXp(225)).toBe(3)
  })

  it('totalXpForLevel is the running sum of xpToNextLevel', () => {
    let sum = 0
    for (let level = 1; level < MAX_LEVEL; level++) {
      expect(totalXpForLevel(level)).toBe(sum)
      expect(levelForTotalXp(sum)).toBe(level)
      sum += xpToNextLevel(level)
    }
  })

  it('caps at MAX_LEVEL', () => {
    expect(levelForTotalXp(10_000_000)).toBe(MAX_LEVEL)
    const s = summarizeProgress(10_000_000)
    expect(s.percent).toBe(100)
    expect(s.levelXpNeeded).toBe(0)
  })

  it('summarizes progress inside a level', () => {
    const s = summarizeProgress(150)
    expect(s.level).toBe(2)
    expect(s.levelXp).toBe(50)
    expect(s.levelXpNeeded).toBe(125)
    expect(s.percent).toBe(40)
    expect(s.rank.id).toBe('BRONZE')
    expect(s.nextRank?.id).toBe('SILVER')
  })
})

describe('match XP', () => {
  it('pays more for a win than a loss, and less for practice', () => {
    expect(xpForMatch({ won: true, practice: false })).toBeGreaterThan(xpForMatch({ won: false, practice: false }))
    expect(xpForMatch({ won: true, practice: true })).toBeLessThan(xpForMatch({ won: true, practice: false }))
  })

  it('gives nothing to a player who abandoned', () => {
    expect(xpForMatch({ won: false, practice: false, reason: 'abandon' })).toBe(0)
    expect(xpForMatch({ won: true, practice: false, reason: 'abandon' })).toBeGreaterThan(0)
  })
})

describe('ranks', () => {
  it('maps level boundaries to ranks', () => {
    expect(rankForLevel(1).id).toBe('BRONZE')
    expect(rankForLevel(4).id).toBe('BRONZE')
    expect(rankForLevel(5).id).toBe('SILVER')
    expect(rankForLevel(10).id).toBe('GOLD')
    expect(rankForLevel(39).id).toBe('MASTER')
    expect(rankForLevel(40).id).toBe('GRANDMASTER')
    expect(rankForLevel(MAX_LEVEL).id).toBe('GRANDMASTER')
  })

  it('has ascending minimum levels', () => {
    for (let i = 1; i < RANKS.length; i++) expect(RANKS[i]!.minLevel).toBeGreaterThan(RANKS[i - 1]!.minLevel)
  })
})

describe('badges', () => {
  it('has unique codes', () => {
    expect(new Set(BADGES.map((b) => b.code)).size).toBe(BADGES.length)
  })

  it('earns nothing with no record', () => {
    expect(badgesEarned(noStats)).toEqual([])
  })

  it('earns win, streak, level, AI and title badges from stats', () => {
    expect(badgesEarned({ ...noStats, onlineWins: 1, winStreak: 1 })).toEqual(['FIRST_WIN'])
    const many = badgesEarned({ onlineWins: 12, onlineMatches: 30, winStreak: 5, level: 10, tournamentTitles: 1, beatAiLevel: 'HARD' })
    expect(many).toEqual(
      expect.arrayContaining(['FIRST_WIN', 'WINS_10', 'MATCHES_25', 'STREAK_3', 'STREAK_5', 'LEVEL_10', 'AI_HARD', 'TOURNAMENT_CHAMPION'])
    )
    expect(many).not.toContain('WINS_50')
    expect(many).not.toContain('STREAK_10')
  })

  it('does not award the robot badge for beating an easier robot', () => {
    expect(badgesEarned({ ...noStats, beatAiLevel: 'MEDIUM' })).toEqual([])
  })
})
