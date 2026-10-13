import { BALL_DIAMETER, BALL_RADIUS, BAULK_LINE_X, D_RADIUS, TABLE_LENGTH, TABLE_WIDTH, pocketPositions, type ShotInput } from '@snooker/shared'

/**
 * The D, as the placement UI sees it: centre and radius in table millimetres,
 * straight out of the shared constants so a preview can never drift from the rule
 * the server enforces. The D sits behind the baulk line (x <= BAULK_LINE_X).
 */
export const D_CENTRE = { x: BAULK_LINE_X, y: TABLE_WIDTH / 2 }
export const D_ZONE_RADIUS = D_RADIUS

/** Mirrors the shared `isInsideD` exactly, so the preview agrees with the server. */
export function isInsideD(pos: { x: number; y: number }): boolean {
  const dx = pos.x - BAULK_LINE_X
  const dy = pos.y - TABLE_WIDTH / 2
  return pos.x <= BAULK_LINE_X && dx * dx + dy * dy <= D_RADIUS * D_RADIUS
}

/** The server's own on-table test, mirrored for the ghost preview. */
export function isOnTable(pos: { x: number; y: number }): boolean {
  return (
    pos.x >= BALL_RADIUS &&
    pos.x <= TABLE_LENGTH - BALL_RADIUS &&
    pos.y >= BALL_RADIUS &&
    pos.y <= TABLE_WIDTH - BALL_RADIUS
  )
}

/** Mirrors the shared pocket-overlap test: a cue centred in a pocket mouth is not placeable. */
export function isInsideAPocket(pos: { x: number; y: number }): boolean {
  for (const pocket of pocketPositions()) {
    const dx = pos.x - pocket.x
    const dy = pos.y - pocket.y
    if (dx * dx + dy * dy < pocket.radius * pocket.radius) return true
  }
  return false

}

/** Mirrors the shared crowding test: centres at least a diameter apart. */
export function isCrowded(pos: { x: number; y: number }, balls: Array<{ id: number; x: number; y: number; potted: boolean }>): boolean {
  for (const ball of balls) {
    if (ball.id === 0 || ball.potted) continue
    const dx = ball.x - pos.x
    const dy = ball.y - pos.y
    if (dx * dx + dy * dy < BALL_DIAMETER * BALL_DIAMETER) return true
  }
  return false
}

/**
 * Whether a spot would be accepted for a placement, and why not when it would not.
 *
 * Pure and mirrored from the server's own `resolveCuePlacement`, so the client can
 * show an honest ghost without ever deciding the rule itself: the server still
 * rejects illegal placements authoritatively. `inD` says which restriction is in
 * force, which the snapshot's `cueInHandInD` carries.
 */
export function placementStatus(
  pos: { x: number; y: number },
  inD: boolean,
  balls: Array<{ id: number; x: number; y: number; potted: boolean }>
): { ok: boolean; reason: 'off-table' | 'in-pocket' | 'crowded' | 'outside-D' | null } {
  if (!isOnTable(pos)) return { ok: false, reason: 'off-table' }
  if (isInsideAPocket(pos)) return { ok: false, reason: 'in-pocket' }
  if (isCrowded(pos, balls)) return { ok: false, reason: 'crowded' }
  if (inD && !isInsideD(pos)) return { ok: false, reason: 'outside-D' }
  return { ok: true, reason: null }
}

/**
 * How far a moving ghost cue ball still is from its follow point, in millimetres,
 * after one frame of exponential smoothing. Returns the new position.
 *
 * The ghost is eased rather than snapped so a pointer jitter does not teleport the
 * preview across the cloth; the factor is frame-rate independent like every other
 * damp in this client.
 */
export function followGhost(
  current: { x: number; y: number },
  target: { x: number; y: number },
  dt: number,
  rate: number = 18
): { x: number; y: number } {
  const k = 1 - Math.exp(-Math.max(0, rate) * Math.max(0, dt))
  return { x: current.x + (target.x - current.x) * k, y: current.y + (target.y - current.y) * k }
}

/**
 * Whether the eased ghost is close enough to its target to commit a placement.
 *
 * A placement fired while the ghost is still far from the pointer would put the
 * cue ball somewhere the player was not looking at, so the commit waits until the
 * preview has caught up. 12mm is well under a ball radius: visually the ghost is
 * sitting on the spot.
 */
export const GHOST_COMMIT_TOLERANCE_MM = 12

export function ghostSettled(current: { x: number; y: number }, target: { x: number; y: number }): boolean {
  return Math.hypot(current.x - target.x, current.y - target.y) <= GHOST_COMMIT_TOLERANCE_MM
}

/* ------------------------------------------------------------------ *
 * The placement flow.
 *
 * Placing the cue ball is three separate things happening in sequence, and the reason
 * they are modelled as a state machine rather than a pile of booleans is that two of
 * them overlap with camera moves the player must not be able to interrupt. The camera
 * flies up to the overhead placement view, the player moves the ball and confirms it,
 * and the camera flies back to behind the cue ball. Between each of those the controls
 * belong to nobody, and the previous version of this flow - which tracked "is placing"
 * with one flag - could restart a camera move it was already in the middle of.
 *
 * Pure, like the rest of this module: it decides what the flow is doing and what the
 * player may do about it, and nothing here touches a camera, a socket or a canvas.
 * ------------------------------------------------------------------ */

/** What the placement flow is doing. */
export type PlacementPhase =
  /** No placement is live. Normal gameplay, controls are the player's. */
  | 'IDLE'
  /** The camera is flying up to the overhead placement view. Nothing may be touched. */
  | 'ENTERING'
  /** The camera is overhead and the player is moving the cue ball within the legal area. */
  | 'PLACING'
  /** The placement is confirmed and the camera is flying back to the gameplay view. */
  | 'RETURNING'

/** How the flow currently stands, plus the position a confirmed placement is held at. */
export interface PlacementFlow {
  phase: PlacementPhase
  /**
   * The confirmed cue-ball position, once the player has committed to one.
   *
   * Held through the camera's flight back so the ball cannot be moved while the view is
   * still moving: the position is the one the server was told, and re-reading it during
   * the transition is how a cue ball ends up somewhere the player did not put it.
   */
  confirmed: { x: number; y: number } | null
}

/** A flow that is not placing, with nothing confirmed. */
export function initialPlacementFlow(): PlacementFlow {
  return { phase: 'IDLE', confirmed: null }
}

/**
 * Whether the player may aim, shoot or charge power on this frame.
 *
 * Refused in every phase except `IDLE`. In `PLACING` the cue ball has no committed position
 * yet, so aiming it would be aiming nothing; in the two camera phases the camera is moving
 * and any input would fight it. This is the one question the input layer, the power bar and
 * the cue-stick drawing all ask, so they cannot disagree.
 *
 * Note this says nothing about whose turn it is. The flow only knows about placements, so a
 * caller that wants the controls to be the player's has to ask that separately - which is
 * why the frame loop ANDs this with its own visit test rather than trusting it alone.
 */
export function placementAllowsGameplayInput(flow: PlacementFlow): boolean {
  return flow.phase === 'IDLE'
}

/**
 * Whether the player may move the ghost cue ball this frame.
 *
 * Only in `PLACING`. Entering and returning are the camera's, and in `IDLE` there is no
 * ghost to move.
 */
export function placementAllowsGhostInput(flow: PlacementFlow): boolean {
  return flow.phase === 'PLACING'
}

/**
 * Whether the caller wants to reset its per-placement scratch state, which is every time
 * the flow stops being live.
 *
 * Separate from "are the overlays up" on purpose. The overlays go down the moment a
 * placement is confirmed, while the camera is still flying home and the controls are still
 * refused - so "the overlays are showing" and "the placement is over" are two different
 * questions and asking the wrong one either leaves the D and the ghost hanging in the air
 * for the length of the flight, or tears down state the flight still depends on.
 */
export function placementIsOver(flow: PlacementFlow): boolean {
  return flow.phase === 'IDLE'
}

/**
 * Advances the flow one frame given what the server's snapshot says.
 *
 * `placing` is the caller's own "this client owns a live ball-in-hand placement"
 * answer, which already folds in whose turn it is and whether the table has settled.
 * This function turns that into a phase, and the phase into the camera moves:
 *
 * - a placement appearing starts `ENTERING`, and the caller starts the camera's flight
 *   into the overhead view on the frame the phase becomes `ENTERING`;
 * - `ENTERING` becomes `PLACING` once the camera has arrived, which the caller reports
 *   by passing `cameraSettled`;
 * - `PLACING` becomes `RETURNING` when the player confirms a position;
 * - `RETURNING` becomes `IDLE` once the camera is back and the server has taken the
 *   placement, so the next shot state cannot be reached through a placement that is
 *   still in progress.
 *
 * The phase is the only thing that changes, so the camera is moved once per transition
 * and never restarted: re-entering a phase the flow is already in is a no-op, which is
 * exactly the bug the explicit phases exist to prevent.
 */
export function stepPlacementFlow(
  flow: PlacementFlow,
  input: { placing: boolean; cameraSettled: boolean; serverAccepted: boolean }
): PlacementFlow {
  const { placing, cameraSettled, serverAccepted } = input
  switch (flow.phase) {
    case 'IDLE':
      // A placement has appeared. Nothing is confirmed and nothing is blocking, so the
      // camera can be asked to start flying up as soon as the caller sees this phase.
      return placing ? { phase: 'ENTERING', confirmed: null } : flow
    case 'ENTERING':
      // The flight is finished and the player is looking straight down at the table.
      // If the placement was withdrawn while the camera was still moving (a frame that
      // ended, a turn that went elsewhere) there is nothing to place, so go back to idle
      // and let the camera fly home.
      if (!placing) return { phase: 'RETURNING', confirmed: null }
      return cameraSettled ? { phase: 'PLACING', confirmed: null } : flow
    case 'PLACING':
      // Withdrawn mid-placement, same as above.
      if (!placing && flow.confirmed === null) return { phase: 'RETURNING', confirmed: null }
      return flow
    case 'RETURNING': {
      // A placement that was confirmed is waiting on two things: the camera back at the
      // gameplay view, and the server's own snapshot having taken the ball. A placement
      // that was withdrawn is only waiting on the camera - nothing was ever sent, so there
      // is no acknowledgement to wait for, and holding the view hostage to one would leave
      // the camera down at the gameplay view with the controls still refused.
      const awaitingServer = flow.confirmed !== null
      return cameraSettled && (!awaitingServer || serverAccepted)
        ? { phase: 'IDLE', confirmed: null }
        : flow
    }
    default:
      return flow
  }
}

/**
 * Confirms a position, which is what moves the flow from `PLACING` to `RETURNING`.
 *
 * The position is recorded on the flow rather than read back from the ghost each frame,
 * so the cue ball stays exactly where it was put for the whole of the camera's flight
 * back. Refused in any other phase, which is what stops a stray click during the
 * transition from starting a second placement.
 */
export function confirmPlacement(flow: PlacementFlow, pos: { x: number; y: number }): PlacementFlow {
  if (flow.phase !== 'PLACING') return flow
  return { phase: 'RETURNING', confirmed: { x: pos.x, y: pos.y } }
}

/**
 * Puts the flow back to entering after the server refuses a confirmed placement.
 *
 * A commit that is rejected leaves the snapshot still saying the cue ball is in hand, which
 * is indistinguishable from a commit that is merely slow - so without this the flow waits in
 * `RETURNING` for an acknowledgement that is never coming, and the player is left looking at
 * a gameplay view they cannot use, with a cue ball they still own and no way to place it.
 * Refusals arrive as an `error` from the server, and this is how the player gets their
 * placement back rather than a dead end.
 *
 * Back to `ENTERING`, not `PLACING`: the camera is already on its way down to the gameplay
 * view, and going straight to `PLACING` would let the ghost be dragged around by a pointer
 * being read through a camera that is still moving. The camera is asked to turn around, and
 * the flow reaches `PLACING` again when it arrives.
 *
 * Refused in any other phase, so an `error` from an unrelated cause cannot drag a
 * gameplay frame back into a placement.
 */
export function rejectPlacement(flow: PlacementFlow): PlacementFlow {
  if (flow.phase !== 'RETURNING' || flow.confirmed === null) return flow
  return { phase: 'ENTERING', confirmed: null }
}
