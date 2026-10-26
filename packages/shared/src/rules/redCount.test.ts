import { describe, expect, it } from 'vitest'
import { BALL_DIAMETER, BALL_IDS, TOTAL_REDS, redsForStake, normalizeRedCount } from '../constants.js'
import { createFrame, createMatch, frameFromSnapshot, frameSnapshot, newFrameForMatch } from './frame.js'
import { isRedId } from './snooker.js'

const redsOf = (frame: ReturnType<typeof createFrame>) => frame.balls.filter((b) => isRedId(b.id))

describe('reds by stake', () => {
  it('racks 6 reds below 100 USDT and 10 from 100 up', () => {
    for (const stake of [0, 1, 5, 10, 20, 50, 99.99]) expect(redsForStake(stake)).toBe(6)
    for (const stake of [100, 500, 1000, 2000, 3000, 5000]) expect(redsForStake(stake)).toBe(10)
  })

  it('treats a missing or broken stake as no stake', () => {
    expect(redsForStake(null)).toBe(6)
    expect(redsForStake(undefined)).toBe(6)
    expect(redsForStake(Number.NaN)).toBe(6)
  })

  it('only racks a count the engine knows', () => {
    expect(normalizeRedCount(6)).toBe(6)
    expect(normalizeRedCount(0)).toBe(TOTAL_REDS)
    expect(normalizeRedCount(99)).toBe(TOTAL_REDS)
  })
})

describe('racking a frame', () => {
  it('a 6-red frame has reds 1..6, all six colours and the cue, in a 3-row triangle', () => {
    const frame = createFrame(0, 6)
    const reds = redsOf(frame)
    expect(reds.map((b) => b.id)).toEqual([1, 2, 3, 4, 5, 6])
    expect(frame.balls).toHaveLength(1 + 6 + 6)
    expect(frame.remainingReds).toBe(6)
    expect(frame.totalReds).toBe(6)
    const rows = new Set(reds.map((b) => Math.round(b.pos.x)))
    expect(rows.size).toBe(3)
  })

  it('a 10-red frame is a 4-row triangle', () => {
    const frame = createFrame(0, 10)
    const reds = redsOf(frame)
    expect(reds).toHaveLength(10)
    expect(frame.remainingReds).toBe(10)
    const xs = [...new Set(reds.map((b) => Math.round(b.pos.x)))].sort((a, b) => a - b)
    expect(xs).toHaveLength(4)
    // Each row holds one more ball than the row before it: 1, 2, 3, 4.
    expect(xs.map((x) => reds.filter((b) => Math.round(b.pos.x) === x).length)).toEqual([1, 2, 3, 4])
  })

  it('no two balls overlap in either rack', () => {
    for (const n of [6, 10]) {
      const balls = createFrame(0, n).balls
      for (let i = 0; i < balls.length; i++) {
        for (let j = i + 1; j < balls.length; j++) {
          const d = Math.hypot(balls[i]!.pos.x - balls[j]!.pos.x, balls[i]!.pos.y - balls[j]!.pos.y)
          expect(d).toBeGreaterThanOrEqual(BALL_DIAMETER - 1e-6)
        }
      }
    }
  })

  it('the engine default is still the full 15 reds', () => {
    expect(redsOf(createFrame(0))).toHaveLength(TOTAL_REDS)
    expect(createFrame(0).balls.find((b) => b.id === BALL_IDS.RED_MAX)).toBeDefined()
  })
})

describe('a match keeps its red count', () => {
  it('every frame of a match is racked the same way', () => {
    const match = createMatch('m1', 'ONE_V_ONE', 'BO3', 10)
    expect(match.reds).toBe(10)
    expect(redsOf(match.currentFrame!)).toHaveLength(10)
    const next = newFrameForMatch(match, 1)
    expect(redsOf(next)).toHaveLength(10)
    expect(next.remainingReds).toBe(10)
  })
})

describe('snapshots', () => {
  it('round-trip the red count and the balls', () => {
    const frame = createFrame(0, 6)
    const snap = frameSnapshot(frame)
    expect(snap.totalReds).toBe(6)
    expect(snap.balls.filter((b) => isRedId(b.id))).toHaveLength(6)
    const back = frameFromSnapshot(snap)
    expect(back.totalReds).toBe(6)
    expect(redsOf(back)).toHaveLength(6)
  })

  it('an older snapshot without a count reads the count from its balls', () => {
    const snap = frameSnapshot(createFrame(0))
    delete snap.totalReds
    expect(frameFromSnapshot(snap).totalReds).toBe(TOTAL_REDS)
  })
})
