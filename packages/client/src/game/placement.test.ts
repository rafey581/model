import { describe, expect, it } from 'vitest'
import { BALL_RADIUS, BAULK_LINE_X, D_RADIUS, TABLE_LENGTH, TABLE_WIDTH } from '@snooker/shared'
import {
  D_CENTRE,
  D_ZONE_RADIUS,
  GHOST_COMMIT_TOLERANCE_MM,
  followGhost,
  ghostSettled,
  isInsideD,
  isInsideAPocket,
  isCrowded,
  isOnTable,
  placementAimAngle,
  placementShot,
  placementStatus
} from './placement.js'

const pocket = { x: 0, y: 0, radius: 85 }

function ball(id: number, x: number, y: number, potted = false): { id: number; x: number; y: number; potted: boolean } {
  return { id, x, y, potted }
}

describe('the D geometry', () => {
  it('matches the shared constants', () => {
    expect(D_CENTRE.x).toBe(BAULK_LINE_X)
    expect(D_CENTRE.y).toBe(TABLE_WIDTH / 2)
    expect(D_ZONE_RADIUS).toBe(D_RADIUS)
  })

  it('accepts the centre of the D and the baulk line itself', () => {
    expect(isInsideD(D_CENTRE)).toBe(true)
    expect(isInsideD({ x: BAULK_LINE_X, y: TABLE_WIDTH / 2 })).toBe(true)
  })

  it('rejects a point one millimetre past the baulk line', () => {
    expect(isInsideD({ x: BAULK_LINE_X + 1, y: TABLE_WIDTH / 2 })).toBe(false)
  })

  it('rejects a point just outside the arc but behind baulk', () => {
    expect(isInsideD({ x: BAULK_LINE_X, y: TABLE_WIDTH / 2 + D_RADIUS + 1 })).toBe(false)
  })
})

describe('validity checks', () => {
  it('mirrors the on-table bound at the cushion', () => {
    expect(isOnTable({ x: BALL_RADIUS, y: TABLE_WIDTH / 2 })).toBe(true)
    expect(isOnTable({ x: BALL_RADIUS - 0.5, y: TABLE_WIDTH / 2 })).toBe(false)
    expect(isOnTable({ x: TABLE_LENGTH - BALL_RADIUS, y: TABLE_WIDTH / 2 })).toBe(true)
  })

  it('sees a centre inside a pocket mouth as unplaceable', () => {
    expect(isInsideAPocket({ x: pocket.x + 10, y: pocket.y + 10 })).toBe(true)
    expect(isInsideAPocket({ x: pocket.x + pocket.radius + 50, y: pocket.y })).toBe(false)
  })

  it('sees a spot a diameter from another ball as crowded, a touch further as free', () => {
    const other = ball(5, 2000, 500)
    const here = { x: 2000, y: 500 }
    const diameter = BALL_RADIUS * 2
    expect(isCrowded({ x: here.x + diameter * 0.99, y: here.y }, [other])).toBe(true)
    expect(isCrowded({ x: here.x + diameter * 1.01, y: here.y }, [other])).toBe(false)
  })

  it('ignores the cue ball itself and potted balls when testing crowding', () => {
    const cue = ball(0, 2000, 500)
    const potted = ball(7, 2000, 500, true)
    expect(isCrowded({ x: 2000, y: 500 }, [cue, potted])).toBe(false)
  })
})

describe('placementStatus', () => {
  const free = { x: 2000, y: 900 }
  const inD = { x: BAULK_LINE_X - 100, y: TABLE_WIDTH / 2 }

  it('accepts a clear spot in either restriction mode', () => {
    expect(placementStatus(free, false, []).ok).toBe(true)
    expect(placementStatus(inD, true, []).ok).toBe(true)
  })

  it('names the D as the reason during break-off and stays quiet mid-frame', () => {
    const pastBaulk = { x: BAULK_LINE_X + 400, y: TABLE_WIDTH / 2 }
    expect(placementStatus(pastBaulk, true, []).reason).toBe('outside-D')
    expect(placementStatus(pastBaulk, false, []).ok).toBe(true)
  })

  it('reports the right reason for each failure class', () => {
    expect(placementStatus({ x: -50, y: 500 }, false, []).reason).toBe('off-table')
    // A middle-pocket mouth: inside the pocket radius, but on the cloth.
    const midPocketMouth = { x: TABLE_LENGTH / 2, y: 40 }
    expect(placementStatus(midPocketMouth, false, []).reason).toBe('in-pocket')
    expect(placementStatus({ x: 2000, y: 500 }, false, [ball(3, 2000, 500)]).reason).toBe('crowded')
  })

  it('checks the hard failures before the D, so the message is never misleading', () => {
    // A spot that is both in a pocket mouth and past the D must not be reported
    // as merely outside the D.
    const midPocketPastD = { x: TABLE_LENGTH / 2, y: 40 }
    expect(placementStatus(midPocketPastD, true, []).reason).toBe('in-pocket')
  })
})

describe('placementShot', () => {
  it('carries the placement as cuePos with resting power and no spin', () => {
    const shot = placementShot({ x: 500, y: 700 }, 0.3, 0.4)
    expect(shot.cuePos).toEqual({ x: 500, y: 700 })
    expect(shot.power).toBe(0.4)
    expect(shot.spin).toEqual({ x: 0, y: 0 })
  })

  it('clamps power into the legal range', () => {
    expect(placementShot({ x: 500, y: 700 }, 0, 5).power).toBe(1)
    expect(placementShot({ x: 500, y: 700 }, 0, -2).power).toBe(0)
  })

  it('keeps the spin shape the physics layer already accepts', () => {
    const shot = placementShot({ x: 1, y: 1 }, 0, 0)
    expect(Object.keys(shot.spin).sort()).toEqual(['x', 'y'])
  })
})

describe('placementAimAngle', () => {
  it('points from a D placement up-table toward the pack', () => {
    const angle = placementAimAngle({ x: BAULK_LINE_X - 100, y: TABLE_WIDTH / 2 })
    expect(Math.abs(angle)).toBeLessThan(Math.PI / 2)
    expect(Math.cos(angle)).toBeGreaterThan(0)
  })

  it('points inward from anywhere on the table', () => {
    for (const pos of [
      { x: 100, y: 100 },
      { x: TABLE_LENGTH - 100, y: TABLE_WIDTH - 100 },
      { x: TABLE_LENGTH / 2, y: 60 }
    ]) {
      const angle = placementAimAngle(pos)
      expect(Math.cos(angle) * (TABLE_LENGTH / 2 - pos.x)).toBeGreaterThanOrEqual(0)
      expect(Math.sin(angle) * (TABLE_WIDTH / 2 - pos.y)).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('the ghost follow', () => {
  it('never overshoots and converges on the target', () => {
    let current = { x: 0, y: 0 }
    const target = { x: 1000, y: 500 }
    for (let i = 0; i < 600; i++) current = followGhost(current, target, 1 / 60)
    expect(current.x).toBeCloseTo(target.x, 3)
    expect(current.y).toBeCloseTo(target.y, 3)
  })

  it('is frame-rate independent: two half steps land where one full step does', () => {
    const target = { x: 800, y: 300 }
    const one = followGhost({ x: 0, y: 0 }, target, 1 / 30)
    const two = followGhost(followGhost({ x: 0, y: 0 }, target, 1 / 60), target, 1 / 60)
    expect(one.x).toBeCloseTo(two.x, 9)
    expect(one.y).toBeCloseTo(two.y, 9)
  })

  it('treats a negative or zero dt as no movement', () => {
    const current = { x: 120, y: 90 }
    expect(followGhost(current, { x: 9999, y: 9999 }, 0)).toEqual(current)
    expect(followGhost(current, { x: 9999, y: 9999 }, -1)).toEqual(current)
  })

  it('settles within the commit tolerance once it has caught up', () => {
    const target = { x: 500, y: 500 }
    const far = { x: target.x + GHOST_COMMIT_TOLERANCE_MM * 3, y: target.y }
    expect(ghostSettled(far, target)).toBe(false)
    expect(ghostSettled(target, target)).toBe(true)
    let current = far
    for (let i = 0; i < 240; i++) current = followGhost(current, target, 1 / 60)
    expect(ghostSettled(current, target)).toBe(true)
  })
})
