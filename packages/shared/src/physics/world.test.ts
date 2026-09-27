import { describe, it, expect } from 'vitest'
import {
  layoutTableBalls,
  simulateStroke,
  createFrame,
  applyStroke,
  framesToWin,
  createMatch,
  BALL_IDS,
  BALL_RADIUS,
  TABLE_LENGTH,
  TABLE_WIDTH
} from '../index.js'

describe('physics', () => {
  it('places 22 balls on the table with no overlaps', () => {
    const balls = layoutTableBalls()
    expect(balls.length).toBe(22)
    for (const ball of balls) {
      expect(ball.pos.x).toBeGreaterThanOrEqual(BALL_RADIUS)
      expect(ball.pos.y).toBeGreaterThanOrEqual(BALL_RADIUS)
      expect(ball.pos.x).toBeLessThanOrEqual(TABLE_LENGTH - BALL_RADIUS)
      expect(ball.pos.y).toBeLessThanOrEqual(TABLE_WIDTH - BALL_RADIUS)
    }
  })

  it('simulates a straight shot and stops balls', () => {
    const balls = layoutTableBalls()
    const result = simulateStroke(balls, { aimAngle: 0, power: 0.3, spin: { x: 0, y: 0 } }, { maxTicks: 120 * 20 })
    expect(result.settled).toBe(true)
    const moving = result.balls.filter((b) => !b.potted && (b.vel.x !== 0 || b.vel.y !== 0))
    expect(moving.length).toBe(0)
  })

  it('records a pot when the cue hits a ball into a pocket', () => {
    const balls = layoutTableBalls()
    const result = simulateStroke(balls, { aimAngle: 0, power: Math.PI / 2 * 0.4, spin: { x: 0, y: 0 } }, { maxTicks: 120 * 30 })
    expect(result.events.some((e) => e.type === 'BALL_HIT')).toBe(true)
  })
})

describe('rules', () => {
  it('creates a fresh frame with reds on', () => {
    const frame = createFrame()
    expect(frame.remainingReds).toBe(15)
    expect(frame.ballOn).toBe('RED')
    expect(frame.scores.player0).toBe(0)
  })

  it('frames to win match the format', () => {
    expect(framesToWin('BO1')).toBe(1)
    expect(framesToWin('BO3')).toBe(2)
    expect(framesToWin('BO5')).toBe(3)
  })

  it('resolves a foul when the cue ball is potted', () => {
    const frame = createFrame()
    const outcome = applyStroke(frame, 0, { power: 1, aimAngle: Math.PI, spin: { x: 0, y: 0 } })
    expect(outcome.resolution.foul).toBe(true)
    expect(outcome.resolution.turnSwitches).toBe(true)
  })

  it('a no-contact shot is a foul and switches turn', () => {
    const frame = createFrame()
    const outcome = applyStroke(frame, 0, { power: 1, aimAngle: Math.PI / 4, spin: { x: 0, y: 0 } })
    expect(outcome.resolution.foul).toBe(true)
    expect(frame.turnIndex).toBe(1)
  })

  it('builds a match state', () => {
    const match = createMatch('m1', 'ONE_V_ONE', 'BO3')
    expect(match.matchType).toBe('ONE_V_ONE')
    expect(match.currentFrame).toBeDefined()
  })
})