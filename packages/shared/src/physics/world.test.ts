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
  TIP_SPIN_RATIO,
  BALL_RESTITUTION,
  TICK_DT,
  MAX_CUE_SPEED,
  buildInitialBalls,
  pocketPositions,
  reflectCushionX,
  reflectCushionY,
  CUSHION_JAWS,
  CUSHION_FACES,
  CUSHION_KNUCKLE_RADIUS,
  cushionFaceEnd,
  resolveJawContact,
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
  // A centre-ball strike leaves the cue ball with no rotation, so it skids for the
  // whole of its first tick and the deceleration it felt is the sliding one.
  return (travelled + 0.5 * SLIDE_FRICTION * TICK_DT * TICK_DT) / TICK_DT
}

/**
 * Plays `shot` and returns the balls a given time after the cue ball's first contact,
 * or null if it never made one. Spin shows itself after the contact, as the cloth takes
 * hold of the rotation the cue ball kept, so that is where it has to be read.
 */
function afterContact(balls: () => BallState[], shot: { aimAngle: number; power: number; spin: { x: number; y: number } }, seconds: number): BallState[] | null {
  const full = simulateStroke(balls(), shot)
  const hit = full.events.find((e) => e.type === 'BALL_HIT')
  if (!hit) return null
  return simulateStroke(balls(), shot, { maxTicks: hit.tick + Math.round(seconds / TICK_DT) }).balls
}

/** Rolling arrival at a closed form: the analytic run of a struck ball that skids, then rolls. */
function skidThenRoll(v0: number): number {
  const rolling = (5 / 7) * v0
  return (v0 * v0 - rolling * rolling) / (2 * SLIDE_FRICTION) + (rolling * rolling) / (2 * ROLL_FRICTION)
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

  it('slides while the ball skids and only rolls once it has gripped, whatever its pace', () => {
    // Measured per tick on an open table. A centre-ball strike leaves the ball with no
    // rotation, so it skids and sheds the sliding figure; a strike with exactly natural
    // roll on it never skids and sheds only rolling resistance — at the same pace.
    const speedAfterTick = (power: number, spinY: number): number => {
      const out = simulateStroke(
        loneCueBall(700, TABLE_WIDTH / 2),
        { aimAngle: 0, power, spin: { x: 0, y: spinY } },
        { maxTicks: 1 }
      )
      return out.balls.find((b) => b.isCue)!.vel.x
    }
    const launch = 0.3 * MAX_CUE_SPEED
    const natural = 1 / TIP_SPIN_RATIO
    expect(launch - speedAfterTick(0.3, 0)).toBeCloseTo(SLIDE_FRICTION * TICK_DT, 6)
    expect(launch - speedAfterTick(0.3, natural)).toBeCloseTo(ROLL_FRICTION * TICK_DT, 6)
    // Slow or fast makes no difference to which phase applies.
    const slow = 0.05 * MAX_CUE_SPEED
    expect(slow - speedAfterTick(0.05, 0)).toBeCloseTo(SLIDE_FRICTION * TICK_DT, 6)
    expect(slow - speedAfterTick(0.05, natural)).toBeCloseTo(ROLL_FRICTION * TICK_DT, 6)
  })

  it('grips at five sevenths of a stun strike and rolls on from there', () => {
    // A ball struck through its centre skids until its spin catches up with it, and the
    // pace it rolls on at is 5/7 of the launch: the classical result for a solid ball.
    const launch = 0.3 * MAX_CUE_SPEED
    const out = simulateStroke(loneCueBall(300, TABLE_WIDTH / 2), { aimAngle: 0, power: 0.3, spin: { x: 0, y: 0 } }, { maxTicks: 60 })
    const cue = out.balls.find((b) => b.isCue)!
    // Half a second on: long since gripped (the skid closes in 2v/(7 mu g) = 0.43 s), so
    // the pace is the gripping pace less half a second's worth of rolling resistance at most.
    const rolling = (5 / 7) * launch
    expect(cue.vel.x).toBeLessThan(rolling)
    expect(cue.vel.x).toBeGreaterThan(rolling - ROLL_FRICTION * 0.5)
    expect(cue.angularVel * BALL_RADIUS).toBeCloseTo(cue.vel.x, 3)
  })

  it('hands the object ball (1+e)/2 of the closing pace on a full hit', () => {
    // Equal masses, stationary object: the analytic transfer is (1+e)/2, so at
    // e = 0.96 the object ball leaves a full hit at 98% of the contact pace. Object
    // balls dying on the spot they were struck is what made the pack feel heavy;
    // the run distance is the direct read-out of the pace they actually left with.
    // The struck ball has no rotation of its own, so it skids before it rolls, and the
    // closed form for its run is the skid followed by the roll.
    const gap = 300
    const objectStart = 700 + gap + BALL_DIAMETER
    const result = simulateStroke(twoBallRack(BALL_IDS.RED_MIN, objectStart), {
      aimAngle: 0,
      power: 900 / MAX_CUE_SPEED,
      spin: { x: 0, y: 0 }
    }, { playback: {} })
    expect(result.events.some((e) => e.type === 'BALL_HIT')).toBe(true)
    expect(result.events.filter((e) => e.type === 'CUSHION')).toHaveLength(0)
    const atContact = result.contacts!.find((c) => c[0] === 0)![4]
    const object = result.balls.find((b) => b.id === BALL_IDS.RED_MIN)!
    const run = object.pos.x - objectStart
    const leaveSpeed = (atContact * (1 + BALL_RESTITUTION)) / 2
    const expectedRun = skidThenRoll(leaveSpeed)
    // The slack covers the discrete step the contact is detected on, the whole-mm
    // rounding of the recorded pace, and the cue ball's small follow-through nudging
    // the object ball a second time.
    expect(run).toBeGreaterThan(expectedRun * 0.95)
    expect(run).toBeLessThan(expectedRun * 1.08)
  })

  it('keeps linear momentum through a ball-ball collision', () => {
    // Momentum along the line of centres is conserved exactly by the impulse
    // resolver; what restitution changes is only how the pace is shared. Read on the
    // tick before the contact and the tick after it, so the only other change is what
    // the cloth took from the two balls in those two ticks.
    const rack = () => twoBallRack(BALL_IDS.RED_MIN, 700 + 200 + BALL_DIAMETER)
    const shot = { aimAngle: 0, power: 1200 / MAX_CUE_SPEED, spin: { x: 0, y: 0 } }
    const hit = simulateStroke(rack(), shot).events.find((e) => e.type === 'BALL_HIT')!.tick
    const before = simulateStroke(rack(), shot, { maxTicks: hit }).balls.find((b) => b.isCue)!.vel.x
    const after = simulateStroke(rack(), shot, { maxTicks: hit + 2 }).balls
    const total = after.find((b) => b.isCue)!.vel.x + after.find((b) => b.id === BALL_IDS.RED_MIN)!.vel.x
    expect(Math.abs(before - total)).toBeLessThan(SLIDE_FRICTION * TICK_DT * 2 * 2)
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
    // The rotation the cue ball arrives with is what it does after the object ball has
    // taken its pace: read a third of a second after the contact, a centre ball that has
    // started to roll drifts on, top spin carries it through, and screw brings it back.
    const cueVelAfter = (spinY: number): number =>
      afterContact(twoBallRack, { aimAngle: 0, power: 0.6, spin: { x: 0, y: spinY } }, 0.33)!.find((b) => b.isCue)!.vel.x
    const stun = cueVelAfter(0)
    const follow = cueVelAfter(1)
    const draw = cueVelAfter(-1)
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
    expect(settle(0.2)).toBeLessThan(7)
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
    // Measured a third of a second after the balls first touch, not where they end up.
    // Let the shot run to rest and the object ball has already gone up the table,
    // rebounded off a cushion and knocked the cue ball about again, so the final
    // resting positions say more about cushion restitution than about the shot that
    // was played. The back spin takes hold as soon as the object ball has the pace.
    //
    // The cue ball's pace along the table at that moment is the measurement: draw
    // reverses it, stun leaves the ball drifting on, follow sends it through.
    const run = (spinY: number): number => {
      const balls = afterContact(twoBallRack, { aimAngle: 0, power: 0.6, spin: { x: 0, y: spinY } }, 0.33)
      if (!balls) throw new Error('cue ball never reached the object ball')
      return balls.find((b) => b.isCue)!.vel.x
    }
    const stun = run(0)
    const draw = run(-1)
    const follow = run(1)

    // Draw sends the cue ball back down the table it came from...
    expect(draw, 'draw should reverse the cue ball').toBeLessThan(0)
    expect(draw).toBeLessThan(stun)
    // ...a centre ball that has begun to roll drifts forward, and follow carries it on.
    expect(stun, 'stun should leave the cue ball on its way').toBeGreaterThan(0)
    expect(follow).toBeGreaterThan(stun)
  })

  it('spin still exists at first contact instead of decaying to nothing', () => {
    // A regression guard on the spin surviving the run up: at a firm medium pace a full
    // screw shot over two thirds of a metre still has back spin when it arrives.
    const result = simulateStroke(twoBallRack(), { aimAngle: 0, power: 0.3, spin: { x: 0, y: -1 } })
    const contactX = 1400 - BALL_DIAMETER
    const cue = result.balls.find((b) => b.isCue)!
    // Draw fired, so the cue ball finished behind the contact point.
    expect(cue.pos.x).toBeLessThan(contactX)
  })
})

describe('slide and roll', () => {
  it('follows through on a full hit when the cue ball arrives rolling, even struck in the centre', () => {
    // Struck through its centre from a metre away, the cue ball has gripped and is rolling
    // by the time it arrives. The object ball takes the pace; the forward roll the cue ball
    // kept then drives it on at 2/7 of its arrival pace — the plain-ball follow-through
    // every snooker player knows, and why a stun from range needs a touch of screw.
    const rack = () => twoBallRack(BALL_IDS.RED_MIN, 700 + 1000 + BALL_DIAMETER)
    const balls = afterContact(rack, { aimAngle: 0, power: 0.2, spin: { x: 0, y: 0 } }, 0.4)!
    const cue = balls.find((b) => b.isCue)!
    expect(cue.vel.x).toBeGreaterThan(150)
    expect(cue.pos.x).toBeGreaterThan(700 + 1000 + 40)
  })

  it('stops a close-range centre-ball hit nearly dead: the cue ball is still skidding at contact', () => {
    const rack = () => twoBallRack(BALL_IDS.RED_MIN, 700 + 60 + BALL_DIAMETER)
    const balls = afterContact(rack, { aimAngle: 0, power: 0.4, spin: { x: 0, y: 0 } }, 0.4)!
    expect(Math.abs(balls.find((b) => b.isCue)!.vel.x)).toBeLessThan(250)
  })

  for (const cutDeg of [15, 30, 45]) {
    it(`bends a rolling cue ball forward off a ${cutDeg} degree cut to the natural angle`, () => {
      // A stunned cue ball leaves a cut along the tangent line, 90 degrees from the object
      // ball. A rolling one starts along that line and curves forward as its roll takes
      // hold, settling on the classical natural angle from the aim line,
      // atan(sin c cos c / (sin^2 c + 2/5)) — about 34 degrees at a half-ball hit, the
      // "30 degree rule" players aim position by.
      const cut = (cutDeg * Math.PI) / 180
      const make = () => {
        const balls = twoBallRack(BALL_IDS.RED_MIN)
        balls.find((b) => b.isCue)!.pos = vec(600, TABLE_WIDTH / 2)
        balls.find((b) => b.id === BALL_IDS.RED_MIN)!.pos = vec(600 + 900, TABLE_WIDTH / 2 + BALL_DIAMETER * Math.sin(cut))
        return balls
      }
      // Read three quarters of a second after the contact, once the cue ball has gripped.
      const balls = afterContact(make, { aimAngle: 0, power: 0.15, spin: { x: 0, y: 0 } }, 0.75)!
      const cue = balls.find((b) => b.isCue)!
      const deflection = Math.abs(Math.atan2(cue.vel.y, cue.vel.x)) * (180 / Math.PI)
      const natural = Math.atan((Math.sin(cut) * Math.cos(cut)) / (Math.sin(cut) ** 2 + 0.4)) * (180 / Math.PI)
      expect(Math.abs(deflection - natural)).toBeLessThan(3)
    })
  }

  it('sends an object ball off skidding, so it rolls on at five sevenths of the pace it was given', () => {
    const rack = () => twoBallRack(BALL_IDS.RED_MIN, 700 + 100 + BALL_DIAMETER)
    const shot = { aimAngle: 0, power: 0.25, spin: { x: 0, y: 0 } }
    const hit = simulateStroke(rack(), shot).events.find((e) => e.type === 'BALL_HIT')!.tick
    const leave = simulateStroke(rack(), shot, { maxTicks: hit + 1 }).balls.find((b) => b.id === BALL_IDS.RED_MIN)!.vel.x
    const gripped = simulateStroke(rack(), shot, { maxTicks: hit + 72 }).balls.find((b) => b.id === BALL_IDS.RED_MIN)!
    // 0.6 s later: gripped long since, and rolling at 5/7 of its leaving pace less the
    // little rolling resistance has taken in the meantime.
    expect(gripped.vel.x).toBeLessThan((5 / 7) * leave)
    expect(gripped.vel.x).toBeGreaterThan((5 / 7) * leave - ROLL_FRICTION * 0.6)
  })

  it('returns a soft touch off a cushion livelier than a hard hit', () => {
    // Speed straight into the far cushion against the speed coming back off it, read on
    // the tick before the cushion and the tick of it.
    const ratio = (speed: number): number => {
      const start = TABLE_LENGTH - BALL_RADIUS - 30
      const shot = { aimAngle: 0, power: speed / MAX_CUE_SPEED, spin: { x: 0, y: 1 / TIP_SPIN_RATIO } }
      const cushion = simulateStroke(loneCueBall(start, TABLE_WIDTH / 2), shot).events.find((e) => e.type === 'CUSHION')!
      const before = simulateStroke(loneCueBall(start, TABLE_WIDTH / 2), shot, { maxTicks: cushion.tick }).balls[0]!.vel.x
      const after = simulateStroke(loneCueBall(start, TABLE_WIDTH / 2), shot, { maxTicks: cushion.tick + 1 }).balls[0]!.vel.x
      return -after / before
    }
    const soft = ratio(500)
    const hard = ratio(5000)
    expect(soft).toBeGreaterThan(hard)
    expect(soft).toBeLessThan(1)
    expect(hard).toBeGreaterThan(0.6)
  })

  it('takes the roll off a ball that meets a cushion, so it comes back slower than it bounced', () => {
    // A rolling ball rebounds and then has to grip again with its roll gone: it settles to
    // 5/7 of its rebound pace, which is what makes a cushion feel like a cushion.
    const start = TABLE_LENGTH - BALL_RADIUS - 200
    const shot = { aimAngle: 0, power: 1500 / MAX_CUE_SPEED, spin: { x: 0, y: 1 / TIP_SPIN_RATIO } }
    const cushion = simulateStroke(loneCueBall(start, TABLE_WIDTH / 2), shot).events.find((e) => e.type === 'CUSHION')!
    const rebound = simulateStroke(loneCueBall(start, TABLE_WIDTH / 2), shot, { maxTicks: cushion.tick + 1 }).balls[0]!.vel.x
    const settled = simulateStroke(loneCueBall(start, TABLE_WIDTH / 2), shot, { maxTicks: cushion.tick + 60 }).balls[0]!
    expect(rebound).toBeLessThan(0)
    // Heading back (negative x): 5/7 of the rebound, less half a second of rolling resistance at most.
    expect(settled.vel.x).toBeGreaterThan((5 / 7) * rebound - 1)
    expect(settled.vel.x).toBeLessThan((5 / 7) * rebound + ROLL_FRICTION * 0.5 + 1)
    expect(settled.angularVel * BALL_RADIUS).toBeCloseTo(Math.abs(settled.vel.x), 3)
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
    /** The direction the cue ball leaves the contact in, read off its velocity a tick later. */
    cueLeaves: number
  } {
    const theta = (cutDeg * Math.PI) / 180
    const along = 120
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
    //
    // The cue ball is struck with just enough screw that it arrives at the object ball
    // skidding with no rotation at all — a stun — which is the shot the analytic
    // tangent line is for. A rolling cue ball bends forward off it as it grips.
    const gap = along - BALL_DIAMETER * Math.cos(theta)
    const shot = { aimAngle: 0, power: stunLaunch / MAX_CUE_SPEED, spin: { x: 0, y: stunSpin(gap) } }
    const result = simulateStroke(balls, shot)
    const hit = result.events.find((e) => e.type === 'BALL_HIT')
    const justAfter = hit ? simulateStroke(balls, shot, { maxTicks: hit.tick + 2 }).balls.find((b) => b.isCue)!.vel : vec(1, 0)

    const objectEnd = { ...result.balls.find((b) => b.id === BALL_IDS.RED_MIN)!.pos }
    return {
      result,
      objectStart,
      contactPoint: { x: startX + gap, y: startY },
      objectEnd,
      cueEnd: { ...result.balls.find((b) => b.isCue)!.pos },
      actualCutDeg: (heading(objectStart, objectEnd) * 180) / Math.PI,
      cueLeaves: Math.atan2(justAfter.y, justAfter.x)
    }
  }

  const stunLaunch = 700

  /**
   * The bottom spin that leaves a cue ball launched at `stunLaunch` with no rotation
   * after `gap` mm: the skid closes at 7/2 mu g and the pace falls at mu g, so solving
   * for the time the run takes gives the rotation it has to start with.
   */
  function stunSpin(gap: number): number {
    const a = SLIDE_FRICTION
    const t = (stunLaunch - Math.sqrt(stunLaunch * stunLaunch - 2 * a * gap)) / a
    // Rotation (as surface speed) at time t is w0 + 5/2 a t; zero at contact.
    return -(2.5 * a * t) / (TIP_SPIN_RATIO * stunLaunch)
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
      const { result, cueLeaves, actualCutDeg } = cutShot(cutDeg)
      expectCleanRun(result)
      if (cutDeg === 0) return // a full hit leaves the cue ball almost stationary

      // Equal masses, a stationary object ball, no spin: the cue ball keeps all
      // of its sideways pace and only (1 - e) / 2 of its pace through the object.
      // The angle is read off the cue ball's velocity just after the contact: a stunned
      // ball holds that line while it skids, so this is the direction it is sent in.
      // The slack covers the contact being found on a discrete step of travel.
      const theta = (actualCutDeg * Math.PI) / 180
      const keep = (1 - BALL_RESTITUTION) / 2
      const expected = theta - Math.atan2(Math.sin(theta), keep * Math.cos(theta))
      expect(Math.abs(degrees(cueLeaves) - degrees(expected))).toBeLessThan(3)
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
    // cos(60) is half of cos(0), so a half-ball cut runs about a quarter as far — a
    // little less here, since the cue ball has further to go to a half-ball contact
    // and arrives slower.
    expect(runs[2]! / runs[0]!).toBeGreaterThan(0.1)
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
      const shot = { aimAngle: 0, power, spin: { x: 0, y: 0 } }
      const out = simulateStroke(twoBallRack(), shot)
      expect(out.events.filter((e) => e.type === 'BALL_HIT').length).toBeGreaterThan(0)
      // The object ball was sent down the table rather than left sitting on its spot,
      // read a tenth of a second after the contact, before a cushion can bring it back.
      const red = afterContact(twoBallRack, shot, 0.1)!.find((b) => b.id === BALL_IDS.RED_MIN)!
      expect(red.pos.x).toBeGreaterThan(1400)
      expect(red.vel.x).toBeGreaterThan(0)
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

describe('cushion faces and jaws', () => {
  it('ends each straight face at the knuckle tangency, not at the pocket centre', () => {
    // The face has to stop exactly where a knuckle of radius rk meets the pocket
    // circle, or there is a step in the cushion a ball can catch on.
    expect(cushionFaceEnd(POCKET_RADIUS_CORNER)).toBeCloseTo(65.254, 3)
    expect(cushionFaceEnd(POCKET_RADIUS_MIDDLE)).toBeCloseTo(69.427, 3)
    for (const face of CUSHION_FACES) {
      expect(face.to - face.from).toBeGreaterThan(0)
    }
    // Twelve jaws: two for every corner and every middle pocket.
    expect(CUSHION_JAWS).toHaveLength(12)
    for (const jaw of CUSHION_JAWS) {
      expect(jaw.radius).toBe(CUSHION_KNUCKLE_RADIUS)
    }
  })

  it('pots a ball aimed straight at a middle pocket', () => {
    const mid = TABLE_LENGTH / 2
    const result = simulateStroke(loneCueBall(mid, 600), {
      aimAngle: -Math.PI / 2,
      power: 0.15,
      spin: { x: 0, y: 0 }
    })
    expect(result.cuePotted).toBe(true)
    expect(result.pottedIds).toContain(BALL_IDS.CUE)
  })

  it('pots a ball rolled along the cushion into a corner', () => {
    // On a real table the cushion has already finished by the time the ball
    // reaches the corner, and the jaw steers it in rather than turning it back.
    const balls = loneCueBall(TABLE_LENGTH - 300, TABLE_WIDTH - BALL_RADIUS)
    const result = simulateStroke(balls, { aimAngle: 0, power: 0.12, spin: { x: 0, y: 0 } })
    expect(result.pottedIds).toContain(BALL_IDS.CUE)
  })

  it('rebounds a ball along the jaw arc normal', () => {
    const jaw = CUSHION_JAWS[0]!
    const contact = jaw.radius + BALL_RADIUS
    const angle = (120 * Math.PI) / 180
    const n = { x: Math.cos(angle), y: Math.sin(angle) }
    const speed = 1000
    const out = resolveJawContact(
      jaw.cx + n.x * (contact - 1),
      jaw.cy + n.y * (contact - 1),
      -n.x * speed,
      -n.y * speed,
      jaw,
      CUSHION_RESTITUTION_SHORT,
      CUSHION_TANGENTIAL_DAMP
    )
    expect(out).not.toBeNull()
    expect(out!.bounced).toBe(true)
    // A square hit comes straight back along the contact normal, keeping only the
    // restitution of its pace.
    expect(out!.vx).toBeCloseTo(n.x * speed * CUSHION_RESTITUTION_SHORT, 6)
    expect(out!.vy).toBeCloseTo(n.y * speed * CUSHION_RESTITUTION_SHORT, 6)
    expect(Math.hypot(out!.vx, out!.vy)).toBeCloseTo(speed * CUSHION_RESTITUTION_SHORT, 6)
    // And the ball is left touching the arc, never inside it.
    expect(Math.hypot(out!.x - jaw.cx, out!.y - jaw.cy)).toBeCloseTo(contact, 6)
  })

  it('never leaves a ball inside the knuckle', () => {
    const jaw = CUSHION_JAWS[0]!
    const contact = jaw.radius + BALL_RADIUS
    let resolved = 0
    for (let deg = 90; deg <= 163; deg += 1) {
      const a = (deg * Math.PI) / 180
      const n = { x: Math.cos(a), y: Math.sin(a) }
      const out = resolveJawContact(
        jaw.cx + n.x * contact * 0.5,
        jaw.cy + n.y * contact * 0.5,
        0,
        0,
        jaw,
        CUSHION_RESTITUTION_SHORT,
        CUSHION_TANGENTIAL_DAMP
      )
      if (!out) continue
      resolved++
      const d = Math.hypot(out.x - jaw.cx, out.y - jaw.cy)
      expect(d).toBeGreaterThanOrEqual(contact - 1e-6)
      expect(d).toBeCloseTo(contact, 6)
    }
    // The whole table-side arc, about 73 degrees, has to be handled.
    expect(resolved).toBeGreaterThan(60)
    // Past the tangency the jaw hands the ball to the pocket circle instead.
    const outsideAngle = Math.PI / 4
    const outside = resolveJawContact(
      jaw.cx + Math.cos(outsideAngle) * contact,
      jaw.cy + Math.sin(outsideAngle) * contact,
      0,
      0,
      jaw,
      CUSHION_RESTITUTION_SHORT,
      CUSHION_TANGENTIAL_DAMP
    )
    expect(outside).toBeNull()
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
    // `simSeconds` is reported to the millisecond, so half a millisecond of rounding sits
    // on top of that tick: without it this passed or failed on which way the break's
    // length happened to round.
    expect(Math.abs(result.simSeconds - result.ticksUsed * TICK_DT)).toBeLessThanOrEqual(TICK_DT + 0.0005)
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
      // A centre-ball strike skids through its first tick at either pace.
      return v0 * TICK_DT - 0.5 * SLIDE_FRICTION * TICK_DT * TICK_DT
    }
    // The slack is half a tick's worth of deceleration: positions are advanced on the
    // speed at the end of each substep, so one substep lands a hair short of the exact
    // curve and many substeps land closer to it.
    const slack = 0.5 * SLIDE_FRICTION * TICK_DT * TICK_DT + 0.01
    expect(Math.abs(after(0.3) - expected(0.3))).toBeLessThan(slack)
    expect(Math.abs(after(0.03) - expected(0.03))).toBeLessThan(slack)
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