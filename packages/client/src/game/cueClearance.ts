import { TABLE_LENGTH, TABLE_WIDTH } from '@snooker/shared'

/**
 * How steeply the cue has to be raised to clear the rail behind the cue ball.
 *
 * Over open cloth a player cues almost flat, the butt raised a few degrees. With the cue
 * ball near a cushion the cue has to come over the rail behind it, so the butt goes up —
 * as steeply as it takes for the cue to pass over the cushion and the wood, and no more.
 * A cue drawn at the flat angle there would run straight through the rail.
 *
 * Plain arithmetic in table millimetres (x along the length, y across, 0..TABLE_LENGTH and
 * 0..TABLE_WIDTH at the cushion noses), so it is tested without a renderer. Picture only:
 * the shot the server plays is the same whatever angle the cue is drawn at.
 */

/** The cue's angle above level over open cloth, in degrees. */
export const CUE_FLAT_ELEVATION_DEG = 4
/**
 * The steepest a cue is ever drawn, in degrees. Only a slight lift, as the cue is drawn in
 * the games players know: with the ball tight on a cushion the butt comes up a little and
 * the cue may graze the top of the rail, rather than standing up nearly on end, which hid
 * the shot and was awkward to line up.
 */
export const CUE_MAX_ELEVATION_DEG = 20
/** The top of the cushion and the wooden rail above the cloth, in millimetres (measured off the table model). */
export const RAIL_TOP_MM = 39
/** Clear air kept between the underside of the cue and the top of the rail, in millimetres. */
export const RAIL_CLEARANCE_MM = 4
/** The cue's radius where it passes over the rail, in millimetres: a little thicker than at the tip. */
export const CUE_RADIUS_OVER_RAIL_MM = 6.5

/**
 * How far the cue ball's centre is from the cushion behind it, along the line the cue comes
 * in on: the first cushion nose the backwards line reaches. Infinity for a line that never
 * reaches one, which cannot happen on a table but keeps the arithmetic honest.
 */
export function distanceToCushionBehind(cue: { x: number; y: number }, angle: number): number {
  const bx = -Math.cos(angle)
  const by = -Math.sin(angle)
  let best = Infinity
  if (bx < -1e-9) best = Math.min(best, (0 - cue.x) / bx)
  if (bx > 1e-9) best = Math.min(best, (TABLE_LENGTH - cue.x) / bx)
  if (by < -1e-9) best = Math.min(best, (0 - cue.y) / by)
  if (by > 1e-9) best = Math.min(best, (TABLE_WIDTH - cue.y) / by)
  return Math.max(0, best)
}

/**
 * The angle the cue is drawn at, in degrees.
 *
 * `hitHeight` is how far above the cloth the tip meets the ball, and `hitDepth` how far
 * behind the ball's centre, along the shot, that point is. The cue runs back from there,
 * rising at the angle; it has to be above the rail by the time it reaches the cushion.
 */
export function cueElevationDeg(cue: { x: number; y: number }, angle: number, hitHeight: number, hitDepth: number): number {
  const toCushion = distanceToCushionBehind(cue, angle)
  // Horizontal run from the tip's point on the ball back to the cushion's nose.
  const run = Math.max(1, toCushion - hitDepth)
  const climb = RAIL_TOP_MM + RAIL_CLEARANCE_MM + CUE_RADIUS_OVER_RAIL_MM - hitHeight
  const needed = climb > 0 ? (Math.atan2(climb, run) * 180) / Math.PI : 0
  return Math.min(CUE_MAX_ELEVATION_DEG, Math.max(CUE_FLAT_ELEVATION_DEG, needed))
}
