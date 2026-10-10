import { describe, expect, it } from 'vitest'
import { peakOf } from './dsp.js'
import { BUFFER_PEAK, ROLLING_KEY } from './recipes.js'
import { loadRecordedSamples, planSamples, prepareSample } from './samples.js'

describe('recordings in place of generated sounds', () => {
  it('deals the files round the variant slots, per strength', () => {
    const plan = planSamples({ 'ball:hard': ['a.wav', 'b.wav'] }, 3)
    expect(plan).toEqual([
      { key: 'ball:hard:0', file: 'a.wav', loop: false },
      { key: 'ball:hard:1', file: 'b.wav', loop: false },
      { key: 'ball:hard:2', file: 'a.wav', loop: false }
    ])
  })

  it('uses a sound listed without a strength for all three', () => {
    const keys = planSamples({ cue: ['cue.wav'] }, 2).map((p) => p.key)
    expect(keys).toEqual(['cue:soft:0', 'cue:soft:1', 'cue:medium:0', 'cue:medium:1', 'cue:hard:0', 'cue:hard:1'])
  })

  it('lets a strength named on its own win over the general list', () => {
    const plan = planSamples({ ball: ['any.wav'], 'ball:soft': ['soft.wav'] }, 1)
    expect(plan.find((p) => p.key === 'ball:soft:0')!.file).toBe('soft.wav')
    expect(plan.find((p) => p.key === 'ball:hard:0')!.file).toBe('any.wav')
    expect(plan.filter((p) => p.key === 'ball:soft:0').length).toBe(1)
  })

  it('maps the pocket, the roll and the small sounds', () => {
    const plan = planSamples({ drop: ['d.wav'], rolling: ['r.wav'], foul: ['f.wav'] }, 2)
    expect(plan).toContainEqual({ key: 'drop:one:0', file: 'd.wav', loop: false })
    expect(plan).toContainEqual({ key: 'drop:one:1', file: 'd.wav', loop: false })
    expect(plan).toContainEqual({ key: ROLLING_KEY, file: 'r.wav', loop: true })
    expect(plan.filter((p) => p.key.startsWith('foul')).length).toBe(1)
  })

  it('ignores names it does not know and file names that are not plain file names', () => {
    expect(planSamples({ explosion: ['boom.wav'], ball: ['../../secret.wav', 'http://x/y.wav'] }, 2)).toEqual([])
  })

  it('trims the silence before a recording, brings it to the common peak and fades its end', () => {
    const input = new Float32Array(44100)
    for (let i = 5000; i < 9000; i++) input[i] = 0.3 * Math.sin(i * 0.3) * Math.exp(-(i - 5000) / 800)
    const out = prepareSample(input, false)
    expect(peakOf(out)).toBeCloseTo(BUFFER_PEAK, 5)
    // The sound starts within a millisecond of the start of the buffer.
    let first = 0
    while (Math.abs(out[first]!) < BUFFER_PEAK * 0.02) first++
    expect(first).toBeLessThan(60)
    expect(Math.abs(out[out.length - 1]!)).toBe(0)
  })

  it('cuts a long recording down to an impact', () => {
    const input = new Float32Array(44100 * 5).fill(0.5)
    expect(prepareSample(input, false).length).toBeLessThanOrEqual(Math.round(44100 * 1.2))
  })

  it('gives back one silent sample for a silent file, rather than dividing by nothing', () => {
    expect(Array.from(prepareSample(new Float32Array(1000), false))).toEqual([0])
  })

  it('loads nothing, and does not throw, where there is nothing to load', async () => {
    let stored = 0
    await expect(loadRecordedSamples(3, () => stored++)).resolves.toBe(0)
    expect(stored).toBe(0)
  })
})
