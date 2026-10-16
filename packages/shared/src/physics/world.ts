import {
  BALL_RADIUS,
  BALL_RESTITUTION,
  CUSHION_TANGENTIAL_DAMP,
  CUSHION_SIDESPIN_KICK,
  CUSHION_SPEED_FALLOFF,
  CUSHION_SPEED_SCALE_MIN,
  CUSHION_SPEED_SCALE_MAX,
  ROLL_FRICTION,
  SLIDE_FRICTION,
  SIDE_SPIN_FRICTION,
  SPIN_TRANSFER,
  MIN_SPEED,
  MAX_SIM_TICKS,
  TICK_DT,
  SIDE_SPIN_THROW_DEG
} from '../constants.js'
import type { BallState } from '../state.js'
import type { SimEvent, SimShot, SimResult, SimKeyframe, SimContact } from '../events.js'
import { sub, length, normalize, vec, clamp } from '../vec.js'
import { reflectCushionX, reflectCushionY } from './collision.js'
import { CUSHION_FACES, CUSHION_JAWS, resolveJawContact } from './cushions.js'
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

/**
 * The gentlest contacts worth recording for the sounds, in mm/s.
 *
 * Two balls resting against each other, or a ball creeping along a cushion, meet again on
 * every substep at next to no speed. None of that is audible, and recording it would turn
 * a couple of hundred contacts into thousands. These are below what the client plays, so
 * nothing a player could hear is lost.
 */
const CONTACT_MIN_BALL_SPEED = 90
const CONTACT_MIN_CUSHION_SPEED = 140

export function simulateStroke(initialBalls: BallState[], shot: SimShot, options: SimOptions = {}): SimResult {
  const balls = initialBalls.map(cloneBall)
  const events: SimEvent[] = []
  const maxTicks = options.maxTicks ?? MAX_SIM_TICKS
  const cue = balls.find((b) => b.isCue)
  if (!cue) throw new Error('cue ball missing')
  applyShot(cue, shot)
  // Each ball's rolling velocity: how fast, and which way, its surface is turning over
  // the cloth. It is what tells a skidding ball from a rolling one, and it carries a cue
  // ball's top or back spin through the contact. Kept here, beside the balls rather than
  // on them, because nothing outside a single stroke needs it.
  const roll = new Map<BallState, Roll>()
  for (const ball of balls) roll.set(ball, initialRoll(ball))

  let firstContactId: number | null = null
  let cuePotted = false
  const pockets = pocketPositions()
  let ticksUsed = 0
  let settled = false
  let simTime = 0

  const keyframes: SimKeyframe[] | null = options.playback ? [] : null
  const pots: Array<[number, number]> | null = options.playback ? [] : null
  // Recorded only when a replay was asked for, like the keyframes. The bot's own trial
  // shots never ask, so they pay nothing for it. Nothing below reads this back: it is
  // written to and returned, and the simulation is the same with or without it.
  const contacts: SimContact[] | null = options.playback ? [] : null
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
      if (speed > 0 || isTurning(roll.get(ball)!)) anyMoving = true
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
        if (ball.potted) continue
        const turning = roll.get(ball)!
        if (ball.vel.x === 0 && ball.vel.y === 0 && !isTurning(turning)) continue
        integrate(ball, turning, subDt)
      }

      for (let i = 0; i < balls.length; i++) {
        const a = balls[i]!
        if (a.potted) continue
        for (let j = i + 1; j < balls.length; j++) {
          const b = balls[j]!
          if (b.potted) continue
          const cue = a.isCue ? a : b.isCue ? b : null
          const cueVelBefore = cue ? vec(cue.vel.x, cue.vel.y) : vec(0, 0)
          // How hard the two are closing along the line between them, measured before
          // the collision changes it. Only worked out when contacts are being recorded.
          let closing = 0
          if (contacts) {
            const cdx = b.pos.x - a.pos.x
            const cdy = b.pos.y - a.pos.y
            const cd = Math.sqrt(cdx * cdx + cdy * cdy)
            if (cd > 0) closing = Math.abs(((b.vel.x - a.vel.x) * cdx + (b.vel.y - a.vel.y) * cdy) / cd)
          }
          if (!resolveCollisionPair(a, b, subDt)) continue
          if (contacts && closing >= CONTACT_MIN_BALL_SPEED) {
            contacts.push([
              0,
              round(simTime + subDt * (step + 1), 3),
              a.id,
              b.id,
              round(closing),
              round((a.pos.x + b.pos.x) / 2),
              round((a.pos.y + b.pos.y) / 2)
            ])
          }
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
            applySpinEffects(cue, other)
          }
        }
      }

      // Rails and pockets are resolved per substep as well, so a ball that reaches
      // a cushion partway through a tick is turned at that moment rather than
      // being allowed to travel its whole remaining tick into the rail and then
      // snapped back, which cost a fast ball most of a ball's width of travel.
      for (const ball of balls) {
        if (ball.potted) continue
        reflectOffCushions(ball, roll.get(ball)!, events, tick, contacts, simTime + subDt * (step + 1))
        const pocket = checkPockets(ball, pockets, events, tick)
        if (pocket) {
          stopRoll(roll.get(ball)!)
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
        keyframes.push(captureKeyframe(balls, simTime, justPotted, newlySettled, roll))
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
    ...(keyframes ? { keyframes, pots: pots ?? [], contacts: contacts ?? [] } : {})
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
  newlySettled: Set<number>,
  roll: Map<BallState, Roll>
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
    // How it is turning as well as where it is, for the replay to draw it turning the way
    // it really does: skidding, screwing back, or spinning on its side. Recorded only;
    // nothing in the simulation reads it back.
    const turning = roll.get(ball)
    sampled.push([
      ball.id,
      round(ball.pos.x),
      round(ball.pos.y),
      round(turning?.x ?? 0),
      round(turning?.y ?? 0),
      round(ball.spin.x * 1000)
    ])
  }
  return { t: round(t, 3), balls: sampled }
}

function round(value: number, places = 0): number {
  const f = 10 ** places
  return Math.round(value * f) / f
}

/** A ball's rolling velocity in mm/s: the speed and direction its surface turns at. */
interface Roll {
  x: number
  y: number
}

/**
 * Below this mismatch, in mm/s, between a ball's centre and its surface the ball is
 * rolling. Gripping is resolved exactly (see `integrate`), so a rolling ball sits at a
 * mismatch of zero; the margin only keeps rounding from reopening a skid.
 */
const ROLL_MATCH = 0.5

/**
 * The rotation a ball starts the stroke with, laid along the way it is travelling.
 *
 * Only the cue ball is moving at the start, and `applyShot` has set its rotation from
 * the tip offset; every other ball is at rest and is not turning.
 */
function initialRoll(ball: BallState): Roll {
  const speed = Math.hypot(ball.vel.x, ball.vel.y)
  if (ball.potted || speed === 0) return { x: 0, y: 0 }
  const surface = (ball.angularVel ?? 0) * BALL_RADIUS
  return { x: (ball.vel.x / speed) * surface, y: (ball.vel.y / speed) * surface }
}

function isTurning(roll: Roll): boolean {
  return roll.x !== 0 || roll.y !== 0
}

function stopRoll(roll: Roll): void {
  roll.x = 0
  roll.y = 0
}

function integrate(ball: BallState, roll: Roll, dt: number): void {
  // Slide, then roll — the way a ball actually behaves on cloth.
  //
  // A ball whose surface is not keeping pace with its centre is skidding, and the cloth
  // pulls on its contact point against the skid. That one force does two things: it
  // slows (or speeds) the centre at mu_s*g, and it turns the ball the other way at
  // 5/2 of that, since a solid ball's moment of inertia is 2/5 m R^2. Between them the
  // mismatch closes at 7/2 mu_s*g until surface and centre agree, and the ball rolls on
  // at 5/7 of a stun ball's pace — or faster, or slower, or back the way it came,
  // depending on the spin it had. From then on only rolling resistance acts.
  //
  // This is what makes a centre-ball stun lose its edge in the first few inches, a
  // struck object ball skid before it rolls, a rolling cue ball follow through after a
  // full contact, and a screw shot come back — none of which is scripted; each is the
  // same skid closing from a different start.
  let vx = ball.vel.x
  let vy = ball.vel.y
  const sx = vx - roll.x
  const sy = vy - roll.y
  const slip = Math.sqrt(sx * sx + sy * sy)
  if (slip > ROLL_MATCH) {
    const closes = 3.5 * SLIDE_FRICTION * dt
    if (closes >= slip) {
      // Grips within this step: centre and surface meet at the analytic natural-roll
      // velocity, v - 2/7 of the slip, and the ball rolls from here.
      vx -= (2 / 7) * sx
      vy -= (2 / 7) * sy
      roll.x = vx
      roll.y = vy
    } else {
      const k = (SLIDE_FRICTION * dt) / slip
      vx -= sx * k
      vy -= sy * k
      roll.x += 2.5 * sx * k
      roll.y += 2.5 * sy * k
    }
    if (Math.sqrt(vx * vx + vy * vy) <= MIN_SPEED && Math.sqrt(roll.x * roll.x + roll.y * roll.y) <= MIN_SPEED) {
      vx = 0
      vy = 0
      stopRoll(roll)
    }
  } else {
    // Rolling. The deceleration is applied along the direction of travel, a fixed
    // slice of speed per second, so the run-out is smooth rather than a drop to a cliff.
    const speed = Math.sqrt(vx * vx + vy * vy)
    const nextSpeed = speed - ROLL_FRICTION * dt
    if (nextSpeed <= MIN_SPEED) {
      vx = 0
      vy = 0
    } else {
      const f = nextSpeed / speed
      vx *= f
      vy *= f
    }
    roll.x = vx
    roll.y = vy
  }
  ball.vel.x = vx
  ball.vel.y = vy
  // Kept on the ball for anything reading it: the turn rate, signed against the way
  // the ball is going (negative is back spin).
  const turn = Math.sqrt(roll.x * roll.x + roll.y * roll.y) / BALL_RADIUS
  ball.angularVel = roll.x * vx + roll.y * vy < 0 ? -turn : turn

  const spinX = ball.spin.x
  if (spinX !== 0) {
    // Side spin wears off on the cloth on its own clock: it turns about the vertical,
    // so it is not part of the skid above.
    ball.spin.x = spinX * Math.max(0, 1 - SIDE_SPIN_FRICTION * dt)
  }
  ball.pos.x += ball.vel.x * dt
  ball.pos.y += ball.vel.y * dt
}

/**
 * How a cushion's rebound scales with the pace the ball meets it at: a little livelier
 * for a soft touch, a little deader for a hard hit, exactly the listed figure at 2 m/s.
 */
function cushionPaceScale(normalSpeed: number): number {
  return clamp(
    1 + CUSHION_SPEED_FALLOFF * (2 - normalSpeed / 1000),
    CUSHION_SPEED_SCALE_MIN,
    CUSHION_SPEED_SCALE_MAX
  )
}

/**
 * What a cushion does to a ball's rotation.
 *
 * The rubber meets a snooker ball above its equator and grips it, so the part of the
 * roll that was carrying the ball into the cushion is taken out: the ball leaves the
 * cushion skidding back out and has to grip again, which is why a rolling ball comes
 * off a cushion slower and on a slightly shorter angle than it went in. The roll along
 * the cushion is damped exactly as the pace along it is, so a ball running along the
 * rail does not suddenly skid.
 */
function cushionRoll(roll: Roll, nx: number, ny: number): void {
  const along = roll.x * nx + roll.y * ny
  const tx = roll.x - along * nx
  const ty = roll.y - along * ny
  roll.x = tx * CUSHION_TANGENTIAL_DAMP
  roll.y = ty * CUSHION_TANGENTIAL_DAMP
}

function reflectOffCushions(
  ball: BallState,
  roll: Roll,
  events: SimEvent[],
  tick: number,
  contacts: SimContact[] | null = null,
  time = 0
): void {
  const damping = cushionDamping(ball)
  const side = clamp(ball.spin.x, -1, 1)

  // Straight cushion faces. Each face only exists over its own span, so a ball
  // that has reached a pocket mouth passes the end of the face instead of being
  // turned back by a cushion that is not physically there.
  for (let faceIndex = 0; faceIndex < CUSHION_FACES.length; faceIndex++) {
    const face = CUSHION_FACES[faceIndex]!
    const along = face.along === 'x' ? ball.pos.x : ball.pos.y
    if (along < face.from || along > face.to) continue
    const perp = face.along === 'x' ? ball.pos.y : ball.pos.x
    const perpVel = face.along === 'x' ? ball.vel.y : ball.vel.x
    const into = face.into < 0 ? perp < face.limit && perpVel < 0 : perp > face.limit && perpVel > 0
    if (!into) continue
    // Recorded before the bounce, at the speed the ball came into the cushion with.
    if (contacts && Math.abs(perpVel) >= CONTACT_MIN_CUSHION_SPEED) {
      contacts.push([1, round(time, 3), ball.id, faceIndex, round(Math.abs(perpVel)), round(ball.pos.x), round(ball.pos.y)])
    }
    const rest = face.restitution * damping * cushionPaceScale(Math.abs(perpVel))
    if (face.along === 'x') {
      ball.vel = reflectCushionY(ball.vel, rest)
      ball.vel.x += face.kick * side * Math.abs(ball.vel.y) * CUSHION_SIDESPIN_KICK
      ball.pos.y = face.limit
      cushionRoll(roll, 0, 1)
    } else {
      ball.vel = reflectCushionX(ball.vel, rest)
      ball.vel.y += face.kick * side * Math.abs(ball.vel.x) * CUSHION_SIDESPIN_KICK
      ball.pos.x = face.limit
      cushionRoll(roll, 1, 0)
    }
    events.push({ type: 'CUSHION', tick, ballId: ball.id })
  }

  // Rounded jaws where each face meets a pocket. These are what a ball running
  // along the rail meets just before the pocket mouth.
  for (let jawIndex = 0; jawIndex < CUSHION_JAWS.length; jawIndex++) {
    const jaw = CUSHION_JAWS[jawIndex]!
    const jawSpeed = contacts ? Math.sqrt(ball.vel.x * ball.vel.x + ball.vel.y * ball.vel.y) : 0
    // The pace into the knuckle, along the line from its centre, sets the rebound
    // exactly as the pace into a straight face does.
    const jx = ball.pos.x - jaw.cx
    const jy = ball.pos.y - jaw.cy
    const jd = Math.sqrt(jx * jx + jy * jy)
    const intoJaw = jd > 0 ? Math.max(0, -(ball.vel.x * jx + ball.vel.y * jy) / jd) : 0
    const contact = resolveJawContact(
      ball.pos.x,
      ball.pos.y,
      ball.vel.x,
      ball.vel.y,
      jaw,
      jaw.restitution * damping * cushionPaceScale(intoJaw),
      CUSHION_TANGENTIAL_DAMP
    )
    if (!contact) continue
    ball.pos.x = contact.x
    ball.pos.y = contact.y
    // A pure depenetration leaves a kissing ball untouched; only report a hit
    // when the jaw actually turned it.
    if (!contact.bounced) continue
    if (contacts && jawSpeed >= CONTACT_MIN_CUSHION_SPEED) {
      contacts.push([2, round(time, 3), ball.id, jawIndex, round(jawSpeed), round(contact.x), round(contact.y)])
    }
    ball.vel.x = contact.vx
    ball.vel.y = contact.vy
    if (jd > 0) cushionRoll(roll, jx / jd, jy / jd)
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
      ball.angularVel = 0
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

function resolveCollisionPair(a: BallState, b: BallState, stepDt = 0): boolean {
  let dx = b.pos.x - a.pos.x
  let dy = b.pos.y - a.pos.y
  const minDist = BALL_RADIUS * 2
  let d2 = dx * dx + dy * dy
  if (d2 === 0 || d2 >= minDist * minDist) return false

  // The two are found overlapping, which means they touched some way back along this
  // substep. Where they touched is what decides which way each one leaves, so they are
  // put back to that moment first, the collision is worked out there, and they are then
  // carried forward again for the time that was left.
  //
  // Working it out from the overlapped positions instead turned every cut shot thin: by
  // the time the overlap was noticed the cue ball had travelled up to a quarter of a
  // radius past the point of contact, and the line between the centres had swung round
  // with it. Measured, that was two degrees on a half-ball cut and over five at worst —
  // several times the width of a pocket at the far end of the table — and it changed
  // with every millimetre of distance, so the same shot did not go the same way twice.
  let rewind = 0
  const wx = b.vel.x - a.vel.x
  const wy = b.vel.y - a.vel.y
  const w2 = wx * wx + wy * wy
  const dw = dx * wx + dy * wy
  if (stepDt > 0 && w2 > 0 && dw < 0) {
    const disc = dw * dw - w2 * (d2 - minDist * minDist)
    const back = (dw + Math.sqrt(disc)) / w2
    // Only a contact that happened inside this substep. An overlap older than that was
    // not made by this motion (a ball pressed against two others, say), and is left to
    // the plain separation below.
    if (back > 0 && back <= stepDt) {
      rewind = back
      a.pos.x -= a.vel.x * back
      a.pos.y -= a.vel.y * back
      b.pos.x -= b.vel.x * back
      b.pos.y -= b.vel.y * back
      dx = b.pos.x - a.pos.x
      dy = b.pos.y - a.pos.y
      d2 = dx * dx + dy * dy
    }
  }

  const d = Math.sqrt(d2)
  const nx = dx / d
  const ny = dy / d
  const relSpeedAlongNormal = (b.vel.x - a.vel.x) * nx + (b.vel.y - a.vel.y) * ny
  if (relSpeedAlongNormal > 0) {
    if (rewind > 0) {
      a.pos.x += a.vel.x * rewind
      a.pos.y += a.vel.y * rewind
      b.pos.x += b.vel.x * rewind
      b.pos.y += b.vel.y * rewind
    }
    return false
  }
  // Impulse for two equal masses with restitution e: j = -(1+e)·(v_rel·n) / 2, the
  // analytic equal-mass result. Going through e means the normal relative velocity
  // after the impulse is exactly -e times what it was before, so at e = 0.96 the
  // object ball leaves a full hit carrying almost the whole of the closing pace —
  // why the pack no longer feels heavy and object balls do not die on the spot.
  const impulse = (-(1 + BALL_RESTITUTION) * relSpeedAlongNormal) / 2
  const ix = nx * impulse
  const iy = ny * impulse
  a.vel.x -= ix
  a.vel.y -= iy
  b.vel.x += ix
  b.vel.y += iy
  // Side spin rubs a little onto the other ball. Top and back spin are left where they
  // are: two polished balls barely grip each other, so each keeps its own rotation
  // through the contact, and that kept rotation is what follows through or screws back.
  const asx = a.spin.x
  const bsx = b.spin.x
  a.spin.x += (bsx - asx) * SPIN_TRANSFER
  b.spin.x += (asx - bsx) * SPIN_TRANSFER
  if (rewind > 0) {
    // The rest of the substep, on the way out.
    a.pos.x += a.vel.x * rewind
    a.pos.y += a.vel.y * rewind
    b.pos.x += b.vel.x * rewind
    b.pos.y += b.vel.y * rewind
    return true
  }
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
 * Side spin's throw on the object ball, for contacts the cue ball takes part in.
 *
 * Follow and screw are not applied here: the cue ball keeps its rotation through the
 * contact (see `integrate`), and that rotation carries it through or pulls it back as
 * the cloth takes hold, by however much spin it still had when it arrived.
 */
function applySpinEffects(cue: BallState, object: BallState): void {
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
    spin: vec(ball.spin.x, ball.spin.y),
    angularVel: ball.angularVel ?? 0
  }
}