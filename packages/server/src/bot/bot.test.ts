import { createFrame, applyStroke } from '@snooker/shared'
import type { PracticeAiLevel } from '@snooker/shared'
import { describe, expect, it } from 'vitest'
import { computeBotShot } from './bot.js'

const LEVELS: PracticeAiLevel[] = ['EASY', 'MEDIUM', 'HARD']
const SEEDS = 2
const MAX_STROKES = 140
const D_CENTER = { x: 737, y: 889 }
const D_RADIUS = 292

interface Stats {
  strokes: number
  fouls: number
  pots: number
  clearedReds: boolean
  finishedFrame: boolean
}

function aggregate(level: PracticeAiLevel): Stats {
  const stats: Stats = { strokes: 0, fouls: 0, pots: 0, clearedReds: false, finishedFrame: false }
  for (let s = 0; s < SEEDS; s++) {
    const frame = createFrame(0)
    let strokes = 0
    let fouls = 0
    let pots = 0
    while (strokes < MAX_STROKES && frame.phase !== 'FRAME_END') {
      const bot = computeBotShot(frame, level, `seed-${s}`)
      const outcome = applyStroke(frame, frame.turnIndex, bot.shot)
      strokes++
      if (outcome.resolution.foul) fouls++
      else if (outcome.resolution.points > 0) pots++
    }
    stats.strokes += strokes
    stats.fouls += fouls
    stats.pots += pots
    stats.clearedReds = stats.clearedReds || frame.remainingReds === 0
    stats.finishedFrame = stats.finishedFrame || frame.phase === 'FRAME_END'
  }
  return stats
}

describe('bot skill levels', () => {
  it(
    'both skilled levels pot more than EASY, clear the reds and finish the frame',
    {
      timeout: 300_000
    },
    () => {
      const rates: Record<PracticeAiLevel, number> = { EASY: 0, MEDIUM: 0, HARD: 0 }
      const stats: Record<PracticeAiLevel, Stats> = { EASY: { strokes: 0, fouls: 0, pots: 0, clearedReds: false, finishedFrame: false }, MEDIUM: { strokes: 0, fouls: 0, pots: 0, clearedReds: false, finishedFrame: false }, HARD: { strokes: 0, fouls: 0, pots: 0, clearedReds: false, finishedFrame: false } }
      for (const level of LEVELS) {
        stats[level] = aggregate(level)
        rates[level] = stats[level].strokes > 0 ? stats[level].pots / stats[level].strokes : 0
      }
      expect(rates.MEDIUM).toBeGreaterThan(rates.EASY)
      expect(rates.HARD).toBeGreaterThan(rates.EASY)
      expect(stats.MEDIUM.clearedReds).toBe(true)
      expect(stats.HARD.clearedReds).toBe(true)
      expect(stats.MEDIUM.finishedFrame).toBe(true)
      expect(stats.HARD.finishedFrame).toBe(true)
    }
  )

  it('produces identical shots for identical frames and seeds', () => {
    for (const level of LEVELS) {
      const frame = createFrame(0)
      const first = computeBotShot(frame, level, 'determinism-seed')
      const frameCopy = createFrame(0)
      const second = computeBotShot(frameCopy, level, 'determinism-seed')
      expect(second.shot.aimAngle).toBe(first.shot.aimAngle)
      expect(second.shot.power).toBe(first.shot.power)
    }
  })

  it('ball-in-hand opening break places the cue inside the D and makes contact', () => {
    const frame = createFrame(0)
    expect(frame.cueInHand).toBe(true)
    const bot = computeBotShot(frame, 'MEDIUM', 'in-hand')
    expect(bot.shot.cuePos).toBeDefined()
    const x = bot.shot.cuePos!.x
    const y = bot.shot.cuePos!.y
    const dx = x - D_CENTER.x
    const dy = y - D_CENTER.y
    expect(x).toBeLessThanOrEqual(D_CENTER.x)
    expect(dx * dx + dy * dy).toBeLessThanOrEqual(D_RADIUS * D_RADIUS)
    const outcome = applyStroke(frame, frame.turnIndex, bot.shot)
    expect(outcome.sim.firstContactId).not.toBeNull()
  })
}, { timeout: 300_000 })