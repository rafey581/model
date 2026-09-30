import { POWER_FINE_STEP } from './power.js'

/**
 * The spin dial's maths, with no DOM in it.
 *
 * The widget draws a cue ball face-on: up is topspin (follow), down is backspin
 * (draw), left and right are side. The physics layer already takes that exact
 * shape — `spin.x` is side, `spin.y` is vertical, each clamped to [-1, 1] by
 * `applyShot` — so the dial's whole job is to move a point inside a circle and
 * hand its x/y out in the same units. Nothing here invents a new representation.
 */

/** The engine's hard limit on either spin axis; the circle's edge is exactly this. */
export const SPIN_LIMIT = 1

/**
 * How the keyboard's axis steps map onto the dial.
 *
 * The arrows move side spin in 0.2 steps today (five presses from centre to the
 * rim), so the dial uses the same step on both axes: one tap of W is one dial
 * step up. Keeping one step size for both inputs is what makes the two controls
 * feel like one control seen two ways.
 */
export const SPIN_ARROW_STEP = 0.2

/** A point on the dial face, in dial units where the rim is at radius 1. */
export interface SpinPoint {
  x: number
  y: number
}

/** The distance a dial point sits from centre, in rim units. */
export function spinMagnitude(point: SpinPoint): number {
  return Math.hypot(point.x, point.y)
}

/**
 * Clamps a strike point to the legal circle.
 *
 * Outside the rim means a miscue in the real game, and the engine clamps each
 * axis to [-1, 1] itself — but a point like (1.4, 1.4) would clamp to the corner
 * (1, 1), a strike that is not on any ball face. Scaling instead of per-axis
 * clamping keeps the direction the player chose and puts them on the rim, which
 * is both honest and exactly what a real cue tip cannot exceed.
 */
export function clampToDial(point: SpinPoint): SpinPoint {
  const mag = spinMagnitude(point)
  if (mag <= SPIN_LIMIT || mag === 0) return { x: point.x, y: point.y }
  const scale = SPIN_LIMIT / mag
  return { x: point.x * scale, y: point.y * scale }
}

/**
 * One step of keyboard spin, shared by the arrow keys and the dial's own keys.
 *
 * Applies the step to one axis, clamps into the circle, and hands back the new
 * point. `ArrowLeft/Right` drive `x`, `W/S` drive `y` — the same keys that set
 * spin today, so the dial adds a way to see and drag it without moving a single
 * existing binding.
 */
export function spinAdjust(point: SpinPoint, axis: 'x' | 'y', direction: number, step: number = SPIN_ARROW_STEP): SpinPoint {
  const moved: SpinPoint = { x: point.x, y: point.y }
  moved[axis] = point[axis] + direction * step
  return clampToDial(moved)
}

/**
 * Where the dot sits, in CSS pixels from the widget's centre, for a spin value.
 *
 * `radius` is the widget's full travel radius: the rim of the circle in pixels,
 * so the mapping is one linear scale from rim-units to pixels and the edge of the
 * drawn circle is exactly the engine's maximum spin.
 */
export function spinToPixels(point: SpinPoint, radius: number): { x: number; y: number } {
  return { x: point.x * radius, y: -point.y * radius }
}

/**
 * The spin value for a pointer position, given the widget's centre and radius.
 *
 * Screen y grows downward and spin `y` grows upward, so the sign flips here once
 * and nowhere else. The result is clamped to the dial, so a drag that leaves the
 * circle slides along the rim rather than escaping it.
 */
export function pointerToSpin(px: number, py: number, cx: number, cy: number, radius: number): SpinPoint {
  if (radius <= 0) return { x: 0, y: 0 }
  return clampToDial({ x: (px - cx) / radius, y: -(py - cy) / radius })
}

/**
 * True when a drag is far enough from the last applied position to be worth a
 * render. Sub-pixel movement is noise, and writing the DOM for it every pointer
 * move is the one cost this widget does not need to pay.
 */
export const SPIN_DRAG_EPSILON = 0.002

export function spinChanged(a: SpinPoint, b: SpinPoint): boolean {
  return Math.abs(a.x - b.x) > SPIN_DRAG_EPSILON || Math.abs(a.y - b.y) > SPIN_DRAG_EPSILON
}

/**
 * Snaps a near-centre point to dead centre.
 *
 * A drag home that lands within a hair of the middle should read as "no spin",
 * not leave the dot hovering a pixel off: the readout would otherwise show a
 * 0.0/0.0 that the visible dot contradicts.
 */
export const SPIN_CENTRE_SNAP = 0.08

export function snapToCentre(point: SpinPoint): SpinPoint {
  return spinMagnitude(point) <= SPIN_CENTRE_SNAP ? { x: 0, y: 0 } : { x: point.x, y: point.y }
}

/** The zero-spin point, for resets. */
export function spinCentre(): SpinPoint {
  return { x: 0, y: 0 }
}

/**
 * The dial's keyboard nudges reuse the power control's fine step, so both dials
 * a hand rests on move in the same-sized increments when a key is held.
 */
export const SPIN_FINE_STEP = POWER_FINE_STEP
