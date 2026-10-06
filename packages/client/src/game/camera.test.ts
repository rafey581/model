import { describe, expect, it } from 'vitest'
import { BALL_RADIUS, POCKET_RADIUS_CORNER, TABLE_LENGTH, TABLE_WIDTH } from '@snooker/shared'
import { pickCameraAt, projectToNdc } from './cameraPick.js'
import {
  AIM_BACK_MM,
  AIM_FOV_DEG,
  AIM_HEIGHT_MM,
  AIM_LOOK_AHEAD_MM,
  AIM_PORTRAIT_MAX_EXTRA_DEG,
  AIM_RAIL_CLEARANCE_MM,
  BROADCAST_BACK_MM,
  BROADCAST_FOV_DEG,
  BROADCAST_HEIGHT_MM,
  CAMERA_REACH_MM,
  CLOSE_BACK_MM,
  CLOSE_FOV_DEG,
  CLOSE_HEIGHT_MM,
  CLOSE_SIDE_MM,
  MAX_CAMERA_HEIGHT_MM,
  MIN_CAMERA_HEIGHT_MM,
  PLACEMENT_TRANSITION_MAX_SECONDS,
  PLACEMENT_TRANSITION_MIN_SECONDS,
  PLACEMENT_TRANSITION_SECONDS,
  PLAYER_CAMERA_MODES,
  SIDE_BACK_MM,
  SIDE_FOV_DEG,
  SIDE_HEIGHT_MM,
  TOP_DOWN_MIN_HEIGHT_MM,
  aimFovDeg,
  beginPlacementTransition,
  broadcastPose,
  clampPlacementTransitionSeconds,
  closePose,
  initialHeadingLatch,
  stepHeadingLatch,
  latchedCameraYaw,
  addOrbit,
  followHeadingLatch,
  MAX_ORBIT_RAD,
  noPlacementTransition,
  sidePose,
  stepPlacementTransition,
  TRACK_MIN_HEIGHT_MM,
  VISIBLE_HALF_LENGTH,
  VISIBLE_HALF_WIDTH,
  aimPose,
  clampPose,
  dampAngle,
  initialRigState,
  placementTransitionEase,
  poseHeading,
  resolveCameraTarget,
  shortestAngleDelta,
  stepCameraRig,
  topDownHeight,
  topDownPose,
  wideFovDeg,
  type CameraPose
} from './camera.js'

const DEG = Math.PI / 180
const HALF_L = TABLE_LENGTH / 2
const HALF_W = TABLE_WIDTH / 2
const ASPECT_2_TO_1 = 2
const ASPECT_16_TO_9 = 16 / 9
/** The four corners of the bed: what any camera has to hold in frame to show a table. */
const TABLE_CORNERS = [
  { x: 0, y: 0 },
  { x: TABLE_LENGTH, y: 0 },
  { x: 0, y: TABLE_WIDTH },
  { x: TABLE_LENGTH, y: TABLE_WIDTH }
]

const request = (overrides: Partial<Parameters<typeof resolveCameraTarget>[0]> = {}) => ({
  mode: 'AIM' as const,
  aspect: ASPECT_2_TO_1,
  cue: { x: HALF_L, y: HALF_W },
  aimAngle: 0,
  latch: initialHeadingLatch(0),
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

describe('the heading latch', () => {
  it('does not move while no shot is being played', () => {
    const latch = initialHeadingLatch(0.5)
    expect(stepHeadingLatch(latch, 2.5, false)).toBe(latch)
    expect(latchedCameraYaw(stepHeadingLatch(latch, 2.5, false))).toBeCloseTo(0.5, 12)
  })

  it('re-latches on a played shot and drops the look-around with it', () => {
    let latch = addOrbit(initialHeadingLatch(0), 0.6)
    latch = stepHeadingLatch(latch, 1.25, true)
    expect(latch.heading).toBeCloseTo(1.25, 12)
    expect(latch.orbit).toBe(0)
  })

  it('keeps a drag inside half a turn either way', () => {
    let latch = initialHeadingLatch(0)
    latch = addOrbit(latch, 99)
    expect(latch.orbit).toBeCloseTo(MAX_ORBIT_RAD, 12)
    latch = addOrbit(latch, -99)
    expect(latch.orbit).toBeCloseTo(-MAX_ORBIT_RAD, 12)
  })

  it('never lets a sweeping aim turn the camera', () => {
    // The bug this rig exists to fix: the player sweeps their aim across the whole
    // table with the pointer and the camera used to follow every degree of it. The
    // rig's heading comes only through the latch, so the bare angle on the request
    // cannot turn anything by itself — the scene decides when the latch follows
    // the aim, and only through followHeadingLatch.
    let state = run(initialRigState(ASPECT_2_TO_1), request({ aimAngle: 0 }), 3)
    const settledYaw = state.yaw
    for (const angle of [0.4, 1.2, 2.4, -1.6, 3.0]) {
      state = run(state, request({ aimAngle: angle }), 1)
      expect(state.yaw).toBeCloseTo(settledYaw, 6)
      expect(state.pose.x).toBeCloseTo(state.pose.x, 12)
    }
  })

  it('turns only when a shot is played or the player drags, and eases between them', () => {
    // Re-latch on a played shot: the camera comes round behind the new heading.
    let state = run(initialRigState(ASPECT_2_TO_1), request({ aimAngle: 0 }), 3)
    state = run(state, request({ aimAngle: Math.PI / 2, latch: initialHeadingLatch(Math.PI / 2) }), 2)
    expect(state.yaw).toBeCloseTo(Math.PI / 2, 4)
    // Drag the look-around: the rig eases there too, via the same latch.
    state = run(state, request({ aimAngle: Math.PI / 2, latch: addOrbit(initialHeadingLatch(Math.PI / 2), 0.5) }), 2)
    expect(state.yaw).toBeCloseTo(Math.PI / 2 + 0.5, 4)
  })
})

describe('following the aim with the camera', () => {
  it('keeps the lens behind the cue ball while the aim sweeps', () => {
    let latch = initialHeadingLatch(0)
    for (const angle of [0.2, 0.5, 0.9]) {
      latch = followHeadingLatch(latch, angle)
      expect(latchedCameraYaw(latch)).toBeCloseTo(angle, 12)
    }
  })

  it('carries the look-around along rather than cancelling it', () => {
    let latch = addOrbit(initialHeadingLatch(0), 0.4)
    latch = followHeadingLatch(latch, 0.3)
    expect(latch.heading).toBeCloseTo(0.3, 12)
    expect(latch.orbit).toBeCloseTo(0.4, 12)
  })

  it('holds when the aim flips into the half of the world behind the lens', () => {
    // The drag-back that sets power picks cloth behind the cue ball, which reads as
    // an aim a half turn from the camera. Chasing it would spin the lens round and
    // round; the camera waits for the aim to come back in front instead.
    let latch = initialHeadingLatch(0)
    latch = followHeadingLatch(latch, Math.PI * 0.75)
    expect(latchedCameraYaw(latch)).toBe(0)
    latch = followHeadingLatch(latch, Math.PI)
    expect(latchedCameraYaw(latch)).toBe(0)
    latch = followHeadingLatch(latch, 1.2)
    expect(latchedCameraYaw(latch)).toBeCloseTo(1.2, 12)
  })

  it('follows across the wrap the short way, with no jump', () => {
    let latch = initialHeadingLatch(179 * DEG)
    latch = followHeadingLatch(latch, -179 * DEG)
    expect(latchedCameraYaw(latch)).toBeCloseTo(-179 * DEG, 9)
  })

  it('puts the rig behind the cue ball on the aim line, once eased', () => {
    let latch = initialHeadingLatch(0)
    let state = run(initialRigState(ASPECT_2_TO_1), request({ latch }), 3)
    for (const angle of [0.5, 1.0, 1.6]) {
      latch = followHeadingLatch(latch, angle)
      state = run(state, request({ latch }), 3)
      // Behind the ball on the line: the settled pose's own heading is the aim's,
      // to well under a tenth of a degree.
      expect(shortestAngleDelta(angle, poseHeading(state.pose))).toBeCloseTo(0, 5)
    }
  })
})

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
    // A player-like pitch: enough to see the bed of the table, not a plan view.
    expect(pitch).toBeGreaterThan(10 * DEG)
    expect(pitch).toBeLessThan(18 * DEG)
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

  it('frames the cue ball low and centred, like a player bent over the shot', () => {
    const cue = { x: 900, y: 900 }
    const pose = aimPose(cue, 0)
    const cam = pickCameraAt(
      { x: pose.x, y: pose.y, height: pose.height },
      { x: pose.lookX, y: pose.lookY, height: pose.lookHeight },
      pose.fov,
      ASPECT_2_TO_1
    )
    const ball = projectToNdc(cue, BALL_RADIUS, cam)
    expect(ball).not.toBeNull()
    // Roughly three quarters of the way down the frame: near enough to feel bent
    // over the shot, far enough that the line ahead is the subject of the picture.
    expect(ball!.y).toBeLessThan(-0.35)
    expect(ball!.y).toBeGreaterThan(-0.75)
    // Dead centre across: the lens sits on the shot line, so the line runs up the
    // middle of the screen rather than across a corner of it.
    expect(Math.abs(ball!.x)).toBeLessThan(0.08)
  })

  it('widens for a narrow portrait canvas without touching the landscape view', () => {
    expect(aimFovDeg(2)).toBeCloseTo(AIM_FOV_DEG, 12)
    expect(aimFovDeg(1)).toBeCloseTo(AIM_FOV_DEG, 12)
    expect(aimFovDeg(0.5)).toBeGreaterThan(AIM_FOV_DEG)
    expect(aimFovDeg(0.1)).toBeLessThanOrEqual(AIM_FOV_DEG + AIM_PORTRAIT_MAX_EXTRA_DEG)
  })

  it('never puts the lens inside the rail when the cue ball is frozen on a cushion', () => {
    const frozenCues = [
      { x: BALL_RADIUS + 2, y: HALF_W },
      { x: TABLE_LENGTH - BALL_RADIUS - 2, y: HALF_W },
      { x: HALF_L, y: BALL_RADIUS + 2 },
      { x: HALF_L, y: TABLE_WIDTH - BALL_RADIUS - 2 }
    ]
    for (const degrees of [0, 45, 90, 135, 180, -90, -135]) {
      for (const cue of frozenCues) {
        const pose = aimPose(cue, degrees * DEG)
        const overRail = pose.x < 0 || pose.x > TABLE_LENGTH || pose.y < 0 || pose.y > TABLE_WIDTH
        // Backed over the rail the lens keeps the clearance floor; on the cloth it
        // keeps the shot height, so the guard changes nothing about the view.
        if (overRail) expect(pose.height).toBeGreaterThanOrEqual(AIM_RAIL_CLEARANCE_MM)
        else expect(pose.height).toBe(AIM_HEIGHT_MM)
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

describe("the venue's television cameras", () => {
  /** Shapes a window can actually take in landscape, where these views are meant to work. */
  const WIDE_ASPECTS = [16 / 9, 2, 1.5]

  /** All four corners of the bed projected for a pose. Null would mean behind the lens. */
  function corners(pose: CameraPose, aspect: number): ({ x: number; y: number } | null)[] {
    const cam = pickCameraAt(
      { x: pose.x, y: pose.y, height: pose.height },
      { x: pose.lookX, y: pose.lookY, height: pose.lookHeight },
      pose.fov,
      aspect
    )
    return TABLE_CORNERS.map((corner) => projectToNdc(corner, 0, cam))
  }

  /** The table is on screen whole: in front of the lens, inside the frame, nothing clipped. */
  function expectTableInFrame(pose: CameraPose, aspect: number): void {
    for (const ndc of corners(pose, aspect)) {
      expect(ndc).not.toBeNull()
      expect(Math.abs(ndc!.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(ndc!.y)).toBeLessThanOrEqual(1)
    }
  }

  it('walks the views in the order the button offers them', () => {
    expect([...PLAYER_CAMERA_MODES]).toEqual(['AIM', 'BROADCAST', 'SIDE', 'CLOSE', 'TOP_DOWN'])
  })

  it('opens up on a narrow canvas without touching the landscape framing', () => {
    expect(wideFovDeg(BROADCAST_FOV_DEG, 2)).toBe(BROADCAST_FOV_DEG)
    expect(wideFovDeg(BROADCAST_FOV_DEG, ASPECT_16_TO_9)).toBe(BROADCAST_FOV_DEG)
    expect(wideFovDeg(BROADCAST_FOV_DEG, 0.5)).toBeGreaterThan(BROADCAST_FOV_DEG)
  })

  it('stands the wide camera down the length of the table, on the landing', () => {
    const pose = broadcastPose(ASPECT_16_TO_9)
    expect(pose.x).toBeCloseTo(-BROADCAST_BACK_MM, 9)
    expect(pose.y).toBeCloseTo(HALF_W, 9)
    expect(pose.height).toBe(BROADCAST_HEIGHT_MM)
    expect(pose.lookX).toBeCloseTo(HALF_L, 9)
    expect(pose.lookY).toBeCloseTo(HALF_W, 9)
    expect(pose.lookHeight).toBeGreaterThan(0)
    expect(pose.lookHeight).toBeLessThan(pose.height)
    expect(pose.fov).toBe(BROADCAST_FOV_DEG)
    // On the landing ring rather than out in the bowl: 1750 of cushion plus its own
    // stand-off, and still inside what the rig is allowed to reach for.
    const range = Math.hypot(pose.x - HALF_L, pose.y - HALF_W)
    expect(range).toBeCloseTo(HALF_L + BROADCAST_BACK_MM, 9)
    expect(range).toBeLessThanOrEqual(CAMERA_REACH_MM)
  })

  it('shows the whole table from the wide camera, near cushion to far', () => {
    for (const aspect of [...WIDE_ASPECTS, 1]) expectTableInFrame(broadcastPose(aspect), aspect)
  })

  it('sits beyond the near cushion, level with the middle of the bed', () => {
    const pose = sidePose(ASPECT_16_TO_9)
    expect(pose.x).toBeCloseTo(HALF_L, 9)
    expect(pose.y).toBeCloseTo(-SIDE_BACK_MM, 9)
    expect(pose.height).toBe(SIDE_HEIGHT_MM)
    expect(pose.lookX).toBeCloseTo(HALF_L, 9)
    expect(pose.lookY).toBeCloseTo(HALF_W, 9)
    expect(pose.fov).toBe(SIDE_FOV_DEG)
    const range = Math.hypot(pose.x - HALF_L, pose.y - HALF_W)
    expect(range).toBeCloseTo(HALF_W + SIDE_BACK_MM, 9)
    expect(range).toBeLessThanOrEqual(CAMERA_REACH_MM)
  })

  it('shows the whole table from the side, cushions and all', () => {
    for (const aspect of WIDE_ASPECTS) expectTableInFrame(sidePose(aspect), aspect)
  })

  it('hangs the close camera off the cue ball, and waits on the wide shot without one', () => {
    const cue = { x: 900, y: 700 }
    const pose = closePose(cue, ASPECT_16_TO_9)
    expect(pose.x).toBeCloseTo(cue.x - CLOSE_BACK_MM, 9)
    expect(pose.y).toBeCloseTo(cue.y - CLOSE_SIDE_MM, 9)
    expect(pose.height).toBe(CLOSE_HEIGHT_MM)
    expect(pose.lookX).toBe(cue.x)
    expect(pose.lookY).toBe(cue.y)
    expect(pose.lookHeight).toBeCloseTo(BALL_RADIUS, 9)
    expect(pose.fov).toBe(CLOSE_FOV_DEG)
    // A camera that invented a cue ball would sweep across the room on the first frame,
    // so with no ball to hang off it holds the wide view instead.
    expect(closePose(null, ASPECT_16_TO_9)).toEqual(broadcastPose(ASPECT_16_TO_9))
  })

  it('frames the cue ball where a close camera belongs: centred, and big enough to read', () => {
    for (const cue of [
      { x: 400, y: 300 },
      { x: TABLE_LENGTH - 400, y: TABLE_WIDTH - 300 },
      { x: HALF_L, y: HALF_W }
    ]) {
      const pose = closePose(cue, ASPECT_16_TO_9)
      const cam = pickCameraAt(
        { x: pose.x, y: pose.y, height: pose.height },
        { x: pose.lookX, y: pose.lookY, height: pose.lookHeight },
        pose.fov,
        ASPECT_16_TO_9
      )
      const ball = projectToNdc(cue, BALL_RADIUS, cam)
      expect(ball).not.toBeNull()
      // On the look point, so dead centre of frame: the shot is what the picture is of.
      expect(Math.abs(ball!.x)).toBeLessThan(0.05)
      expect(Math.abs(ball!.y)).toBeLessThan(0.05)
      // A few per cent of the frame across, which is what makes it a close camera: the
      // ball reads as a subject rather than as one of twenty on a wide table.
      const top = projectToNdc(cue, BALL_RADIUS * 2, cam)
      expect(top).not.toBeNull()
      const span = top!.y - ball!.y
      expect(span).toBeGreaterThan(0.02)
      expect(span).toBeLessThan(0.2)
    }
  })

  it('takes its heading from the look-around alone, never from the shot line', () => {
    const latch = addOrbit(initialHeadingLatch(0), 0.7)
    const wide = { ...request({ mode: 'BROADCAST', aimAngle: 1.2, latch }), cue: { x: 900, y: 700 } }
    expect(resolveCameraTarget(wide)).toEqual(broadcastPose(ASPECT_2_TO_1, latch.orbit))
    expect(resolveCameraTarget({ ...wide, mode: 'SIDE' })).toEqual(sidePose(ASPECT_2_TO_1, latch.orbit))
    expect(resolveCameraTarget({ ...wide, mode: 'CLOSE' })).toEqual(closePose(wide.cue, ASPECT_2_TO_1, latch.orbit))
  })

  it('needs no clamping of its own, at any look-around and with the ball anywhere on the cloth', () => {
    const poses: CameraPose[] = []
    for (const orbit of [0, 0.9, Math.PI, -2.2]) {
      poses.push(broadcastPose(ASPECT_16_TO_9, orbit), sidePose(ASPECT_16_TO_9, orbit))
      for (const cue of [...TABLE_CORNERS, { x: HALF_L, y: HALF_W }]) {
        poses.push(closePose(cue, ASPECT_16_TO_9, orbit))
      }
    }
    for (const pose of poses) expect(clampPose(pose)).toEqual(pose)
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
    // Every pair, including the three fixed television views: they ease like the rest, so
    // the guard has to hold for a broadcast-to-close move as much as for aim-to-overhead.
    const modes = ['AIM', 'TOP_DOWN', 'TRACK', 'BROADCAST', 'SIDE', 'CLOSE'] as const
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
    // The heading arrives via the latch, which a real played shot re-latches; the
    // bare aim angle on its own cannot move the camera any more.
    state = run(state, request({ cue: moved, aimAngle: 180 * DEG, latch: initialHeadingLatch(180 * DEG) }), 4)
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
    // lookHeight is no longer clamped to MIN_CAMERA_HEIGHT_MM; it can be at cloth level or below
    expect(pose.lookHeight).toBe(-10)
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

describe('the placement camera transition', () => {
  const overhead = topDownPose(ASPECT_2_TO_1)
  const gameplay = aimPose({ x: 600, y: TABLE_WIDTH / 2 }, 0)
  /** Runs a transition to completion at a fixed step, handing back every pose it drew. */
  function runTransition(from: typeof gameplay, to: typeof overhead, seconds = PLACEMENT_TRANSITION_SECONDS) {
    let transition = beginPlacementTransition(from, to, seconds)
    const poses: Array<ReturnType<typeof aimPose>> = []
    let guard = 0
    while (transition.active && guard++ < 10_000) {
      const stepped = stepPlacementTransition(transition, 1 / 60)
      transition = stepped.transition
      poses.push(stepped.pose)
    }
    return { poses, transition }
  }

  it('refuses input from the first frame of the move, not once it is under way', () => {
    // The bug this guards: input stayed live for the opening frames of the camera's
    // flight, so a player could aim or click while the table was still lifting.
    const transition = beginPlacementTransition(gameplay, overhead)
    expect(transition.blocking).toBe(true)
    expect(transition.active).toBe(true)
    expect(noPlacementTransition().blocking).toBe(false)
  })

  it('keeps refusing input for the whole move and only releases on arrival', () => {
    let transition = beginPlacementTransition(gameplay, overhead)
    let frames = 0
    // The invariant, asserted every frame rather than reasoned about: a transition that is
    // still running is always blocking, and a transition that has finished never is. The
    // window between "move started" and "move finished" is exactly where an input that
    // fights the camera would land, so the two can never come apart.
    while (frames++ < 10_000) {
      expect(transition.blocking).toBe(transition.active)
      if (!transition.active) break
      transition = stepPlacementTransition(transition, 1 / 60).transition
    }
    expect(frames).toBeGreaterThan(1)
    expect(transition.active).toBe(false)
    expect(transition.blocking).toBe(false)
  })

  it('lands exactly on the overhead pose, not a step short of it', () => {
    const { poses, transition } = runTransition(gameplay, overhead)
    const last = poses[poses.length - 1]!
    const end = clampPose(overhead)
    // The frame the input is released on is the end pose itself. Ending one eased step
    // short would be a visible snap on the very frame controls come back.
    expect(transition.active).toBe(false)
    expect(last.height).toBeCloseTo(end.height, 9)
    expect(last.x).toBeCloseTo(end.x, 9)
    expect(last.y).toBeCloseTo(end.y, 9)
    expect(last.lookX).toBeCloseTo(end.lookX, 9)
    expect(last.lookY).toBeCloseTo(end.lookY, 9)
    expect(last.lookHeight).toBeCloseTo(end.lookHeight, 9)
    expect(last.fov).toBeCloseTo(end.fov, 9)
  })

  it('starts on the pose it was given, so the first frame does not jump', () => {
    const stepped = stepPlacementTransition(beginPlacementTransition(gameplay, overhead), 1 / 60)
    // A first frame that has moved a visible fraction of the way reads as a cut even
    // though every later frame is smooth.
    expect(Math.abs(stepped.pose.height - gameplay.height)).toBeLessThan(40)
  })

  it('never teleports: every frame moves a small fraction of the way', () => {
    const { poses } = runTransition(gameplay, overhead)
    let previous = gameplay
    for (const pose of poses) {
      // The whole move is thousands of millimetres of camera travel. Any single frame
      // covering a large part of that is a snap, whatever the curve is doing overall.
      expect(Math.abs(pose.height - previous.height)).toBeLessThan(300)
      previous = pose
    }
  })

  it('moves position, height, look-at and field of view together', () => {
    // Every one of these is interpolated rather than only the position: a camera whose
    // lens slid up while its look-at stayed behind would swing the table across frame
    // on the way past, which is the "cut" the flow exists to avoid. The endpoints here
    // differ in fov as well, because the aim and overhead views happen to share one and
    // would otherwise not exercise that component at all.
    const narrow = { ...gameplay, fov: 40 }
    const { poses } = runTransition(narrow, overhead)
    let sawHeight = false
    let sawLookAt = false
    let sawFov = false
    let previous = narrow
    for (const pose of poses) {
      if (Math.abs(pose.height - previous.height) > 0.01) sawHeight = true
      if (Math.abs(pose.lookX - previous.lookX) > 0.01 || Math.abs(pose.lookY - previous.lookY) > 0.01) {
        sawLookAt = true
      }
      if (Math.abs(pose.fov - previous.fov) > 0.01) sawFov = true
      previous = pose
    }
    expect(sawHeight).toBe(true)
    expect(sawLookAt).toBe(true)
    expect(sawFov).toBe(true)
  })

  it('leaves and arrives at zero speed, so there is no jolt at either end', () => {
    // Smoothstep's derivative vanishes at 0 and 1. A linear move is smooth in position but
    // not in speed, and the visible start-stop at each end is what reads as a cut.
    expect(placementTransitionEase(0)).toBe(0)
    expect(placementTransitionEase(1)).toBe(1)
    const first = placementTransitionEase(0.001)
    const lastStep = 1 - placementTransitionEase(0.999)
    expect(first).toBeLessThan(0.001)
    expect(lastStep).toBeLessThan(0.001)
    // And the curve is monotonic, so it cannot overshoot the end pose and come back.
    let previous = -1
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const eased = placementTransitionEase(t)
      expect(eased).toBeGreaterThanOrEqual(previous)
      previous = eased
    }
  })

  it('clamps a frame that overshoots the window onto the end pose', () => {
    // A dropped frame must not extrapolate the camera past where it was going: the
    // overshoot lands on 1, which is the pose, rather than sailing through it. This is
    // also why `dt` is not clamped the way the rig's is - a tab that was in the
    // background has to come back to the end pose, not to a camera stranded part of the
    // way across the table still refusing input.
    const transition = beginPlacementTransition(gameplay, overhead)
    const jumped = stepPlacementTransition(transition, 5)
    expect(jumped.transition.active).toBe(false)
    expect(jumped.transition.blocking).toBe(false)
    expect(jumped.pose.height).toBeCloseTo(clampPose(overhead).height, 9)
  })

  it('survives a zero or negative frame step without moving', () => {
    const transition = beginPlacementTransition(gameplay, overhead)
    const zero = stepPlacementTransition(transition, 0)
    expect(zero.pose.height).toBeCloseTo(gameplay.height, 9)
    const negative = stepPlacementTransition(transition, -1)
    expect(negative.pose.height).toBeCloseTo(gameplay.height, 9)
  })

  it('holds the end pose once it has finished rather than drifting off it', () => {
    const done = runTransition(gameplay, overhead).transition
    const after = stepPlacementTransition(done, 1 / 60)
    expect(after.pose.height).toBeCloseTo(clampPose(overhead).height, 9)
    expect(after.transition.active).toBe(false)
  })

  it('keeps the lens sane at every frame of the move, in both directions', () => {
    // The transition's endpoints come from the rig, so the clamp has nothing to catch in
    // the normal case. It is asserted anyway because an out-of-bounds pose mid-flight is
    // the failure that looks worst: the table vanishing from inside the cloth.
    for (const [from, to] of [
      [gameplay, overhead],
      [overhead, gameplay],
      [aimPose({ x: 100, y: 100 }, 0), overhead],
      [overhead, aimPose({ x: TABLE_LENGTH - 100, y: 100 }, Math.PI)]
    ] as const) {
      let transition = beginPlacementTransition(from, to)
      let guard = 0
      while (transition.active && guard++ < 10_000) {
        const stepped = stepPlacementTransition(transition, 1 / 60)
        transition = stepped.transition
        const p = stepped.pose
        expect(p.height).toBeGreaterThanOrEqual(MIN_CAMERA_HEIGHT_MM)
        expect(p.height).toBeLessThanOrEqual(MAX_CAMERA_HEIGHT_MM)
        expect(Math.abs(p.x - HALF_L)).toBeLessThanOrEqual(CAMERA_REACH_MM)
        expect(Math.abs(p.y - HALF_W)).toBeLessThanOrEqual(CAMERA_REACH_MM)
        expect(Number.isFinite(p.x + p.y + p.height + p.lookX + p.lookY + p.lookHeight + p.fov)).toBe(true)
      }
    }
  })

  it('keeps every requested duration inside the 0.5-1.0 second window', () => {
    // A caller cannot ask for a cut by passing a small number, and cannot ask for a wait
    // by passing a large one: the flow's feel is fixed by these bounds, not by whatever
    // value happens to reach the function.
    expect(clampPlacementTransitionSeconds(0.01)).toBe(PLACEMENT_TRANSITION_MIN_SECONDS)
    expect(clampPlacementTransitionSeconds(60)).toBe(PLACEMENT_TRANSITION_MAX_SECONDS)
    expect(clampPlacementTransitionSeconds(0.8)).toBe(0.8)
    expect(PLACEMENT_TRANSITION_SECONDS).toBeGreaterThanOrEqual(PLACEMENT_TRANSITION_MIN_SECONDS)
    expect(PLACEMENT_TRANSITION_SECONDS).toBeLessThanOrEqual(PLACEMENT_TRANSITION_MAX_SECONDS)
  })

  it('takes about as long as it says it will, at any frame rate', () => {
    for (const step of [1 / 30, 1 / 60, 1 / 120]) {
      let transition = beginPlacementTransition(gameplay, overhead)
      let frames = 0
      while (transition.active && frames++ < 10_000) {
        transition = stepPlacementTransition(transition, step).transition
      }
      expect(transition.active).toBe(false)
      // Elapsed time tracks wall-clock rather than frames, so a 30fps client and a 120fps
      // one get the same move: not one that is twice as fast on the slow machine, and not
      // one that has not finished when the frame budget says it should have.
      expect(transition.elapsed).toBeGreaterThanOrEqual(PLACEMENT_TRANSITION_SECONDS)
      expect(transition.elapsed).toBeLessThan(PLACEMENT_TRANSITION_SECONDS + step)
      expect(frames).toBeGreaterThan(0)
    }
  })

  it('resolves the placement view through the rig like any other mode', () => {
    // The placement view is a mode on the existing rig, not a second camera, so asking
    // the rig for it directly has to give the overhead pose.
    const target = resolveCameraTarget(
      request({ mode: 'PLACEMENT_TOP_DOWN' })
    )
    expect(target.height).toBeCloseTo(overhead.height, 9)
    expect(target.x).toBeCloseTo(HALF_L, 9)
    expect(target.lookHeight).toBe(0)
  })

  it('eases the rig itself into the placement view without a cut', () => {
    // Proves the placement view is reachable through the ordinary rig, so a client that
    // never runs a transition at all still arrives somewhere legal.
    let state = run(initialRigState(ASPECT_2_TO_1), request({ aimAngle: 0 }), 2)
    const placement = request({ mode: 'PLACEMENT_TOP_DOWN' })
    let previous = { ...state.pose }
    for (let i = 0; i < 120; i++) {
      state = stepCameraRig(state, placement, 1 / 60)
      expect(Math.abs(state.pose.height - previous.height)).toBeLessThan(400)
      expect(state.pose.height).toBeGreaterThanOrEqual(MIN_CAMERA_HEIGHT_MM)
      previous = { ...state.pose }
    }
  })
})