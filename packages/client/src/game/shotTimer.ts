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
