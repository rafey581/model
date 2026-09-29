/**
 * Power: the numbers behind the shot control.
 *
 * Kept apart from the input handling so the arithmetic can be tested on its own. The
 * gesture itself is fiddly and hard to pin down in a test, but the thing it is
 * supposed to compute — "this many pixels along the aim axis, from this much power,
 * is that much power" — is a pure function and is where the bugs live.
 *
 * Every distance here is in CSS pixels, because that is the unit the pointer reports
 * in. The value that leaves this module is the 0..1 the physics and the server take.
 */

/** The floor a shot always has, matching the minimum the drag gesture can reach. */
export const POWER_MIN = 0.05

/**
 * The power a press starts from.
 *
 * Unchanged from before this phase, deliberately: a quick tap has always played at
 * this strength, and the resting value being 0 would turn every tap into a
 * 5%-strength nudge. What changed is only that the bar reads 0% while nobody is
 * charging, so the number on screen is honest about "no power chosen yet".
 */
export const POWER_RESTING_DEFAULT = 0.4

/**
 * How far the pointer has to travel along the aim axis to cover the whole range.
 *
 * Sized against a table that is roughly 1000px wide on a laptop: a third of the table
 * is a long, deliberate pull, and a tenth is a flick of the wrist. Larger than that
 * and fine control becomes impossible; smaller and the bar slams to 100% before the
 * player has decided anything.
 */
export const POWER_DRAG_FULL_PX = 300

/** One wheel notch, and one press of the fine-adjust keys. */
export const POWER_FINE_STEP = 0.04

export function clampPower(value: number): number {
  if (Number.isNaN(value)) return POWER_MIN
  return Math.min(1, Math.max(POWER_MIN, value))
}

export function clampPowerLoose(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * Power from a drag, as a delta from where the gesture started.
 *
 * Two-way by construction: the distance is signed along the aim axis, so pulling back
 * off the ball raises the power and pushing forward lowers it, and there is no
 * direction the player can move that has no answer. Deliberately relative rather than
 * read from the pointer's absolute position — an absolute mapping cannot go back the
 * way it came, which is the whole point of this control.
 *
 * @param distancePx signed travel along the aim axis, positive when pulling back.
 * @param powerAtStart the power the gesture began from.
 */
export function powerFromDrag(distancePx: number, powerAtStart: number): number {
  return clampPowerLoose(powerAtStart + distancePx / POWER_DRAG_FULL_PX)
}

/** Applies a fine adjustment, for the wheel and the +/- keys. */
export function powerAdjust(current: number, delta: number): number {
  return clampPowerLoose(current + delta)
}

/** The whole-number percentage shown next to the bar. */
export function powerPercent(power: number): number {
  return Math.round(clampPowerLoose(power) * 100)
}

/**
 * The eased value the bar shows.
 *
 * The number the player reads should not flicker between 61% and 62% on a drag that
 * is really holding steady, so the displayed percentage is a smoothed follow of the
 * real value rather than a rounded copy of it. It converges on the truth, so it can
 * never show a power that is not the one being sent.
 */
export function easePower(displayed: number, target: number): number {
  return displayed + (target - displayed) * 0.35
}
