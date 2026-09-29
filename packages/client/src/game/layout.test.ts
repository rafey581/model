import { describe, expect, it } from 'vitest'
import { fitTableBox, TABLE_ASPECT } from './layout.js'

/** A few window shapes: a desktop, a laptop, a phone held upright, and so on. */
const CASES: Array<[number, number]> = [
  [1920, 1080],
  [1366, 640],
  [640, 900],
  [320, 180],
  [1000, 500]
]

describe('fitTableBox', () => {
  it('fills the width when the width is the binding constraint', () => {
    const box = fitTableBox(1200, 2000)
    expect(box.width).toBe(1200)
    expect(box.height).toBe(1200 / TABLE_ASPECT)
  })

  it('fills the height when the height is the binding constraint', () => {
    // A short, wide window: the table has to be limited by the height or the bottom
    // rail lands off the screen, which is what the match page used to do.
    const box = fitTableBox(2000, 500)
    expect(box.height).toBe(500)
    expect(box.width).toBe(500 * TABLE_ASPECT)
  })

  it('is exactly the right shape, whichever constraint bound', () => {
    for (const [w, h] of CASES) {
      const box = fitTableBox(w, h)
      expect(box.width / box.height).toBeCloseTo(TABLE_ASPECT, 10)
    }
  })

  it('never claims more space than it was given', () => {
    for (const [w, h] of CASES) {
      const box = fitTableBox(w, h)
      expect(box.width).toBeLessThanOrEqual(w)
      expect(box.height).toBeLessThanOrEqual(h)
    }
  })

  it('reports nothing to draw rather than a degenerate box when unmeasured', () => {
    // A hidden stage measures zero. Sizing a table to that would give the canvas the
    // minimum width it is allowed and then stretch the aim mapping to match.
    expect(fitTableBox(0, 600)).toEqual({ width: 0, height: 0 })
    expect(fitTableBox(600, 0)).toEqual({ width: 0, height: 0 })
  })
})
