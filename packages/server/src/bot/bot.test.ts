import { createFrame, applyStroke } from '@snooker/shared'
import type { FrameState, PracticeAiLevel } from '@snooker/shared'
import { describe, expect, it } from 'vitest'
import { computeBotShot } from './bot.js'

const LEVELS: PracticeAiLevel[] = ['EASY', 'MEDIUM', 'HARD']
const D_CENTER = { x: 737, y: 889 }
const D_RADIUS = 292

interface Stats {
  strokes: number
  fouls: number
  wrongBallFirst: number
  missedEverything: number
  pots: number
  framesFinished: number
}

function legalIds(frame: FrameState): number[] {
  const on = frame.ballOn
  if (on === 'RED') return frame.balls.filter((b) => b.isRed && !b.potted).map((b) => b.id)
  if (on === 'ANY_COLOUR') return [...frame.colorsRemaining]
  return [on.colour]
}

/** The robot plays both sides of whole frames; every stroke is judged by the real rules. */
function play(level: PracticeAiLevel, reds: number, frames: number, maxStrokes: number): Stats {
  const stats: Stats = { strokes: 0, fouls: 0, wrongBallFirst: 0, missedEverything: 0, pots: 0, framesFinished: 0 }
  for (let f = 0; f < frames; f++) {
    const frame = createFrame(0, reds)
    let strokes = 0
    while (strokes < maxStrokes && frame.phase !== 'FRAME_END') {
      const legal = legalIds(frame)
      const bot = computeBotShot(frame, level, `frame-${f}`)
      const outcome = applyStroke(frame, frame.turnIndex, bot.shot)
      strokes++
      if (outcome.resolution.foul) {
        stats.fouls++
        if (outcome.sim.firstContactId === null) stats.missedEverything++
        else if (!legal.includes(outcome.sim.firstContactId)) stats.wrongBallFirst++
      } else if (outcome.resolution.points > 0) {
        stats.pots++
      }
    }
    stats.strokes += strokes
    if (frame.phase === 'FRAME_END') stats.framesFinished++
  }
  return stats
}

describe('bot play', () => {
  it('HARD never fouls and clears 6-red and 10-red frames', { timeout: 300_000 }, () => {
    for (const reds of [6, 10]) {
      const s = play('HARD', reds, 2, 150)
      expect(s.fouls).toBe(0)
      expect(s.framesFinished).toBe(2)
      // Everything but the break-off goes in.
      expect(s.pots / s.strokes).toBeGreaterThan(0.85)
    }
  })

  it('MEDIUM never hits a colour first while a red is on, or misses everything', { timeout: 300_000 }, () => {
    const s = play('MEDIUM', 6, 2, 150)
    expect(s.wrongBallFirst).toBe(0)
    expect(s.missedEverything).toBe(0)
    expect(s.fouls).toBe(0)
  })

  it('EASY makes no wrong-ball or no-contact fouls either, and pots less than the others', { timeout: 300_000 }, () => {
    const easy = play('EASY', 6, 2, 120)
    const medium = play('MEDIUM', 6, 2, 120)
    const hard = play('HARD', 6, 2, 120)
    expect(easy.wrongBallFirst).toBe(0)
    expect(easy.missedEverything).toBe(0)
    const rate = (s: Stats) => s.pots / s.strokes
    expect(rate(medium)).toBeGreaterThan(rate(easy))
    expect(rate(hard)).toBeGreaterThan(rate(medium))
  })

  it('produces identical shots for identical frames and seeds', () => {
    for (const level of LEVELS) {
      const first = computeBotShot(createFrame(0, 6), level, 'determinism-seed')
      const second = computeBotShot(createFrame(0, 6), level, 'determinism-seed')
      expect(second.shot).toEqual(first.shot)
    }
  })

  it('ball-in-hand opening break places the cue inside the D and makes a legal contact', () => {
    for (const reds of [6, 10, 15]) {
      const frame = createFrame(0, reds)
      expect(frame.cueInHand).toBe(true)
      const bot = computeBotShot(frame, 'MEDIUM', 'in-hand')
      expect(bot.shot.cuePos).toBeDefined()
      const { x, y } = bot.shot.cuePos!
      const dx = x - D_CENTER.x
      const dy = y - D_CENTER.y
      expect(x).toBeLessThanOrEqual(D_CENTER.x)
      expect(dx * dx + dy * dy).toBeLessThanOrEqual(D_RADIUS * D_RADIUS)
      const outcome = applyStroke(frame, frame.turnIndex, bot.shot)
      expect(outcome.resolution.foul).toBe(false)
    }
  })

  it('escapes a snooker instead of missing everything', () => {
    // Red on, the cue ball tucked behind the brown on the baulk line with the green and
    // yellow beside it: no straight line to any red. The robot has to find a way out.
    const frame = createFrame(0, 6)
    frame.cueInHand = false
    frame.cueInHandInD = false
    const cue = frame.balls.find((b) => b.isCue)!
    const brown = frame.balls.find((b) => b.colorName === 'brown')!
    cue.pos = { x: brown.pos.x - 110, y: brown.pos.y }
    for (const level of LEVELS) {
      const copy = structuredClone(frame)
      const bot = computeBotShot(copy, level, 'snookered')
      const outcome = applyStroke(copy, copy.turnIndex, bot.shot)
      expect(outcome.sim.firstContactId).not.toBeNull()
      expect(copy.balls.find((b) => b.id === outcome.sim.firstContactId)!.isRed).toBe(true)
    }
  })
})
