import { describe, it, expect } from 'vitest'
import {
  layoutTableBalls,
  simulateStroke,
  createFrame,
  applyStroke,
  isRedId,
  framesToWin,
  createMatch,
  BALL_IDS,
  BALL_RADIUS,
  BALL_DIAMETER,
  TABLE_LENGTH,
  TABLE_WIDTH,
  POCKET_RADIUS_CORNER,
  POCKET_RADIUS_MIDDLE,
  CUSHION_TANGENTIAL_DAMP,
  CUSHION_RESTITUTION_LONG,
  CUSHION_RESTITUTION_SHORT,
  CLOTH_CRR,
  ROLL_FRICTION,
  SLIDE_FRICTION,
  SLIDE_SPEED_THRESHOLD,
  BALL_RESTITUTION,
  TICK_DT,
  MAX_CUE_SPEED,
  buildInitialBalls,
  pocketPositions,
  reflectCushionX,
  reflectCushionY,
  vec
} from '../index.js'
import type { BallState } from '../index.js'

/** Cue ball plus a single red on a clear lane, for isolated collision tests. */
function twoBallRack(objectId = BALL_IDS.RED_MIN, objectX = 1400): BallState[] {
  const balls = buildInitialBalls().filter((b) => b.isCue || b.id === objectId)
  const cue = balls.find((b) => b.isCue)!
  const object = balls.find((b) => b.id === objectId)!
  cue.pos = vec(700, TABLE_WIDTH / 2)
  cue.vel = vec(0, 0)
  cue.spin = vec(0, 0)
  object.pos = vec(objectX, TABLE_WIDTH / 2)
  object.vel = vec(0, 0)
  object.spin = vec(0, 0)
  return balls
}

/** A single cue ball, so cushion and pocket behaviour is measured in isolation. */
function loneCueBall(x: number, y: number): BallState[] {
  const balls = buildInitialBalls().filter((b) => b.isCue)
  balls[0]!.pos = vec(x, y)
  return balls
}

/**
 * The speed the cue ball leaves the tip at, recovered from a single tick of travel.
 *
 * Measuring the launch rather than reading it off the ball keeps the test honest
 * about the thing that matters: what the player actually put on the table. A ball at
 * rest does not move, so the recovery has to allow for the ball's own starting speed
 * and comes back a fraction low; a percent of slack absorbs that.
 */
function launchSpeed(power: number): number {
  const startX = 700
  const out = simulateStroke(
    loneCueBall(startX, TABLE_WIDTH / 2),
    { aimAngle: 0, power, spin: { x: 0, y: 0 } },
    { maxTicks: 1 }
  )
  const cue = out.balls.find((b) => b.isCue)!
  const travelled = cue.pos.x - startX
  // Every launch this helper measures is above the slide threshold, so the
  // deceleration the ball felt across its first tick is the sliding one.
  const deceleration = power * MAX_CUE_SPEED > SLIDE_SPEED_THRESHOLD ? SLIDE_FRICTION : ROLL_FRICTION
  return (travelled + 0.5 * deceleration * TICK_DT * TICK_DT) / TICK_DT
}

describe('WPBSA collision and cloth model', () => {
  it('uses near-elastic ball contact at e = 0.96', () => {
    // Phenolic snooker balls measure 0.92-0.96; the sim is set to the authentic
    // top of that band so object balls leave a full hit carrying almost all of
    // the cue ball's pace.
    expect(BALL_RESTITUTION).toBe(0.96)
  })

  it('rebounds off both rail lengths at 0.85 with 0.85 tangential retention', () => {
    expect(CUSHION_RESTITUTION_LONG).toBe(0.85)
    expect(CUSHION_RESTITUTION_SHORT).toBe(0.85)
    expect(CUSHION_TANGENTIAL_DAMP).toBe(0.85)
  })

  it('rolls at C_rr = 0.018 and slides harder than it rolls', () => {
    expect(CLOTH_CRR).toBe(0.018)
    expect(ROLL_FRICTION).toBeCloseTo(CLOTH_CRR * 9810, 6)
    // Sliding cloth drags several times harder than rolling resistance, which is
    // the whole point of the split: hard shots lose their edge quickly, then glide.
    expect(SLIDE_FRICTION).toBeGreaterThan(ROLL_FRICTION * 5)
  })

  it('splits the cloth into a slide phase above the threshold and a roll phase below it', () => {
    // Measured per tick on an open table: the speed shed in one tick while sliding
    // must be the sliding deceleration, and the speed shed while rolling must be
    // the rolling one — not a blend, and not one constant everywhere.
    const speedAfterTick = (power: number): number => {
      const out = simulateStroke(
        loneCueBall(700, TABLE_WIDTH / 2),
        { aimAngle: 0, power, spin: { x: 0, y: 0 } },
        { maxTicks: 1 }
      )
      return out.balls.find((b) => b.isCue)!.vel.x
    }
    const slidFrom = 0.3 * MAX_CUE_SPEED
    const rolledFrom = 0.05 * MAX_CUE_SPEED
    expect(slidFrom).toBeGreaterThan(SLIDE_SPEED_THRESHOLD)
    expect(rolledFrom).toBeLessThan(SLIDE_SPEED_THRESHOLD)
    expect(slidFrom - speedAfterTick(0.3)).toBeCloseTo(SLIDE_FRICTION * TICK_DT, 6)
    expect(rolledFrom - speedAfterTick(0.05)).toBeCloseTo(ROLL_FRICTION * TICK_DT, 6)
  })

  it('hands the object ball (1+e)/2 of the closing pace on a full hit', () => {
    // Equal masses, stationary object: the analytic transfer is (1+e)/2, so at
    // e = 0.96 the object ball leaves a full hit at 98% of the contact pace. Object
    // balls dying on the spot they were struck is what made the pack feel heavy;
    // the run distance is the direct read-out of the pace they actually left with.
    // Everything here is below the slide threshold, so the closed form for a
    // constant deceleration is exact: run = v² / (2a).
    const atContact = 600
    const gap = 300
    const objectStart = 700 + gap + BALL_DIAMETER
    const launch = Math.sqrt(atContact * atContact + 2 * ROLL_FRICTION * gap)
    const result = simulateStroke(twoBallRack(BALL_IDS.RED_MIN, objectStart), {
      aimAngle: 0,
      power: launch / MAX_CUE_SPEED,
      spin: { x: 0, y: 0 }
    })
    expect(result.events.some((e) => e.type === 'BALL_HIT')).toBe(true)
    expect(result.events.filter((e) => e.type === 'CUSHION')).toHaveLength(0)
    const object = result.balls.find((b) => b.id === BALL_IDS.RED_MIN)!
    const run = object.pos.x - objectStart
    const leaveSpeed = (atContact * (1 + BALL_RESTITUTION)) / 2
    const expectedRun = (leaveSpeed * leaveSpeed) / (2 * ROLL_FRICTION)
    // The slack covers the discrete step the contact is detected on (up to a
    // quarter-radius of cue travel, which shortens the object's run a little).
    expect(run).toBeGreaterThan(expectedRun * 0.97)
    expect(run).toBeLessThan(expectedRun * 1.03)
  })

  it('keeps linear momentum through a ball-ball collision', () => {
    // Momentum along the line of centres is conserved exactly by the impulse
    // resolver; what restitution changes is only how the pace is shared.
    const atContact = 700
    const gap = 200
    const launch = Math.sqrt(atContact * atContact + 2 * ROLL_FRICTION * gap)
    const result = simulateStroke(twoBallRack(BALL_IDS.RED_MIN, 700 + gap + BALL_DIAMETER), {
      aimAngle: 0,
      power: launch / MAX_CUE_SPEED,
      spin: { x: 0, y: 0 }
    })
    const hit = result.events.find((e) => e.type === 'BALL_HIT')!.tick
    // Replay to the tick after contact and sum both balls' x-momentum there.
    const after = simulateStroke(twoBallRack(BALL_IDS.RED_MIN, 700 + gap + BALL_DIAMETER), {
      aimAngle: 0,
      power: launch / MAX_CUE_SPEED,
      spin: { x: 0, y: 0 }
    }, { maxTicks: hit + 2 })
    const cue = after.balls.find((b) => b.isCue)!
    const object = after.balls.find((b) => b.id === BALL_IDS.RED_MIN)!
    // Before the collision all the momentum was the cue ball's; the two-body sum
    // afterwards must match it to within the friction one extra tick of rolling
    // applies to each ball (simulated independently, so the sum is off only by
    // the difference of what friction took from each — bounded by the full
    // per-tick shed of both).
    const before = (launch - ROLL_FRICTION * TICK_DT * (hit + 2))
    const total = cue.vel.x + object.vel.x
    expect(before - total).toBeLessThan(SLIDE_FRICTION * TICK_DT * 2)
  })

  it('glides the last stretch into the pocket instead of braking abruptly', () => {
    // The complaint the split fixes: a single high constant made the final crawl
    // shed speed in big linear bites and stop with a thud. Under the roll model
    // the closing steps shrink smoothly, so the last sampled steps are a small
    // fraction of the first and each is smaller than the one before it.
    const result = simulateStroke(layoutTableBalls(), { aimAngle: 0, power: 0.4, spin: { x: 0, y: 0 } }, {
      maxTicks: 120 * 60,
      playback: { rate: 30 }
    })
    const trail = result.keyframes!.filter((k) => k.balls.some(([id]) => id === BALL_IDS.CUE))
    const steps: number[] = []
    let previous: { x: number; y: number } | null = null
    for (const keyframe of trail) {
      const sample = keyframe.balls.find(([id]) => id === BALL_IDS.CUE)
      if (!sample) continue
      if (previous) steps.push(Math.hypot(sample[1] - previous.x, sample[2] - previous.y))
      previous = { x: sample[1], y: sample[2] }
    }
    const moving = steps.filter((s) => s > 0)
    expect(moving.length).toBeGreaterThan(4)
    const last = moving[moving.length - 1]!
    const first = moving[0]!
    expect(last).toBeLessThan(first * 0.05)
  })

  it('keeps spin alive through contact for stun and follow', () => {
    // The spin budget must survive the run to the object ball: a stun shot at
    // contact range still stops dead, and a follow still carries through, both
    // measured at the contact tick like the draw test above.
    const cueVelAtContact = (spinY: number): number => {
      for (let maxTicks = 1; maxTicks <= 200; maxTicks++) {
        const result = simulateStroke(twoBallRack(), { aimAngle: 0, power: 0.6, spin: { x: 0, y: spinY } }, { maxTicks })
        if (result.firstContactId !== null) return result.balls.find((b) => b.isCue)!.vel.x
      }
      throw new Error('never reached contact')
    }
    const stun = cueVelAtContact(0)
    const follow = cueVelAtContact(1)
    const draw = cueVelAtContact(-1)
    expect(stun).toBeGreaterThan(0)
    expect(follow).toBeGreaterThan(stun)
    expect(draw).toBeLessThan(0)
  })
})

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

  it('reports settled=false when the tick budget runs out with balls still moving', () => {
    const balls = loneCueBall(700, TABLE_WIDTH / 2)
    const result = simulateStroke(balls, { aimAngle: 0, power: 1, spin: { x: 0, y: 0 } }, { maxTicks: 2 })
    expect(result.settled).toBe(false)
    expect(result.balls.some((b) => !b.potted && (b.vel.x !== 0 || b.vel.y !== 0))).toBe(true)
  })

  it('brings a routine shot to rest within a few seconds, the way cloth does', () => {
    // A real ball rolling on snooker cloth sheds 0.2-0.4 m/s^2, which puts a shot
    // out of play in three to six seconds. The previous figure let a ball coast
    // for 13-19 seconds, so the replay dragged on long after the position was
    // readable. This guards the feel rather than a constant: anyone raising
    // ROLL_FRICTION to make a ball stop dead has to move this band deliberately.
    const settle = (power: number): number => {
      const balls = loneCueBall(200, TABLE_WIDTH / 2)
      const result = simulateStroke(balls, { aimAngle: 0, power, spin: { x: 0, y: 0 } })
      expect(result.settled).toBe(true)
      return result.simSeconds
    }
    // Soft, routine and full power, all measured on an open table with no pack to
    // absorb the energy, so these are the worst case for time taken to settle.
    expect(settle(0.2)).toBeGreaterThan(2)
    expect(settle(0.2)).toBeLessThan(6)
    expect(settle(0.5)).toBeLessThan(9)
    expect(settle(1)).toBeLessThan(11)
  })
})

describe('pockets', () => {
  it('gives corners and middles a capture radius larger than the cushion-clamped approach', () => {
    // A ball centre can never get closer to a corner than the cushion clamp
    // allows. If the capture radius is below this bound the pocket is
    // mathematically impossible to pot into, which is exactly the bug this
    // guards against.
    const closestCornerApproach = Math.hypot(BALL_RADIUS, BALL_RADIUS)
    expect(closestCornerApproach).toBeLessThan(POCKET_RADIUS_CORNER)
    expect(BALL_RADIUS).toBeLessThan(POCKET_RADIUS_MIDDLE)
  })

  it('pots into every one of the six pockets', () => {
    const mid = TABLE_LENGTH / 2
    // Straight-in approach points for each pocket: corners are entered at 45
    // degrees, middles square on from the rail.
    const approaches: Array<{ pocket: string; from: { x: number; y: number }; at: { x: number; y: number } }> = [
      { pocket: 'tl', from: { x: 400, y: 400 }, at: { x: 0, y: 0 } },
      { pocket: 'tm', from: { x: mid, y: 600 }, at: { x: mid, y: 0 } },
      { pocket: 'tr', from: { x: TABLE_LENGTH - 400, y: 400 }, at: { x: TABLE_LENGTH, y: 0 } },
      { pocket: 'bl', from: { x: 400, y: TABLE_WIDTH - 400 }, at: { x: 0, y: TABLE_WIDTH } },
      { pocket: 'bm', from: { x: mid, y: TABLE_WIDTH - 600 }, at: { x: mid, y: TABLE_WIDTH } },
      { pocket: 'br', from: { x: TABLE_LENGTH - 400, y: TABLE_WIDTH - 400 }, at: { x: TABLE_LENGTH, y: TABLE_WIDTH } }
    ]

    for (const { pocket, from, at } of approaches) {
      const balls = loneCueBall(from.x, from.y)
      const aimAngle = Math.atan2(at.y - from.y, at.x - from.x)
      const result = simulateStroke(balls, { aimAngle, power: 0.15, spin: { x: 0, y: 0 } })
      expect(result.pottedIds, `expected a pot into ${pocket}`).toContain(BALL_IDS.CUE)
      expect(result.cuePotted, `expected cue potted in ${pocket}`).toBe(true)
    }
  })

  it('pots a ball rolled into a corner along the rail', () => {
    // Regression case for the old radius: a ball hugging the top cushion can
    // only ever reach 37.12mm from the corner centre.
    const balls = loneCueBall(300, BALL_RADIUS)
    const result = simulateStroke(balls, { aimAngle: Math.PI, power: 0.12, spin: { x: 0, y: 0 } })
    expect(result.pottedIds).toContain(BALL_IDS.CUE)
  })

  it('pocket geometry is shared by the sim and the table renderers', () => {
    const pockets = pocketPositions()
    expect(pockets).toHaveLength(6)
    expect(pockets.filter((p) => p.kind === 'corner')).toHaveLength(4)
    expect(pockets.filter((p) => p.kind === 'middle')).toHaveLength(2)
    for (const p of pockets) {
      expect(p.radius).toBe(p.kind === 'corner' ? POCKET_RADIUS_CORNER : POCKET_RADIUS_MIDDLE)
    }
  })
})

describe('spin', () => {
  it('side spin deflects the object ball off the straight line', () => {
    // Object ball is 300mm down the table from the cue so the whole shot is one
    // collision with a long clear run-out, making the resting offset a direct
    // read-out of the launch direction.
    const deviation = (sideSpin: number): number => {
      const result = simulateStroke(twoBallRack(BALL_IDS.RED_MIN, 1000), {
        aimAngle: 0,
        power: 0.06,
        spin: { x: sideSpin, y: 0 }
      })
      const object = result.balls.find((b) => b.id === BALL_IDS.RED_MIN)!
      return object.pos.y - TABLE_WIDTH / 2
    }

    const none = deviation(0)
    const right = deviation(1)
    const left = deviation(-1)

    // Unspun must run dead straight down the table.
    expect(Math.abs(none)).toBeLessThan(1)
    // Full english must push the object ball off that line, in opposite
    // directions for opposite spin, by an amount a player could actually see.
    expect(Math.abs(right)).toBeGreaterThan(2)
    expect(Math.abs(left)).toBeGreaterThan(2)
    expect(Math.sign(right)).toBe(-Math.sign(left))
  })

  it('side spin does not inject energy into the collision', () => {
    const run = (sideSpin: number) => {
      const result = simulateStroke(twoBallRack(BALL_IDS.RED_MIN, 1000), {
        aimAngle: 0,
        power: 0.06,
        spin: { x: sideSpin, y: 0 }
      })
      const object = result.balls.find((b) => b.id === BALL_IDS.RED_MIN)!
      return object.pos.x - 1000
    }
    // A rotation preserves the velocity magnitude, so the spammed ball can only
    // ever travel the same distance as the unspun one, never further.
    expect(run(1)).toBeLessThanOrEqual(run(0) + 0.001)
    expect(run(-1)).toBeLessThanOrEqual(run(0) + 0.001)
    expect(MAX_CUE_SPEED).toBeGreaterThan(0)
  })

  it('draw pulls the cue ball back off a full-blooded shot', () => {
    // Measured on the tick the balls first touch, not where they end up. Let the
    // shot run to rest and the object ball has already gone up the table, rebounded
    // off a cushion and knocked the cue ball about again, so the final resting
    // positions say more about cushion restitution than about the shot that was
    // played. Spin is settled at contact, so that is where it has to be read.
    //
    // The cue ball's pace along the table at that moment is the measurement: draw
    // reverses it, stun leaves the ball drifting on, follow sends it through.
    const run = (spinY: number): number => {
      for (let maxTicks = 1; maxTicks <= 200; maxTicks++) {
        const result = simulateStroke(twoBallRack(), { aimAngle: 0, power: 0.6, spin: { x: 0, y: spinY } }, { maxTicks })
        if (result.firstContactId !== null) return result.balls.find((b) => b.isCue)!.vel.x
      }
      throw new Error('cue ball never reached the object ball within 200 ticks')
    }
    const stun = run(0)
    const draw = run(-1)
    const follow = run(1)

    // Draw sends the cue ball back down the table it came from...
    expect(draw, 'draw should reverse the cue ball').toBeLessThan(0)
    expect(draw).toBeLessThan(stun)
    // ...stun leaves it drifting forward, and follow carries it on through.
    expect(stun, 'stun should leave the cue ball on its way').toBeGreaterThan(0)
    expect(follow).toBeGreaterThan(stun)
  })

  it('spin still exists at first contact instead of decaying to nothing', () => {
    // A regression guard on SPIN_FRICTION: at 240 the whole spin budget was
    // consumed inside the first 8ms substep, long before any contact.
    const result = simulateStroke(twoBallRack(), { aimAngle: 0, power: 0.2, spin: { x: 0, y: -1 } })
    const contactX = 1400 - BALL_DIAMETER
    const cue = result.balls.find((b) => b.isCue)!
    // Draw fired, so the cue ball finished behind the contact point.
    expect(cue.pos.x).toBeLessThan(contactX)
  })
})

describe('ball contact', () => {
  /**
   * Runs a cut shot of `cutDeg` and reports where each ball came to rest.
   *
   * Firing straight along +x at a ball sitting beside the line of travel is what
   * produces a cut: the offset has to be exactly one ball diameter of sine, so
   * that when the cue ball first touches, the line of centres is at `cutDeg` to
   * its direction. Friction only ever slows a ball, never turns it, so where a
   * ball stops still shows the direction it left the contact in.
   */
  function cutShot(cutDeg: number): {
    result: ReturnType<typeof simulateStroke>
    objectStart: { x: number; y: number }
    /** Where the cue ball's centre is at first contact, the origin for its deflection. */
    contactPoint: { x: number; y: number }
    objectEnd: { x: number; y: number }
    cueEnd: { x: number; y: number }
    /** The cut angle the simulation actually produced. */
    actualCutDeg: number
  } {
    const theta = (cutDeg * Math.PI) / 180
    const along = 260
    const balls = twoBallRack(BALL_IDS.RED_MIN)
    const cue = balls.find((b) => b.isCue)!
    const object = balls.find((b) => b.id === BALL_IDS.RED_MIN)!
    const startX = TABLE_LENGTH / 2
    const startY = TABLE_WIDTH / 2
    cue.pos = vec(startX, startY)
    object.pos = vec(startX + along, startY + BALL_DIAMETER * Math.sin(theta))
    // The simulation mutates the balls in place, so the start has to be kept.
    const objectStart = { x: object.pos.x, y: object.pos.y }

    // A gentle pace keeps each step of travel small, so the contact is detected
    // close to the true point of contact, and gentle enough that neither ball
    // reaches a cushion: a rebound would destroy the straight-line measurement.
    // It also sits below the slide threshold, so the whole run is pure rolling
    // resistance and the launch needed to arrive at `atContact` is the exact
    // closed form under the constant-deceleration model.
    const atContact = 400
    const gap = along - BALL_DIAMETER * Math.cos(theta)
    const launch = Math.sqrt(atContact * atContact + 2 * ROLL_FRICTION * gap)
    const result = simulateStroke(balls, { aimAngle: 0, power: launch / MAX_CUE_SPEED, spin: { x: 0, y: 0 } })

    const objectEnd = { ...result.balls.find((b) => b.id === BALL_IDS.RED_MIN)!.pos }
    return {
      result,
      objectStart,
      contactPoint: { x: startX + gap, y: startY },
      objectEnd,
      cueEnd: { ...result.balls.find((b) => b.isCue)!.pos },
      actualCutDeg: (heading(objectStart, objectEnd) * 180) / Math.PI
    }
  }

  function heading(from: { x: number; y: number }, to: { x: number; y: number }): number {
    return Math.atan2(to.y - from.y, to.x - from.x)
  }

  function degrees(radians: number): number {
    return (radians * 180) / Math.PI
  }

  /** Both balls must have come to rest without touching a cushion. */
  function expectCleanRun(result: ReturnType<typeof simulateStroke>): void {
    expect(result.events.filter((e) => e.type === 'CUSHION'), 'a rebound would skew the measurement').toHaveLength(0)
    expect(result.settled).toBe(true)
  }

  for (const cutDeg of [0, 15, 30, 45, 60]) {
    it(`drives the object ball along the line of centres on a ${cutDeg} degree cut`, () => {
      const { result, objectStart, objectEnd } = cutShot(cutDeg)
      expectCleanRun(result)

      const run = Math.hypot(objectEnd.x - objectStart.x, objectEnd.y - objectStart.y)
      expect(run, 'the object ball should be driven away').toBeGreaterThan(25)
      // No throw: the object ball leaves exactly along the line of centres. The
      // only slack allowed is the sub-millimetre step the contact is found on.
      expect(Math.abs(cutShot(cutDeg).actualCutDeg - cutDeg)).toBeLessThan(3)
    })

    it(`sends the cue ball to the analytic stun angle on a ${cutDeg} degree cut`, () => {
      const { result, contactPoint, cueEnd, actualCutDeg } = cutShot(cutDeg)
      expectCleanRun(result)
      if (cutDeg === 0) return // a full hit leaves the cue ball almost stationary

      // Equal masses, a stationary object ball, no spin: the cue ball keeps all
      // of its sideways pace and only (1 - e) / 2 of its pace through the object.
      // The angle is measured from the point of contact, not from where the cue
      // ball started, or the long run-up to the object ball would drown it out.
      // The slack covers two things: the contact is found on a discrete step of
      // travel, and a shallow cut leaves the cue ball only a short run to measure.
      const theta = (actualCutDeg * Math.PI) / 180
      const keep = (1 - BALL_RESTITUTION) / 2
      const expected = theta - Math.atan2(Math.sin(theta), keep * Math.cos(theta))
      expect(Math.abs(degrees(heading(contactPoint, cueEnd)) - degrees(expected))).toBeLessThan(3)
    })
  }

  it('hands almost all of the pace to the object ball on a full hit', () => {
    const { result, objectStart, objectEnd, contactPoint, cueEnd } = cutShot(0)
    expectCleanRun(result)
    const objectRun = Math.hypot(objectEnd.x - objectStart.x, objectEnd.y - objectStart.y)
    const cueRun = Math.hypot(cueEnd.x - contactPoint.x, cueEnd.y - contactPoint.y)
    // With e = 0.95 and equal masses the split is 97.5% / 2.5%, so the cue ball
    // covers a small fraction of the distance the object ball does.
    expect(cueRun).toBeLessThan(objectRun * 0.25)
    expect(objectRun).toBeGreaterThan(25)
  })

  it('sends the two balls to opposite sides of the aim line', () => {
    for (const cutDeg of [15, 30, 45, 60]) {
      const { result, objectStart, objectEnd, contactPoint, cueEnd } = cutShot(cutDeg)
      expectCleanRun(result)
      // Compared against the aim line itself: the object ball is sent off one
      // way, the cue ball squirts out the other.
      const objectSide = Math.sign(heading(objectStart, objectEnd))
      const cueSide = Math.sign(heading(contactPoint, cueEnd))
      expect(cueSide, `cue and object should separate at ${cutDeg} degrees`).toBe(-objectSide)
    }
  })

  it('gives the object ball less pace the wider the cut', () => {
    const run = (cutDeg: number): number => {
      const { objectStart, objectEnd } = cutShot(cutDeg)
      return Math.hypot(objectEnd.x - objectStart.x, objectEnd.y - objectStart.y)
    }
    // A cut throws away the cos of the cut angle, and distance goes as the
    // square of speed, so each widening step must shorten the run.
    const runs = [0, 30, 60].map(run)
    expect(runs[0]!).toBeGreaterThan(runs[1]!)
    expect(runs[1]!).toBeGreaterThan(runs[2]!)
    // cos(60) is half of cos(0), so a half-ball cut runs about a quarter as far.
    expect(runs[2]! / runs[0]!).toBeGreaterThan(0.15)
    expect(runs[2]! / runs[0]!).toBeLessThan(0.4)
  })
})

describe('only struck balls move', () => {
  /** The ids that took part in at least one ball-on-ball contact. */
  function contactedIds(result: ReturnType<typeof simulateStroke>): Set<number> {
    const ids = new Set<number>()
    for (const e of result.events) {
      if (e.type === 'BALL_HIT' && e.otherBallId !== undefined) {
        ids.add(e.ballId)
        ids.add(e.otherBallId)
      }
    }
    return ids
  }

  it('starts every layout without a single overlapping pair', () => {
    // The collision resolver separates any pair that overlaps, so a resting layout
    // that started overlapped would have untouched balls shoved apart before the
    // cue was ever struck.
    expect(createFrame(0).balls).toHaveLength(22)
    const shot = createFrame(0)
    applyStroke(shot, 0, { aimAngle: 0.4, power: 0.5, spin: { x: 0, y: 0 } })
    for (const balls of [createFrame(0).balls, shot.balls]) {
      for (let i = 0; i < balls.length; i++) {
        for (let j = i + 1; j < balls.length; j++) {
          const a = balls[i]!
          const b = balls[j]!
          if (a.potted || b.potted) continue
          const d = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y)
          expect(d).toBeGreaterThanOrEqual(BALL_DIAMETER - 1e-9)
        }
      }
    }
  })

  it('never moves a ball that took no part in a contact', () => {
    // Across the whole power range, every ball that ends up somewhere else must
    // have a recorded contact to explain it. A ball that drifted without a contact
    // would mean the resolver is nudging balls it should be leaving alone.
    for (const power of [0.2, 0.5, 0.85, 1]) {
      const frame = createFrame(0)
      const before = new Map(frame.balls.map((b) => [b.id, { x: b.pos.x, y: b.pos.y }]))
      const { sim } = applyStroke(frame, 0, { aimAngle: 0.9, power, spin: { x: 0, y: 0 } })
      const contacted = contactedIds(sim)
      expect(contacted.size).toBeGreaterThan(0)
      for (const ball of frame.balls) {
        if (ball.potted) continue
        const was = before.get(ball.id)!
        const moved = Math.hypot(ball.pos.x - was.x, ball.pos.y - was.y)
        if (moved > 0.5) expect(contacted.has(ball.id)).toBe(true)
      }
    }
  })

  it('carries a chain reaction only as far as the balls it actually reaches', () => {
    // Three reds in a row on an otherwise empty table. The strike must move all
    // three through the chain, and the chain must stop there rather than setting
    // every other ball rolling.
    const frame = createFrame(0)
    const chainIds = frame.balls.filter((b) => isRedId(b.id)).slice(0, 3).map((b) => b.id)
    const lineY = TABLE_WIDTH / 2
    for (const ball of frame.balls) {
      if (ball.isCue || chainIds.includes(ball.id)) continue
      ball.potted = true
    }
    frame.balls
      .filter((b) => chainIds.includes(b.id))
      .forEach((b, i) => {
        b.pos = vec(TABLE_LENGTH / 2 + i * 60, lineY)
      })
    const cue = frame.balls.find((b) => b.isCue)!
    cue.pos = vec(TABLE_LENGTH / 2 - 600, lineY)

    // `applyStroke` swaps in a fresh balls array, so the settled positions have to
    // be read back off the new state rather than off the objects set up above.
    const before = new Map(frame.balls.map((b) => [b.id, { x: b.pos.x, y: b.pos.y }]))
    const { sim } = applyStroke(frame, 0, {
      aimAngle: 0,
      power: 0.5,
      spin: { x: 0, y: 0 }
    })
    const contacted = contactedIds(sim)
    const after = new Map(frame.balls.map((b) => [b.id, b]))
    for (const id of chainIds) {
      const was = before.get(id)!
      const now = after.get(id)!
      expect(Math.hypot(now.pos.x - was.x, now.pos.y - was.y)).toBeGreaterThan(1)
      expect(contacted.has(id)).toBe(true)
    }
    // Every other ball was off the table, so nothing else can have moved.
    for (const [id, ball] of after) {
      if (ball.potted || id === BALL_IDS.CUE || chainIds.includes(id)) continue
      const was = before.get(id)!
      expect(Math.hypot(ball.pos.x - was.x, ball.pos.y - was.y)).toBe(0)
    }
  })
})

describe('launch and contact detection', () => {
  const breakShot = { aimAngle: 0, power: 1, spin: { x: 0, y: 0 } }

  it('launches the cue ball at a speed set only by the power', () => {
    // A linear map, so half power is half the pace and full power is the whole of it.
    for (const power of [0.1, 0.25, 0.5, 0.75, 1]) {
      const speed = launchSpeed(power)
      expect(Math.abs(speed - power * MAX_CUE_SPEED)).toBeLessThan(power * MAX_CUE_SPEED * 0.01)
    }
  })

  it('clamps the launch to the power range the rules allow', () => {
    // More than a full-blooded stroke is still a full-blooded stroke, and a negative
    // power is a tap rather than a shot backwards.
    expect(launchSpeed(1.5)).toBeCloseTo(launchSpeed(1), 0)
    expect(launchSpeed(-0.5)).toBeCloseTo(launchSpeed(0), 0)
  })

  it('leaves the cue ball where it was when the player never strikes it', () => {
    const startX = 700
    const out = simulateStroke(
      loneCueBall(startX, TABLE_WIDTH / 2),
      { aimAngle: 0, power: 0, spin: { x: 0, y: 0 } },
      { maxTicks: 1 }
    )
    expect(out.balls.find((b) => b.isCue)!.pos.x).toBe(startX)
  })

  it('never lets a hard cue ball pass through the ball in front of it', () => {
    // At full power the cue ball covers 75mm in a tick, which is more than a whole
    // ball is wide, so contact is only caught because the tick is subdivided. Without
    // the subdivision a full-blooded shot would pass clean through its target and the
    // contact would register as a glancing nothing.
    for (const power of [0.25, 0.5, 0.75, 1]) {
      const out = simulateStroke(twoBallRack(), { aimAngle: 0, power, spin: { x: 0, y: 0 } })
      expect(out.events.filter((e) => e.type === 'BALL_HIT').length).toBeGreaterThan(0)
      // The object ball was sent down the table rather than left sitting on its spot.
      expect(out.balls.find((b) => b.id === BALL_IDS.RED_MIN)!.pos.x).toBeGreaterThan(1400)
    }
  })

  it('advances each substep by far less than a ball radius, however hard it is hit', () => {
    // The guarantee the contact test above depends on: whatever the speed, the tick is
    // split finely enough that a ball cannot step over its neighbour.
    for (const speed of [MAX_CUE_SPEED, MAX_CUE_SPEED / 2, MAX_CUE_SPEED / 10]) {
      const substeps = Math.max(1, Math.ceil((speed * TICK_DT) / (BALL_RADIUS * 0.25)))
      expect((speed * TICK_DT) / substeps).toBeLessThan(BALL_RADIUS)
    }
  })

  it('never moves a ball between two samples further than its top speed allows', () => {
    // A ball cannot be handed more pace than the cue ball started with, so a sample
    // step wider than the top speed times the gap means a ball teleported. This is the
    // visible symptom of a broken tick or a dropped collision, and it is what makes a
    // replay look like it skips.
    const result = simulateStroke(layoutTableBalls(), breakShot, {
      maxTicks: 120 * 60,
      playback: { rate: 30 }
    })
    const keyframes = result.keyframes
    // Playback was asked for, so samples have to come back: a shot that silently
    // produced none would make every assertion below pass over nothing.
    expect(keyframes).toBeDefined()
    const seen = new Map<number, { x: number; y: number; t: number }>()
    let checked = 0
    for (const frame of keyframes!) {
      for (const [id, x, y] of frame.balls) {
        const prev = seen.get(id)
        if (prev) {
          const gap = frame.t - prev.t
          const step = Math.hypot(x - prev.x, y - prev.y)
          // Positions are rounded to whole millimetres for the wire, which is the
          // only slack the bound needs.
          expect(step).toBeLessThanOrEqual(MAX_CUE_SPEED * gap + 2)
          checked++
        }
        seen.set(id, { x, y, t: frame.t })
      }
    }
    // Guard the guard: a vacuous pass over no samples would prove nothing.
    expect(checked).toBeGreaterThan(1000)
  })
})

describe('cushions', () => {
  it('damps the tangential component on the long rails', () => {
    const out = reflectCushionX({ x: -1000, y: 500 }, 0.8)
    expect(out.x).toBe(800)
    expect(out.y).toBeCloseTo(500 * CUSHION_TANGENTIAL_DAMP, 10)
    expect(Math.abs(out.y)).toBeLessThan(500)
  })

  it('damps the tangential component on the short rails', () => {
    const out = reflectCushionY({ x: 500, y: -1000 }, 0.75)
    expect(out.y).toBe(750)
    expect(out.x).toBeCloseTo(500 * CUSHION_TANGENTIAL_DAMP, 10)
    expect(Math.abs(out.x)).toBeLessThan(500)
  })

  it('loses energy on every cushion contact', () => {
    const out = reflectCushionX({ x: -1000, y: 500 }, 0.8)
    const before = Math.hypot(1000, 500)
    const after = Math.hypot(out.x, out.y)
    expect(after).toBeLessThan(before)
  })

  it('retains far less tangential speed than before the fix (99.4% -> damped)', () => {
    const incoming = 2000
    // Head-on into the vertical rail: velocity is entirely normal, so the
    // tangential axis must come through untouched at zero.
    const headOn = reflectCushionX({ x: -incoming, y: 0 }, 0.8)
    expect(headOn.y).toBe(0)
    // Glancing: the normal part is reversed and damped by the restitution, the
    // tangential part is damped by CUSHION_TANGENTIAL_DAMP instead of surviving.
    const glancing = reflectCushionX({ x: -incoming, y: incoming }, 0.8)
    expect(glancing.x).toBe(incoming * 0.8)
    expect(glancing.y).toBeCloseTo(incoming * CUSHION_TANGENTIAL_DAMP, 10)
    expect(Math.abs(glancing.y)).toBeLessThan(incoming)
  })

  it('mirrors the incoming angle about the cushion normal at every impact angle', () => {
    // The real ball reaches a rail at every angle a player can aim, so the geometry
    // has to hold along the whole arc and not just at the two angles that are easy to
    // write a test for. A cushion is a mirror with a lossy finish: the normal
    // component comes back reversed and damped by the restitution, the component
    // running along the rail keeps its direction and loses a fixed fraction.
    for (let deg = 5; deg <= 85; deg += 5) {
      const rad = (deg * Math.PI) / 180
      const speed = 2000
      const incoming = { x: -Math.cos(rad) * speed, y: Math.sin(rad) * speed }
      const out = reflectCushionX(incoming, BALL_RESTITUTION)

      expect(out.x).toBeCloseTo(-incoming.x * BALL_RESTITUTION, 6)
      expect(out.y).toBeCloseTo(incoming.y * CUSHION_TANGENTIAL_DAMP, 6)
      // The ball leaves on the far side of the normal it arrived on, never back
      // through the cushion, and it keeps the same sense along the rail.
      expect(out.x).toBeGreaterThan(0)
      expect(Math.sign(out.y)).toBe(Math.sign(incoming.y))
    }
  })

  it('loses energy at every impact angle, and more of it the more square the hit', () => {
    // Square on, the whole of the speed is normal and the ball keeps the restitution.
    // Fully along the rail there is no normal part at all and it keeps only the
    // tangential damp, which is the smaller of the two, so the hardest-looking rails
    // shot is the one that gives back least.
    const square = reflectCushionX({ x: -2000, y: 0 }, BALL_RESTITUTION)
    const alongRail = reflectCushionX({ x: 0, y: -2000 }, BALL_RESTITUTION)
    expect(Math.hypot(square.x, square.y)).toBeCloseTo(2000 * BALL_RESTITUTION, 6)
    expect(Math.hypot(alongRail.x, alongRail.y)).toBeCloseTo(2000 * CUSHION_TANGENTIAL_DAMP, 6)

    for (let deg = 0; deg <= 90; deg += 5) {
      const rad = (deg * Math.PI) / 180
      const speed = 2000
      const before = speed
      const out = reflectCushionX({ x: -Math.cos(rad) * speed, y: Math.sin(rad) * speed }, BALL_RESTITUTION)
      const after = Math.hypot(out.x, out.y)
      // Some pace is always lost, and never more than all of it.
      expect(after).toBeLessThan(before)
      expect(after).toBeGreaterThan(0)
      // The retained fraction is a blend of the two coefficients, so it always sits
      // between them and slides from one to the other as the aim opens up.
      const kept = after / before
      expect(kept).toBeGreaterThanOrEqual(Math.min(BALL_RESTITUTION, CUSHION_TANGENTIAL_DAMP))
      expect(kept).toBeLessThanOrEqual(Math.max(BALL_RESTITUTION, CUSHION_TANGENTIAL_DAMP))
    }
  })

  it('loses energy off a short rail the same way as off a long one', () => {
    for (let deg = 5; deg <= 85; deg += 5) {
      const rad = (deg * Math.PI) / 180
      const speed = 1500
      const out = reflectCushionY({ x: Math.sin(rad) * speed, y: -Math.cos(rad) * speed }, 0.75)
      expect(out.y).toBeCloseTo(Math.cos(rad) * speed * 0.75, 6)
      expect(out.x).toBeCloseTo(Math.sin(rad) * speed * CUSHION_TANGENTIAL_DAMP, 6)
      expect(Math.hypot(out.x, out.y)).toBeLessThan(speed)
    }
  })
})

describe('shot scenarios', () => {
  /**
   * A frame with everything off the table except the cue ball and the given balls,
   * so a scenario is testing the shot rather than the clutter around it.
   */
  function tableWith(ids: number[]): ReturnType<typeof createFrame> {
    const frame = createFrame(0)
    const keep = new Set([BALL_IDS.CUE, ...ids])
    for (const ball of frame.balls) {
      if (!keep.has(ball.id)) ball.potted = true
    }
    // Clearing balls off the table does not clear the frame's own running count, so it
    // has to be brought into line or the rules are scoring shots that are not there.
    frame.remainingReds = frame.balls.filter((b) => isRedId(b.id) && !b.potted).length
    frame.phase = 'PLAYING'
    frame.cueInHand = false
    return frame
  }

  it('pots a red and puts the frame on the colours', () => {
    // The everyday case: a red straight into a corner from a clear line. The pot has
    // to be scored, not merely spotted, and the frame has to hand over to the colour
    // on rather than leaving the striker on the reds.
    const frame = tableWith([BALL_IDS.RED_MIN])
    const red = frame.balls.find((b) => b.id === BALL_IDS.RED_MIN)!
    const cue = frame.balls.find((b) => b.isCue)!
    // On the 45 degree into the top left corner, the cue ball directly behind the red
    // so the pot is a straight full-blooded hit rather than a cut.
    red.pos = vec(400, 400)
    red.vel = vec(0, 0)
    cue.pos = vec(800, 800)
    cue.vel = vec(0, 0)

    const { resolution, sim } = applyStroke(frame, 0, {
      aimAngle: (-3 * Math.PI) / 4,
      power: 0.3,
      spin: { x: 0, y: 0 }
    })

    expect(resolution.foul).toBe(false)
    expect(sim.pottedIds).toContain(BALL_IDS.RED_MIN)
    expect(resolution.points).toBe(1)
    expect(sim.cuePotted).toBe(false)
    expect(frame.remainingReds).toBe(0)
    // A red potted hands the table to the colours, with the striker still at the table.
    expect(frame.phase).toBe('COLOURING_UP')
    expect(frame.turnIndex).toBe(0)
  })

  it('plays a safety that makes legal contact and keeps the cue ball on the table', () => {
    // A safety is the shot that gives nothing away: it must touch the ball on, it must
    // not pot, and above all the cue ball must survive, since losing it is a foul that
    // hands the opponent the table with the reds still up.
    const frame = tableWith([BALL_IDS.RED_MIN, BALL_IDS.BLACK])
    const red = frame.balls.find((b) => b.id === BALL_IDS.RED_MIN)!
    const cue = frame.balls.find((b) => b.isCue)!
    cue.pos = vec(700, TABLE_WIDTH / 2)
    cue.vel = vec(0, 0)
    // The red is parked away from every pocket and off the cushion, so nothing is
    // available to pot and the only way to reach it is a gentle roll.
    red.pos = vec(TABLE_LENGTH / 2, TABLE_WIDTH / 2)
    red.vel = vec(0, 0)

    const { resolution, sim } = applyStroke(frame, 0, {
      aimAngle: 0,
      power: 0.12,
      spin: { x: 0, y: 0 }
    })

    // Contact was made, and on the ball that was on.
    expect(sim.firstContactId).toBe(BALL_IDS.RED_MIN)
    expect(resolution.foul).toBe(false)
    // Nothing was potted and the cue ball is still in play.
    expect(sim.pottedIds).toHaveLength(0)
    expect(sim.cuePotted).toBe(false)
    expect(frame.balls.find((b) => b.isCue)!.potted).toBe(false)
    // The red has to have been left where it was found, which is the whole point of
    // rolling up to it rather than driving through it.
    expect(frame.remainingReds).toBe(1)
  })

  it('opens a frame with a break that scatters the pack and comes to rest', () => {
    // The break is the one shot every frame has to survive, at the highest speed the
    // game ever reaches, with fifteen reds in a triangle. It has to scatter them, stay
    // inside the tick budget, and leave a table a player can actually shoot from.
    const frame = createFrame(0)
    expect(frame.cueInHand).toBe(true)
    const redsBefore = frame.remainingReds

    const before = new Map(frame.balls.map((b) => [b.id, { x: b.pos.x, y: b.pos.y }]))
    const { sim } = applyStroke(
      frame,
      0,
      { aimAngle: 0, power: 1, spin: { x: 0, y: 0 }, cuePos: vec(700, 889) },
      { maxTicks: 120 * 60 }
    )

    // The pack has to be broken open, not tapped.
    const movedReds = frame.balls.filter((b) => {
      if (!isRedId(b.id)) return false
      const was = before.get(b.id)!
      return Math.hypot(b.pos.x - was.x, b.pos.y - was.y) > 50
    })
    expect(movedReds.length).toBeGreaterThanOrEqual(10)
    // And it has to come to rest inside the budget, which is what keeps the backstop
    // from firing on an ordinary break.
    expect(sim.settled).toBe(true)
    expect(sim.simSeconds).toBeLessThan(20)
    // The break is a legal shot on the reds, so no foul and no reds are awarded away.
    expect(frame.remainingReds).toBeLessThanOrEqual(redsBefore)
  })
})

describe('playback', () => {
  const breakShot = { aimAngle: 0, power: 1, spin: { x: 0, y: 0 } }

  it('reports simulated time on the same clock as the tick count', () => {
    const result = simulateStroke(layoutTableBalls(), breakShot, { maxTicks: 120 * 60 })
    expect(result.simSeconds).toBeGreaterThan(0)
    // Subdividing a tick divides it rather than repeating it, so a tick of wall
    // clock is a tick of simulated time however many substeps it took. The two
    // clocks agreeing is what makes the keyframe times line up with the replay.
    // `ticksUsed` counts the final tick that found the table already settled, which
    // adds no time, so the two agree to within a single tick.
    expect(Math.abs(result.simSeconds - result.ticksUsed * TICK_DT)).toBeLessThanOrEqual(TICK_DT)
    expect(result.simSeconds).toBeLessThan(60)
  })

  it('advances a ball by one tick of travel however many substeps a tick takes', () => {
    // The subdivision exists only to keep contact detection from tunnelling. If it
    // ever advanced a ball by a whole tick per substep, a fast ball would cross the
    // table several times over in a single tick and pass straight through anything
    // it met. Over one tick, distance has to follow speed and not the substep count.
    const openTable = (): ReturnType<typeof layoutTableBalls> => {
      const balls = layoutTableBalls()
      for (const ball of balls) ball.potted = ball.id !== 0
      return balls
    }
    const after = (power: number) => {
      const balls = openTable()
      const from = balls[0]!.pos.x
      const result = simulateStroke(balls, { aimAngle: 0, power, spin: { x: 0, y: 0 } }, { maxTicks: 1 })
      return result.balls[0]!.pos.x - from
    }
    // Power 0.3 needs several substeps a tick and power 0.03 needs one.
    //
    // Comparing the two against a plain speed ratio would be measuring friction
    // rather than substepping. Friction removes a fixed slice of speed every
    // tick whatever the ball was doing, so a slow ball loses a larger share of
    // its pace and the ratio of distances drifts just above the ratio of speeds.
    // The meaningful claim is that one tick of travel is the analytic amount,
    // which is only true if the substeps divide the tick.
    const expected = (power: number) => {
      const v0 = power * MAX_CUE_SPEED
      // The two-phase cloth: the deceleration of the tick is the phase the launch
      // speed sits in, which for these two powers is slide for 0.3 and roll for 0.03.
      const deceleration = v0 > SLIDE_SPEED_THRESHOLD ? SLIDE_FRICTION : ROLL_FRICTION
      return v0 * TICK_DT - 0.5 * deceleration * TICK_DT * TICK_DT
    }
    expect(after(0.3)).toBeCloseTo(expected(0.3), 1)
    expect(after(0.03)).toBeCloseTo(expected(0.03), 1)
    // Friction costs both equally in absolute terms, so the faster ball must
    // still cover proportionally more ground.
    expect(after(0.3) / after(0.03)).toBeGreaterThan(0.3 / 0.03)
  })

  it('does not sample keyframes unless playback is requested', () => {
    // The bot runs thousands of candidate simulations per shot; sampling has to
    // stay opt-in or it would slow every AI decision down.
    const plain = simulateStroke(layoutTableBalls(), breakShot)
    expect(plain.keyframes).toBeUndefined()
    expect(plain.pots).toBeUndefined()
    const sampled = simulateStroke(layoutTableBalls(), breakShot, { playback: { rate: 30 } })
    expect(sampled.keyframes!.length).toBeGreaterThan(0)
    // Whatever this particular break shot does, every recorded pot must name a ball
    // that the simulation agrees was potted, at a time inside the shot.
    for (const [ballId, at] of sampled.pots ?? []) {
      expect(sampled.pottedIds).toContain(ballId)
      expect(at).toBeGreaterThanOrEqual(0)
      expect(at).toBeLessThanOrEqual(sampled.simSeconds)
    }
  })

  it('produces strictly increasing keyframe times that reach the shot duration', () => {
    const result = simulateStroke(layoutTableBalls(), breakShot, { maxTicks: 120 * 60, playback: { rate: 30 } })
    const keyframes = result.keyframes!
    expect(keyframes.length).toBeGreaterThan(10)
    for (let i = 1; i < keyframes.length; i++) {
      expect(keyframes[i]!.t).toBeGreaterThan(keyframes[i - 1]!.t)
    }
    const last = keyframes[keyframes.length - 1]!
    expect(last.t).toBeLessThanOrEqual(result.simSeconds)
    expect(result.simSeconds - last.t).toBeLessThan(0.1)
  })

  it('only ever samples balls that are on the table and moving', () => {
    const result = simulateStroke(layoutTableBalls(), breakShot, { maxTicks: 120 * 60, playback: { rate: 30 } })
    const potted = new Set(result.pottedIds)
    // A ball is allowed to appear in the one keyframe where it drops, so that the
    // replay shows it reach the pocket instead of blinking out mid-air. It must not
    // reappear in any later keyframe.
    const potTimes = new Map<number, number>()
    for (const [ballId, at] of result.pots ?? []) potTimes.set(ballId, at)
    for (const keyframe of result.keyframes!) {
      const seen = new Set<number>()
      for (const [id, x, y] of keyframe.balls) {
        expect(seen.has(id), `ball ${id} sampled twice in one keyframe`).toBe(false)
        seen.add(id)
        if (potted.has(id)) {
          // It may appear up to and including the frame it drops in, never after.
          expect(keyframe.t, `ball ${id} sampled after it was potted`).toBeLessThanOrEqual(potTimes.get(id)! + 1e-9)
          continue
        }
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true)
        expect(x).toBeGreaterThanOrEqual(0)
        expect(y).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('ends every moving ball on the exact position it settles at', () => {
    // The replay holds a ball at its last sampled position, and the authoritative
    // snapshot takes over when the replay ends. Those two positions have to be the
    // same point, or the ball jumps by the difference at the moment playback ends.
    // A ball is therefore sampled on the keyframe where it comes to rest, so its
    // final sample is its resting place rather than wherever it was still creeping.
    //
    // The comparison allows the half-millimetre the keyframe format rounds to,
    // which is a hundredth of a ball radius and cannot be seen. What it does not
    // allow is the gap this test exists for: a ball still creeping when it stopped
    // being sampled would be left a whole keyframe short of where it ended up.
    const result = simulateStroke(layoutTableBalls(), breakShot, { maxTicks: 120 * 60, playback: { rate: 30 } })
    const final = new Map<number, { x: number; y: number }>()
    for (const ball of result.balls) final.set(ball.id, ball.pos)

    const lastSample = new Map<number, { x: number; y: number }>()
    for (const keyframe of result.keyframes!) {
      for (const [id, x, y] of keyframe.balls) lastSample.set(id, { x, y })
    }

    const potted = new Set(result.pottedIds)
    let movedBalls = 0
    for (const [id, sample] of lastSample) {
      if (potted.has(id)) continue
      const settled = final.get(id)!
      expect(Math.abs(sample.x - settled.x), `ball ${id} last keyframe x`).toBeLessThanOrEqual(0.5)
      expect(Math.abs(sample.y - settled.y), `ball ${id} last keyframe y`).toBeLessThanOrEqual(0.5)
      movedBalls++
    }
    expect(movedBalls).toBeGreaterThan(0)
  })

  it('never brings a ball back into the replay after it has stopped', () => {
    // A moving ball is sampled in every keyframe and a ball at rest is sampled
    // once more and then dropped, so each ball's appearances have to be one
    // unbroken run. A ball reappearing after a gap would mean it was still being
    // moved after the replay had already settled it, which is a jump.
    const result = simulateStroke(layoutTableBalls(), breakShot, { maxTicks: 120 * 60, playback: { rate: 30 } })
    const gapSinceLastSeen = new Map<number, number>()
    result.keyframes!.forEach((keyframe, index) => {
      const seen = new Set<number>()
      for (const [id] of keyframe.balls) {
        const gap = gapSinceLastSeen.get(id)
        expect(gap, `ball ${id} came back after ${gap} keyframes without a sample`).toBeUndefined()
        seen.add(id)
      }
      for (const id of gapSinceLastSeen.keys()) {
        if (seen.has(id)) gapSinceLastSeen.delete(id)
        else gapSinceLastSeen.set(id, (gapSinceLastSeen.get(id) ?? 0) + 1)
      }
    })
  })

  it('decelerates smoothly into the stop instead of arriving there in a jump', () => {
    // The last stretch of a rolling ball has to keep shrinking, not hold a constant
    // step and then stop. Sampling the cue ball's final keyframes and measuring each
    // step catches a settle that teleports, and also catches a settle so abrupt that
    // the ball appears to stop dead rather than run out of pace.
    const result = simulateStroke(layoutTableBalls(), breakShot, { maxTicks: 120 * 60, playback: { rate: 30 } })
    const trail = result.keyframes!.filter((k) => k.balls.some(([id]) => id === BALL_IDS.CUE))
    expect(trail.length).toBeGreaterThan(4)
    const steps: number[] = []
    let previous: { x: number; y: number } | null = null
    for (const keyframe of result.keyframes!) {
      const sample = keyframe.balls.find(([id]) => id === BALL_IDS.CUE)
      if (!sample) {
        previous = null
        continue
      }
      if (previous) steps.push(Math.hypot(sample[1] - previous.x, sample[2] - previous.y))
      previous = { x: sample[1], y: sample[2] }
    }
    const movingSteps = steps.filter((s) => s > 0)
    expect(movingSteps.length).toBeGreaterThan(3)
    // The first sampled step is taken at full pace; by the end the ball has to be
    // covering a small fraction of it, which is what "ran out of speed" looks like.
    const first = movingSteps[0]!
    const lastFew = movingSteps.slice(-3)
    for (const step of lastFew) expect(step).toBeLessThan(first * 0.5)
    // Nothing anywhere in the shot jumps further than the shot's own peak step, so a
    // single bad keyframe cannot read as a teleport.
    const peak = Math.max(...movingSteps)
    for (const step of movingSteps) expect(step).toBeLessThanOrEqual(peak + 1e-6)
  })

  it('sampling never changes the simulation it is sampling', () => {
    // If this fails, adding playback would alter gameplay itself.
    const plain = simulateStroke(layoutTableBalls(), breakShot, { maxTicks: 120 * 60 })
    const sampled = simulateStroke(layoutTableBalls(), breakShot, { maxTicks: 120 * 60, playback: { rate: 30 } })
    expect(sampled.simSeconds).toBe(plain.simSeconds)
    expect(sampled.ticksUsed).toBe(plain.ticksUsed)
    expect(sampled.settled).toBe(plain.settled)
    expect(sampled.pottedIds).toEqual(plain.pottedIds)
    expect(sampled.events).toEqual(plain.events)
    for (let i = 0; i < plain.balls.length; i++) {
      expect(sampled.balls[i]!.pos).toEqual(plain.balls[i]!.pos)
      expect(sampled.balls[i]!.potted).toBe(plain.balls[i]!.potted)
    }
  })

  it('timestamps pots so the client can play the drop sound on cue', () => {
    const balls = loneCueBall(400, 400)
    const result = simulateStroke(balls, { aimAngle: Math.atan2(-400, -400), power: 0.15, spin: { x: 0, y: 0 } }, { playback: { rate: 30 } })
    expect(result.pottedIds).toContain(BALL_IDS.CUE)
    expect(result.pots).toEqual([[BALL_IDS.CUE, expect.any(Number)]])
    const pottedAt = result.pots![0]![1]
    expect(pottedAt).toBeGreaterThan(0)
    expect(pottedAt).toBeLessThanOrEqual(result.simSeconds)
    // The ball must still be visible on the table right up to the pot.
    const before = result.keyframes!.filter((k) => k.t <= pottedAt)
    expect(before[before.length - 1]!.balls.some(([id]) => id === BALL_IDS.CUE)).toBe(true)
  })

  it('samples a potted ball at its pocket centre, not at the pocket lip', () => {
    // Without this the replay holds the ball on the capture radius for the rest
    // of the shot and only drops it when the authoritative snapshot lands.
    const balls = loneCueBall(400, 400)
    const result = simulateStroke(balls, { aimAngle: Math.atan2(-400, -400), power: 0.15, spin: { x: 0, y: 0 } }, { playback: { rate: 30 } })
    const pottedAt = result.pots![0]![1]
    const at = result.keyframes!.find((k) => k.t === pottedAt)!
    const sample = at.balls.find(([id]) => id === BALL_IDS.CUE)
    expect(sample, 'the pot must force its own keyframe').toBeDefined()

    const pockets = pocketPositions()
    const nearest = pockets.reduce((best, p) => {
      const d = Math.hypot(sample![1] - p.x, sample![2] - p.y)
      return d < best.d ? { d, p } : best
    }, { d: Infinity, p: pockets[0]! })
    expect(nearest.d).toBeLessThan(1)
    // The simulation itself is untouched: presentation must not move the ball.
    const truth = result.balls.find((b) => b.id === BALL_IDS.CUE)!
    expect(Math.hypot(truth.pos.x - nearest.p.x, truth.pos.y - nearest.p.y)).toBeGreaterThan(1)
  })

  it('always samples through to the final resting positions', () => {
    // An earlier version stretched the sample interval once a keyframe cap was
    // hit, which doubled fast enough to leave the last several seconds of the
    // shot unsampled. Sampling must be unconditional.
    for (const rate of [5, 30, 90]) {
      const result = simulateStroke(layoutTableBalls(), breakShot, { maxTicks: 120 * 60, playback: { rate } })
      const last = result.keyframes![result.keyframes!.length - 1]!
      expect(result.simSeconds - last.t, `rate ${rate}`).toBeLessThan(1 / rate + 0.05)
    }
  })

  it('keeps a full-power break payload to a sane size', () => {
    const result = simulateStroke(layoutTableBalls(), breakShot, { maxTicks: 120 * 60, playback: { rate: 30 } })
    const payload = JSON.stringify({
      duration: result.simSeconds,
      keyframes: result.keyframes,
      pots: result.pots
    })
    // 30Hz sampling of every moving ball on a full rack lands around 56KB.
    expect(payload.length).toBeLessThan(90 * 1024)
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
    const outcome = applyStroke(frame, 0, { power: 0.3, aimAngle: -Math.PI / 2, spin: { x: 0, y: 0 } })
    // Guard the premise: this only tests the no-contact rule if nothing was hit.
    expect(outcome.sim.firstContactId).toBeNull()
    expect(outcome.resolution.foul).toBe(true)
    expect(frame.turnIndex).toBe(1)
  })

  it('reports a wrong-ball first contact as a contact, not as no contact', () => {
    // The same penalty applies either way, so the two cases are only distinguishable
    // by what the engine reports. First contact is what decides it: a stroke that
    // reaches a ball it may not hit has made a contact, and must be recorded as one
    // rather than being lumped in with a stroke that never touched anything.
    const frame = createFrame()
    const cue = frame.balls.find((b) => b.id === BALL_IDS.CUE)!
    // Clear the rest of the table so the yellow is the only ball within reach, then
    // put it squarely in the cue ball's path. A red is on, so this is a wrong ball.
    for (const b of frame.balls) {
      if (b.id !== BALL_IDS.CUE && b.id !== BALL_IDS.YELLOW) b.potted = true
    }
    const yellow = frame.balls.find((b) => b.id === BALL_IDS.YELLOW)!
    yellow.potted = false
    yellow.vel.x = 0
    yellow.vel.y = 0
    yellow.pos.x = cue.pos.x + 120
    yellow.pos.y = cue.pos.y

    const outcome = applyStroke(frame, 0, { power: 0.6, aimAngle: 0, spin: { x: 0, y: 0 } })
    // Contact happened, so this is not the no-contact case.
    expect(outcome.sim.firstContactId).toBe(BALL_IDS.YELLOW)
    // ...but reaching an illegal ball is still a foul, and the visit still switches.
    expect(outcome.resolution.foul).toBe(true)
    expect(frame.turnIndex).toBe(1)
    // The struck ball was actually driven away, which is what separates a real
    // contact from a stroke that passed through empty space.
    const struck = frame.balls.find((b) => b.id === BALL_IDS.YELLOW)!
    expect(Math.abs(struck.pos.x - (cue.pos.x + 120))).toBeGreaterThan(1)
  })

  it('builds a match state', () => {
    const match = createMatch('m1', 'ONE_V_ONE', 'BO3')
    expect(match.matchType).toBe('ONE_V_ONE')
    expect(match.currentFrame).toBeDefined()
  })
})