import { describe, expect, it } from 'vitest'
import {
  SPIN_ARROW_STEP,
  SPIN_CENTRE_SNAP,
  SPIN_DRAG_EPSILON,
  SPIN_FINE_STEP,
  SPIN_LIMIT,
  clampToDial,
  pointerToSpin,
  snapToCentre,
  spinAdjust,
  spinCentre,
  spinChanged,
  spinMagnitude,
  spinToPixels
} from './spinDial.js'
import { POWER_FINE_STEP } from './power.js'

describe('dial clamping', () => {
  it('leaves points inside the rim alone', () => {
    expect(clampToDial({ x: 0.5, y: 0.5 })).toEqual({ x: 0.5, y: 0.5 })
    expect(clampToDial({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 })
    expect(clampToDial({ x: -1, y: 0 })).toEqual({ x: -1, y: 0 })
  })

  it('scales outside points back onto the rim, keeping their direction', () => {
    const clamped = clampToDial({ x: 1.4, y: 1.4 })
    expect(spinMagnitude(clamped)).toBeCloseTo(SPIN_LIMIT, 12)
    expect(clamped.x).toBeCloseTo(clamped.y, 12)
    // A diagonal stays a diagonal: per-axis clamping would have made this (1, 1),
    // which is a corner no ball face has.
    expect(clamped.x).toBeCloseTo(Math.SQRT1_2, 12)
  })

  it('never returns a magnitude over the engine limit', () => {
    for (const p of [{ x: 3, y: 4 }, { x: -0.1, y: -2 }, { x: 99, y: 0 }]) {
      expect(spinMagnitude(clampToDial(p))).toBeLessThanOrEqual(SPIN_LIMIT + 1e-12)
    }
  })

  it('treats the centre as already legal', () => {
    expect(clampToDial({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 })
  })
})

describe('keyboard steps', () => {
  it('matches the arrow-key step the spin control already used', () => {
    expect(SPIN_ARROW_STEP).toBe(0.2)
  })

  it('moves one axis at a time and clamps through the rim', () => {
    let p = spinCentre()
    p = spinAdjust(p, 'y', 1)
    expect(p).toEqual({ x: 0, y: 0.2 })
    // (−0.98, 0.2) sits outside the rim (magnitude ≈ 1.0003), so it slides onto
    // it in the same direction rather than per-axis clamping to an imaginary corner.
    p = spinAdjust(p, 'x', -1, 0.98)
    expect(spinMagnitude(p)).toBeCloseTo(1, 12)
    expect(p.x).toBeLessThan(0)
    expect(p.y).toBeGreaterThan(0)
  })

  it('can climb to the rim in five presses from centre', () => {
    let p = spinCentre()
    for (let i = 0; i < 5; i++) p = spinAdjust(p, 'y', 1)
    expect(p.y).toBeCloseTo(1, 12)
  })

  it('never passes the rim, however many presses', () => {
    let p = spinCentre()
    for (let i = 0; i < 20; i++) p = spinAdjust(p, 'y', 1)
    expect(p.y).toBeCloseTo(SPIN_LIMIT, 12)
  })

  it('reuses the power control fine step for the dial nudge', () => {
    expect(SPIN_FINE_STEP).toBe(POWER_FINE_STEP)
  })
})

describe('screen mapping', () => {
  it('flips the y axis once: screen up is positive spin y', () => {
    const px = spinToPixels({ x: 0.5, y: 1 }, 40)
    expect(px.x).toBe(20)
    expect(px.y).toBe(-40)
  })

  it('reads a pointer below centre as backspin', () => {
    // Centre (50, 50), radius 40: 20px below centre is 0.5 of draw.
    const p = pointerToSpin(50, 70, 50, 50, 40)
    expect(p.x).toBeCloseTo(0, 12)
    expect(p.y).toBeCloseTo(-0.5, 12)
  })

  it('reads diagonals as combined spin, proportionally', () => {
    const p = pointerToSpin(50 + 28, 50 - 28, 50, 50, 40)
    expect(p.x).toBeGreaterThan(0.5)
    expect(p.y).toBeGreaterThan(0.5)
    expect(p.x).toBeCloseTo(p.y, 12)
  })

  it('clamps a wild pointer to the rim instead of escaping the circle', () => {
    const p = pointerToSpin(50 + 400, 50, 50, 50, 40)
    expect(p.x).toBeCloseTo(SPIN_LIMIT, 12)
    expect(p.y).toBeCloseTo(0, 12)
  })

  it('round-trips through the pixel mapping', () => {
    const value = { x: 0.3, y: -0.6 }
    const px = spinToPixels(value, 40)
    const back = pointerToSpin(50 + px.x, 50 + px.y, 50, 50, 40)
    expect(back.x).toBeCloseTo(value.x, 12)
    expect(back.y).toBeCloseTo(value.y, 12)
  })

  it('is safe with a zero radius', () => {
    expect(pointerToSpin(10, 10, 0, 0, 0)).toEqual({ x: 0, y: 0 })
  })
})

describe('change detection and snapping', () => {
  it('ignores sub-epsilon movement', () => {
    const a = { x: 0.5, y: 0.5 }
    expect(spinChanged(a, { x: a.x + SPIN_DRAG_EPSILON / 2, y: a.y })).toBe(false)
    expect(spinChanged(a, { x: a.x + SPIN_DRAG_EPSILON * 2, y: a.y })).toBe(true)
  })

  it('snaps a near-centre drag home to dead centre', () => {
    expect(snapToCentre({ x: SPIN_CENTRE_SNAP / 2, y: 0 })).toEqual({ x: 0, y: 0 })
    expect(snapToCentre({ x: SPIN_CENTRE_SNAP * 3, y: 0 })).toEqual({ x: SPIN_CENTRE_SNAP * 3, y: 0 })
  })

  it('keeps a real offset through the snap untouched', () => {
    const p = { x: 0.5, y: -0.5 }
    expect(snapToCentre(p)).toEqual(p)
  })
})
