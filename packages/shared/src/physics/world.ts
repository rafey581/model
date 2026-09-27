import {
  BALL_RADIUS,
  BALL_RESTITUTION,
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
import { sub, length, normalize, vec } from '../vec.js'
import { reflectCushionX, reflectCushionY } from './collision.js'
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
          if (!resolveCollisionPair(a, b)) continue
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
  const vx = ball.vel.x
  const vy = ball.vel.y
  const speed = Math.sqrt(vx * vx + vy * vy)
  if (speed > 0) {
    const reduction = ROLL_FRICTION * TICK_DT
    const nextSpeed = speed - reduction
    if (nextSpeed <= MIN_SPEED) {
      ball.vel.x = 0
      ball.vel.y = 0
    } else {
      const f = nextSpeed / speed
      ball.vel.x = vx * f
      ball.vel.y = vy * f
    }
  }
  const sx = ball.spin.x
  const sy = ball.spin.y
  const spinMag = Math.sqrt(sx * sx + sy * sy)
  if (spinMag > 0) {
    const reduction = SPIN_FRICTION * TICK_DT
    const nextSpin = spinMag - reduction
    if (nextSpin <= 0) {
      ball.spin.x = 0
      ball.spin.y = 0
    } else {
      const f = nextSpin / spinMag
      ball.spin.x = sx * f
      ball.spin.y = sy * f
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
    const dx = ball.pos.x - pocket.x
    const dy = ball.pos.y - pocket.y
    if (dx * dx + dy * dy < pocket.radius * pocket.radius) {
      ball.potted = true
      ball.vel.x = 0
      ball.vel.y = 0
      ball.spin.x = 0
      ball.spin.y = 0
      events.push({
        type: ball.isCue ? 'CUE_POTTED' : 'POTTED',
        tick,
        ballId: ball.id
      })
      return
    }
  }
}

function resolveCollisionPair(a: BallState, b: BallState): boolean {
  const dx = b.pos.x - a.pos.x
  const dy = b.pos.y - a.pos.y
  const minDist = BALL_RADIUS * 2
  const d2 = dx * dx + dy * dy
  if (d2 === 0 || d2 >= minDist * minDist) return false
  const d = Math.sqrt(d2)
  const nx = dx / d
  const ny = dy / d
  const relSpeedAlongNormal = (b.vel.x - a.vel.x) * nx + (b.vel.y - a.vel.y) * ny
  if (relSpeedAlongNormal > 0) return false
  const impulse = (-(1 + BALL_RESTITUTION) * relSpeedAlongNormal) / 2
  const ix = nx * impulse
  const iy = ny * impulse
  a.vel.x -= ix
  a.vel.y -= iy
  b.vel.x += ix
  b.vel.y += iy
  const overlap = minDist - d
  const cx = nx * (overlap / 2)
  const cy = ny * (overlap / 2)
  a.pos.x -= cx
  a.pos.y -= cy
  b.pos.x += cx
  b.pos.y += cy
  return true
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