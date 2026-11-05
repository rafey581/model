import { describe, expect, it } from 'vitest'
import { cueSliderSvg, cueSliderTicksSvg } from './cueSliderArt.js'

describe('the power stick', () => {
  it('is drawn as polished silver, with a highlight and a dark edge', () => {
    const svg = cueSliderSvg()
    expect(svg).toContain('#f7fbfe')
    expect(svg).toContain('#3e474f')
    expect(svg).toContain('linearGradient')
    // The old walnut forearm is gone: this control is metal.
    expect(svg).not.toContain('#5a3220')
    expect(svg).not.toContain('#e2bd7c')
  })

  it('marks the five power levels and no finer scale', () => {
    const ticks = cueSliderTicksSvg()
    expect(ticks.match(/<line /g)).toHaveLength(5)
    for (const y of [20, 40, 60, 80, 100]) expect(ticks).toContain(`y1="${y}"`)
  })
})
