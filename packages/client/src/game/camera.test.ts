import { describe, expect, it } from 'vitest'
import { POCKET_RADIUS_CORNER, TABLE_LENGTH, TABLE_WIDTH } from '@snooker/shared'
import {
  AIM_BACK_MM,
  AIM_HEIGHT_MM,
  AIM_LOOK_AHEAD_MM,
  CAMERA_REACH_MM,
  MAX_CAMERA_HEIGHT_MM,
  MIN_CAMERA_HEIGHT_MM,
  TOP_DOWN_MIN_HEIGHT_MM,
  TRACK_MIN_HEIGHT_MM,
  VISIBLE_HALF_LENGTH,
  VISIBLE_HALF_WIDTH,
  aimPose,
  clampPose,
  dampAngle,
  initialRigState,
  poseHeading,
  resolveCameraTarget,
  shortestAngleDelta,
  stepCameraRig,
  topDownHeight,
  topDownPose
} from './camera.js'

const DEG = Math.PI / 180
const HALF_L = TABLE_LENGTH / 2
const HALF_W = TABLE_WIDTH / 2
const ASPECT_2_TO_1 = 2

const request = (overrides: Partial<Parameters<typeof resolveCameraTarget>[0]> = {}) => ({
  mode: 'AIM' as const,
  aspect: ASPECT_2_TO_1,
  cue: { x: HALF_L, y: HALF_W },
  aimAngle: 0,
  focus: null,
  ...overrides
})

/** Runs the rig for `seconds` at a fixed step and hands back the final state. */
function run(state: ReturnType<typeof initialRigState>, req: ReturnType<typeof request>, seconds: number) {
  const steps = Math.round(seconds / (1 / 60))
  let current = state
  for (let i = 0; i < steps; i++) current = stepCameraRig(current, req, 1 / 60)
  return current
}

describe('the shortest way round', () => {
  it('takes the direct line when there is one', () => {
    expect(shortestAngleDelta(0, 90 * DEG)).toBeCloseTo(90 * DEG, 10)
    expect(shortestAngleDelta(90 * DEG, 0)).toBeCloseTo(-90 * DEG, 10)
  })

  it('goes the short way across the wrap instead of unwinding', () => {
    // The failure this exists for: 179 to -179 is two degrees apart the short way and 358
    // the long way, and a camera that takes the long one spins the table right round.
    expect(shortestAngleDelta(179 * DEG, -179 * DEG)).toBeCloseTo(2 * DEG, 10)
    expect(shortestAngleDelta(-179 * DEG, 179 * DEG)).toBeCloseTo(-2 * DEG, 10)
  })

  it('is zero on itself and half a turn exactly opposite', () => {
    expect(shortestAngleDelta(1.234, 1.234)).toBe(0)
    expect(Math.abs(shortestAngleDelta(0, 180 * DEG))).toBeCloseTo(180 * DEG, 10)
  })

  it('never returns a turn longer than half a circle', () => {
    for (let a = -Math.PI; a < Math.PI; a += 0.11) {
      for (let b = -Math.PI; b < Math.PI; b += 0.13) {
        expect(Math.abs(shortestAngleDelta(a, b))).toBeLessThanOrEqual(Math.PI + 1e-9)
      }
    }
  })
})

describe('easing a heading', () => {
  it('closes on the target and stops there', () => {
    let yaw = 0
    for (let i = 0; i < 400; i++) yaw = dampAngle(yaw, 90 * DEG, 7, 1 / 60)
    expect(yaw).toBeCloseTo(90 * DEG, 4)
  })

  it('crosses the wrap the short way, never the long way round', () => {
    let yaw = 179 * DEG
    const target = -179 * DEG
    const seen: number[] = []
    for (let i = 0; i < 120; i++) {
      yaw = dampAngle(yaw, target, 7, 1 / 60)
      seen.push(yaw)
    }
    // Every step is a nudge past 180 degrees: it keeps rising through the wrap instead of
    // diving back down through zero.
    for (const step of seen) expect(step).toBeGreaterThan(179 * DEG)
    expect(seen[seen.length - 1]).toBeCloseTo(target + Math.PI * 2, 3)
  })

  it('is monotonic, so it cannot overshoot and jitter back', () => {
    let yaw = 0
    let previous = -Infinity
    for (let i = 0; i < 200; i++) {
      yaw = dampAngle(yaw, 120 * DEG, 7, 1 / 60)
      expect(yaw).toBeGreaterThan(previous)
      previous = yaw
    }
  })

  it('takes the same shape of curve whatever the frame rate', () => {
    // A dropped frame has to move further without overshooting, or the camera is only
    // smooth on a machine that never drops one.
    let fast = 0
    for (let i = 0; i < 60; i++) fast = dampAngle(fast, 100 * DEG, 7, 1 / 120)
    let slow = 0
    for (let i = 0; i < 30; i++) slow = dampAngle(slow, 100 * DEG, 7, 1 / 60)
    expect(fast).toBeCloseTo(slow, 6)
  })
})

describe('the aim camera', () => {
  it('sits behind the cue ball, looking down the line of the shot', () => {
    const cue = { x: 1000, y: 900 }
    const pose = aimPose(cue, 0)
    expect(pose.x).toBeCloseTo(cue.x - AIM_BACK_MM, 9)
    expect(pose.y).toBeCloseTo(cue.y, 9)
    expect(pose.height).toBeCloseTo(AIM_HEIGHT_MM, 9)
    expect(pose.lookX).toBeCloseTo(cue.x + AIM_LOOK_AHEAD_MM, 9)
  })

  it('turns with the aim, so the shot line always runs away from the viewer', () => {
    for (const degrees of [0, 37, 90, 180, -120]) {
      const yaw = degrees * DEG
      const cue = { x: 500, y: 500 }
      const pose = aimPose(cue, yaw)
      // The lens is behind the cue ball along the shot line, so both the cue ball and the
      // look-at point lie ahead of it and the cue ball's own heading is the shot's.
      expect(pose.x).toBeCloseTo(cue.x - Math.cos(yaw) * AIM_BACK_MM, 9)
      expect(pose.y).toBeCloseTo(cue.y - Math.sin(yaw) * AIM_BACK_MM, 9)
      expect(shortestAngleDelta(yaw, poseHeading(pose))).toBeCloseTo(0, 9)
    }
  })

  it('looks down at the cloth rather than level, so the table runs away upward', () => {
    const pose = aimPose({ x: 1000, y: 900 }, 0)
    expect(pose.lookHeight).toBeLessThan(pose.height)
    const pitch = Math.atan2(pose.height - pose.lookHeight, AIM_LOOK_AHEAD_MM + AIM_BACK_MM)
    // A shallow downward tilt: enough to see the bed of the table, not a plan view.
    expect(pitch).toBeGreaterThan(5 * DEG)
    expect(pitch).toBeLessThan(30 * DEG)
  })

  it('stays above the cushions and clear of the cloth however it is turned', () => {
    for (const degrees of [0, 45, 90, 135, 180, -45, -135]) {
      for (const cue of [
        { x: 100, y: 100 },
        { x: TABLE_LENGTH - 100, y: TABLE_WIDTH - 100 },
        { x: HALF_L, y: HALF_W }
      ]) {
        const pose = clampPose(aimPose(cue, degrees * DEG))
        expect(pose.height).toBeGreaterThanOrEqual(MIN_CAMERA_HEIGHT_MM)
      }
    }
  })
})

describe('the overhead camera', () => {
  it('shows the whole table, cushions and all six pockets, on a 2:1 canvas', () => {
    const pose = topDownPose(ASPECT_2_TO_1)
    const tanV = Math.tan((pose.fov * Math.PI) / 360)
    const tanH = tanV * ASPECT_2_TO_1
    // Every corner of what the camera has to show is inside the frame.
    expect(VISIBLE_HALF_LENGTH / tanH).toBeLessThanOrEqual(pose.height)
    expect(VISIBLE_HALF_WIDTH / tanV).toBeLessThanOrEqual(pose.height)
    expect(pose.height).toBeGreaterThan(TOP_DOWN_MIN_HEIGHT_MM)
  })

  it('still clears the pockets on a canvas of any other shape', () => {
    // A tall or narrow window is the case where a fixed height would shave the ends off
    // the table, so the height is solved from the canvas rather than assumed.
    for (const aspect of [0.6, 1, 1.5, 2, 3, 5]) {
      const pose = topDownPose(aspect)
      const tanV = Math.tan((pose.fov * Math.PI) / 360)
      const tanH = tanV * aspect
      expect(VISIBLE_HALF_LENGTH / tanH).toBeLessThanOrEqual(pose.height)
      expect(VISIBLE_HALF_WIDTH / tanV).toBeLessThanOrEqual(pose.height)
    }
  })

  it('reaches past the pocket mouths, not just the cloth', () => {
    expect(VISIBLE_HALF_LENGTH).toBeGreaterThan(HALF_L + POCKET_RADIUS_CORNER)
    expect(VISIBLE_HALF_WIDTH).toBeGreaterThan(HALF_W + POCKET_RADIUS_CORNER)
  })

  it('is centred on the table and looking straight down', () => {
    const pose = topDownPose(ASPECT_2_TO_1)
    expect(pose.x).toBeCloseTo(HALF_L, 9)
    expect(pose.y).toBeCloseTo(HALF_W, 9)
    expect(pose.lookHeight).toBe(0)
    expect(pose.height).toBeGreaterThan(0)
  })

  it('rises as the canvas narrows', () => {
    expect(topDownHeight(0.75)).toBeGreaterThan(topDownHeight(2))
    expect(topDownHeight(1)).toBeGreaterThan(topDownHeight(4))
  })
})

describe('the tracking camera', () => {
  it('follows the focus it is given, holding the balls in frame', () => {
    const pose = resolveCameraTarget(
      request({ mode: 'TRACK', focus: { x: 900, y: 500, spread: 300 }, aimAngle: 0 })
    )
    expect(pose.lookX).toBe(900)
    expect(pose.lookY).toBe(500)
    expect(pose.height).toBeGreaterThan(TRACK_MIN_HEIGHT_MM)
  })

  it('backs off for balls that are spread out, and holds height for a tight pack', () => {
    const tight = resolveCameraTarget(request({ mode: 'TRACK', focus: { x: 900, y: 500, spread: 0 } }))
    const wide = resolveCameraTarget(request({ mode: 'TRACK', focus: { x: 900, y: 500, spread: 1400 } }))
    expect(wide.height).toBeGreaterThan(tight.height)
  })

  it('never drops onto the cloth however tight the balls are', () => {
    const pose = resolveCameraTarget(request({ mode: 'TRACK', focus: { x: 900, y: 500, spread: -500 } }))
    expect(pose.height).toBeGreaterThanOrEqual(MIN_CAMERA_HEIGHT_MM)
  })

  it('falls back to the overhead view when there is nothing to follow', () => {
    const pose = resolveCameraTarget(request({ mode: 'TRACK', focus: null }))
    expect(pose.height).toBeCloseTo(topDownPose(ASPECT_2_TO_1).height, 9)
  })

  it('keeps the table the right way up, held at the angle the shot was played', () => {
    const pose = resolveCameraTarget(
      request({ mode: 'TRACK', focus: { x: 900, y: 500, spread: 200 }, aimAngle: 90 * DEG })
    )
    // The camera sits behind the focus along the shot line rather than always on the
    // same edge, so the table does not swing round as the aim changes.
    expect(pose.y).toBeLessThan(500)
  })
})

describe('the rig', () => {
  it('starts overhead and eases down behind the cue ball', () => {
    const start = initialRigState(ASPECT_2_TO_1)
    expect(start.pose.height).toBeCloseTo(topDownHeight(ASPECT_2_TO_1), 9)
    const settled = run(start, request(), 4)
    expect(settled.pose.height).toBeCloseTo(AIM_HEIGHT_MM, 1)
    expect(settled.pose.x).toBeCloseTo(HALF_L - AIM_BACK_MM, 1)
  })

  it('never cuts: the pose changes every frame between two modes', () => {
    let state = initialRigState(ASPECT_2_TO_1)
    const aim = request({ aimAngle: 0 })
    state = run(state, aim, 2)
    const previous = { ...state.pose }
    const next = request({ mode: 'TOP_DOWN' })
    for (let i = 0; i < 30; i++) {
      state = stepCameraRig(state, next, 1 / 60)
      // A real step each frame, and never a teleport: the biggest single move is well
      // inside a frame's worth of travel rather than the whole table.
      expect(Math.abs(state.pose.height - previous.height)).toBeLessThan(400)
      expect(state.pose.height).toBeGreaterThanOrEqual(MIN_CAMERA_HEIGHT_MM)
      Object.assign(previous, state.pose)
    }
  })

  it('keeps the lens sane through every transition between every pair of modes', () => {
    const modes = ['AIM', 'TOP_DOWN', 'TRACK'] as const
    const cues = [
      { x: 120, y: 120 },
      { x: TABLE_LENGTH - 120, y: TABLE_WIDTH - 120 },
      { x: HALF_L, y: HALF_W }
    ]
    for (const from of modes) {
      for (const to of modes) {
        let state = run(initialRigState(ASPECT_2_TO_1), request({ mode: from, aimAngle: 0 }), 1.5)
        for (let i = 0; i < 240; i++) {
          state = stepCameraRig(
            state,
            request({
              mode: to,
              aimAngle: (i / 20) * DEG,
              focus: { x: HALF_L, y: HALF_W, spread: 400 },
              cue: cues[i % cues.length]
            }),
            1 / 60
          )
          const p = state.pose
          expect(p.height).toBeGreaterThanOrEqual(MIN_CAMERA_HEIGHT_MM)
          expect(p.height).toBeLessThanOrEqual(MAX_CAMERA_HEIGHT_MM)
          expect(Math.abs(p.x - HALF_L)).toBeLessThanOrEqual(CAMERA_REACH_MM)
          expect(Math.abs(p.y - HALF_W)).toBeLessThanOrEqual(CAMERA_REACH_MM)
          expect(p.fov).toBeGreaterThan(0)
          expect(Number.isFinite(p.x + p.y + p.height + p.lookX + p.lookY + p.fov)).toBe(true)
        }
      }
    }
  })

  it('comes back to the aim camera behind where the cue ball has ended up', () => {
    let state = run(initialRigState(ASPECT_2_TO_1), request({ cue: { x: 400, y: 500 } }), 2)
    const moved = { x: 2800, y: 1200 }
    state = run(state, request({ cue: moved, aimAngle: 180 * DEG }), 4)
    expect(state.pose.x).toBeCloseTo(moved.x - AIM_BACK_MM * Math.cos(Math.PI), 1)
    expect(state.pose.height).toBeCloseTo(AIM_HEIGHT_MM, 1)
  })

  it('holds overhead until there is a cue ball to sit behind', () => {
    const target = resolveCameraTarget(request({ cue: null }))
    expect(target.height).toBeCloseTo(topDownHeight(ASPECT_2_TO_1), 9)
  })

it('settles instead of creeping, so a settled camera costs nothing to hold', () => {
    const state = run(initialRigState(ASPECT_2_TO_1), request(), 5)
    const after = stepCameraRig(state, request(), 1 / 60)
    // Still converging in principle, but by now the remaining step is far below a
    // millimetre — which is what "no jitter" actually means in practice.
    expect(Math.abs(after.pose.height - state.pose.height)).toBeLessThan(0.001)
    expect(Math.abs(after.pose.x - state.pose.x)).toBeLessThan(0.001)
  })

  it('survives a zero or enormous frame step', () => {
    let state = initialRigState(ASPECT_2_TO_1)
    for (const dt of [0, 1 / 240, 0.5, 12]) {
      state = stepCameraRig(state, request({ mode: 'TOP_DOWN' }), dt)
      expect(Number.isFinite(state.pose.height)).toBe(true)
      expect(state.pose.height).toBeGreaterThanOrEqual(MIN_CAMERA_HEIGHT_MM)
    }
  })
})

describe('the sanity clamp', () => {
  it('pulls the lens up out of the cloth', () => {
    const pose = clampPose({
      x: 100,
      y: 100,
      height: -500,
      lookX: 0,
      lookY: 0,
      lookHeight: -10,
      fov: 50
    })
    expect(pose.height).toBe(MIN_CAMERA_HEIGHT_MM)
    expect(pose.lookHeight).toBe(MIN_CAMERA_HEIGHT_MM)
  })

  it('brings it back inside the reach of the table', () => {
    const pose = clampPose({
      x: 99_999,
      y: -99_999,
      height: 2000,
      lookX: -50_000,
      lookY: 50_000,
      lookHeight: 0,
      fov: 50
    })
    expect(pose.x).toBeCloseTo(HALF_L + CAMERA_REACH_MM, 9)
    expect(pose.y).toBeCloseTo(HALF_W - CAMERA_REACH_MM, 9)
    expect(pose.lookX).toBeCloseTo(HALF_L - CAMERA_REACH_MM, 9)
    expect(pose.lookY).toBeCloseTo(HALF_W + CAMERA_REACH_MM, 9)
  })

  it('keeps the lens within a usable angle', () => {
    expect(clampPose({ ...topDownPose(2), fov: 200 }).fov).toBe(75)
    expect(clampPose({ ...topDownPose(2), fov: 4 }).fov).toBe(30)
  })

  it('leaves a sane pose exactly as it is', () => {
    const pose = topDownPose(ASPECT_2_TO_1)
    const clamped = clampPose(pose)
    expect(clamped.x).toBeCloseTo(pose.x, 12)
    expect(clamped.height).toBeCloseTo(pose.height, 12)
    expect(clamped.fov).toBeCloseTo(pose.fov, 12)
  })
})