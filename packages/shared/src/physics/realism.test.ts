import { describe, expect, it } from 'vitest'
import {
  BALL_RADIUS,
  MAX_CUE_SPEED,
  ROLL_FRICTION,
  SLIDE_FRICTION,
  TABLE_LENGTH,
  TABLE_WIDTH,
  TICK_DT,
  buildInitialBalls,
  pocketPositions,
  simulateStroke
} from '../index.js'
import type { BallState } from '../state.js'
import { vec } from '../vec.js'

const MID = TABLE_WIDTH / 2

function loneCue(x: number, y: number): BallState[] {
  const balls = buildInitialBalls().filter((ball) => ball.isCue)
  const cue = balls[0]!
  cue.pos = vec(x, y)
  cue.vel = vec(0, 0)
  cue.spin = vec(0, 0)
  cue.angularVel = 0
  cue.potted = false
  return balls
}

function cueAndRed(gap: number): BallState[] {
  const balls = buildInitialBalls().filter((ball) => ball.isCue || ball.id === 1)
  const cue = balls.find((ball) => ball.isCue)!
  const red = balls.find((ball) => ball.id === 1)!
  cue.pos = vec(1100, MID)
  cue.vel = vec(0, 0)
  cue.spin = vec(0, 0)
  cue.angularVel = 0
  red.pos = vec(1100 + BALL_RADIUS * 2 + gap, MID)
  red.vel = vec(0, 0)
  red.spin = vec(0, 0)
  red.potted = false
  return balls
}

describe('cloth grip', () => {
  it('slows a stunned ball at sliding friction until the cloth grips it', () => {
    const power = 0.45
    const ticks = 40
    const start = 700
    const out = simulateStroke(loneCue(start, MID), { aimAngle: 0, power, spin: { x: 0, y: 0 } }, { maxTicks: ticks })
    const cue = out.balls.find((ball) => ball.isCue)!
    const dt = ticks * TICK_DT
    const launch = power * MAX_CUE_SPEED
    const travelled = cue.pos.x - start
    const slide = launch * dt - 0.5 * SLIDE_FRICTION * dt * dt
    const roll = launch * dt - 0.5 * ROLL_FRICTION * dt * dt
    expect(Math.abs(travelled - slide)).toBeLessThan(30)
    expect(roll - travelled).toBeGreaterThan(40)
    expect(cue.pos.y).toBeCloseTo(MID, 1)
  })

  it('keeps rolling once the slip has closed, slower than the slide', () => {
    const power = 0.25
    const launch = power * MAX_CUE_SPEED
    const gripTicks = Math.ceil(launch / (3.5 * SLIDE_FRICTION) / TICK_DT) + 4
    const out = simulateStroke(
      loneCue(400, MID),
      { aimAngle: 0, power, spin: { x: 0, y: 0 } },
      { maxTicks: gripTicks + 30, playback: { rate: 60 } }
    )
    const frames = out.keyframes ?? []
    const speeds: number[] = []
    for (let i = 1; i < frames.length; i++) {
      const prev = frames[i - 1]!.balls.find((row) => row[0] === 0)!
      const next = frames[i]!.balls.find((row) => row[0] === 0)!
      const dt = frames[i]!.t - frames[i - 1]!.t
      if (dt <= 0) continue
      speeds.push(Math.hypot(next[1] - prev[1], next[2] - prev[2]) / dt)
    }
    expect(speeds.length).toBeGreaterThan(4)
    const early = speeds[0]!
    const late = speeds[speeds.length - 1]!
    expect(late).toBeLessThan(early)
    expect(late).toBeGreaterThan(0)
  })
})

describe('tip spin', () => {
  it('screws back, stuns, and follows through a third of a second after contact', () => {
    const pace = (spinY: number): number => {
      const shot = { aimAngle: 0, power: 0.55, spin: { x: 0, y: spinY } }
      const rack = () => cueAndRed(320)
      const hit = simulateStroke(rack(), shot).events.find((event) => event.type === 'BALL_HIT')
      expect(hit).toBeTruthy()
      const balls = simulateStroke(rack(), shot, { maxTicks: hit!.tick + Math.round(0.33 / TICK_DT) }).balls
      return balls.find((ball) => ball.isCue)!.vel.x
    }
    const screw = pace(-1)
    const stun = pace(0)
    const follow = pace(1)
    expect(screw).toBeLessThan(0)
    expect(stun).toBeGreaterThan(0)
    expect(follow).toBeGreaterThan(stun + 80)
  })
})

describe('sidespin', () => {
  it('swerves a sliding ball and throws the object ball the other way', () => {
    const left = simulateStroke(loneCue(700, MID), { aimAngle: 0, power: 0.55, spin: { x: -1, y: 0 } }, { maxTicks: 36 })
    const right = simulateStroke(loneCue(700, MID), { aimAngle: 0, power: 0.55, spin: { x: 1, y: 0 } }, { maxTicks: 36 })
    const ly = left.balls.find((ball) => ball.isCue)!.pos.y
    const ry = right.balls.find((ball) => ball.isCue)!.pos.y
    expect(ry - ly).toBeGreaterThan(4)
    expect(ly).toBeLessThan(MID)
    expect(ry).toBeGreaterThan(MID)

    const hit = (side: number) =>
      simulateStroke(cueAndRed(240), { aimAngle: 0, power: 0.5, spin: { x: side, y: 0 } }).balls.find((ball) => ball.id === 1)!
    const thrownLeft = hit(-1)
    const thrownRight = hit(1)
    expect(thrownRight.pos.y - thrownLeft.pos.y).toBeGreaterThan(1)
  })
})

describe('cushions and pockets', () => {
  it('opens the rebound angle when pace along the cushion is scrubbed', () => {
    const y = TABLE_WIDTH - BALL_RADIUS - 40
    const out = simulateStroke(
      loneCue(900, y),
      { aimAngle: -0.55, power: 0.35, spin: { x: 0, y: 0 } },
      { playback: { rate: 120 } }
    )
    const frames = out.keyframes ?? []
    let hit = -1
    for (let i = 1; i < frames.length; i++) {
      const prev = frames[i - 1]!.balls.find((row) => row[0] === 0)!
      const next = frames[i]!.balls.find((row) => row[0] === 0)!
      if (next[2] < prev[2] && prev[2] > y) {
        hit = i
        break
      }
    }
    expect(hit).toBeGreaterThan(1)
    const before = frames[hit - 1]!.balls.find((row) => row[0] === 0)!
    const prior = frames[hit - 2]!.balls.find((row) => row[0] === 0)!
    const after = frames[Math.min(frames.length - 1, hit + 2)]!.balls.find((row) => row[0] === 0)!
    const incoming = Math.atan2(prior[2] - before[2], before[1] - prior[1])
    const leaving = Math.atan2(before[2] - after[2], after[1] - before[1])
    expect(Math.abs(leaving)).toBeGreaterThan(Math.abs(incoming) * 0.15)
    expect(out.events.some((event) => event.type === 'CUSHION')).toBe(true)
  })

  it('drops a slow ball aimed at a pocket and rattles a fast one that only clips the jaw', () => {
    const pocket = pocketPositions().find((item) => item.name === 'br')!
    const aimed = loneCue(pocket.x - 180, pocket.y - 180)
    const drop = simulateStroke(aimed, { aimAngle: Math.PI / 4, power: 0.18, spin: { x: 0, y: 0.2 } })
    expect(drop.balls.find((ball) => ball.isCue)!.potted).toBe(true)

    // Above the throat, so a hard ball clips the jaw instead of falling in.
    const clip = loneCue(TABLE_LENGTH - 240, TABLE_WIDTH - 46)
    const rattle = simulateStroke(clip, { aimAngle: 0, power: 0.7, spin: { x: 0, y: 0 } })
    const cue = rattle.balls.find((ball) => ball.isCue)!
    expect(cue.potted).toBe(false)
    expect(cue.pos.x).toBeLessThan(TABLE_LENGTH)
    expect(cue.pos.y).toBeLessThan(TABLE_WIDTH)
  })
})
