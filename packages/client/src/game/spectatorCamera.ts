import { TABLE_LENGTH, TABLE_WIDTH } from '@snooker/shared'
import {
  CAMERA_REACH_MM,
  MAX_FOV_DEG,
  VISIBLE_HALF_LENGTH,
  VISIBLE_HALF_WIDTH,
  clampPose,
  stepPlacementTransition,
  type CameraPose,
  type PlacementTransition
} from './camera.js'
import { USE_SPECTATOR_CAM } from '../lobby/flag.js'

/**
 * The spectator camera: where the lens stands while somebody else is at the table.
 *
 * A television view from high above one short end, looking down the length of the bed, so
 * the whole table is in frame and the opponent's cue, line and power can be read. It is a
 * pose for the existing rig and a use of its existing timed transition, not a camera of
 * its own: everything here is plain arithmetic that hands the rig a `CameraPose`.
 *
 * Presentation only. Nothing in this file decides a turn — it is told whose turn it is and
 * answers where to look from.
 */

export interface SpectatorCamConfig {
  /** Off, and the camera behaves exactly as it did before this view existed. */
  enabled: boolean
  /** How far below the horizontal the lens points, in degrees. */
  pitchDeg: number
  /** Vertical field of view, in degrees. Widened only when the table cannot otherwise fit. */
  fovDeg: number
  /** Clear space kept between the table and each edge of the screen, as a fraction of it. */
  screenMargin: number
  /** Which short end the camera stands over. `foot` is the end opposite the baulk line. */
  endSide: 'foot' | 'baulk'
  /** The lowest and highest the lens may stand, in millimetres above the cloth. */
  minHeight: number
  maxHeight: number
  /** How long the move into the view and back out of it takes, in seconds. */
  enterSeconds: number
  exitSeconds: number
  /** A duration at or under this is a cut. Set the two above to it for an instant change. */
  instantSeconds: number
  /**
   * How long the table has to have been at rest before the view goes up, in seconds.
   *
   * The player has just played a shot and wants to see where it finished: the balls stop,
   * the table is held as it is for this long, and only then does the camera leave. Without
   * it the view changed on the very frame the last ball stopped, which read as the game
   * not waiting for the shot to end.
   */
  settleSeconds: number
  /** How much thicker the opponent's cue is drawn from up here. Its length is untouched. */
  cueThicknessScale: number
  /**
   * How long the opponent's cue stands behind the ball lining up before it draws back, in
   * seconds. Longer than the venue's own beat, because from this view the point of the
   * wind-up is to be read: where the cue is pointed and how hard the shot will be.
   */
  cueAimSeconds: number
  /** The opponent's aim line: the player's own ribbon, dimmer and warm. */
  aimLineColor: number
  aimLineOpacity: number
}

export const SPECTATOR_CAM: SpectatorCamConfig = {
  enabled: USE_SPECTATOR_CAM,
  pitchDeg: 55,
  fovDeg: 42,
  screenMargin: 0.06,
  endSide: 'foot',
  minHeight: 1500,
  maxHeight: 5800,
  // A cut both ways. The move into the view was a fly-over of most of a second and read
  // as a wait; set these to 0.9 and 0.7 to have it back.
  enterSeconds: 0.05,
  exitSeconds: 0.05,
  instantSeconds: 0.05,
  settleSeconds: 1.4,
  cueThicknessScale: 1.6,
  cueAimSeconds: 0.9,
  aimLineColor: 0xffc27a,
  aimLineOpacity: 0.6
}

const HALF_L = TABLE_LENGTH / 2
const HALF_W = TABLE_WIDTH / 2

/** What the fit worked out, with the numbers a test or a report wants alongside the pose. */
export interface SpectatorFit {
  pose: CameraPose
  /** The field of view actually used: the configured one unless the screen was too narrow. */
  fovDeg: number
  /** How far the lens is from the centre of the table, in millimetres. */
  distance: number
  /** False only when even the widest lens the rig allows cannot hold the table in the box. */
  fits: boolean
}

/**
 * Solves the camera for one field of view: the lens position on the table's long axis
 * that puts the near rail on the bottom margin and the far rail on the top one, pulled
 * back further if the near corners would otherwise leave the sides.
 *
 * Worked in the vertical plane through the table's long axis, where the camera has two
 * unknowns — how far along and how high — and each rail on its margin is one linear
 * equation in them. The sides are then a single inequality on the near rail, which is the
 * closest thing to the lens and so the widest on screen; when it fails the frame is
 * tightened and solved again, which backs the camera off along its own line of sight and
 * keeps the table centred top to bottom.
 */
function solveForFov(config: SpectatorCamConfig, aspect: number, fovDeg: number): { x: number; height: number } {
  const pitch = (config.pitchDeg * Math.PI) / 180
  // Looking towards -x from the foot end, towards +x from the baulk end.
  const facing = config.endSide === 'foot' ? -1 : 1
  const fx = facing * Math.cos(pitch)
  const fh = -Math.sin(pitch)
  const ux = facing * Math.sin(pitch)
  const uh = Math.cos(pitch)
  const usable = Math.max(0.05, 1 - 2 * config.screenMargin)
  const tanV = Math.tan((fovDeg * Math.PI) / 360) * usable
  const tanH = tanV * Math.max(aspect, 0.05)
  const nearX = HALF_L - facing * VISIBLE_HALF_LENGTH
  const farX = HALF_L + facing * VISIBLE_HALF_LENGTH

  const solve = (t: number): { x: number; height: number; nearDepth: number } => {
    // A rail at `t` up the frame satisfies r·(u − t·f) = 0, with r from the lens to it.
    const nearGx = ux + t * fx
    const nearGh = uh + t * fh
    const farGx = ux - t * fx
    const farGh = uh - t * fh
    // (nearX − X)·nearGx − H·nearGh = 0 and (farX − X)·farGx − H·farGh = 0.
    const det = nearGx * farGh - farGx * nearGh
    const x = (nearX * nearGx * farGh - farX * farGx * nearGh) / det
    // Height from the far rail's equation: its divisor is never small, where the near
    // rail's goes to zero as the bottom of the frame approaches straight down.
    const height = ((farX - x) * farGx) / farGh
    const nearDepth = (nearX - x) * fx - height * fh
    return { x, height, nearDepth }
  }

  let best = solve(tanV)
  if (VISIBLE_HALF_WIDTH / best.nearDepth > tanH) {
    // Too wide for the screen at this framing. A tighter vertical frame is a camera
    // further back, and the near rail's depth grows steadily as it tightens, so the
    // loosest frame that still clears the sides is found by halving.
    let low = 0.0001
    let high = tanV
    for (let i = 0; i < 48; i++) {
      const mid = (low + high) / 2
      if (VISIBLE_HALF_WIDTH / solve(mid).nearDepth > tanH) high = mid
      else low = mid
    }
    best = solve(low)
  }
  return { x: best.x, height: best.height }
}

const insideBox = (config: SpectatorCamConfig, at: { x: number; height: number }): boolean =>
  at.height <= config.maxHeight && Math.abs(at.x - HALF_L) <= CAMERA_REACH_MM

/**
 * The spectator pose for a screen of this shape.
 *
 * Pure: the table, the config and an aspect ratio in, a pose out. The whole table — bed,
 * cushions and pocket mouths — sits inside the screen with the configured margin on every
 * side, centred left to right, with no roll.
 *
 * On a wide screen the configured field of view is used as it stands. On a narrow one the
 * camera would have to stand further back than the room allows, so the lens is opened
 * instead, by the least that brings it back inside the rig's own limits.
 */
export function fitSpectatorCamera(aspect: number, config: SpectatorCamConfig = SPECTATOR_CAM): SpectatorFit {
  let fovDeg = config.fovDeg
  let at = solveForFov(config, aspect, fovDeg)
  let fits = insideBox(config, at)
  if (!fits) {
    const widest = solveForFov(config, aspect, MAX_FOV_DEG)
    if (insideBox(config, widest)) {
      let low = config.fovDeg
      let high = MAX_FOV_DEG
      for (let i = 0; i < 32; i++) {
        const mid = (low + high) / 2
        if (insideBox(config, solveForFov(config, aspect, mid))) high = mid
        else low = mid
      }
      fovDeg = high
      at = solveForFov(config, aspect, fovDeg)
      fits = true
    } else {
      fovDeg = MAX_FOV_DEG
      at = widest
    }
  }
  const pitch = (config.pitchDeg * Math.PI) / 180
  const facing = config.endSide === 'foot' ? -1 : 1
  const height = Math.max(config.minHeight, at.height)
  // The look-at point is where the line of sight meets the cloth, so the pose carries the
  // pitch exactly and the rig's own `lookAt` reproduces it.
  const pose = clampPose({
    x: at.x,
    y: HALF_W,
    height,
    lookX: at.x + (facing * Math.cos(pitch) * at.height) / Math.sin(pitch),
    lookY: HALF_W,
    lookHeight: height - at.height,
    fov: fovDeg
  })
  return { pose, fovDeg, distance: Math.hypot(pose.x - HALF_L, pose.height), fits }
}

/**
 * Where a point on the cloth lands on screen from a pose, in normalised device
 * coordinates: -1 to 1 across and up, with 0,0 the centre. Null behind the lens.
 *
 * The same pinhole the renderer uses, written out so the fit can be checked without one.
 */
export function projectFromPose(
  pose: CameraPose,
  aspect: number,
  point: { x: number; y: number }
): { x: number; y: number } | null {
  const fx = pose.lookX - pose.x
  const fy = pose.lookY - pose.y
  const fh = pose.lookHeight - pose.height
  const fl = Math.hypot(fx, fy, fh)
  if (fl === 0) return null
  const f = { x: fx / fl, y: fy / fl, h: fh / fl }
  // Right is forward crossed with straight up; up is right crossed with forward.
  const rl = Math.hypot(f.x, f.y)
  if (rl === 0) return null
  const r = { x: -f.y / rl, y: f.x / rl }
  const u = { x: -r.y * f.h, y: r.x * f.h, h: r.y * f.x - r.x * f.y }
  const dx = point.x - pose.x
  const dy = point.y - pose.y
  const dh = -pose.height
  const depth = dx * f.x + dy * f.y + dh * f.h
  if (depth <= 0) return null
  const tanV = Math.tan((pose.fov * Math.PI) / 360)
  return {
    x: (dx * r.x + dy * r.y) / (depth * tanV * aspect),
    y: (dx * u.x + dy * u.y + dh * u.h) / (depth * tanV)
  }
}

/**
 * Where the opponent's cue rests while they are at the table and have not yet played.
 *
 * Nothing tells this client where the opponent is aiming before the shot arrives, so this
 * is a resting pose and not a prediction: the cue points from the cue ball at the nearest
 * ball that is on, which is where somebody walking up to the shot would naturally stand.
 * The real line replaces it the moment the shot is known.
 */
export function addressHeading(
  cue: { x: number; y: number },
  balls: ReadonlyArray<{ id: number; x: number; y: number; potted: boolean }>,
  ballOn: string
): number {
  const colour = /colour:(\d+)/.exec(ballOn)
  const wanted = colour ? Number(colour[1]) : null
  let best: { x: number; y: number } | null = null
  let bestDistance = Infinity
  for (const ball of balls) {
    if (ball.potted || ball.id === 0) continue
    // Reds are ids 1 to 15; a named colour is its own id.
    const on = wanted === null ? ball.id >= 1 && ball.id <= 15 : ball.id === wanted
    if (!on) continue
    const distance = Math.hypot(ball.x - cue.x, ball.y - cue.y)
    if (distance < bestDistance) {
      bestDistance = distance
      best = ball
    }
  }
  // Nothing on (or nothing left): face the middle of the table.
  const target = best ?? { x: TABLE_LENGTH / 2, y: TABLE_WIDTH / 2 }
  return Math.atan2(target.y - cue.y, target.x - cue.x)
}

/** Everything the decision reads. All of it is the game's own state, only looked at. */
export interface SpectatorSignal {
  /** The feature flag and the config switch, already combined. */
  enabled: boolean
  /** Whether this client knows which seat it is in. Without that there is no "opponent". */
  seatKnown: boolean
  /** The turn as the game has it right now: true when it is not this player's. */
  liveOpponentTurn: boolean
  /** Whether a shot is being replayed right now. */
  liveReplay: boolean
  /**
   * Who played the shot that is being replayed: true when it was the opponent's. Read
   * off whose visit it was on the frame before the replay began, which is the only honest
   * answer — by the time the replay is running the turn may already have changed hands.
   */
  replayByOpponent: boolean
  /** The table has been at rest long enough for the last shot to have been seen. */
  settled: boolean
  /** The turn as the table is currently *showing* it: true when it is this player's. */
  shownMyTurn: boolean
  /** A turn presentation is holding the table back right now. */
  presentationHeld: boolean
  /** The player's own ball-in-hand view is up, or flying. It outranks this one. */
  placementActive: boolean
}

/**
 * Whether the spectator view should be up next frame, given whether it is up now.
 *
 * The rule is whose shot or whose visit is on the table:
 *
 *  - A shot is being replayed. The view is up for the opponent's and down for the
 *    player's own, whatever the turn says — a missed shot has already handed the turn
 *    over while it is still rolling, and the camera belongs to whoever played it.
 *  - The table is at rest. The view follows the turn, but only once the table has been
 *    still for a moment, so the last shot is seen to finish before the camera leaves it.
 *    Until then it stays wherever it was.
 *
 * That is what keeps the view up for the whole of the opponent's visit: their shots hold
 * it, and the gaps between their shots do not drop it.
 */
export function nextSpectating(current: boolean, signal: SpectatorSignal): boolean {
  if (!signal.enabled || !signal.seatKnown || signal.placementActive) return false
  if (signal.liveReplay) return signal.replayByOpponent
  if (!signal.settled || signal.presentationHeld) return current
  if (signal.liveOpponentTurn) return true
  return signal.shownMyTurn ? false : current
}

/**
 * Advances a spectator move by `dt`: the rig's own `stepPlacementTransition`, with the
 * `blocking` it raises while running put back down, so nothing that asks whether input is
 * refused can ever hear yes from this.
 */
export function stepSpectatorTransition(
  transition: PlacementTransition,
  dt: number
): { pose: CameraPose; transition: PlacementTransition } {
  const stepped = stepPlacementTransition(transition, dt)
  stepped.transition.blocking = false
  return stepped
}

export function beginSpectatorTransition(from: CameraPose, to: CameraPose, seconds: number): PlacementTransition {
  return {
    from: { ...from },
    to: clampPose(to),
    elapsed: 0,
    duration: Math.max(0.001, seconds),
    active: true,
    blocking: false
  }
}
