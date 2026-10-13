/**
 * Turning a point on the screen into a point on the cloth.
 *
 * The pointer has to be answered through the camera the player is actually looking
 * through. The old answer was a straight line from the cue ball's projected position to
 * the pointer, which is only right from directly overhead: under the overhead view the
 * projection is close enough to affine for that line to be the aim, but from behind the
 * cue ball the same shortcut points the cue somewhere else entirely, and it gets worse
 * the further the cue ball is from the middle of the table.
 *
 * So the pointer is cast as what it is: a ray from the lens through a point on the
 * screen, intersected with the plane of the cloth. That is exact for any camera position
 * and any angle, which is what makes one input path correct for all three views.
 *
 * Plain arithmetic again, no renderer: the 3D scene reads its basis off the live camera
 * and hands it over, and the geometry is testable here without a canvas.
 */

import { BALL_RADIUS, TABLE_LENGTH, TABLE_WIDTH } from '@snooker/shared'

/**
 * The height a pointer ray is aimed at, above the cloth.
 *
 * The cloth, not the middle of the cue ball. Aiming is a flat, top-down decision — where
 * the cue ball would travel along the bed — so the plane to intersect is the one the
 * table is drawn on. Answering on the ball's centre plane instead would put every aim a
 * little high, further off the further the camera is above the table.
 */
export const PICK_PLANE_HEIGHT_MM = 0

/**
 * A camera, as three unit vectors and a lens.
 *
 * `x`, `y` and `height` are in table millimetres; each of the three vectors is a
 * direction in the same `(x, y, height)` frame, so a direction is a triple whose third
 * component is vertical. `forward` is the direction the lens looks, `right` and `up` are
 * the camera's own right and up, and they form a right-handed orthonormal set.
 */
export interface PickCamera {
  x: number
  y: number
  height: number
  forward: Vec3
  right: Vec3
  up: Vec3
  /** Vertical field of view, in degrees. */
  fovDeg: number
  /** Canvas width divided by height. */
  aspect: number
}

export interface Vec3 {
  x: number
  y: number
  h: number
}

export interface TablePoint {
  x: number
  y: number
}

const CAMERA_BASIS_TOLERANCE = 1e-6

function normalise(v: Vec3): Vec3 {
  const length = Math.hypot(v.x, v.y, v.h) || 1
  return { x: v.x / length, y: v.y / length, h: v.h / length }
}

/**
 * The world-space ray through a point on the screen, in the `(x, y, height)` frame.
 *
 * `ndc` is in the usual normalised device coordinates: x from -1 at the left edge to 1
 * at the right, y from -1 at the bottom to 1 at the top. The half-angles come from the
 * field of view and the canvas shape, which is the whole of the projection — the rest is
 * just which way the camera is facing.
 */
export function screenRay(ndcX: number, ndcY: number, camera: PickCamera): Vec3 {
  const tanV = Math.tan((camera.fovDeg * Math.PI) / 360)
  const tanH = tanV * camera.aspect
  return normalise({
    x: camera.forward.x + camera.right.x * ndcX * tanH + camera.up.x * ndcY * tanV,
    y: camera.forward.y + camera.right.y * ndcX * tanH + camera.up.y * ndcY * tanV,
    h: camera.forward.h + camera.right.h * ndcX * tanH + camera.up.h * ndcY * tanV
  })
}

/**
 * Where a ray through a point on the screen meets the cloth, or null if it never does.
 *
 * Null is the honest answer in three cases, and all three happen in normal play: the ray
 * is level with the cloth or climbing away from it, which is everything above the
 * horizon; the ray points back toward the camera; and the lens is already on the plane.
 * A caller that gets null should leave the aim where it was rather than snapping it to
 * the middle of the table.
 */
export function screenToTable(ndcX: number, ndcY: number, camera: PickCamera): TablePoint | null {
  const ray = screenRay(ndcX, ndcY, camera)
  const denominator = ray.h
  if (denominator > -CAMERA_BASIS_TOLERANCE) return null
  const t = (PICK_PLANE_HEIGHT_MM - camera.height) / denominator
  if (!(t > 0)) return null
  return { x: camera.x + ray.x * t, y: camera.y + ray.y * t }
}

/**
 * A camera built from a position, a heading and a tilt, without needing the renderer's
 * matrix maths.
 *
 * Used by the tests, and by anything that wants a pickable camera description without a
 * scene. The heading is a point on the cloth the lens looks at, so a caller can say "from
 * here, looking at that" and get a basis it can cast rays through.
 */
export function pickCameraAt(
  position: { x: number; y: number; height: number },
  lookAt: { x: number; y: number; height: number },
  fovDeg: number,
  aspect: number
): PickCamera {
  const forward = normalise({
    x: lookAt.x - position.x,
    y: lookAt.y - position.y,
    h: lookAt.height - position.height
  })
  // The right vector is the heading turned a quarter turn in the horizontal plane, which
  // is the right vector for any camera that is level or tilted but never rolled.
  //
  // Straight down is the degenerate case: the heading has no horizontal part to turn, so
  // the quarter turn comes out zero length and every ray would come back as the same
  // direction. Overhead there is no correct sideways — the camera has no roll and no
  // heading to speak of — so it is given the table's own length as the right, which puts
  // the two long cushions across the frame and leaves the overhead view with the same
  // handedness as the flat renderer: increasing `y` runs down the screen in both, so
  // switching between the two views does not turn the table round.
  const flat = Math.hypot(-forward.y, forward.x)
  const right: Vec3 =
    flat > CAMERA_BASIS_TOLERANCE
      ? { x: -forward.y / flat, y: forward.x / flat, h: 0 }
      : { x: 1, y: 0, h: 0 }
  // The up vector is the other pair crossed the way a camera needs it: with the right
  // vector along the table's length and the lens pointing down, this is the sense that
  // matches the flat renderer's.
  const up = normalise({
    x: forward.y * right.h - forward.h * right.y,
    y: forward.h * right.x - forward.x * right.h,
    h: forward.x * right.y - forward.y * right.x
  })
  return { ...position, forward, right, up, fovDeg, aspect }
}

/**
 * Where a point on the cloth sits on the screen, as normalised device coordinates.
 *
 * The inverse of `screenToTable`, and useful for exactly the same reason: a caller that
 * draws a ball at a point and then wants to know what the player has to touch to aim at
 * it can ask, and the answer is guaranteed to be the pixel that picks that ball back.
 */
export function projectToNdc(point: TablePoint, height: number, camera: PickCamera): { x: number; y: number } | null {
  const dx = point.x - camera.x
  const dy = point.y - camera.y
  const dh = height - camera.height
  const depth =
    dx * camera.forward.x + dy * camera.forward.y + dh * camera.forward.h
  if (depth <= CAMERA_BASIS_TOLERANCE) return null
  const tanV = Math.tan((camera.fovDeg * Math.PI) / 360)
  const tanH = tanV * camera.aspect
  const right = dx * camera.right.x + dy * camera.right.y + dh * camera.right.h
  const up = dx * camera.up.x + dy * camera.up.y + dh * camera.up.h
  return { x: right / (depth * tanH), y: up / (depth * tanV) }
}

/**
 * The camera as the renderer has it, turned into a pickable one.
 *
 * Three keeps its world matrix column-major, with the camera's own axes as the first three
 * columns: right along +X, up along +Y, and the lens looking down -Z. Taking the basis
 * straight out of that matrix — rather than deriving it again from the rig's pose — is what
 * makes the pick and the picture impossible to disagree about: both are the same matrix, so
 * a change to either is a change to both.
 *
 * The renderer's world is X across, Y up and Z down the table, while a point on the cloth is
 * `(x, y)` in millimetres measured from the corner. That swap is the only thing this needs
 * from the renderer, and it is done here so nothing downstream has to remember it.
 */
export function pickCameraFromWorldMatrix(
  position: { x: number; y: number; z: number },
  worldMatrix: ArrayLike<number>,
  fovDeg: number,
  aspect: number
): PickCamera {
  const at = (index: number): number => worldMatrix[index] ?? 0
  return {
    x: position.x + TABLE_LENGTH / 2,
    y: position.z + TABLE_WIDTH / 2,
    height: position.y,
    forward: normalise({ x: -at(8), y: -at(10), h: -at(9) }),
    right: normalise({ x: at(0), y: at(2), h: at(1) }),
    up: normalise({ x: at(4), y: at(6), h: at(5) }),
    fovDeg,
    aspect
  }
}

/**
 * A canvas pixel, as the browser reports it, in normalised device coordinates.
 *
 * Canvas y grows downwards and normalised y grows upwards, hence the sign; getting it the
 * wrong way round is a bug that looks almost right in the middle of the screen and badly
 * wrong at the edges, so it is worth the one line that makes the flip explicit.
 */
export function pixelToNdc(px: number, py: number, width: number, height: number): { x: number; y: number } {
  return { x: (px / width) * 2 - 1, y: -((py / height) * 2 - 1) }
}

/** The inverse of `pixelToNdc`: where a normalised point is drawn, in canvas pixels. */
export function ndcToPixel(ndcX: number, ndcY: number, width: number, height: number): { x: number; y: number } {
  return { x: ((ndcX + 1) / 2) * width, y: ((1 - ndcY) / 2) * height }
}

/**
 * How wide a ball is drawn, in canvas pixels, at a point on the cloth.
 *
 * The radius is measured across the direction of view rather than along it, because that
 * is the direction the ball is not foreshortened in — the one its true width shows up in.
 * Measuring along the view would shrink the answer to nothing as the camera came round to
 * face the ball, which is exactly where a tap tolerance most needs to be generous.
 *
 * Top-down is the degenerate case again: with no horizontal direction of view there is no
 * "across", and the table's own length is as good a choice as any.
 */
export function ballRadiusPx(
  centre: TablePoint,
  radiusMm: number,
  width: number,
  height: number,
  camera: PickCamera
): number {
  const flat = Math.hypot(camera.forward.x, camera.forward.y)
  const across =
    flat > CAMERA_BASIS_TOLERANCE
      ? { x: -camera.forward.y / flat, y: camera.forward.x / flat }
      : { x: 1, y: 0 }
  const middle = projectToNdc(centre, PICK_PLANE_HEIGHT_MM, camera)
  const edge = projectToNdc(
    { x: centre.x + across.x * radiusMm, y: centre.y + across.y * radiusMm },
    PICK_PLANE_HEIGHT_MM,
    camera
  )
  if (!middle || !edge) return 0
  const inner = ndcToPixel(middle.x, middle.y, width, height)
  const outer = ndcToPixel(edge.x, edge.y, width, height)
  return Math.hypot(outer.x - inner.x, outer.y - inner.y)
}

/**
 * The aim angle from a cue ball to a point on the cloth, or null when the point is the
 * cue ball.
 *
 * In the same convention the whole game already uses: an angle in radians whose
 * direction is `(cos, sin)` in table millimetres, which is what the aim guide and the
 * server both take. A point the cue ball is already sitting on describes no direction at
 * all, and reporting a zero there would point the cue at the baulk end for no reason.
 */
export function aimAngleTo(cue: TablePoint, target: TablePoint): number | null {
  const dx = target.x - cue.x
  const dy = target.y - cue.y
  if (Math.hypot(dx, dy) < BALL_RADIUS * 0.1) return null
  return Math.atan2(dy, dx)
}

/**
 * The screen direction the cue points, as drawn.
 *
 * The drag gesture asks how far the pointer has travelled along the cue, and that has to be
 * measured in the pixels the player can see. Under a camera looking down the line of the
 * shot, the table-space angle and the screen angle are nothing like each other: aiming away
 * from the camera moves the aim point barely at all on screen, while aiming back towards it
 * throws it across the frame. Measuring along the line from the cue ball to a point behind it
 * takes the projection's own answer, so the gesture feels the same in every view instead of
 * only overhead.
 *
 * `tableToScreen` returns null for a point behind the lens, and so does this — a caller
 * should leave whatever it was doing alone rather than substitute a guess.
 */
export function cueAxisPixels(
  cue: TablePoint,
  angle: number,
  backMm: number,
  tableToScreen: (x: number, y: number) => { x: number; y: number } | null
): { x: number; y: number } | null {
  const butt = tableToScreen(cue.x - Math.cos(angle) * backMm, cue.y - Math.sin(angle) * backMm)
  const ball = tableToScreen(cue.x, cue.y)
  if (!butt || !ball) return null
  const dx = butt.x - ball.x
  const dy = butt.y - ball.y
  const length = Math.hypot(dx, dy)
  // Too short to be a direction: the two points have landed on the same pixel, which is
  // what happens when the sample is far enough back that the projection squashes it.
  if (length < CAMERA_BASIS_TOLERANCE) return null
  return { x: dx / length, y: dy / length }
}