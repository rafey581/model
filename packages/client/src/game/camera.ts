import { BALL_RADIUS, POCKET_RADIUS_CORNER, TABLE_LENGTH, TABLE_WIDTH } from '@snooker/shared'

/**
 * The camera rig: where it looks from, and how it gets there.
 *
 * Everything here is plain arithmetic on numbers, with no renderer and no scene in
 * sight. That is deliberate — the awkward parts of a camera are the parts you cannot
 * see by reading them, the shortest path round the wrap at 180 degrees, the frame that
 * clips a corner pocket, the transition that dips the lens through the cloth — and all
 * of them are testable without a browser once they are separated from the drawing.
 *
 * All positions are in table millimetres: `x` runs along the length from the baulk end,
 * `y` across the width from the far cushion, and `height` is above the cloth. The 3D
 * scene owns the conversion to its own axes and nothing else in the client does.
 */

const HALF_L = TABLE_LENGTH / 2
const HALF_W = TABLE_WIDTH / 2

/* ------------------------------------------------------------------ *
 * Tunable camera geometry.
 *
 * Every distance and angle the camera uses is named here, in millimetres or degrees, so
 * the feel can be judged by eye and changed in one place.
 * ------------------------------------------------------------------ */

/** Vertical field of view for the aim camera, in degrees. */
export const AIM_FOV_DEG = 50
/** How far behind the cue ball the aim camera sits, in millimetres. */
export const AIM_BACK_MM = 800
/** How far above the cloth the aim camera sits, in millimetres. */
export const AIM_HEIGHT_MM = 350
/**
 * How far ahead of the cue ball the aim camera looks, in millimetres.
 *
 * This is what tilts the lens down. Looking at the cloth ahead rather than at the ball
 * itself puts the horizon above the shot line, so the table runs away toward the top of
 * the screen and the cue ball sits low and near, the way a cue view actually looks.
 */
export const AIM_LOOK_AHEAD_MM = 700
/** The height the aim camera looks at: the cloth, not the ball. */
export const AIM_LOOK_HEIGHT_MM = 0

/** Vertical field of view for the overhead camera, in degrees. */
export const TOP_DOWN_FOV_DEG = 50
/**
 * Extra room around the table for the overhead camera, as a multiple of the half-extent.
 *
 * Covers the cushions and the pocket jaws, which sit outside the cloth, so that the
 * overhead view is of the whole table and not of the bed with its edges shaved off.
 */
export const TOP_DOWN_MARGIN = 1.1
/** A floor under the overhead height, so it never drops onto the cloth on a wide canvas. */
export const TOP_DOWN_MIN_HEIGHT_MM = 1500

/** Vertical field of view for the shot-tracking camera, in degrees. */
export const TRACK_FOV_DEG = 46
/**
 * The tracking camera's height above the focus point before it starts widening for the
 * spread of the balls, in millimetres.
 */
export const TRACK_HEIGHT_MM = 1450
/** How far behind the focus point the tracking camera sits, in millimetres. */
export const TRACK_BACK_MM = 950
/**
 * Extra height per millimetre of spread across the balls being followed.
 *
 * The spread is measured as the radius of the smallest circle round the focus that
 * contains them, so a handful of balls in one corner pulls the camera in over that
 * corner and a spread across the whole table pushes it up and back far enough to hold
 * them all.
 */
export const TRACK_SPREAD_GAIN = 1.45
/** The tracking camera never drops below this, however tight the balls are. */
export const TRACK_MIN_HEIGHT_MM = 900
/** The furthest the tracking camera is ever pushed back by spread alone. */
export const TRACK_MAX_HEIGHT_MM = 3400

/* ------------------------------------------------------------------ *
 * Damping.
 *
 * Rates are in 1/seconds and are used as `1 - e^(-rate * dt)`, so the behaviour is the
 * same at any frame rate: a slow frame takes a bigger step, but the curve is identical,
 * which is what keeps a dropped frame from reading as a jump.
 * ------------------------------------------------------------------ */

/**
 * How fast the camera's heading follows the aim angle, per second.
 *
 * Slower than the move rate on purpose. Aiming is a continuous gesture and the camera
 * has to feel attached to the cue, but a camera that snapped its heading would make the
 * aim line slide underneath the pointer and the whole thing would feel loose.
 */
export const YAW_RATE = 7
/** How fast position and look-at point catch up with their targets, per second. */
export const MOVE_RATE = 4.5
/** How fast the field of view catches up, per second. */
export const FOV_RATE = 3.5
/**
 * How fast the tracking camera follows the balls, per second.
 *
 * Deliberately slower than the visit camera: a shot is a couple of seconds of watching,
 * and a camera that keeps up instantly reads as a cut rather than as a follow.
 */
export const TRACK_MOVE_RATE = 2.4
/** How fast the tracking camera's heading follows the shot line, per second. */
export const TRACK_YAW_RATE = 3

/* ------------------------------------------------------------------ *
 * Sanity limits.
 *
 * The camera is a camera: it stays above the cloth, inside a box that is generous enough
 * to hold every pose the modes can produce and small enough that a bad input cannot put
 * it somewhere the table is not. Every pose passes through this on the way out, so a
 * transition cannot end up looking through the cloth or out in empty space.
 * ------------------------------------------------------------------ */

/** The lowest the lens may ever be, in millimetres: above the cushion, well clear. */
export const MIN_CAMERA_HEIGHT_MM = 140
/** The highest the lens may ever be, in millimetres. */
export const MAX_CAMERA_HEIGHT_MM = 6000
/**
 * The furthest from the table's centre the lens may sit, in millimetres.
 *
 * Has to clear the aim camera's 800mm setback when the cue ball is in a corner and the
 * shot is played back down the table — 2600mm from centre at worst — and the tracking
 * camera's 950mm from a focus at the far rail, with room over both. It is a backstop
 * against a bad pose, not a constraint the modes feel.
 */
export const CAMERA_REACH_MM = 3000
/** The narrowest and widest the lens may ever be, in degrees. */
export const MIN_FOV_DEG = 30
export const MAX_FOV_DEG = 75

/**
 * How much of the table the overhead camera has to show: the cloth, the cushions, and
 * the pocket mouths, which all reach past the cushion line.
 */
export const VISIBLE_HALF_LENGTH = HALF_L + POCKET_RADIUS_CORNER + 60
export const VISIBLE_HALF_WIDTH = HALF_W + POCKET_RADIUS_CORNER + 60

/** The three things the camera can be doing. */
export type CameraMode = 'AIM' | 'TOP_DOWN' | 'TRACK'

/** Where the camera is, and where it is looking, all in table millimetres. */
export interface CameraPose {
  x: number
  y: number
  height: number
  lookX: number
  lookY: number
  lookHeight: number
  fov: number
}

/**
 * How far the player may push the camera round from the shot's own heading, in radians.
 *
 * Half a turn either way is more than any shot needs: the camera can end up in front of
 * the cue ball looking back, which is the view you want when the ball is tight against a
 * cushion, and no further.
 */
export const MAX_ORBIT_RAD = Math.PI

/**
 * Where the camera is pointed, kept apart from where the cue is pointed.
 *
 * These are two different questions and the rig is not allowed to answer one with the
 * other. Aiming sweeps the cue the whole length of the table, and a camera bolted to that
 * angle swings round behind the cue ball with it, so sweeping out a shot line turns the
 * room over rather than turning the cue. The heading is therefore latched when a shot
 * starts and held for as long as the player spends on that shot, and the player's own
 * look-around is kept as a separate offset that only a deliberate drag can move.
 */
export interface HeadingLatch {
  /** The heading the camera was last pointed at. Fixed for the length of a shot. */
  heading: number
  /** The player's look-around from the current heading. Right-drag only. */
  orbit: number
}

export function initialHeadingLatch(aimAngle: number = 0): HeadingLatch {
  return { heading: aimAngle, orbit: 0 }
}

/**
 * Carries the latch from one frame to the next.
 *
 * `startingShot` is the signal that a new shot is being set up. While it is false nothing
 * about the aim can reach the camera, which is what keeps a moving cursor from turning
 * anything: however far the player's aim travels in between, the heading and the orbit
 * come back out of here untouched.
 *
 * A new shot re-latches from the aim it starts with and drops the look-around, because
 * that aim is the direction the player just played, so the camera comes back to the view
 * the shot was taken from rather than to wherever they had wandered.
 */
export function stepHeadingLatch(
  latch: HeadingLatch,
  aimAngle: number,
  startingShot: boolean
): HeadingLatch {
  if (!startingShot) return latch
  return { heading: aimAngle, orbit: 0 }
}

/** Adds a drag to the player's look-around, held inside {@link MAX_ORBIT_RAD}. */
export function addOrbit(latch: HeadingLatch, delta: number): HeadingLatch {
  return { heading: latch.heading, orbit: clamp(latch.orbit + delta, -MAX_ORBIT_RAD, MAX_ORBIT_RAD) }
}

/** The heading the camera is actually pointed along: the latched one, plus the look-around. */
export function latchedCameraYaw(latch: HeadingLatch): number {
  return latch.heading + latch.orbit
}

/** What the rig is being asked to do this frame. */
export interface CameraRequest {
  mode: CameraMode
  /**
   * The canvas shape. The overhead camera's height is derived from it rather than fixed,
   * because the one thing that must never happen is a pocket falling off the edge of the
   * screen, and a fixed height cannot promise that on a canvas of any other shape.
   */
  aspect: number
  /** Where the cue ball is. Null before the table has said where anything is. */
  cue: { x: number; y: number } | null
  /**
   * The heading the shot is being played along, in radians.
   *
   * Read by {@link resolveCameraTarget} when it is called directly. The rig itself takes
   * its heading from the latch below, never from a live aim — which is what keeps a
   * hovering pointer from rotating anything.
   */
  aimAngle: number
  /**
   * Where the camera is pointed: the latched shot heading plus the player's own
   * look-around. This, and only this, is what the rig eases its yaw towards.
   */
  latch: HeadingLatch
  /**
   * The point the tracking camera should hold in frame, and how far the balls spread
   * around it. Null when there is nothing worth following, which drops the camera back to
   * the overhead view rather than inventing a focus.
   */
  focus: { x: number; y: number; spread: number } | null
}

/**
 * The rig's own memory: the pose it is at, and the heading it has turned to so far.
 *
 * The heading is kept separately from the pose because it is the one quantity with two
 * ways round it. Damping a direction as a vector would swing the camera the long way when
 * the aim crosses 180 degrees, which is the spin-around this rig exists to avoid.
 */
export interface CameraRigState {
  pose: CameraPose
  yaw: number
}

const TABLE_CENTRE = { x: HALF_L, y: HALF_W }

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}

/**
 * The turn from one heading to another, taken the short way round, in radians.
 *
 * Always in (-π, π]. Two headings a degree apart across the wrap give a delta of two
 * degrees, not 358, which is the whole point: the caller adds this to the current
 * heading and steps towards the target along the line the player turned.
 */
export function shortestAngleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2)
  if (delta > Math.PI) delta -= Math.PI * 2
  if (delta <= -Math.PI) delta += Math.PI * 2
  return delta
}

/**
 * Eases a heading towards a target along the shortest path.
 *
 * Exponential rather than a fixed step, so it slows into the target instead of arriving
 * and stopping. Monotonic by construction: the factor is always between 0 and 1, so it
 * can never overshoot the target and settle back, which is the jitter that makes a
 * damped camera feel loose.
 */
export function dampAngle(current: number, target: number, rate: number, dt: number): number {
  return current + shortestAngleDelta(current, target) * (1 - Math.exp(-rate * dt))
}

/** Eases a number towards a target, exponential and monotonic, like the heading. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt))
}

/**
 * The height the overhead camera needs to hold the whole table in frame.
 *
 * Solved rather than tabulated: the horizontal field of view follows from the canvas
 * shape, so a wide canvas needs less height for the same table and a tall one needs more.
 * Taking the larger of the two answers is what guarantees the frame clears both ends and
 * both cushions at once — the failure that would otherwise show up as a pocket sitting
 * just off the edge of the screen.
 */
export function topDownHeight(aspect: number, fovDeg: number = TOP_DOWN_FOV_DEG): number {
  const tanV = Math.tan((fovDeg * Math.PI) / 360)
  const tanH = tanV * Math.max(aspect, 0.1)
  const forLength = VISIBLE_HALF_LENGTH / tanH
  const forWidth = VISIBLE_HALF_WIDTH / tanV
  return Math.max(TOP_DOWN_MIN_HEIGHT_MM, forLength, forWidth) * TOP_DOWN_MARGIN
}

/**
 * The aim camera's pose for a cue ball and a heading.
 *
 * Placed along the line behind the cue ball, so the cue ball is dead centre of the frame
 * and the shot line runs away from the viewer, which is the view that makes the object
 * ball the far thing rather than the near one.
 */
export function aimPose(
  cue: { x: number; y: number },
  yaw: number,
  fovDeg: number = AIM_FOV_DEG
): CameraPose {
  const dx = Math.cos(yaw)
  const dy = Math.sin(yaw)
  return {
    x: cue.x - dx * AIM_BACK_MM,
    y: cue.y - dy * AIM_BACK_MM,
    height: AIM_HEIGHT_MM,
    lookX: cue.x + dx * AIM_LOOK_AHEAD_MM,
    lookY: cue.y + dy * AIM_LOOK_AHEAD_MM,
    lookHeight: AIM_LOOK_HEIGHT_MM,
    fov: fovDeg
  }
}

/** The overhead pose: centred on the table, looking straight down at it. */
export function topDownPose(aspect: number, fovDeg: number = TOP_DOWN_FOV_DEG): CameraPose {
  return {
    x: TABLE_CENTRE.x,
    y: TABLE_CENTRE.y,
    height: topDownHeight(aspect, fovDeg),
    lookX: TABLE_CENTRE.x,
    lookY: TABLE_CENTRE.y,
    lookHeight: 0,
    fov: fovDeg
  }
}

/**
 * The shot-tracking pose: a raised camera behind the balls that are moving, held at the
 * angle the shot was played along so the table does not spin under the viewer.
 *
 * The height follows the spread rather than being fixed, because the alternative is
 * either clipping the balls that run to a cushion or pulling so far back that the shot
 * is a dot.
 */
export function trackPose(focus: { x: number; y: number; spread: number }, yaw: number): CameraPose {
  const height = clamp(
    TRACK_HEIGHT_MM + Math.max(0, focus.spread) * TRACK_SPREAD_GAIN,
    TRACK_MIN_HEIGHT_MM,
    TRACK_MAX_HEIGHT_MM
  )
  const dx = Math.cos(yaw)
  const dy = Math.sin(yaw)
  return {
    x: focus.x - dx * TRACK_BACK_MM,
    y: focus.y - dy * TRACK_BACK_MM,
    height,
    lookX: focus.x,
    lookY: focus.y,
    lookHeight: BALL_RADIUS,
    fov: TRACK_FOV_DEG
  }
}

/**
 * Keeps the lens above the cloth and inside a box the table actually occupies.
 *
 * Applied to every pose the rig produces, including the ones it eases between, so a
 * transition is as bounded as the states at either end of it. This is the guard against
 * the two ways a camera rig goes wrong: looking up through the table from underneath it,
 * and drifting off to somewhere the table is not.
 */
export function clampPose(pose: CameraPose): CameraPose {
  const cx = TABLE_CENTRE.x
  const cy = TABLE_CENTRE.y
  const lookX = clamp(pose.lookX, cx - CAMERA_REACH_MM, cx + CAMERA_REACH_MM)
  const lookY = clamp(pose.lookY, cy - CAMERA_REACH_MM, cy + CAMERA_REACH_MM)
  return {
    x: clamp(pose.x, cx - CAMERA_REACH_MM, cx + CAMERA_REACH_MM),
    y: clamp(pose.y, cy - CAMERA_REACH_MM, cy + CAMERA_REACH_MM),
    height: clamp(pose.height, MIN_CAMERA_HEIGHT_MM, MAX_CAMERA_HEIGHT_MM),
    lookX,
    lookY,
    lookHeight: clamp(pose.lookHeight, MIN_CAMERA_HEIGHT_MM, MAX_CAMERA_HEIGHT_MM),
    fov: clamp(pose.fov, MIN_FOV_DEG, MAX_FOV_DEG)
  }
}

/** The pose a request asks for, before any easing. */
export function resolveCameraTarget(request: CameraRequest): CameraPose {
  if (request.mode === 'TOP_DOWN') return topDownPose(request.aspect)
  if (request.mode === 'TRACK') {
    return request.focus ? trackPose(request.focus, request.aimAngle) : topDownPose(request.aspect)
  }
  // With no cue ball there is nothing to sit behind, and a camera that invented one
  // would swing across the table on the first frame. It waits overhead until there is.
  return request.cue ? aimPose(request.cue, request.aimAngle) : topDownPose(request.aspect)
}

/** A rig parked in the overhead view, which is where every match starts. */
export function initialRigState(aspect: number): CameraRigState {
  const pose = topDownPose(aspect)
  return { pose, yaw: 0 }
}

function dampPose(current: CameraPose, target: CameraPose, rate: number, fovRate: number, dt: number): CameraPose {
  return {
    x: damp(current.x, target.x, rate, dt),
    y: damp(current.y, target.y, rate, dt),
    height: damp(current.height, target.height, rate, dt),
    lookX: damp(current.lookX, target.lookX, rate, dt),
    lookY: damp(current.lookY, target.lookY, rate, dt),
    lookHeight: damp(current.lookHeight, target.lookHeight, rate, dt),
    fov: damp(current.fov, target.fov, fovRate, dt)
  }
}

/**
 * Advances the rig one frame.
 *
 * The order matters: the heading is eased first, and the aim pose is then rebuilt from
 * the eased heading rather than from the target. That is what makes a 179-to-minus-179
 * turn sweep through 180 degrees over about a fifth of a second instead of unwinding
 * the long way round through zero. Everything after that is a plain eased move towards
 * a pose the rig has already decided it is heading for.
 */
export function stepCameraRig(state: CameraRigState, request: CameraRequest, dt: number): CameraRigState {
  const step = Math.max(0, Math.min(dt, 0.1))
  const tracking = request.mode === 'TRACK'
  // The heading the rig eases towards is the latched one, plus whatever look-around the
  // player has dragged in. The live aim is nowhere in it: aiming turns the cue, and only
  // a played shot re-latching or an explicit drag can move this target.
  const yaw = dampAngle(state.yaw, latchedCameraYaw(request.latch), tracking ? TRACK_YAW_RATE : YAW_RATE, step)

  // The aim pose is rebuilt from the eased heading, so its own position eases with it.
  // The other modes resolve normally: their headings come out of their geometry.
  const target =
    request.mode === 'AIM' && request.cue
      ? aimPose(request.cue, yaw)
      : resolveCameraTarget({ ...request, aimAngle: yaw })

  const pose = clampPose(
    dampPose(state.pose, target, tracking ? TRACK_MOVE_RATE : MOVE_RATE, FOV_RATE, step)
  )
  return { pose, yaw }
}

/** The heading a pose implies, for tests and for re-seeding the rig. */
export function poseHeading(pose: CameraPose): number {
  return Math.atan2(pose.lookY - pose.y, pose.lookX - pose.x)
}