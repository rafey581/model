import { describe, expect, it } from 'vitest'
import {
  POWER_DRAG_FULL_PX,
  POWER_FINE_STEP,
  POWER_MIN,
  POWER_RESTING_DEFAULT,
  clampPower,
  clampPowerLoose,
  easePower,
  powerAdjust,
  powerFromDrag,
  powerFromSliderValue,
  powerPercent,
  sliderValueFromPower
} from './power.js'

describe('powerFromDrag', () => {
  it('pulling back off the ball adds power', () => {
    expect(powerFromDrag(POWER_DRAG_FULL_PX, 0)).toBe(1)
    expect(powerFromDrag(POWER_DRAG_FULL_PX / 2, 0)).toBeCloseTo(0.5, 10)
  })

  it('moving forward lowers the power again', () => {
    // The whole point of the control: the same gesture reads as less power the other
    // way, rather than sticking where it got to.
    expect(powerFromDrag(-POWER_DRAG_FULL_PX / 2, 0.5)).toBeCloseTo(0, 10)
    expect(powerFromDrag(-POWER_DRAG_FULL_PX, 0.5)).toBe(0)
  })

  it('is reversible, so a drag out and back returns to where it started', () => {
    const start = POWER_RESTING_DEFAULT
    expect(powerFromDrag(-120, powerFromDrag(120, start))).toBeCloseTo(start, 10)
  })

  it('keeps the full-travel distance meaning the same thing at any starting power', () => {
    // A player who has already charged to 0.8 and then pulls back a third of the
    // travel should reach 1, not 0.8 + 0.33 of what is left.
    expect(powerFromDrag(POWER_DRAG_FULL_PX * 0.2, 0.8)).toBe(1)
  })

  it('clamps rather than wrapping', () => {
    expect(powerFromDrag(POWER_DRAG_FULL_PX * 10, 0.5)).toBe(1)
    expect(powerFromDrag(-POWER_DRAG_FULL_PX * 10, 0.5)).toBe(0)
  })

  it('never reports a shot weaker than the floor the physics is guaranteed', () => {
    // The drag itself is allowed to reach zero, because a player easing off to
    // nothing is a real gesture; the floor is applied where the shot is sent.
    expect(powerFromDrag(-POWER_DRAG_FULL_PX, 0.1)).toBe(0)
    expect(clampPower(0)).toBe(POWER_MIN)
  })
})

describe('powerAdjust', () => {
  it('steps up and down by the fine step', () => {
    expect(powerAdjust(0.5, POWER_FINE_STEP)).toBeCloseTo(0.54, 10)
    expect(powerAdjust(0.5, -POWER_FINE_STEP)).toBeCloseTo(0.46, 10)
  })

  it('accumulates, so repeated presses are worth more than one', () => {
    let power = 0.5
    for (let i = 0; i < 5; i++) power = powerAdjust(power, POWER_FINE_STEP)
    expect(power).toBeCloseTo(0.7, 10)
  })

  it('cannot leave the range in either direction', () => {
    expect(powerAdjust(0.99, POWER_FINE_STEP)).toBe(1)
    expect(powerAdjust(0.01, -POWER_FINE_STEP)).toBe(0)
  })
})

describe('clampPower', () => {
  it('guarantees the floor a shot is never sent below', () => {
    expect(clampPower(0)).toBe(POWER_MIN)
    expect(clampPower(-3)).toBe(POWER_MIN)
    expect(clampPower(1)).toBe(1)
    expect(clampPower(9)).toBe(1)
  })

  it('treats a nonsense value as the floor rather than passing NaN on', () => {
    // A NaN power would serialise to null and be rejected by the server, which reads
    // to the player as the game hanging rather than as a bad shot.
    expect(clampPower(Number.NaN)).toBe(POWER_MIN)
    expect(clampPowerLoose(Number.NaN)).toBe(0)
  })
})

describe('powerPercent', () => {
  it('is the number shown next to the bar', () => {
    expect(powerPercent(0)).toBe(0)
    expect(powerPercent(0.4)).toBe(40)
    expect(powerPercent(0.625)).toBe(63)
    expect(powerPercent(1)).toBe(100)
  })

  it('reads the same value the shot is sent as, to the percent it is shown at', () => {
    // The percentage is a rounded view of the number physics receives, so they can
    // differ by at most the half-percent the rounding itself introduces and never by
    // a whole percent, which is what a stale or separately-scaled readout would cause.
    for (const power of [0, 0.05, 0.2, 0.4, 0.62, 0.875, 1]) {
      // Half a percent is the most a rounding to the nearest percent can cost, and a
      // power sitting exactly on a .5 boundary spends all of it; the epsilon is there
      // so the test is not about whether 0.005 is representable.
      expect(Math.abs(powerPercent(power) / 100 - power)).toBeLessThanOrEqual(0.005 + 1e-12)
    }
  })
})

describe('the slider mapping', () => {
  it('takes the handle position straight as the power', () => {
    expect(powerFromSliderValue(0)).toBe(0)
    expect(powerFromSliderValue(0.5)).toBe(0.5)
    expect(powerFromSliderValue(1)).toBe(1)
  })

  it('clamps a handle dragged past either end', () => {
    expect(powerFromSliderValue(-0.4)).toBe(0)
    expect(powerFromSliderValue(1.4)).toBe(1)
    expect(powerFromSliderValue(Number.NaN)).toBe(0)
  })

  it('is the exact inverse, so the handle never disagrees with the shot sent', () => {
    for (const power of [0, 0.1, 0.35, 0.5, 0.77, 1]) {
      expect(powerFromSliderValue(sliderValueFromPower(power))).toBeCloseTo(power, 12)
    }
  })
})

describe('easePower', () => {
  it('moves towards the target without overshooting it', () => {
    let shown = 0
    for (let i = 0; i < 40; i++) shown = easePower(shown, 1)
    expect(shown).toBeCloseTo(1, 3)
    expect(shown).toBeLessThanOrEqual(1)
  })

  it('converges on a value that came back down, rather than lagging behind it', () => {
    let shown = 1
    for (let i = 0; i < 40; i++) shown = easePower(shown, 0)
    expect(shown).toBeCloseTo(0, 3)
    expect(shown).toBeGreaterThanOrEqual(0)
  })
})

import {
  POWER_PULL_DEAD_ZONE,
  powerFromPull,
  pullFromDrag,
  pullFromPower,
  pullQuarter,
  pullShoots
} from './power.js'

describe('the cue-stick slider', () => {
  it('maps the ends of the pull onto the ends of the power', () => {
    expect(powerFromPull(0)).toBe(0)
    expect(powerFromPull(1)).toBe(1)
    expect(powerFromPull(-3)).toBe(0)
    expect(powerFromPull(9)).toBe(1)
    expect(powerFromPull(Number.NaN)).toBe(0)
  })

  it('gives fine control at the gentle end: half the pull is well under half the power', () => {
    expect(powerFromPull(0.5)).toBeLessThan(0.45)
    expect(powerFromPull(0.5)).toBeGreaterThan(0.3)
    // And it only ever goes up.
    let previous = 0
    for (let pull = 0.05; pull <= 1.0001; pull += 0.05) {
      const power = powerFromPull(pull)
      expect(power).toBeGreaterThan(previous)
      previous = power
    }
  })

  it('puts the cue back exactly where a power came from', () => {
    for (const pull of [0, 0.04, 0.25, 0.5, 0.8, 1]) {
      expect(pullFromPower(powerFromPull(pull))).toBeCloseTo(pull, 9)
    }
  })

  it('moves the cue by the distance the finger moved, from wherever it was picked up', () => {
    expect(pullFromDrag(0, 300)).toBe(0)
    expect(pullFromDrag(150, 300)).toBeCloseTo(0.5, 9)
    expect(pullFromDrag(300, 300)).toBe(1)
    expect(pullFromDrag(900, 300)).toBe(1)
    // Pushing back up past the top stops at the top.
    expect(pullFromDrag(-50, 300)).toBe(0)
    // Picked up part-way: relative to where it was.
    expect(pullFromDrag(60, 300, 0.3)).toBeCloseTo(0.5, 9)
    expect(pullFromDrag(-60, 300, 0.3)).toBeCloseTo(0.1, 9)
    // A groove with no height cannot be dragged.
    expect(pullFromDrag(100, 0, 0.2)).toBeCloseTo(0.2, 9)
  })

  it('does not shoot from inside the dead zone, and does from just outside it', () => {
    expect(pullShoots(0)).toBe(false)
    expect(pullShoots(POWER_PULL_DEAD_ZONE)).toBe(false)
    expect(pullShoots(POWER_PULL_DEAD_ZONE + 0.001)).toBe(true)
    expect(pullShoots(1)).toBe(true)
  })

  it('sends the shot the same kind of number the old bar did', () => {
    // Same type, same range: a 0..1 number, with the same two ends.
    for (const pull of [0.05, 0.3, 0.6, 1]) {
      const power = powerFromPull(pull)
      expect(typeof power).toBe('number')
      expect(power).toBeGreaterThanOrEqual(0)
      expect(power).toBeLessThanOrEqual(1)
      expect(clampPowerLoose(power)).toBe(power)
    }
  })

  it('counts the quarter marks for the haptic ticks', () => {
    expect(pullQuarter(0)).toBe(0)
    expect(pullQuarter(0.24)).toBe(0)
    expect(pullQuarter(0.25)).toBe(1)
    expect(pullQuarter(0.5)).toBe(2)
    expect(pullQuarter(0.76)).toBe(3)
    expect(pullQuarter(1)).toBe(4)
  })
})

import { POWER_ARROW_PULL_STEP, powerAfterArrow } from './power.js'

describe('the arrow keys on the cue slider', () => {
  it('moves the cue the same distance on every tap, up and down', () => {
    let power = 0
    for (let tap = 1; tap <= 10; tap++) {
      power = powerAfterArrow(power, 1)
      expect(pullFromPower(power)).toBeCloseTo(tap * POWER_ARROW_PULL_STEP, 9)
    }
    for (let tap = 9; tap >= 0; tap--) {
      power = powerAfterArrow(power, -1)
      expect(pullFromPower(power)).toBeCloseTo(tap * POWER_ARROW_PULL_STEP, 9)
    }
  })

  it('stops at the ends of the travel', () => {
    expect(powerAfterArrow(0, -1)).toBe(0)
    expect(powerAfterArrow(1, 1)).toBe(1)
    let power = 0
    for (let i = 0; i < 40; i++) power = powerAfterArrow(power, 1)
    expect(power).toBe(1)
  })
})
