import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createProgressController,
  PHASE_ORDER,
  PHASE_WEIGHTS,
  weightsSum
} from './progressController.js'

describe('match loading progress controller', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('weights sum to 100', () => {
    expect(weightsSum()).toBe(100)
    const manual = PHASE_ORDER.reduce((n, p) => n + PHASE_WEIGHTS[p], 0)
    expect(manual).toBe(100)
  })

  it('displayed value is monotonic and capped at 99 until finish', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const ctrl = createProgressController({ minMs: 1200 })

    const samples: number[] = []
    ctrl.report('fonts', 1)
    vi.advanceTimersByTime(100)
    samples.push(ctrl.displayed())

    ctrl.report('network', 0.5)
    vi.advanceTimersByTime(100)
    samples.push(ctrl.displayed())

    ctrl.report('network', 0.2) // must not go backwards within the phase
    vi.advanceTimersByTime(50)
    samples.push(ctrl.displayed())

    for (const phase of PHASE_ORDER) ctrl.report(phase, 1)
    vi.advanceTimersByTime(400)
    samples.push(ctrl.displayed())

    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]! - 1e-6)
    }
    expect(ctrl.displayed()).toBeLessThanOrEqual(99)

    ctrl.markReady()
    // Still under min duration — must stay at most 99 until the clock catches up.
    vi.setSystemTime(500)
    vi.advanceTimersByTime(50)
    expect(ctrl.displayed()).toBeLessThanOrEqual(99)

    vi.setSystemTime(1300)
    vi.advanceTimersByTime(100)
    expect(ctrl.displayed()).toBe(100)

    ctrl.dispose()
  })

  it('respects minimum duration before ready', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const ctrl = createProgressController({ minMs: 1200 })

    for (const phase of PHASE_ORDER) ctrl.report(phase, 1)
    ctrl.markReady()
    vi.setSystemTime(500)
    vi.advanceTimersByTime(50)
    expect(ctrl.isFullyReady()).toBe(false)

    const ready = ctrl.whenReady()
    vi.setSystemTime(1300)
    vi.advanceTimersByTime(100)
    await ready
    expect(ctrl.isFullyReady()).toBe(true)
    ctrl.dispose()
  })

  it('skipping a failing phase does not stall', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const ctrl = createProgressController({ minMs: 100 })

    // textures never reported — markReady still completes.
    ctrl.report('fonts', 1)
    ctrl.report('network', 1)
    ctrl.report('scene', 1)
    ctrl.report('shaders', 1)
    ctrl.report('bakes', 1)
    ctrl.report('audio', 1)
    ctrl.report('warmup', 1)
    ctrl.markReady()
    vi.setSystemTime(200)
    vi.advanceTimersByTime(100)
    await ctrl.whenReady()
    expect(ctrl.displayed()).toBe(100)
    ctrl.dispose()
  })

  it('watchdog fires and completes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    let watchdog = false
    const ctrl = createProgressController({
      minMs: 0,
      watchdogMs: 1000,
      onWatchdog: () => {
        watchdog = true
      }
    })

    const ready = ctrl.whenReady()
    vi.setSystemTime(1000)
    vi.advanceTimersByTime(1000)
    await ready
    expect(watchdog).toBe(true)
    expect(ctrl.displayed()).toBe(100)
    ctrl.dispose()
  })
})
