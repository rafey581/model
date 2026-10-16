import { describe, expect, it } from 'vitest'
import { BALL_RADIUS, TABLE_LENGTH, TABLE_WIDTH } from '@snooker/shared'
import {
  CUE_FLAT_ELEVATION_DEG,
  CUE_MAX_ELEVATION_DEG,
  CUE_RADIUS_OVER_RAIL_MM,
  RAIL_TOP_MM,
  cueElevationDeg,
  distanceToCushionBehind
} from './cueClearance.js'

const middle = { x: TABLE_LENGTH / 2, y: TABLE_WIDTH / 2 }

/** Where the underside of the cue is over the cushion nose, for a cue at `deg`. */
function undersideOverCushion(cue: { x: number; y: number }, angle: number, deg: number): number {
  const run = distanceToCushionBehind(cue, angle) - BALL_RADIUS
  return BALL_RADIUS + run * Math.tan((deg * Math.PI) / 180) - CUE_RADIUS_OVER_RAIL_MM
}

describe('cue elevation over the rail', () => {
  it('measures the run back to the cushion along the line of the shot', () => {
    // Shooting towards +x from the middle: the cushion behind is at x = 0.
    expect(distanceToCushionBehind(middle, 0)).toBeCloseTo(TABLE_LENGTH / 2, 6)
    // Shooting towards +y: the cushion behind is at y = 0.
    expect(distanceToCushionBehind(middle, Math.PI / 2)).toBeCloseTo(TABLE_WIDTH / 2, 6)
  })

  it('cues nearly flat over open cloth', () => {
    expect(cueElevationDeg(middle, 0, BALL_RADIUS, BALL_RADIUS)).toBe(CUE_FLAT_ELEVATION_DEG)
  })

  it('raises the butt just enough to clear the rail with the ball near a cushion', () => {
    for (const gap of [5, 20, 60, 150, 300]) {
      // A ball `gap` from the bottom cushion, played away from it.
      const cue = { x: 1200, y: BALL_RADIUS + gap }
      const deg = cueElevationDeg(cue, Math.PI / 2, BALL_RADIUS, BALL_RADIUS)
      expect(deg).toBeGreaterThan(CUE_FLAT_ELEVATION_DEG - 1e-9)
      expect(deg).toBeLessThanOrEqual(CUE_MAX_ELEVATION_DEG)
      if (deg < CUE_MAX_ELEVATION_DEG) expect(undersideOverCushion(cue, Math.PI / 2, deg)).toBeGreaterThan(RAIL_TOP_MM)
    }
  })

  it('is steeper the closer the ball is to the cushion', () => {
    const near = cueElevationDeg({ x: 1200, y: BALL_RADIUS + 10 }, Math.PI / 2, BALL_RADIUS, BALL_RADIUS)
    const far = cueElevationDeg({ x: 1200, y: BALL_RADIUS + 200 }, Math.PI / 2, BALL_RADIUS, BALL_RADIUS)
    expect(near).toBeGreaterThan(far)
  })

  it('does not care about a cushion in front of the ball, only the one behind', () => {
    // Close to the top cushion, but shooting into it: the cushion behind is far away.
    const cue = { x: 1200, y: TABLE_WIDTH - BALL_RADIUS - 10 }
    expect(cueElevationDeg(cue, Math.PI / 2, BALL_RADIUS, BALL_RADIUS)).toBe(CUE_FLAT_ELEVATION_DEG)
  })
})
