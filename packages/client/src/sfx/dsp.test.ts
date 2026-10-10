import { describe, expect, it } from 'vitest'
import { SAMPLE_RATE, crossfadeLoop, isFiniteBuffer, mulberry32, normalise, peakOf, pinkNoise } from './dsp.js'
import { BUFFER_PEAK, ROLLING_KEY, bufferKey, renderAuxSound, renderFlat, renderJobs, renderLayered, renderRollingLoop } from './recipes.js'
import { LAYERS, SFX_CONFIG } from './sfxConfig.js'

const expectedLength = (ms: number): number => Math.max(1, Math.round((ms / 1000) * SAMPLE_RATE))

describe('the generator', () => {
  it('gives the same numbers for the same seed, and different ones for another', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const c = mulberry32(43)
    const first = [a(), a(), a()]
    expect([b(), b(), b()]).toEqual(first)
    expect([c(), c(), c()]).not.toEqual(first)
    for (const v of first) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('the rendered sounds', () => {
  const layered = (['ball', 'cue', 'cushion'] as const).flatMap((type) => LAYERS.map((layer) => [type, layer] as const))

  it.each(layered)('%s (%s) is deterministic, finite, the right length and normalised', (type, layer) => {
    const a = renderLayered(type, layer, 0)
    const b = renderLayered(type, layer, 0)
    expect(Array.from(a)).toEqual(Array.from(b))
    expect(isFiniteBuffer(a)).toBe(true)
    expect(a.length).toBe(expectedLength(SFX_CONFIG.recipes[type].lengthMs))
    expect(peakOf(a)).toBeCloseTo(BUFFER_PEAK, 5)
  })

  it.each(layered)('%s (%s) has died away by its end', (type, layer) => {
    const a = renderLayered(type, layer, 1)
    const tail = a.subarray(a.length - 12)
    expect(peakOf(tail)).toBeLessThan(0.001)
    // The fade ends on silence. Either sign of zero is silence.
    expect(Math.abs(a[a.length - 1]!)).toBe(0)
  })

  it.each(['jaw', 'drop', 'net'] as const)('%s is deterministic, finite, the right length, normalised and decayed', (type) => {
    const a = renderFlat(type, 0)
    expect(Array.from(a)).toEqual(Array.from(renderFlat(type, 0)))
    expect(isFiniteBuffer(a)).toBe(true)
    expect(a.length).toBe(expectedLength(SFX_CONFIG.recipes[type].lengthMs))
    expect(peakOf(a)).toBeCloseTo(BUFFER_PEAK, 5)
    expect(peakOf(a.subarray(a.length - 12))).toBeLessThan(0.001)
  })

  it.each(['uiClick', 'uiHover', 'placeTick', 'turnTick', 'chalk', 'foul'] as const)('%s is short, finite and normalised', (type) => {
    const a = renderAuxSound(type)
    expect(isFiniteBuffer(a)).toBe(true)
    expect(peakOf(a)).toBeCloseTo(BUFFER_PEAK, 5)
    expect(a.length / SAMPLE_RATE).toBeLessThanOrEqual(type === 'foul' ? 0.45 : 0.081)
    expect(peakOf(a.subarray(a.length - 8))).toBeLessThan(0.001)
  })

  it('makes every variant of a sound a different sound', () => {
    for (const type of ['ball', 'cue', 'cushion'] as const) {
      const a = renderLayered(type, 'medium', 0)
      const b = renderLayered(type, 'medium', 1)
      let differing = 0
      for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 0.01) differing++
      expect(differing).toBeGreaterThan(a.length * 0.1)
    }
  })

  it('makes a hard hit brighter than a soft one', () => {
    // Energy in the sample-to-sample difference is a cheap measure of high-frequency content.
    const brightness = (data: Float32Array): number => {
      let diff = 0
      let total = 0
      for (let i = 1; i < data.length; i++) {
        diff += (data[i]! - data[i - 1]!) ** 2
        total += data[i]! ** 2
      }
      return diff / total
    }
    for (const type of ['ball', 'cue', 'cushion'] as const) {
      expect(brightness(renderLayered(type, 'hard', 0))).toBeGreaterThan(brightness(renderLayered(type, 'soft', 0)))
    }
  })
})

describe('the rolling loop', () => {
  it('is the configured length, finite and normalised', () => {
    const loop = renderRollingLoop()
    expect(loop.length).toBe(expectedLength(SFX_CONFIG.rolling.loopSeconds * 1000))
    expect(isFiniteBuffer(loop)).toBe(true)
    expect(peakOf(loop)).toBeCloseTo(BUFFER_PEAK, 5)
  })

  it('joins its end to its start without a step', () => {
    const raw = normalise(pinkNoise(1000, mulberry32(7)), 0.9)
    const loop = crossfadeLoop(raw, 100)
    // The sample after the last one is the first one: the jump across the seam should be
    // no bigger than the jumps inside the noise.
    let typical = 0
    for (let i = 1; i < loop.length; i++) typical = Math.max(typical, Math.abs(loop[i]! - loop[i - 1]!))
    expect(Math.abs(loop[0]! - loop[loop.length - 1]!)).toBeLessThanOrEqual(typical)
  })
})

describe('the render plan', () => {
  it('renders more variants on a better tier, and names every buffer once', () => {
    const count = (tier: 'low' | 'medium' | 'high'): number => renderJobs(tier).length
    expect(count('low')).toBeLessThan(count('medium'))
    expect(count('medium')).toBeLessThan(count('high'))
    const keys = renderJobs('high').map((job) => job.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toContain(bufferKey('ball', 'hard', 3))
    expect(keys).toContain(ROLLING_KEY)
    expect(renderJobs('low').map((job) => job.key)).not.toContain(bufferKey('ball', 'hard', 2))
  })

  it('stays inside the memory budget', () => {
    let samples = 0
    for (const job of renderJobs('high')) samples += job.render().length
    // Four bytes a sample, under three megabytes in all.
    expect(samples * 4).toBeLessThan(3 * 1024 * 1024)
  })

  it('can re-render one sound on its own', () => {
    const keys = renderJobs('medium', SFX_CONFIG, 'cushion').map((job) => job.key)
    expect(keys.length).toBe(9)
    expect(keys.every((key) => key.startsWith('cushion:'))).toBe(true)
  })
})
