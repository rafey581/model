import {
  BALL_RADIUS,
  CUSHION_KNUCKLE_RADIUS,
  CUSHION_RESTITUTION_LONG,
  CUSHION_RESTITUTION_SHORT,
  POCKET_RADIUS_CORNER,
  POCKET_RADIUS_MIDDLE,
  TABLE_LENGTH,
  TABLE_WIDTH
} from '../constants.js'

/**
 * Cushion geometry shared by the simulation and its tests.
 *
 * The old model reflected a ball off four full-length planes that ran right up
 * to each corner. That is not what a snooker table is: every cushion face stops
 * short of the pocket and is capped by a rounded jaw (knuckle), and it is the
 * jaw, not a phantom straight cushion, that a ball meets when it arrives near a
 * pocket. This module encodes that geometry once, in table millimetres, so the
 * faces and jaws cannot drift apart.
 *
 * Coordinates are the simulation's: x runs 0..TABLE_LENGTH and y runs
 * 0..TABLE_WIDTH, with the cushion nose lines exactly on the table edges and a
 * ball centre always at least BALL_RADIUS inside them.
 *
 * A face is described in the local terms the resolver needs: the axis it runs
 * along, the span of that axis over which it exists, the perpendicular
 * coordinate a ball centre sits at when it touches, the velocity sign that means
 * "heading into the cushion", and its restitution.
 *
 * A jaw is the circular arc that continues the face from its end into the
 * pocket. In pocket-local coordinates (a along the rail away from the pocket, t
 * outward from the nose line) the arc centre is F = (aEnd, rk) with radius rk,
 * so it meets the straight face at (aEnd, 0) and is tangent to the pocket circle
 * of radius R at T = F·R/(R+rk). `aEnd` follows from that tangency:
 * aEnd = sqrt((R + rk)^2 - rk^2).
 */

export interface CushionFace {
  /** Axis the rail runs along. */
  along: 'x' | 'y'
  /** Span of the ball-centre coordinate along the rail over which the face exists. */
  from: number
  to: number
  /** Ball-centre coordinate on the perpendicular axis at the moment of contact. */
  limit: number
  /** Sign of the perpendicular velocity that means the ball is heading into the cushion. */
  into: -1 | 1
  restitution: number
  /** Sign applied to the sidespin kick on the along-rail velocity. */
  kick: -1 | 1
}

export interface CushionJaw {
  /** Arc centre F, in table millimetres. */
  cx: number
  cy: number
  /** Knuckle radius rk. */
  radius: number
  /** The pocket this jaw caps, used only to frame the arc. */
  px: number
  py: number
  restitution: number
  /** Unit normal at the face end, where the arc begins. */
  sx: number
  sy: number
  /**
   * Signed sweep from the face-end normal to the tangent normal at the pocket
   * circle. Contact is only resolved between those two bounds, so beyond the
   * tangency the pocket circle takes over.
   */
  sweep: number
}

/**
 * Distance along the rail from a pocket centre to the end of the straight
 * cushion face, so that a knuckle of radius `rk` meets the pocket circle of
 * radius `pocketRadius` tangentially.
 */
export function cushionFaceEnd(pocketRadius: number): number {
  return Math.sqrt((pocketRadius + CUSHION_KNUCKLE_RADIUS) ** 2 - CUSHION_KNUCKLE_RADIUS ** 2)
}

const CORNER_END = cushionFaceEnd(POCKET_RADIUS_CORNER)
const MIDDLE_END = cushionFaceEnd(POCKET_RADIUS_MIDDLE)
const MID = TABLE_LENGTH / 2
const RK = CUSHION_KNUCKLE_RADIUS

/**
 * The straight part of each cushion, as ball-centre contact spans.
 *
 * The top and bottom rails run along x and are interrupted by the two corner
 * pockets and the middle pocket; the left and right rails run along y and are
 * interrupted only by the two corners. Restitution follows the old split:
 * long rails (left/right) and short rails (top/bottom) share a value today but
 * stay separate so they can be tuned apart.
 */
export const CUSHION_FACES: readonly CushionFace[] = [
  // top rail (nose y = 0)
  { along: 'x', from: CORNER_END, to: MID - MIDDLE_END, limit: BALL_RADIUS, into: -1, restitution: CUSHION_RESTITUTION_SHORT, kick: 1 },
  { along: 'x', from: MID + MIDDLE_END, to: TABLE_LENGTH - CORNER_END, limit: BALL_RADIUS, into: -1, restitution: CUSHION_RESTITUTION_SHORT, kick: 1 },
  // bottom rail (nose y = TABLE_WIDTH)
  { along: 'x', from: CORNER_END, to: MID - MIDDLE_END, limit: TABLE_WIDTH - BALL_RADIUS, into: 1, restitution: CUSHION_RESTITUTION_SHORT, kick: -1 },
  { along: 'x', from: MID + MIDDLE_END, to: TABLE_LENGTH - CORNER_END, limit: TABLE_WIDTH - BALL_RADIUS, into: 1, restitution: CUSHION_RESTITUTION_SHORT, kick: -1 },
  // left rail (nose x = 0)
  { along: 'y', from: CORNER_END, to: TABLE_WIDTH - CORNER_END, limit: BALL_RADIUS, into: -1, restitution: CUSHION_RESTITUTION_LONG, kick: -1 },
  // right rail (nose x = TABLE_LENGTH)
  { along: 'y', from: CORNER_END, to: TABLE_WIDTH - CORNER_END, limit: TABLE_LENGTH - BALL_RADIUS, into: 1, restitution: CUSHION_RESTITUTION_LONG, kick: 1 }
]

/**
 * Builds a jaw from the pocket it caps and the rail direction pointing away
 * from the pocket along the face.
 */
function makeJaw(
  px: number,
  py: number,
  ux: number,
  uy: number,
  wx: number,
  wy: number,
  aEnd: number,
  restitution: number
): CushionJaw {
  const cx = px + ux * aEnd + wx * RK
  const cy = py + uy * aEnd + wy * RK
  // The normal at the face end points back toward the table (-w).
  const sx = -wx
  const sy = -wy
  // The normal at the tangency with the pocket circle points from F to the
  // pocket centre, i.e. along -(u * aEnd + w * rk).
  const tx = -(ux * aEnd + wx * RK)
  const ty = -(uy * aEnd + wy * RK)
  const tl = Math.hypot(tx, ty)
  const tnx = tx / tl
  const tny = ty / tl
  const sweep = Math.atan2(sx * tny - sy * tnx, sx * tnx + sy * tny)
  return { cx, cy, radius: RK, px, py, restitution, sx, sy, sweep }
}

/**
 * The rounded jaw at each end of every face. Four corners have two apiece and
 * both middle pockets have one on either side, making twelve in all.
 */
export const CUSHION_JAWS: readonly CushionJaw[] = [
  // top-left corner
  makeJaw(0, 0, 1, 0, 0, -1, CORNER_END, CUSHION_RESTITUTION_SHORT),
  makeJaw(0, 0, 0, 1, -1, 0, CORNER_END, CUSHION_RESTITUTION_LONG),
  // top-middle pocket
  makeJaw(MID, 0, -1, 0, 0, -1, MIDDLE_END, CUSHION_RESTITUTION_SHORT),
  makeJaw(MID, 0, 1, 0, 0, -1, MIDDLE_END, CUSHION_RESTITUTION_SHORT),
  // top-right corner
  makeJaw(TABLE_LENGTH, 0, -1, 0, 0, -1, CORNER_END, CUSHION_RESTITUTION_SHORT),
  makeJaw(TABLE_LENGTH, 0, 0, 1, 1, 0, CORNER_END, CUSHION_RESTITUTION_LONG),
  // bottom-left corner
  makeJaw(0, TABLE_WIDTH, 1, 0, 0, 1, CORNER_END, CUSHION_RESTITUTION_SHORT),
  makeJaw(0, TABLE_WIDTH, 0, -1, -1, 0, CORNER_END, CUSHION_RESTITUTION_LONG),
  // bottom-middle pocket
  makeJaw(MID, TABLE_WIDTH, -1, 0, 0, 1, MIDDLE_END, CUSHION_RESTITUTION_SHORT),
  makeJaw(MID, TABLE_WIDTH, 1, 0, 0, 1, MIDDLE_END, CUSHION_RESTITUTION_SHORT),
  // bottom-right corner
  makeJaw(TABLE_LENGTH, TABLE_WIDTH, -1, 0, 0, 1, CORNER_END, CUSHION_RESTITUTION_SHORT),
  makeJaw(TABLE_LENGTH, TABLE_WIDTH, 0, -1, 1, 0, CORNER_END, CUSHION_RESTITUTION_LONG)
]

export interface JawContact {
  /** Ball centre after the contact has been resolved. */
  x: number
  y: number
  vx: number
  vy: number
  /** Whether the velocity was actually turned (false for a pure depenetration). */
  bounced: boolean
}

/**
 * Resolves a ball against a single jaw, treating the knuckle as a circular
 * obstacle of radius `rk` that the ball's centre may not enter within
 * `rk + BALL_RADIUS`.
 *
 * The contact normal is radial, so the reflection is the same lossy mirror as a
 * cushion (normal component reversed and damped by `restitution`, tangential
 * component damped by `tangentialDamp`), just about an arbitrary normal rather
 * than a table axis. Contact is rejected outside the arc's angular span so the
 * pocket circle, not the jaw, handles everything past the tangency.
 *
 * Returns null when the ball is not touching the arc.
 */
export function resolveJawContact(
  x: number,
  y: number,
  vx: number,
  vy: number,
  jaw: CushionJaw,
  restitution: number,
  tangentialDamp: number
): JawContact | null {
  const dx = x - jaw.cx
  const dy = y - jaw.cy
  const contact = jaw.radius + BALL_RADIUS
  const d2 = dx * dx + dy * dy
  if (d2 === 0 || d2 >= contact * contact) return null
  const d = Math.sqrt(d2)
  const nx = dx / d
  const ny = dy / d

  // Angular gate: the ball must be on the table side of the arc, between the
  // face end and the pocket-circle tangency.
  const cross = jaw.sx * ny - jaw.sy * nx
  const dot = jaw.sx * nx + jaw.sy * ny
  const phi = Math.atan2(cross, dot)
  if (jaw.sweep >= 0 ? phi < 0 || phi > jaw.sweep : phi > 0 || phi < jaw.sweep) return null

  const px = jaw.cx + nx * contact
  const py = jaw.cy + ny * contact
  const vn = vx * nx + vy * ny
  if (vn >= 0) return { x: px, y: py, vx, vy, bounced: false }

  const tx = vx - vn * nx
  const ty = vy - vn * ny
  const reflected = -vn * restitution
  return {
    x: px,
    y: py,
    vx: reflected * nx + tx * tangentialDamp,
    vy: reflected * ny + ty * tangentialDamp,
    bounced: true
  }
}
