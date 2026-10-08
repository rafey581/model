import { BALL_RADIUS, TABLE_LENGTH, TABLE_WIDTH } from '@snooker/shared'

/**
 * Where the cue ball is aiming, and what it will meet.
 *
 * This is a drawing aid only. It answers the question a player actually has
 * before a shot -- "am I going to clip that ball, and where?" -- and shares no
 * code with the simulation, so it can never change how a shot is played out.
 */
export interface AimGuide {
  /** The ball the cue ball will touch first. */
  targetId: number
  /** How far the cue ball's centre travels before the contact, in millimetres. */
  travel: number
  /** Where the cue ball's centre sits at the moment of contact. */
  ghost: { x: number; y: number }
  /**
   * The point on the target ball's surface where the two balls touch. This is
   * the line of centres pulled back by one ball radius, and it is where the
   * guide should stop and the contact marker belong.
   */
  contact: { x: number; y: number }
  /**
   * The line of centres, pointing the way the target ball leaves. Kept separate
   * from the aim line because on a cut the two are visibly different directions.
   */
  lineOfCentres: { x: number; y: number }
  /**
   * Where the cue ball itself goes after the contact, as a chain of straight runs
   * that turn where they meet a cushion.
   *
   * This is the half of the collision the object-ball arrow does not show. On a
   * full hit the cue ball has nowhere to go and stops dead, and this is empty. On
   * a cut it leaves along the tangent, at right angles to the line of centres,
   * running further the thinner the cut. Predicting that is what lets a player see
   * a shot is safe before playing it rather than after.
   */
  cuePath: AimSegment[]
}

/** One straight run of a predicted path, from one bounce to the next. */
export interface AimSegment {
  from: { x: number; y: number }
  to: { x: number; y: number }
}

export interface AimGuideBall {
  id: number
  x: number
  y: number
  potted: boolean
}

/**
 * How far the object-ball direction arrow is drawn beyond the contact point, in
 * millimetres. Roughly three and a half ball widths: long enough to read the
 * line at a glance, short enough not to be mistaken for the aim line.
 */
export const OBJECT_DIR_ARROW_LENGTH = 190

/** The head of the object-ball arrow, as an angle, for drawing the barbs. */
const ARROW_HEAD_LENGTH = 46
const ARROW_HEAD_ANGLE = Math.PI / 7

/**
 * How far the predicted cue-ball path is drawn, in millimetres.
 *
 * This is a drawing length, not a distance prediction. How far the cue ball really
 * runs after contact depends on the power it was struck with and on how long it
 * takes for the cloth to take that speed away, and neither is known while aiming.
 * What the guide does commit to is the direction, which is exact: right angles to
 * the line of centres, whichever way the cut was made. So the path is drawn the same
 * length whatever the cut, and the one thing that decides whether there is a path at
 * all is whether any sideways motion survived the collision.
 */
const CUE_PATH_LENGTH = 520

/** Cushion turns the predicted path will take before it is given up on. */
const CUE_PATH_MAX_BOUNCES = 2

/**
 * Where the cue ball goes once it has hit the target.
 *
 * Momentum only passes along the line of centres, so what is left of the cue ball's
 * own velocity is the part travelling across that line, and it leaves along the
 * tangent to the contact:
 *
 *     n = unit(target - cue at contact)
 *     t = (-n.y, n.x)
 *     v_cue' = (v_cue . t) t
 *
 * Because the incoming velocity runs along the aim line, `v_cue . t` is just the
 * sine of the cut angle, which is why a full ball leaves nothing behind and a thin
 * cut sends the cue ball the full length of the table. The runs are then turned off
 * the cushions so the line reads as a path across the cloth rather than a ray into
 * the rail.
 *
 * The sign matters: cutting the other way sends the cue ball off in the opposite
 * tangent direction, so the guide has to carry it rather than assume one side.
 */
function predictCuePath(
  ghost: { x: number; y: number },
  lineOfCentres: { x: number; y: number },
  incoming: { x: number; y: number },
  length: number
): AimSegment[] {
  // The tangent is the line of centres turned a quarter turn.
  const tx = -lineOfCentres.y
  const ty = lineOfCentres.x
  // Only the sideways part of the strike survives the collision.
  const along = incoming.x * tx + incoming.y * ty
  // A full ball leaves the cue ball with no sideways motion at all, so it stops.
  if (Math.abs(along) < 0.02) return []

  const dirX = Math.sign(along) * tx
  const dirY = Math.sign(along) * ty

  const segments: AimSegment[] = []
  let x = ghost.x
  let y = ghost.y
  let dx = dirX
  let dy = dirY
  let remaining = length

  for (let bounce = 0; bounce <= CUE_PATH_MAX_BOUNCES && remaining > 1; bounce++) {
    // Distance to each rail the path is heading for, and which rail that is.
    const bounds = {
      left: BALL_RADIUS,
      right: TABLE_LENGTH - BALL_RADIUS,
      top: BALL_RADIUS,
      bottom: TABLE_WIDTH - BALL_RADIUS
    }
    const toRight = dx > 0 ? (bounds.right - x) / dx : Infinity
    const toLeft = dx < 0 ? (bounds.left - x) / dx : Infinity
    const toBottom = dy > 0 ? (bounds.bottom - y) / dy : Infinity
    const toTop = dy < 0 ? (bounds.top - y) / dy : Infinity
    const rail = Math.min(toRight, toLeft, toBottom, toTop)

    // Nothing left to run, or the path is already off the cloth.
    if (!Number.isFinite(rail) || rail <= 0) break

    if (rail <= remaining) {
      // It reaches the cushion: draw up to it, then turn.
      const to = { x: x + dx * rail, y: y + dy * rail }
      segments.push({ from: { x, y }, to })
      x = to.x
      y = to.y
      remaining -= rail
      // Only the component into the rail is turned back; the rest runs along it,
      // which is the same split the cushion itself uses.
      if (rail === toTop || rail === toBottom) dy = -dy
      else dx = -dx
    } else {
      segments.push({ from: { x, y }, to: { x: x + dx * remaining, y: y + dy * remaining } })
      remaining = 0
    }
  }

  return segments
}

export interface ObjectDirection {
  /** Where the arrow starts: the contact point on the target ball. */
  from: { x: number; y: number }
  /** Where the arrowhead points: out along the line of centres. */
  to: { x: number; y: number }
  /** The two barbs, so the arrow reads as an arrowhead rather than a plain line. */
  barbs: [{ x: number; y: number }, { x: number; y: number }]
}

/**
 * The path the struck ball will take once the cue ball reaches it: the line of
 * centres continued past the contact point, with an arrowhead on the end.
 *
 * This is the cue-ball contact line and the object-ball departure line in one,
 * which is the single fact a player needs to judge a cut shot. It is derived
 * only from the geometry of the contact, so it holds for every angle: on a full
 * hit the two lines coincide, and on a thin cut they open up.
 */
export function objectDirection(guide: AimGuide, length: number = OBJECT_DIR_ARROW_LENGTH): ObjectDirection {
  const dx = guide.lineOfCentres.x
  const dy = guide.lineOfCentres.y
  const from = { x: guide.contact.x, y: guide.contact.y }
  const to = { x: from.x + dx * length, y: from.y + dy * length }
  // The barbs sweep back from the tip, one on each side of the shaft.
  const head = Math.atan2(dy, dx)
  const barb = (sign: number): { x: number; y: number } => ({
    x: to.x - Math.cos(head + sign * ARROW_HEAD_ANGLE) * ARROW_HEAD_LENGTH,
    y: to.y - Math.sin(head + sign * ARROW_HEAD_ANGLE) * ARROW_HEAD_LENGTH
  })
  return { from, to, barbs: [barb(1), barb(-1)] }
}

/**
 * Works out what the cue ball is lined up on.
 *
 * A contact happens when the two centres are one diameter apart, so the cue ball
 * is treated as a point travelling along the aim line and the target as a circle
 * of that diameter. Solving that ray/circle intersection gives the exact distance
 * to the contact, which is what makes the guide land on the ball rather than
 * stopping short of it or running past it.
 *
 * Returns null when the aim line touches nothing, so callers can fall back to a
 * plain direction indicator.
 */
export function computeAimGuide(
  cue: { x: number; y: number; id?: number },
  angle: number,
  balls: AimGuideBall[],
  radius: number = BALL_RADIUS,
  cuePathLength: number = CUE_PATH_LENGTH
): AimGuide | null {
  const dirX = Math.cos(angle)
  const dirY = Math.sin(angle)
  const contact2 = (radius * 2) * (radius * 2)
  const cueId = cue.id ?? 0

  let best: AimGuide | null = null

  for (const ball of balls) {
    if (ball.potted || ball.id === cueId) continue

    // Centre of the target relative to the cue ball.
    const mx = ball.x - cue.x
    const my = ball.y - cue.y
    const along = mx * dirX + my * dirY
    // Already past the point of contact, or the line of centres points backwards.
    if (along <= 0) continue

    const perpendicularSq = mx * mx + my * my - along * along
    // The aim line has to pass within one diameter of the centre to make contact.
    if (perpendicularSq >= contact2) continue

    const half = Math.sqrt(contact2 - perpendicularSq)
    const travel = along - half
    if (travel <= 0) continue
    if (best && travel >= best.travel) continue

    const ghostX = cue.x + dirX * travel
    const ghostY = cue.y + dirY * travel
    // The line of centres runs from the cue ball to the target at contact.
    const nx = ball.x - ghostX
    const ny = ball.y - ghostY
    const length = Math.hypot(nx, ny) || 1

    const lineOfCentres = { x: nx / length, y: ny / length }

    best = {
      targetId: ball.id,
      travel,
      ghost: { x: ghostX, y: ghostY },
      contact: { x: ball.x - (nx / length) * radius, y: ball.y - (ny / length) * radius },
      lineOfCentres,
      cuePath: predictCuePath(
        { x: ghostX, y: ghostY },
        lineOfCentres,
        { x: dirX, y: dirY },
        cuePathLength
      )
    }
  }

  return best
}

/**
 * How thick the aim lines read on screen, in pixels.
 *
 * The lines are drawn as strips lying on the cloth, so their world width has to
 * change with the lens: a fixed millimetre width is a hairline at the overhead
 * camera and a bar at the cue camera. This is the thickness they are held to
 * instead — a broadcast shot line is about five pixels of solid colour, crisp
 * rather than glowing or feathered.
 */
export const AIM_LINE_TARGET_PX = 5

/** The thinnest a line is ever drawn, in millimetres: below this it aliases. */
export const AIM_LINE_MIN_MM = 3
/** The thickest a line is ever drawn, in millimetres: beyond this it is a stripe. */
export const AIM_LINE_MAX_MM = 24

/**
 * The world width, in millimetres, that makes a line read as
 * {@link AIM_LINE_TARGET_PX} pixels from `distanceMm`, for a lens of `fovDeg`
 * filling `viewportPx` pixels of height. Clamped so neither the overhead view
 * nor a ball against the lens can push it to a hairline or a bar.
 */
export function aimLineWorldWidth(distanceMm: number, fovDeg: number, viewportPx: number): number {
  const perPixel = (2 * distanceMm * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(1, viewportPx)
  return Math.min(AIM_LINE_MAX_MM, Math.max(AIM_LINE_MIN_MM, AIM_LINE_TARGET_PX * perPixel))
}

/**
 * Where LINE 1 is drawn: from the cue ball's own surface along the aim angle,
 * stopping at the ghost ball when something is in the way and at the cushion
 * when the table is open.
 *
 * The heading is always the aim angle, never the direction to the contact point.
 * Those differ on a cut, and a shot line that leans toward the ball it is going
 * to hit is drawing a shot nobody is playing: the cue ball goes straight, and
 * only after contact does anything else move.
 *
 * `out` is filled in place so the caller can hold one layout for the frame
 * without allocating.
 */
export interface ShotLineLayout {
  /** The heading the line is drawn along: the aim angle, unchanged. */
  angle: number
  /** Where the line starts, in table coordinates: the cue ball's surface. */
  from: { x: number; y: number }
  /** Where it stops: the ghost ball on contact, or the cushion face. */
  to: { x: number; y: number }
  /** Millimetres of line to draw, from `from` to `to`. */
  length: number
}

/** An empty {@link ShotLineLayout} for a caller to reuse across frames. */
export function shotLineLayoutTarget(): ShotLineLayout {
  return { angle: 0, from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, length: 0 }
}

export function shotLineLayout(
  cue: { x: number; y: number },
  angle: number,
  guide: AimGuide | null,
  out: ShotLineLayout
): ShotLineLayout {
  const dirX = Math.cos(angle)
  const dirY = Math.sin(angle)
  out.angle = angle
  out.from.x = cue.x + dirX * BALL_RADIUS
  out.from.y = cue.y + dirY * BALL_RADIUS

  if (guide) {
    out.to.x = guide.ghost.x
    out.to.y = guide.ghost.y
    out.length = Math.max(0, guide.travel - BALL_RADIUS)
    return out
  }

  // Nothing in the way: the line runs to the bed's own rectangle. Geometry, not
  // prediction, so no aim data is being invented here.
  let far = 4000
  if (dirX > 0.0001) far = Math.min(far, (TABLE_LENGTH - cue.x) / dirX)
  if (dirX < -0.0001) far = Math.min(far, -cue.x / dirX)
  if (dirY > 0.0001) far = Math.min(far, (TABLE_WIDTH - cue.y) / dirY)
  if (dirY < -0.0001) far = Math.min(far, -cue.y / dirY)
  out.to.x = cue.x + dirX * far
  out.to.y = cue.y + dirY * far
  out.length = Math.max(0, far - BALL_RADIUS)
  return out
}


