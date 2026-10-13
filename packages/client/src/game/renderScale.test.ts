import { describe, expect, it } from 'vitest'
import {
  createRenderScaler,
  PROBE_WINDOW_MS,
  RAISE_AFTER_MS,
  TARGET_FRAME_MS,
  WARM_UP_MS
} from './renderScale.js'

/**
 * Runs the scaler against a GPU whose frame time goes with the pixel count: `fullMs` at
 * scale 1, and never faster than the display's own frame. Returns every scale it visited.
 */
function simulate(fullMs: number, seconds: number, minScale = 0.3, start = 1): { scales: number[]; final: number } {
  const scaler = createRenderScaler()
  scaler.reset(start, minScale)
  const scales = [scaler.scale]
  let now = 0
  while (now < seconds * 1000) {
    const frameMs = Math.max(TARGET_FRAME_MS, fullMs * scaler.scale * scaler.scale)
    now += frameMs
    if (scaler.step(frameMs, now)) scales.push(scaler.scale)
  }
  return { scales, final: scaler.scale }
}

describe('the adaptive render scale', () => {
  it('leaves a machine that holds the frame rate at full resolution', () => {
    const { scales } = simulate(12, 60)
    expect(scales).toEqual([1])
  })

  it('brings a slow machine onto the frame rate within a couple of steps', () => {
    // 50ms at full scale is the measured cost of the arena at 1080p on integrated graphics.
    const { scales, final } = simulate(50, 10)
    expect(50 * final * final).toBeLessThan(21)
    // One or two cuts, not a staircase of small ones through seconds of bad frames.
    expect(scales.length).toBeLessThanOrEqual(4)
  })

  it('never goes under its floor, however slow the frames are', () => {
    const { final } = simulate(400, 30, 0.5)
    expect(final).toBeCloseTo(0.5, 9)
  })

  it('does not hunt: a step up that fails is undone and then left alone for longer', () => {
    const { scales } = simulate(50, 180)
    const settled = scales.filter((_, i) => i > 0 && scales[i]! > scales[i - 1]!).length
    // Three minutes at a twenty-second retry would be nine probes; backing off leaves few.
    expect(settled).toBeLessThanOrEqual(3)
  })

  it('takes resolution back once there is room for it', () => {
    // Remembered low from a heavier session, on a machine that now has headroom.
    const { final } = simulate(12, (WARM_UP_MS + RAISE_AFTER_MS * 4) / 1000, 0.3, 0.6)
    expect(final).toBeGreaterThan(0.6)
  })

  it('gives up the surroundings before it gives up resolution', () => {
    // A GPU where the cheaper surroundings take a third off the frame, which is enough.
    let cheap = false
    let asked = 0
    const scaler = createRenderScaler({
      cheapen: () => {
        asked++
        if (cheap) return false
        cheap = true
        return true
      }
    })
    scaler.reset(1, 0.3)
    let now = 0
    for (let i = 0; i < 1200; i++) {
      const frameMs = Math.max(TARGET_FRAME_MS, (cheap ? 16 : 24) * scaler.scale * scaler.scale)
      now += frameMs
      expect(scaler.step(frameMs, now)).toBe(false)
    }
    expect(cheap).toBe(true)
    expect(asked).toBe(1)
    expect(scaler.scale).toBe(1)
  })

  it('cuts resolution once there is nothing cheaper left to give', () => {
    let cheap = false
    const scaler = createRenderScaler({ cheapen: () => (cheap ? false : (cheap = true)) })
    scaler.reset(1, 0.3)
    let now = 0
    for (let i = 0; i < 1200; i++) {
      const frameMs = Math.max(TARGET_FRAME_MS, 40 * scaler.scale * scaler.scale)
      now += frameMs
      scaler.step(frameMs, now)
    }
    expect(cheap).toBe(true)
    expect(scaler.scale).toBeLessThan(1)
    expect(40 * scaler.scale * scaler.scale).toBeLessThan(21)
  })

  it('ignores a stall, and the first second of a match', () => {
    const scaler = createRenderScaler()
    scaler.reset(1, 0.3)
    let now = 0
    // Shader compilation: a run of terrible frames right at the start.
    for (let i = 0; i < 12; i++) {
      now += 80
      expect(scaler.step(80, now)).toBe(false)
    }
    // Then a healthy game with the odd hidden-tab stall in it.
    for (let i = 0; i < 600; i++) {
      const frameMs = i % 50 === 0 ? 200 : 16.7
      now += frameMs
      expect(scaler.step(frameMs, now)).toBe(false)
    }
    expect(scaler.scale).toBe(1)
  })

  it('treats a drop long after a step up as a real slowdown, not a failed probe', () => {
    const scaler = createRenderScaler()
    scaler.reset(0.6, 0.3)
    let now = 0
    const feed = (frameMs: number, ms: number): void => {
      const until = now + ms
      while (now < until) {
        now += frameMs
        scaler.step(frameMs, now)
      }
    }
    feed(16.7, WARM_UP_MS + RAISE_AFTER_MS + 2000)
    const raised = scaler.scale
    expect(raised).toBeGreaterThan(0.6)
    feed(16.7, PROBE_WINDOW_MS + 2000)
    feed(30, 3000)
    // Cut from where it was by the size of the miss, rather than snapped back to 0.6.
    expect(scaler.scale).toBeLessThan(raised)
    expect(scaler.scale).not.toBeCloseTo(0.6, 6)
  })
})
