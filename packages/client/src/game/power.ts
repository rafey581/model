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
/**
 * One tap of the arrow keys.
 *
 * Finer than the wheel and the +/- keys, because the arrows are the trimming
 * control: a player nudging power up two or three percent to drop the cue ball
 * dead wants taps, not jumps.
 */
export const POWER_ARROW_STEP = 0.02

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

/**
 * Power from where the slider handle sits.
 *
 * The slider's travel is 0..1 bottom-to-top and so is the power, but the mapping goes
 * through this function rather than being assigned directly, so there is one place
 * that owns the range and one floor to change. A drag is relative by design; a slider
 * is absolute by design — the handle goes where the pointer lands — and the two
 * gestures meet only here, in the value they both produce.
 */
export function powerFromSliderValue(value: number): number {
  return clampPowerLoose(value)
}

/**
 * Where the slider handle sits for a power, 0 at the bottom of the travel and 1 at
 * the top. The exact inverse of `powerFromSliderValue`, so the control never shows a
 * number the shot would not be sent as.
 */
export function sliderValueFromPower(power: number): number {
  return clampPowerLoose(power)
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

/* ------------------------------------------------------------------ *
 * The cue-stick slider.
 *
 * The slider is a cue in a groove: the player pulls it back and lets go. How far it has
 * been pulled is `pull`, 0 at rest and 1 at the end of its travel; the power that makes is
 * a curve of it, not a straight line, so the first half of the travel covers the soft
 * shots where a few percent matter and the last part covers the hard ones where it does
 * not. What leaves here is still the same 0..1 the shot has always been sent with.
 * ------------------------------------------------------------------ */

/** The curve's exponent. Above 1 gives fine control at the gentle end of the travel. */
export const POWER_PULL_EXPONENT = 1.35
/** A release with the cue pulled back no further than this is a change of mind, not a shot. */
export const POWER_PULL_DEAD_ZONE = 0.04

function clampUnit(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** The power a pull of the cue makes. */
export function powerFromPull(pull: number): number {
  return Math.pow(clampUnit(pull), POWER_PULL_EXPONENT)
}

/** How far back the cue sits for a power: the exact inverse of {@link powerFromPull}. */
export function pullFromPower(power: number): number {
  return Math.pow(clampUnit(power), 1 / POWER_PULL_EXPONENT)
}

/**
 * The pull after a drag.
 *
 * Relative to where the gesture started, so the cue moves by exactly the distance the
 * finger has, wherever on the groove it was picked up.
 *
 * @param dragPx how far the pointer has moved down since the press, in CSS pixels.
 * @param travelPx the cue's whole travel, in CSS pixels.
 * @param pullAtStart where the cue was when it was picked up.
 */
export function pullFromDrag(dragPx: number, travelPx: number, pullAtStart = 0): number {
  if (!(travelPx > 0)) return clampUnit(pullAtStart)
  return clampUnit(pullAtStart + dragPx / travelPx)
}

/** How far one tap of an arrow key moves the cue, as a share of its travel. */
export const POWER_ARROW_PULL_STEP = 0.04

/**
 * The power after one tap of an arrow key.
 *
 * Stepped along the cue's travel rather than along the power, so every tap moves the cue
 * in the slider the same distance. A fixed step of power would be a lurch at the top of
 * the travel and a crawl everywhere else, because of the curve between the two.
 */
export function powerAfterArrow(power: number, direction: 1 | -1): number {
  return powerFromPull(pullFromPower(power) + direction * POWER_ARROW_PULL_STEP)
}

/** Whether letting go at this pull plays the shot. At or inside the dead zone it does not. */
export function pullShoots(pull: number): boolean {
  return clampUnit(pull) > POWER_PULL_DEAD_ZONE
}

/**
 * Which quarter mark a pull has reached: 0 below a quarter, up to 4 at full. The slider
 * gives a tick of haptic feedback each time this number goes up.
 */
export function pullQuarter(pull: number): number {
  return Math.floor(clampUnit(pull) * 4 + 1e-9)
}
