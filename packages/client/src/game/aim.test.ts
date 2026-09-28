import { describe, expect, it } from 'vitest'
import { BALL_RADIUS, TABLE_LENGTH, TABLE_WIDTH } from '@snooker/shared'
import { computeAimGuide, type AimGuideBall } from './aim.js'

const CUE = { x: 700, y: 400, id: 0 }

function ball(id: number, x: number, y: number): AimGuideBall {
  return { id, x, y, potted: false }
}

/** The angle from the cue ball to a ball, which is how a full ball is lined up. */
function at(x: number, y: number): number {
  return Math.atan2(y - CUE.y, x - CUE.x)
}

describe('cue ball deflection after contact', () => {
  it('leaves the cue ball nothing to do on a full ball', () => {
    // Struck dead centre, every bit of the strike goes into the object ball along the
    // line of centres, so the cue ball has no sideways motion left and stops. This is
    // the case that makes the prediction a real check rather than a decoration: an
    // earlier guide that always drew a path would have to lie here.
    const guide = computeAimGuide(CUE, at(1200, 400), [ball(1, 1200, 400)])

    expect(guide).not.toBeNull()
    expect(guide!.targetId).toBe(1)
    // The line of centres is straight down the aim line on a full ball.
    expect(guide!.lineOfCentres.x).toBeCloseTo(1, 5)
    expect(guide!.lineOfCentres.y).toBeCloseTo(0, 5)
    // Nothing survives as sideways motion, so the cue ball stays put.
    expect(guide!.cuePath).toHaveLength(0)
  })

  it('sends the cue ball along the tangent at a right angle on a cut', () => {
    // Aiming 30mm past the target so the contact is off centre. That is within the
    // one-diameter contact window, so the cue ball really does clip it.
    const guide = computeAimGuide(CUE, at(1200, 400 + 30), [ball(1, 1200, 400)])

    expect(guide).not.toBeNull()
    expect(guide!.cuePath.length).toBeGreaterThan(0)

    const first = guide!.cuePath[0]!
    const runX = first.to.x - first.from.x
    const runY = first.to.y - first.from.y
    const runLength = Math.hypot(runX, runY)
    expect(runLength).toBeGreaterThan(1)

    // The tangent is the line of centres turned a quarter turn, so the dot product
    // of the two directions has to be zero.
    const dot = (runX / runLength) * guide!.lineOfCentres.x + (runY / runLength) * guide!.lineOfCentres.y
    expect(dot).toBeCloseTo(0, 6)

    // And it has to start where the contact happens, not at the aim line's end.
    expect(first.from.x).toBeCloseTo(guide!.ghost.x, 6)
    expect(first.from.y).toBeCloseTo(guide!.ghost.y, 6)
  })

  it('sends the cue ball to opposite sides of the target depending on the cut', () => {
    // Cutting the same ball from the other side reverses the tangent, so a guide
    // that ignored the sign of the sideways component would send both shots the same
    // way. That is the mistake this guards.
    const above = computeAimGuide(CUE, at(1200, 400 - 40), [ball(1, 1200, 400)])!
    const below = computeAimGuide(CUE, at(1200, 400 + 40), [ball(1, 1200, 400)])!

    const run = (g: typeof above) => {
      const s = g.cuePath[0]!
      return Math.atan2(s.to.y - s.from.y, s.to.x - s.from.x)
    }

    // The two shots are mirror images about the horizontal, so their departures must
    // be mirror images too rather than coincident.
    const wrapped = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
    expect(wrapped(run(below))).toBeCloseTo(wrapped(-run(above)), 6)
  })

  it('shows a path for any cut at all, however thin, and none on a full ball', () => {
    // The direction of the departure is exact, but its length is a drawing choice,
    // so the guide commits only to there being a path. A hair's-breadth cut is
    // still a cut, and treating it as a full ball would hide a real deflection.
    const pathFor = (offsetY: number) => {
      const g = computeAimGuide(CUE, at(1200, 400 + offsetY), [ball(1, 1200, 400)])
      return g?.cuePath ?? []
    }

    expect(pathFor(0)).toHaveLength(0)
    for (const thin of [5, 20, 45]) {
      expect(pathFor(thin).length, `expected a path for a ${thin}mm cut`).toBeGreaterThan(0)
    }
  })

  it('turns the path off the cushions instead of running it into the rail', () => {
    // A cut that sends the cue ball up towards the top cushion, with the cue ball
    // placed near enough that the rail is inside the drawn length. The guide has to
    // stop at the cushion and carry on the other way, because a ray that stopped at
    // the rail claims the ball ends there when it does not.
    const nearTop = { x: 700, y: 300, id: 0 }
    const angle = Math.atan2(260 - nearTop.y, 1200 - nearTop.x)
    const guide = computeAimGuide(nearTop, angle, [ball(1, 1200, 300)])

    expect(guide).not.toBeNull()
    expect(guide!.cuePath.length).toBeGreaterThan(1)

    // Every turn happens exactly on a cushion, never short of it and never past it.
    for (const segment of guide!.cuePath.slice(0, -1)) {
      const onRail =
        Math.abs(segment.to.x - BALL_RADIUS) < 1e-6 ||
        Math.abs(segment.to.x - (TABLE_LENGTH - BALL_RADIUS)) < 1e-6 ||
        Math.abs(segment.to.y - BALL_RADIUS) < 1e-6 ||
        Math.abs(segment.to.y - (TABLE_WIDTH - BALL_RADIUS)) < 1e-6
      expect(onRail).toBe(true)
    }
    // The turn is a genuine reflection, so the path leaves the cushion on the other
    // side of it rather than doubling back.
    const first = guide!.cuePath[0]!
    const second = guide!.cuePath[1]!
    const before = Math.atan2(first.to.y - first.from.y, first.to.x - first.from.x)
    const after = Math.atan2(second.to.y - second.to.y, second.to.x - second.to.x)
    expect(Math.abs(Math.sin(after - before))).toBeGreaterThan(1e-6)

    // And the whole path stays on the cloth.
    for (const segment of guide!.cuePath) {
      for (const point of [segment.from, segment.to]) {
        expect(point.x).toBeGreaterThanOrEqual(BALL_RADIUS - 1e-6)
        expect(point.x).toBeLessThanOrEqual(TABLE_LENGTH - BALL_RADIUS + 1e-6)
        expect(point.y).toBeGreaterThanOrEqual(BALL_RADIUS - 1e-6)
        expect(point.y).toBeLessThanOrEqual(TABLE_WIDTH - BALL_RADIUS + 1e-6)
      }
    }
  })

  it('predicts nothing at all when the aim line touches no ball', () => {
    expect(computeAimGuide(CUE, 0, [ball(1, 1200, 900)])).toBeNull()
  })
})
