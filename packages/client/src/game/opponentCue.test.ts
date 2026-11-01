import { describe, expect, it, vi } from 'vitest'

// The cue's textures are painted on a canvas; no browser here, so a canvas that takes
// every drawing call and does nothing stands in for it.
const noop: any = new Proxy(function () {}, { get: () => noop, apply: () => noop })
vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => noop }) })

const { buildOpponentCue } = await import('./opponentCue.js')
const { VENUE_CONFIG } = await import('./venueConfig.js')

const cfg = VENUE_CONFIG.cue
const strokeOnly = cfg.backswingSeconds + cfg.strikeSeconds

/** Steps the cue until it has struck, returning how long that took in seconds. */
function timeToStrike(cue: ReturnType<typeof buildOpponentCue>): number {
  let t = 0
  while (cue.winding() || !cue.power()) {
    cue.step(0.01)
    t += 0.01
    if (t > 5) break
  }
  // Through the strike itself.
  for (let i = 0; i < Math.round(cfg.strikeSeconds / 0.01) && cue.active(); i++) {
    cue.step(0.01)
    t += 0.01
  }
  return t
}

describe('opponent cue wind-up', () => {
  it('a cue lined up by the live aim only draws back and strikes', () => {
    const cue = buildOpponentCue()
    cue.address(500, 800, 0.4, 0.5)
    expect(cue.preRoll(0.4)).toBeCloseTo(strokeOnly, 9)
    cue.show({ x: 500, y: 800, angle: 0.4, power: 0.5 })
    expect(cue.winding()).toBe(true)
    expect(timeToStrike(cue)).toBeLessThan(strokeOnly + 0.05)
  })

  it('a cue resting on another line turns onto it, then strikes, without lining up again', () => {
    const cue = buildOpponentCue()
    cue.address(500, 800, 0.4, 0)
    expect(cue.preRoll(1.4)).toBeCloseTo(0.5 + strokeOnly, 9)
  })

  it('with no live aim the full wind-up is played', () => {
    const cue = buildOpponentCue()
    expect(cue.preRoll(0.4)).toBeCloseTo(cfg.aimSeconds + strokeOnly, 9)
  })
})
