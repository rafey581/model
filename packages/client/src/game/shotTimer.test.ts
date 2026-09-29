import { describe, expect, it } from 'vitest'
import {
  TURN_URGENT_MS,
  TURN_WARN_MS,
  clockOffsetMs,
  remainingMs,
  ringProgress,
  secondsLeft,
  timerTone
} from './shotTimer.js'
import type { TurnTiming } from './shotTimer.js'

const T0 = 1_700_000_000_000

function timing(over: Partial<TurnTiming> = {}): TurnTiming {
  return { turnDeadlineAt: T0 + 30_000, turnDurationMs: 30_000, serverNow: T0, ...over }
}

describe('clock offset', () => {
  it('measures the client clock against the server clock from the same message', () => {
    // A machine 1.25s fast. The message says it was stamped 1250ms before the client
    // looked at it, so that is how far ahead the server is running.
    expect(clockOffsetMs(timing({ serverNow: T0 }), T0 - 1_250)).toBe(1_250)
  })

  it('is zero on a machine whose clock agrees with the server', () => {
    expect(clockOffsetMs(timing(), T0)).toBe(0)
  })
})

describe('remaining time', () => {
  it('is measured against the corrected clock, not the local one', () => {
    // A client whose clock runs 1250ms behind the server's. The message says the
    // server stamped it at T0, so by the time the client looks at its own T0 the
    // server has already reached T0 + 1250, and 1250ms of the turn are gone.
    const t = timing()
    expect(remainingMs(t, T0, 1_250)).toBe(28_750)
    // What it would have shown without the correction, which is the whole reason for
    // the correction: a client that ignored the offset would claim 30 seconds and hand
    // the player 1250ms that had already run out — and so disagree with the server
    // about when the foul is coming.
    expect(remainingMs(t, T0, 0)).toBe(30_000)
  })

  it('counts down as the turn goes on', () => {
    const t = timing()
    expect(remainingMs(t, T0, 0)).toBe(30_000)
    expect(remainingMs(t, T0 + 10_000, 0)).toBe(20_000)
    expect(remainingMs(t, T0 + 29_500, 0)).toBe(500)
  })

  it('is zero when the server said no clock is running', () => {
    expect(remainingMs(timing({ turnDeadlineAt: null }), T0, 0)).toBe(0)
  })

  it('goes negative once the deadline has passed rather than clamping at zero', () => {
    // The client is allowed to notice it is late. Hiding the overrun would be a lie
    // about the server's deadline, and the foul it is counting towards is real.
    expect(remainingMs(timing(), T0 + 31_000, 0)).toBe(-1_000)
  })
})

describe('tone', () => {
  it('is calm with time to spare', () => {
    expect(timerTone(30_000)).toBe('ok')
    // Exactly ten seconds is still ten seconds, not under ten.
    expect(timerTone(TURN_WARN_MS)).toBe('ok')
    expect(timerTone(TURN_WARN_MS + 1)).toBe('ok')
  })

  it('warns under ten seconds', () => {
    expect(timerTone(TURN_WARN_MS - 1)).toBe('warn')
    expect(timerTone(TURN_URGENT_MS + 1)).toBe('warn')
  })

  it('is urgent under five', () => {
    expect(timerTone(TURN_URGENT_MS - 1)).toBe('urgent')
    expect(timerTone(0)).toBe('urgent')
    expect(timerTone(-2_000)).toBe('urgent')
  })

  it('changes tone as the clock passes the threshold, and not before', () => {
    // The boundary is the one place an off-by-one would be visible, since a client and
    // the server would then disagree about which of the three states a turn is in.
    expect(timerTone(TURN_WARN_MS - 1)).not.toBe(timerTone(TURN_WARN_MS))
    expect(timerTone(TURN_URGENT_MS - 1)).not.toBe(timerTone(TURN_URGENT_MS))
  })
})

describe('ring progress', () => {
  it('is full at the start of the turn and empty at the end', () => {
    expect(ringProgress(30_000, 30_000)).toBe(1)
    expect(ringProgress(0, 30_000)).toBe(0)
  })

  it('is proportional in between', () => {
    expect(ringProgress(15_000, 30_000)).toBe(0.5)
    expect(ringProgress(7_500, 30_000)).toBe(0.25)
  })

  it('clamps at both ends so the ring cannot be drawn past its own start', () => {
    expect(ringProgress(31_000, 30_000)).toBe(1)
    expect(ringProgress(-4_000, 30_000)).toBe(0)
  })

  it('is empty when the turn clock is switched off', () => {
    expect(ringProgress(30_000, 0)).toBe(0)
  })
})

describe('seconds shown', () => {
  it('rounds up so a clock with time left never reads zero', () => {
    // The failure this avoids is the ugly one: a ring that is still visibly draining
    // next to a number saying 0.
    expect(secondsLeft(30_000)).toBe(30)
    expect(secondsLeft(29_001)).toBe(30)
    expect(secondsLeft(29_000)).toBe(29)
    expect(secondsLeft(1)).toBe(1)
  })

  it('shows zero once the time is gone, and never a negative clock', () => {
    expect(secondsLeft(0)).toBe(0)
    expect(secondsLeft(-1_000)).toBe(0)
  })
})
