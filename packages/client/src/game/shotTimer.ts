/**
 * The shot clock.
 *
 * The server owns the deadline and the client only draws it. Everything here is
 * therefore a view: it never decides that a turn has expired, never extends a deadline,
 * and never keeps a clock running that the server has not said is running. If the two
 * disagree, the server is right and the client is wrong, which is the whole reason the
 * deadline is sent as an absolute instant rather than a duration to count down from.
 */

/** The turn timing as it travels on the wire, in server epoch milliseconds. */
export interface TurnTiming {
  /** When the current visit runs out, or null when no clock is running. */
  turnDeadlineAt: number | null
  /** The full length of a turn, used to draw the ring as a proportion. */
  turnDurationMs: number
  /** The server's clock at the moment it sent this, for offset correction. */
  serverNow: number
  /**
   * True while the clock is being held for a placement, and only then.
   *
   * The deadline is still sent while held, and is still the one the server will resume
   * from, so this is not the same thing as `turnDeadlineAt === null`. It says: the clock
   * is stopped, but these are the seconds you have. A client that ignored it would keep
   * counting the hold away and show the player draining to zero for a placement that is
   * costing them nothing, and would then resume from a deadline the server has already
   * moved on from.
   */
  paused?: boolean
}

/** Whether the server has said it is holding this clock. */
export function isPaused(timing: TurnTiming | null): boolean {
  return timing?.paused === true
}

/** Below this the clock changes tone. Named because the display and the tests share it. */
export const TURN_WARN_MS = 10_000
/** Below this it is urgent and pulses. */
export const TURN_URGENT_MS = 5_000

export type TimerTone = 'ok' | 'warn' | 'urgent'

/**
 * How far the client's clock is from the server's.
 *
 * Both stamps in a message are taken on the same machine, so the difference is the
 * whole error: whatever the message took to arrive is already accounted for in the
 * direction that does not matter (a client is always slightly behind, never ahead).
 */
export function clockOffsetMs(timing: TurnTiming, localNow: number): number {
  return timing.serverNow - localNow
}

/** Milliseconds left on the clock, in server time. */
export function remainingMs(timing: TurnTiming, localNow: number, offsetMs: number): number {
  if (timing.turnDeadlineAt === null) return 0
  return timing.turnDeadlineAt - (localNow + offsetMs)
}

/**
 * The tone the clock is read in.
 *
 * "Under ten seconds" and "under five", taken literally: the change happens as the
 * clock passes the threshold, not as it lands on it, so at exactly 10.0s the clock is
 * still calm and one millisecond later it is not.
 *
 * A single decision in one place, so the ring, the seconds and the pulse can never
 * disagree about which of the three states the clock is in.
 */
export function timerTone(remaining: number): TimerTone {
  if (remaining < TURN_URGENT_MS) return 'urgent'
  if (remaining < TURN_WARN_MS) return 'warn'
  return 'ok'
}

/**
 * How much of the ring is left, 1 down to 0.
 *
 * Clamped at both ends on purpose. A clock can be read a few milliseconds after it
 * runs out, and a negative fraction would draw the ring past its own start; a ring
 * that sits at empty is the honest picture of a clock that has nothing left.
 */
export function ringProgress(remaining: number, durationMs: number): number {
  if (durationMs <= 0) return 0
  return Math.min(1, Math.max(0, remaining / durationMs))
}

/** The whole seconds shown on the clock, rounded up so it never reads 0 while there is time. */
export function secondsLeft(remaining: number): number {
  return Math.max(0, Math.ceil(remaining / 1000))
}

/**
 * The seconds to actually print, which can never be more than the turn is worth.
 *
 * The deadline is stamped by the server and read by the client a moment later, so the
 * time left measures a hair over the full turn: on a 30-second clock a client that read
 * the message five milliseconds late has 30.005s on the clock and prints 31. The ring
 * already clamps its own fraction for the same reason, so the number beside it and the
 * arc around it could disagree at the very moment the turn begins.
 *
 * This caps the display at the length the server declared. It is deliberately not a
 * second opinion about how long a turn should be: a duration the server sends is drawn
 * as sent, because the client drawing its own number instead of the server's is how a
 * client and a server end up disagreeing about when a foul is coming. The shot clock
 * being 30 seconds is the server's business, not this function's.
 */
export function displayedSeconds(remaining: number, durationMs: number): number {
  const capped = durationMs > 0 ? Math.min(remaining, durationMs) : remaining
  return secondsLeft(capped)
}
