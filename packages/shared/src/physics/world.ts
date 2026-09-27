import {
  BALL_RADIUS,
  TABLE_LENGTH,
  TABLE_WIDTH,
  CUSHION_RESTITUTION_LONG,
  CUSHION_RESTITUTION_SHORT,
  CUSHION_TANGENTIAL_DAMP,
  ROLL_FRICTION,
  SPIN_FRICTION,
  MIN_SPEED,
  MAX_SIM_TICKS,
  TICK_DT,
  FOLLOW_IMPULSE,
  DRAW_IMPULSE,
  SIDE_SPIN_IMPULSE
} from '../constants.js'
import type { BallState } from '../state.js'
import type { SimEvent, SimShot, SimResult } from '../events.js'
import type { Vec2 } from '../vec.js'
import { add, sub, scale, length, dist, normalize, vec } from '../vec.js'
import { resolveBallBall, positionalCorrection, reflectCushionX, reflectCushionY } from './collision.js'
import { applyShot } from './cue.js'
import { pocketPositions } from './layout.js'
import type { Pocket } from './layout.js'

export interface SimOptions {
  maxTicks?: number
}

export function simulateStroke(initialBalls: BallState[], shot: SimShot, options: SimOptions = {}): SimResult {
  const balls = initialBalls.map(cloneBall)
  const events: SimEvent[] = []
  const maxTicks = options.maxTicks ?? MAX_SIM_TICKS
  const cue = balls.find((b) => b.isCue)
  if (!cue) throw new Error('cue ball missing')
  applyShot(cue, shot)

  let firstContactId: number | null = null
  let cuePotted = false
  const pockets = pocketPositions()
  let ticksUsed = 0

  for (let tick = 0; tick < maxTicks; tick++) {
    ticksUsed = tick + 1
    let anyMoving = false
    let maxSpeed = 0
    for (const ball of balls) {
      if (ball.potted) continue
      const speed = length(ball.vel)
      if (speed > maxSpeed) maxSpeed = speed
      if (speed > 0) anyMoving = true
    }
    if (!anyMoving) break

    const substeps = Math.max(1, Math.ceil((maxSpeed * TICK_DT) / (BALL_RADIUS * 0.25)))
    for (let step = 0; step < substeps; step++) {
      for (const ball of balls) {
        if (ball.potted || ball.vel.x === 0 && ball.vel.y === 0) continue
        integrate(ball)
      }

      for (let i = 0; i < balls.length; i++) {
        const a = balls[i]!
        if (a.potted) continue
        for (let j = i + 1; j < balls.length; j++) {
          const b = balls[j]!
          if (b.potted) continue
          const res = resolveBallBall(a.pos, a.vel, b.pos, b.vel)
          if (!res.colliding) continue
          const corr = positionalCorrection(a.pos, b.pos)
          a.pos = corr.aPos
          b.pos = corr.bPos
          a.vel = res.aVel
          b.vel = res.bVel
          events.push({ type: 'BALL_HIT', tick, ballId: b.id, otherBallId: a.id })
          if (firstContactId === null && (a.isCue || b.isCue)) {
            firstContactId = a.isCue ? b.id : a.id
          }
          applySpinEffects(balls, i, j)
        }
      }

      for (const ball of balls) {
        if (ball.potted) continue
        reflectOffCushions(ball, events, tick)
        checkPockets(ball, pockets, events, tick)
        if (ball.isCue && ball.potted) {
          cuePotted = true
        }
      }
    }
  }

  const pottedIds: number[] = []
  for (const event of events) {
    if (event.type === 'POTTED' || event.type === 'CUE_POTTED') {
      pottedIds.push(event.ballId)
    }
  }

  return {
    balls,
    events,
    firstContactId,
    cuePotted,
    pottedIds,
    settled: true,
    ticksUsed
  }
}

function integrate(ball: BallState): void {
  const speed = length(ball.vel)
  if (speed > 0) {
    const reduction = ROLL_FRICTION * TICK_DT
    const nextSpeed = speed - reduction
    if (nextSpeed <= MIN_SPEED) {
      ball.vel = vec(0, 0)
    } else {
      ball.vel = scale(ball.vel, nextSpeed / speed)
    }
  }
  const spinMag = length(ball.spin)
  if (spinMag > 0) {
    const reduction = SPIN_FRICTION * TICK_DT
    const nextSpin = spinMag - reduction
    if (nextSpin <= 0) {
      ball.spin = vec(0, 0)
    } else {
      ball.spin = scale(ball.spin, nextSpin / spinMag)
    }
  }
  ball.pos.x += ball.vel.x * TICK_DT
  ball.pos.y += ball.vel.y * TICK_DT
}

function reflectOffCushions(ball: BallState, events: SimEvent[], tick: number): void {
  const left = BALL_RADIUS
  const right = TABLE_LENGTH - BALL_RADIUS
  const top = BALL_RADIUS
  const bottom = TABLE_WIDTH - BALL_RADIUS
  const damping = cushionDamping(ball)

  if (ball.pos.y < top && ball.vel.y < 0) {
    ball.vel = reflectCushionY(ball.vel, CUSHION_RESTITUTION_SHORT * damping)
    ball.pos.y = top
    events.push({ type: 'CUSHION', tick, ballId: ball.id })
  } else if (ball.pos.y > bottom && ball.vel.y > 0) {
    ball.vel = reflectCushionY(ball.vel, CUSHION_RESTITUTION_SHORT * damping)
    ball.pos.y = bottom
    events.push({ type: 'CUSHION', tick, ballId: ball.id })
  }
  if (ball.pos.x < left && ball.vel.x < 0) {
    ball.vel = reflectCushionX(ball.vel, CUSHION_RESTITUTION_LONG * damping)
    ball.pos.x = left
    events.push({ type: 'CUSHION', tick, ballId: ball.id })
  } else if (ball.pos.x > right && ball.vel.x > 0) {
    ball.vel = reflectCushionX(ball.vel, CUSHION_RESTITUTION_LONG * damping)
    ball.pos.x = right
    events.push({ type: 'CUSHION', tick, ballId: ball.id })
  }
}

function cushionDamping(ball: BallState): number {
  const side = Math.abs(ball.spin.x)
  if (side < 0.01) return 1
  return Math.max(0.5, CUSHION_TANGENTIAL_DAMP + (1 - CUSHION_TANGENTIAL_DAMP) * (1 - side * 0.5))
}

function checkPockets(ball: BallState, pockets: Pocket[], events: SimEvent[], tick: number): void {
  for (const pocket of pockets) {
    const d = dist(ball.pos, vec(pocket.x, pocket.y))
    if (d < pocket.radius) {
      ball.potted = true
      ball.vel = vec(0, 0)
      ball.spin = vec(0, 0)
      events.push({
        type: ball.isCue ? 'CUE_POTTED' : 'POTTED',
        tick,
        ballId: ball.id
      })
      return
    }
  }
}

function applySpinEffects(balls: BallState[], cueIndex: number, objectIndex: number): void {
  const cue = balls[cueIndex]!
  const object = balls[objectIndex]!
  const direction = normalize(cue.vel)
  const speed = length(cue.vel)

  if (Math.abs(cue.spin.y) > 0.01 && speed > 0) {
    const kick = cue.spin.y > 0
      ? speed * cue.spin.y * FOLLOW_IMPULSE
      : speed * cue.spin.y * DRAW_IMPULSE
    cue.vel = { x: cue.vel.x + direction.x * kick, y: cue.vel.y + direction.y * kick }
  }

  if (Math.abs(cue.spin.x) > 0.01) {
    const contactNormal = normalize(sub(object.pos, cue.pos))
    const perpendicular = vec(-contactNormal.y, contactNormal.x)
    const nudge = cue.spin.x * SIDE_SPIN_IMPULSE * 0.3
    object.vel = { x: object.vel.x + perpendicular.x * nudge * speed, y: object.vel.y + perpendicular.y * nudge * speed }
  }

  cue.spin = vec(cue.spin.x * 0.5, cue.spin.y * 0.5)
}

function cloneBall(ball: BallState): BallState {
  return {
    ...ball,
    pos: vec(ball.pos.x, ball.pos.y),
    vel: vec(ball.vel.x, ball.vel.y),
    spin: vec(ball.spin.x, ball.spin.y)
  }
}