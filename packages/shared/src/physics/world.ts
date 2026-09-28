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
  SIDE_SPIN_THROW_DEG
} from '../constants.js'
import type { BallState } from '../state.js'
import type { SimEvent, SimShot, SimResult, SimKeyframe } from '../events.js'
import type { Vec2 } from '../vec.js'
import { sub, length, normalize, vec, clamp } from '../vec.js'
import { reflectCushionX, reflectCushionY } from './collision.js'
import { applyShot } from './cue.js'
import { pocketPositions } from './layout.js'
import type { Pocket } from './layout.js'

export interface SimOptions {
  maxTicks?: number
  /**
   * Sample ball positions for client-side playback. Off by default: the bot runs
   * thousands of candidate simulations per shot and must not pay for the extra
   * allocations.
   */
  playback?: SimPlaybackOptions
}

export interface SimPlaybackOptions {
  /**
   * Keyframes per second of simulated time. Sampling runs for the whole shot,
   * so a keyframe is never skipped and the replay always reaches the final
   * resting positions.
   */
  rate?: number
}

const DEFAULT_KEYFRAME_RATE = 30

export function simulateStroke(initialBalls: BallState[], shot: SimShot, options: SimOptions = {}): SimResult {
  const balls = initialBalls.map(cloneBall)
  const events: SimEvent[] = []
  const maxTicks = options.maxTicks ?? MAX_SIM_TICKS
  const cue = balls.find((b) => b.isCue)
  if (!cue) throw new Error('cue ball missing')
  applyShot(cue, shot)

  let firstContactId: number | null = null
  let cueFirstContact = false
  let cuePotted = false
  const pockets = pocketPositions()
  let ticksUsed = 0
  let settled = false
  let simTime = 0

  const keyframes: SimKeyframe[] | null = options.playback ? [] : null
  const pots: Array<[number, number]> | null = options.playback ? [] : null
  const sampleInterval = 1 / (options.playback?.rate ?? DEFAULT_KEYFRAME_RATE)
  let nextSampleAt = 0
  /** Balls potted during the current substep, mapped to their pocket centre. */
  let justPotted: Array<[id: number, at: [number, number]]> = []
  /**
   * Ids that were still moving when the last keyframe was taken. A ball that was
   * moving then and is at rest now is the one that has just settled, and it is the
   * only ball whose resting position still has to be recorded.
   */
  let sampledAsMoving = new Set<number>()

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
    if (!anyMoving) {
      settled = true
      break
    }

    // A tick is subdivided so that no ball advances more than a quarter of a
    // radius per substep, which is what keeps contact detection from tunnelling:
    // two balls are 105mm across, and a fast cue ball covers far more than that in
    // a whole tick.
    //
    // The subdivision must divide the tick, not repeat it. Advancing by a whole
    // TICK_DT on every substep made a fast ball travel several ticks' worth of
    // ground per tick, so it could pass clean through an object ball without ever
    // overlapping it, and the shot it "hit" registered as a glancing nothing. It
    // also applied rolling resistance once per substep, which made the effective
    // friction rise with speed and left harder shots travelling shorter distances
    // than softer ones. The substep delta below fixes both.
    const substeps = Math.max(1, Math.ceil((maxSpeed * TICK_DT) / (BALL_RADIUS * 0.25)))
    const subDt = TICK_DT / substeps
    for (let step = 0; step < substeps; step++) {
      for (const ball of balls) {
        if (ball.potted || ball.vel.x === 0 && ball.vel.y === 0) continue
        integrate(ball, subDt)
      }

      for (let i = 0; i < balls.length; i++) {
        const a = balls[i]!
        if (a.potted) continue
        for (let j = i + 1; j < balls.length; j++) {
          const b = balls[j]!
          if (b.potted) continue
          const cue = a.isCue ? a : b.isCue ? b : null
          const cueVelBefore = cue ? vec(cue.vel.x, cue.vel.y) : vec(0, 0)
          if (!resolveCollisionPair(a, b)) continue
          events.push({ type: 'BALL_HIT', tick, ballId: b.id, otherBallId: a.id })
          if (cue) {
            const other = cue === a ? b : a
            // The striker has to cause the cue ball to make the first contact. If the
            // cue ball was already standing still and an object ball ran into it, the
            // object ball was never "on", so that cannot be a legal first contact and
            // must not be recorded as one.
            if (firstContactId === null && cueVelBefore.x * cueVelBefore.x + cueVelBefore.y * cueVelBefore.y > 0) {
              firstContactId = other.id
            }
            applySpinEffects(cue, other, !cueFirstContact, cueVelBefore)
            cueFirstContact = true
          }
        }
      }

      // Rails and pockets are resolved per substep as well, so a ball that reaches
      // a cushion partway through a tick is turned at that moment rather than
      // being allowed to travel its whole remaining tick into the rail and then
      // snapped back, which cost a fast ball most of a ball's width of travel.
      for (const ball of balls) {
        if (ball.potted) continue
        reflectOffCushions(ball, events, tick)
        const pocket = checkPockets(ball, pockets, events, tick)
        if (pocket) {
          if (pots) pots.push([ball.id, round(simTime + TICK_DT, 3)])
          justPotted.push([ball.id, [pocket.x, pocket.y]])
        }
        if (ball.isCue && ball.potted) {
          cuePotted = true
        }
      }
    }

    simTime += TICK_DT
    if (keyframes) {
      const due = simTime >= nextSampleAt
      // A pot always forces a sample: without one the ball would sit at the
      // pocket lip until the replay ended and the snapshot took over.
      if (due || justPotted.length) {
        // A ball that has just stopped is sampled once more, on the keyframe where
        // it came to rest. Without it the ball's last sample was taken while it
        // was still creeping, and the replay held it at that sample for the rest
        // of the shot -- so the position the animation finished on was up to one
        // keyframe short of the authoritative resting position, and the
        // authoritative snapshot that replaced it produced a small jump.
        const newlySettled: Set<number> = new Set()
        const stillMoving = new Set<number>()
        for (const ball of balls) {
          if (ball.potted) continue
          const moving = ball.vel.x !== 0 || ball.vel.y !== 0
          if (moving) stillMoving.add(ball.id)
          else if (sampledAsMoving.has(ball.id)) newlySettled.add(ball.id)
        }
        keyframes.push(captureKeyframe(balls, simTime, justPotted, newlySettled))
        sampledAsMoving = stillMoving
        justPotted = []
        nextSampleAt = simTime + (due ? sampleInterval : 0)
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
    settled,
    ticksUsed,
    // Same precision as the keyframe and pot timestamps. The client stops its
    // clock at this value, so if it were rounded more finely a keyframe could
    // land fractionally beyond the end of the replay and never be reached.
    simSeconds: round(simTime, 3),
    ...(keyframes ? { keyframes, pots: pots ?? [] } : {})
  }
}

/**
 * Samples the balls that are still in motion, plus any that came to rest on this
 * keyframe. Rounding to whole millimetres costs nothing visually against a 26mm
 * ball and roughly halves the JSON size. A ball that stopped on an earlier
 * keyframe keeps that keyframe's position, which is exactly where it settled, so
 * omitting it from later keyframes does not move it.
 *
 * A ball potted in this substep is emitted at its pocket's centre rather than
 * where it crossed the capture radius, so the replay shows it dropping in
 * instead of stopping at the lip. The simulation state itself is left alone:
 * this is presentation data, not a change to where the ball actually is.
 */
function captureKeyframe(
  balls: BallState[],
  t: number,
  justPotted: Array<[number, [number, number]]>,
  newlySettled: Set<number>
): SimKeyframe {
  const sampled: SimKeyframe['balls'] = []
  const dropped = justPotted.length ? new Map(justPotted) : null
  for (const ball of balls) {
    const at = dropped?.get(ball.id)
    if (at) {
      sampled.push([ball.id, round(at[0]), round(at[1])])
      continue
    }
    if (ball.potted) continue
    // At rest and already recorded at rest: nothing has moved, so there is nothing
    // to send. A ball captured on the keyframe where it stopped keeps that sample.
    if (ball.vel.x === 0 && ball.vel.y === 0 && !newlySettled.has(ball.id)) continue
    sampled.push([ball.id, round(ball.pos.x), round(ball.pos.y)])
  }
  return { t: round(t, 3), balls: sampled }
}

function round(value: number, places = 0): number {
  const f = 10 ** places
  return Math.round(value * f) / f
}

function integrate(ball: BallState, dt: number): void {
  const vx = ball.vel.x
  const vy = ball.vel.y
  const speed = Math.sqrt(vx * vx + vy * vy)
  if (speed > 0) {
    const reduction = ROLL_FRICTION * dt
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
  if (sx !== 0 || sy !== 0) {
    // Spin bleeds off proportionally, not linearly. A linear ramp to zero means
    // a shot that takes longer than (spin / SPIN_FRICTION) to reach its target
    // cancels the spin outright, which leaves the bottom of the spin control
    // range doing nothing at all. Proportional decay keeps the effect in
    // proportion to the spin applied at every shot distance.
    const retain = Math.max(0, 1 - SPIN_FRICTION * dt)
    ball.spin.x = sx * retain
    ball.spin.y = sy * retain
  }
  ball.pos.x += ball.vel.x * dt
  ball.pos.y += ball.vel.y * dt
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

function checkPockets(ball: BallState, pockets: Pocket[], events: SimEvent[], tick: number): Pocket | null {
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
      return pocket
    }
  }
  return null
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

/**
 * Spin is only meaningful for the cue ball, so this is driven exclusively by
 * collisions the cue ball takes part in.
 *
 * `cueVelBefore` is the cue ball's velocity immediately prior to the impulse,
 * which is what follow and draw must scale against: after a full-ball hit the
 * residual speed is a few percent of the launch speed, so scaling by it makes
 * both effects unnoticeable. The kick is also applied along the *incoming* line
 * of travel, because a stun shot leaves the cue ball with almost no direction
 * of its own.
 *
 * `firstContact` gates the follow/draw kick: that vertical spin is transferred
 * to the cloth at the moment of first contact and is spent, so it must not be
 * re-applied on every later collision. Side spin (english) is a persistent
 * property of the ball, so it keeps applying until it decays away.
 */
function applySpinEffects(cue: BallState, object: BallState, firstContact: boolean, cueVelBefore: Vec2): void {
  const launchSpeed = length(cueVelBefore)

  if (firstContact && Math.abs(cue.spin.y) > 0.01 && launchSpeed > 0) {
    const direction = normalize(cueVelBefore)
    const kick = cue.spin.y > 0
      ? launchSpeed * cue.spin.y * FOLLOW_IMPULSE
      : launchSpeed * cue.spin.y * DRAW_IMPULSE
    cue.vel = vec(cue.vel.x + direction.x * kick, cue.vel.y + direction.y * kick)
    cue.spin = vec(cue.spin.x, 0)
  }

  if (Math.abs(cue.spin.x) > 0.01) {
    const contactNormal = normalize(sub(object.pos, cue.pos))
    if (contactNormal.x === 0 && contactNormal.y === 0) return
    const angle = (SIDE_SPIN_THROW_DEG * Math.PI / 180) * clamp(cue.spin.x, -1, 1)
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const vx = object.vel.x
    const vy = object.vel.y
    object.vel = vec(vx * cos - vy * sin, vx * sin + vy * cos)
  }
}

function cloneBall(ball: BallState): BallState {
  return {
    ...ball,
    pos: vec(ball.pos.x, ball.pos.y),
    vel: vec(ball.vel.x, ball.vel.y),
    spin: vec(ball.spin.x, ball.spin.y)
  }
}