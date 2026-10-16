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
  /**
   * Extra table kept in view beyond the pocket mouths, in millimetres: the leather and the
   * wood of the corners stand further out than the cloth. Absent is none.
   */
  extraMm?: number
  /**
   * Where the camera stands. `foot` and `baulk` are over a short end, looking down the
   * length; `side` is over the near long cushion, looking across, so the length of the
   * table runs across the screen — the fit for a wide phone held sideways.
   */
  endSide: 'foot' | 'baulk' | 'side'
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

/**
 * The phone's spectator view: from over the foot end, looking down the table the way the
 * mobile snooker games show the opponent's visit, but lower and closer than the desktop's,
 * with almost no margin. The near cushion spreads across the screen and the balls are drawn
 * as large as a wide screen held sideways allows, with the whole table still in view.
 */
export const SPECTATOR_CAM_PHONE_OVERRIDES: Partial<SpectatorCamConfig> = {
  endSide: 'foot',
  pitchDeg: 45,
  fovDeg: 44,
  screenMargin: 0.04,
  // The corner leather stands about 140 mm out from the cushion line on the model.
  extraMm: 75,
  minHeight: 600
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
/**
 * The axis the camera looks along, for where it stands: its centre on the table, how far
 * the table reaches along it (depth) and across it (to the sides of the screen).
 */
function viewAxis(config: SpectatorCamConfig): { centre: number; halfDepth: number; halfSide: number; facing: number } {
  const extra = config.extraMm ?? 0
  if (config.endSide === 'side') {
    // Over the long cushion at y = 0, looking towards +y.
    return { centre: HALF_W, halfDepth: VISIBLE_HALF_WIDTH + extra, halfSide: VISIBLE_HALF_LENGTH + extra, facing: 1 }
  }
  // Looking towards -x from the foot end, towards +x from the baulk end.
  return {
    centre: HALF_L,
    halfDepth: VISIBLE_HALF_LENGTH + extra,
    halfSide: VISIBLE_HALF_WIDTH + extra,
    facing: config.endSide === 'foot' ? -1 : 1
  }
}

function solveForFov(config: SpectatorCamConfig, aspect: number, fovDeg: number): { x: number; height: number } {
  const pitch = (config.pitchDeg * Math.PI) / 180
  const axis = viewAxis(config)
  const facing = axis.facing
  const fx = facing * Math.cos(pitch)
  const fh = -Math.sin(pitch)
  const ux = facing * Math.sin(pitch)
  const uh = Math.cos(pitch)
  const usable = Math.max(0.05, 1 - 2 * config.screenMargin)
  const tanV = Math.tan((fovDeg * Math.PI) / 360) * usable
  const tanH = tanV * Math.max(aspect, 0.05)
  const nearX = axis.centre - facing * axis.halfDepth
  const farX = axis.centre + facing * axis.halfDepth

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
  if (axis.halfSide / best.nearDepth > tanH) {
    // Too wide for the screen at this framing. A tighter vertical frame is a camera
    // further back, and the near rail's depth grows steadily as it tightens, so the
    // loosest frame that still clears the sides is found by halving.
    let low = 0.0001
    let high = tanV
    for (let i = 0; i < 48; i++) {
      const mid = (low + high) / 2
      if (axis.halfSide / solve(mid).nearDepth > tanH) high = mid
      else low = mid
    }
    best = solve(low)
  }
  return { x: best.x, height: best.height }
}

const insideBox = (config: SpectatorCamConfig, at: { x: number; height: number }): boolean =>
  at.height <= config.maxHeight && Math.abs(at.x - viewAxis(config).centre) <= CAMERA_REACH_MM

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
  const axis = viewAxis(config)
  const facing = axis.facing
  const height = Math.max(config.minHeight, at.height)
  // The look-at point is where the line of sight meets the cloth, so the pose carries the
  // pitch exactly and the rig's own `lookAt` reproduces it.
  const along = at.x + (facing * Math.cos(pitch) * at.height) / Math.sin(pitch)
  const side = config.endSide === 'side'
  const pose = clampPose({
    x: side ? HALF_L : at.x,
    y: side ? at.x : HALF_W,
    height,
    lookX: side ? HALF_L : along,
    lookY: side ? along : HALF_W,
    lookHeight: height - at.height,
    fov: fovDeg
  })
  return { pose, fovDeg, distance: Math.hypot(side ? pose.y - HALF_W : pose.x - HALF_L, pose.height), fits }
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

/** The pocket camera: how far outside the pocket it stands, how high, where it looks, and its lens. */
export const POT_CAM = {
  backMm: 880,
  heightMm: 400,
  lookAheadMm: 950,
  fovDeg: 46,
  /**
   * The cut waits until the ball that drops is already close to its pocket, this many mm
   * from it, and is heading in: that is the moment anyone watching can see it is going in.
   * Cutting any earlier — the instant the cue ball touched it — made the camera look as if
   * it had known the result before the shot was played.
   */
  approachMm: 900,
  /** Simulated seconds of the shot it is up for, at most, before the ball drops and after. */
  leadSeconds: 0.9,
  tailSeconds: 1.35,
  /** The ball that drops is watched moving for at least this long from the table view first. */
  watchFirstSeconds: 0.4,
  /** A cut that would be up for less than this before the drop is not made at all. */
  minShowSeconds: 0.2,
  /**
   * A ball that drops sooner than this after the strike is not cut to. The picture has
   * only just cut to the whole table; cutting again a third of a second later, and back
   * again after that, is three pictures in the time it takes to read one.
   */
  earliestPotSeconds: 0.75,
  /**
   * The cut never comes before this much of the shot has been seen from the table view.
   * The replay clock sits at 0 through the opponent's wind-up, and a ball that dropped
   * within `leadSeconds` of the strike opened the window at 0 — the camera went to the
   * pocket before the cue had touched the ball, giving the shot away.
   */
  afterStrikeSeconds: 0.45
} as const

/**
 * The view of a ball going in: from just outside the pocket, low, looking back across the
 * table at the ball coming.
 *
 * A pose like any other, in table millimetres. It stands on the far side of the pocket
 * from the middle of the table, so the pocket is at the bottom of the picture and the
 * ball runs towards the lens and drops out of sight in front of it.
 */
export function potCameraPose(pocket: { x: number; y: number }): CameraPose {
  let dx = HALF_L - pocket.x
  let dy = HALF_W - pocket.y
  // A middle pocket is on the long axis of the table: looking at the centre from there is
  // looking straight across, which is what is wanted.
  const length = Math.hypot(dx, dy) || 1
  dx /= length
  dy /= length
  return {
    x: pocket.x - dx * POT_CAM.backMm,
    y: pocket.y - dy * POT_CAM.backMm,
    height: POT_CAM.heightMm,
    lookX: pocket.x + dx * POT_CAM.lookAheadMm,
    lookY: pocket.y + dy * POT_CAM.lookAheadMm,
    lookHeight: 0,
    fov: POT_CAM.fovDeg
  }
}

/**
 * Whether the spectator view should be up next frame, given whether it is up now.
 *
 * The rule is whose shot or whose visit is on the table:
 *
 *  - A shot is being replayed. The view is up, whoever played it: the moment a ball is
 *    struck the picture cuts to the whole table, the way a broadcast does, so the shot is
 *    watched from where all of it can be seen. The player's own shot used to be watched
 *    from behind the cue ball, where everything past the first contact happens at the far
 *    end of a long foreshortened table.
 *  - The table is at rest. The view follows the turn, but only once the table has been
 *    still for a moment, so the last shot is seen to finish before the camera leaves it.
 *    Until then it stays wherever it was.
 *
 * That is what keeps the view up for the whole of the opponent's visit: their shots hold
 * it, and the gaps between their shots do not drop it.
 */
export function nextSpectating(current: boolean, signal: SpectatorSignal): boolean {
  if (!signal.enabled || !signal.seatKnown || signal.placementActive) return false
  if (signal.liveReplay) return true
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
