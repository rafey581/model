import { describe, expect, it } from 'vitest'
import { BALL_RADIUS, BALL_RESTITUTION, MAX_CUE_SPEED } from '../constants.js'
import type { BallState } from '../state.js'
import { vec } from '../vec.js'
import { layoutTableBalls } from './layout.js'
import { simulateStroke } from './world.js'

function ball(id: number, x: number, y: number, cue = false): BallState {
  return {
    id,
    value: cue ? 0 : 1,
    isCue: cue,
    isRed: !cue,
    isColor: false,
    pos: vec(x, y),
    vel: vec(0, 0),
    spin: vec(0, 0),
    angularVel: 0,
    potted: false
  }
}

function speed(b: BallState): number {
  return Math.hypot(b.vel.x, b.vel.y)
}

/** Sum of speed-squared. Mass is the same for every ball, so this is the kinetic energy. */
function kinetic(balls: BallState[]): number {
  return balls.reduce((sum, b) => (b.potted ? sum : sum + speed(b) ** 2), 0)
}

describe('ball-ball momentum and energy', () => {
  const launch = 0.25 * MAX_CUE_SPEED

  it('splits a head-on hit between two equal balls without adding energy', () => {
    const cue = ball(0, 1000, 900, true)
    const object = ball(1, 1000 + BALL_RADIUS * 2 + 0.5, 900)
    const result = simulateStroke([cue, object], { aimAngle: 0, power: 0.25, spin: { x: 0, y: 0 } }, { maxTicks: 2, untilFirstContact: true })
    const cueAfter = result.balls.find((b) => b.id === 0)!
    const objectAfter = result.balls.find((b) => b.id === 1)!
    const cueSpeed = speed(cueAfter)
    const objectSpeed = speed(objectAfter)
    // Equal masses, restitution 0.96: the object leaves with almost the whole pace
    // and the cue ball keeps a sliver. Friction in the same ticks trims both a little.
    expect(objectSpeed).toBeGreaterThan(cueSpeed * 10)
    expect(objectSpeed).toBeGreaterThan(((1 + BALL_RESTITUTION) * launch) / 2 - 80)
    expect(objectSpeed).toBeLessThan(((1 + BALL_RESTITUTION) * launch) / 2 + 20)
    expect(cueSpeed + objectSpeed).toBeLessThan(launch * 1.02)
    expect(cueSpeed + objectSpeed).toBeGreaterThan(launch * 0.9)
    expect(kinetic(result.balls)).toBeLessThan(launch * launch)
    expect(result.firstContactId).toBe(1)
  })

  it('gives a thin cut less of the cue ball than a full hit', () => {
    const full = simulateStroke(
      [ball(0, 800, 900, true), ball(1, 800 + 400, 900)],
      { aimAngle: 0, power: 0.4, spin: { x: 0, y: 0 } },
      { maxTicks: 30, untilFirstContact: true }
    )
    const thin = simulateStroke(
      [ball(0, 800, 900, true), ball(1, 800 + 400, 900 + BALL_RADIUS * 1.7)],
      { aimAngle: 0, power: 0.4, spin: { x: 0, y: 0 } },
      { maxTicks: 40, untilFirstContact: true }
    )
    const fullObject = speed(full.balls.find((b) => b.id === 1)!)
    const thinObject = speed(thin.balls.find((b) => b.id === 1)!)
    const thinCue = speed(thin.balls.find((b) => b.id === 0)!)
    expect(thin.firstContactId).toBe(1)
    expect(thinObject).toBeLessThan(fullObject * 0.55)
    expect(thinObject).toBeLessThan(thinCue)
    expect(kinetic(thin.balls)).toBeLessThan((0.4 * MAX_CUE_SPEED) ** 2)
  })
})

describe('cloth, cushions, spin and power', () => {
  it('slows a stun ball on every tick until a cushion is in play', () => {
    let previous = Infinity
    for (let ticks = 1; ticks <= 25; ticks++) {
      const result = simulateStroke([ball(0, 400, 889, true)], { aimAngle: 0, power: 0.12, spin: { x: 0, y: 0 } }, { maxTicks: ticks })
      const cue = result.balls[0]!
      const now = speed(cue)
      expect(cue.pos.x).toBeGreaterThan(400)
      expect(cue.pos.x).toBeLessThan(2500)
      expect(now).toBeLessThanOrEqual(previous + 1e-6)
      previous = now
    }
    expect(previous).toBeLessThan(0.12 * MAX_CUE_SPEED)
  })

  it('lets top spin run further than stun, and pulls a screwed cue ball back after a full hit', () => {
    const open = (spinY: number) =>
      simulateStroke([ball(0, 400, 889, true)], { aimAngle: 0, power: 0.2, spin: { x: 0, y: spinY } }, { maxTicks: 30 })
    const stun = open(0).balls[0]!
    const top = open(1).balls[0]!
    expect(top.pos.x).toBeGreaterThan(stun.pos.x + 40)
    expect(top.pos.x).toBeLessThan(3200)

    const hit = (spinY: number) =>
      simulateStroke(
        [ball(0, 1200, 889, true), ball(1, 1200 + BALL_RADIUS * 2 + 2, 889)],
        { aimAngle: 0, power: 0.45, spin: { x: 0, y: spinY } },
        { maxTicks: 40 }
      ).balls[0]!
    expect(hit(0).vel.x).toBeGreaterThanOrEqual(-5)
    expect(hit(-1).vel.x).toBeLessThan(-200)
    expect(hit(1).vel.x).toBeGreaterThan(200)
  })

  it('returns a ball from a cushion slower than it arrived', () => {
    let approach = 0
    let leave = 0
    for (let ticks = 1; ticks <= 40; ticks++) {
      const cue = simulateStroke([ball(0, 1200, 400, true)], { aimAngle: -Math.PI / 2, power: 0.5, spin: { x: 0, y: 0 } }, { maxTicks: ticks }).balls[0]!
      if (cue.vel.y < -200) approach = Math.max(approach, -cue.vel.y)
      if (approach > 0 && cue.vel.y > 50 && leave === 0) leave = cue.vel.y
    }
    expect(approach).toBeGreaterThan(1000)
    expect(leave).toBeGreaterThan(0)
    expect(leave).toBeLessThan(approach)
    expect(leave / approach).toBeLessThan(1)
  })

  it('sends a harder level further while the ball is still on open cloth', () => {
    const at = (power: number) =>
      simulateStroke([ball(0, 400, 889, true)], { aimAngle: 0, power, spin: { x: 0, y: 0 } }, { maxTicks: 8 }).balls[0]!.pos.x
    const soft = at(0.15)
    const mid = at(0.35)
    const firm = at(0.55)
    expect(mid).toBeGreaterThan(soft)
    expect(firm).toBeGreaterThan(mid)
  })
})

describe('the stroke is the same stroke every time', () => {
  const shot = { aimAngle: 0.02, power: 0.55, spin: { x: 0.4, y: -0.6 } }

  function signature(rate?: number): string {
    const result = simulateStroke(layoutTableBalls(6), shot, rate ? { playback: { rate } } : {})
    return result.balls.map((b) => `${b.id}:${b.potted ? 'p' : `${b.pos.x.toFixed(3)},${b.pos.y.toFixed(3)}`}`).join('|')
  }

  it('repeats, and a playback sample rate does not move the balls', () => {
    const once = signature()
    expect(signature()).toBe(once)
    expect(signature(15)).toBe(once)
    expect(signature(60)).toBe(once)
  })

  it('still meets a ball that a full-power cue ball reaches in one tick of travel', () => {
    const result = simulateStroke(
      [ball(0, 500, 889, true), ball(1, 500 + 2000, 889)],
      { aimAngle: 0, power: 1, spin: { x: 0, y: 0 } }
    )
    const object = result.balls.find((b) => b.id === 1)!
    expect(result.firstContactId).toBe(1)
    expect(Math.hypot(object.pos.x - (500 + 2000), object.pos.y - 889)).toBeGreaterThan(100)
  })
})
