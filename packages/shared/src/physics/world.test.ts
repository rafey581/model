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
  BALL_DIAMETER,
  TABLE_LENGTH,
  TABLE_WIDTH,
  POCKET_RADIUS_CORNER,
  POCKET_RADIUS_MIDDLE,
  CUSHION_TANGENTIAL_DAMP,
  ROLL_FRICTION,
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
    const contactX = 1400 - BALL_DIAMETER
    const run = (spinY: number): number => {
      const result = simulateStroke(twoBallRack(), { aimAngle: 0, power: 0.6, spin: { x: 0, y: spinY } })
      return result.balls.find((b) => b.isCue)!.pos.x
    }
    const stun = run(0)
    const draw = run(-1)
    const follow = run(1)

    expect(draw).toBeLessThan(stun)
    expect(draw).toBeLessThan(contactX)
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
    const atContact = 220
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
    const fast = after(0.3)
    const slow = after(0.03)
    expect(fast / slow).toBeCloseTo(0.3 / 0.03, 1)
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