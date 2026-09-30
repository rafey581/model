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
 * The shot input for a placement stroke: the cue ball goes where the player put it.
 *
 * The angle points up-table toward the pack, power rests at the bar's default and
 * spin at zero — the shot is only ever the carrier for `cuePos`, and the placement
 * commit is what hands the turn to real aiming. A zero power stroke is never sent:
 * the caller fires this through the normal `shot:play` path, which validates and
 * lets the server resolve the placement.
 */
export function placementShot(cuePos: { x: number; y: number }, aimAngle: number, power: number): Omit<ShotInput, 'timestamp'> {
  return {
    aimAngle,
    power: Math.max(0, Math.min(1, power)),
    spin: { x: 0, y: 0 },
    cuePos: { x: cuePos.x, y: cuePos.y }
  }
}

/**
 * The minimum-aim sanity: while placing, the aim line points from the ghost into
 * the table so the committed stroke reads as a legal break or safety. Feeds
 * `placementShot`; kept trivial and pure so the placement commit is testable.
 */
export function placementAimAngle(pos: { x: number; y: number }): number {
  // Toward the table centre, so a break-off D placement looks up-table and a
  // mid-frame placement never fires straight into the nearest cushion.
  return Math.atan2(TABLE_WIDTH / 2 - pos.y, TABLE_LENGTH / 2 - pos.x)
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
