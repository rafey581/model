import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCueController } from './input.js'

/** The canvas, reduced to what the controller touches. */
class FakeCanvas {
  width = 800
  height = 400
  style: { touchAction: string } = { touchAction: '' }
  private readonly listeners = new Map<string, (event: Record<string, unknown>) => void>()
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 800, height: 400 }
  }
  setPointerCapture(): void {}
  addEventListener(type: string, handler: (event: Record<string, unknown>) => void): void {
    this.listeners.set(type, handler)
  }
  removeEventListener(type: string): void {
    this.listeners.delete(type)
  }
  fire(type: string, event: Record<string, unknown>): void {
    this.listeners.get(type)?.({ preventDefault(): void {}, ...event })
  }
}

function harness(enabled = true) {
  const canvas = new FakeCanvas()
  const orbit: number[] = []
  const shots: unknown[] = []
  let allowed = enabled
  const controller = createCueController({
    canvas: canvas as unknown as HTMLCanvasElement,
    cuePosition: { x: 900, y: 500 },
    enabled: () => allowed,
    onChange: () => undefined,
    onShoot: (shot) => shots.push(shot),
    onOrbit: (pixels) => orbit.push(pixels)
  })
  const touch = (type: string, x: number, id = 1): void =>
    canvas.fire(type, { pointerType: 'touch', pointerId: id, clientX: x, clientY: 200, button: 0, buttons: type === 'pointerup' ? 0 : 1 })
  return {
    controller,
    orbit,
    shots,
    touch,
    setAllowed: (v: boolean) => {
      allowed = v
    }
  }
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('aiming with a finger', () => {
  it('turns the aim by how far the finger moves, not by where it is', () => {
    const h = harness()
    const start = h.controller.aim.angle
    h.touch('pointerdown', 600)
    // Putting the finger down turns nothing.
    expect(h.controller.aim.angle).toBe(start)
    h.touch('pointermove', 700)
    const turned = h.controller.aim.angle - start
    expect(turned).toBeCloseTo((100 * Math.PI) / 900, 9)
    // The same drag starting somewhere else on the table turns it by the same amount.
    h.touch('pointerup', 700)
    h.touch('pointerdown', 100)
    h.touch('pointermove', 200)
    expect(h.controller.aim.angle - start).toBeCloseTo(turned * 2, 9)
  })

  it('turns the view by exactly what it turns the aim, so the cue stays up the screen', () => {
    const h = harness()
    const start = h.controller.aim.angle
    h.touch('pointerdown', 400)
    for (const x of [430, 470, 460, 380]) h.touch('pointermove', x)
    const orbitRadians = h.orbit.reduce((sum, px) => sum + px, 0) * (Math.PI / 900)
    expect(h.controller.aim.angle - start).toBeCloseTo(orbitRadians, 9)
  })

  it('turns back when the finger goes back', () => {
    const h = harness()
    const start = h.controller.aim.angle
    h.touch('pointerdown', 400)
    h.touch('pointermove', 520)
    h.touch('pointermove', 400)
    expect(h.controller.aim.angle).toBeCloseTo(start, 9)
  })

  it('is finer for a slow creep than for a swipe', () => {
    const slow = harness()
    slow.touch('pointerdown', 400)
    for (let x = 401; x <= 420; x++) slow.touch('pointermove', x)
    const fast = harness()
    fast.touch('pointerdown', 400)
    fast.touch('pointermove', 420)
    expect(Math.abs(slow.controller.aim.angle)).toBeLessThan(Math.abs(fast.controller.aim.angle) * 0.5)
    expect(Math.abs(slow.controller.aim.angle)).toBeGreaterThan(0)
  })

  it('never charges power and never fires: that is the slider’s job on a touch screen', () => {
    const h = harness()
    h.touch('pointerdown', 400)
    h.touch('pointermove', 410)
    h.touch('pointerup', 410)
    expect(h.shots.length).toBe(0)
    expect(h.controller.aim.power).toBe(0)
  })

  it('does nothing while the visit cannot be played', () => {
    const h = harness(false)
    h.touch('pointerdown', 400)
    h.touch('pointermove', 600)
    expect(h.controller.aim.angle).toBe(0)
    expect(h.orbit.length).toBe(0)
    // And a finger already down stops turning the moment the visit ends.
    h.setAllowed(true)
    h.touch('pointerup', 600)
    h.touch('pointerdown', 400)
    h.setAllowed(false)
    h.touch('pointermove', 600)
    expect(h.controller.aim.angle).toBe(0)
  })

  it('follows one finger and ignores a second', () => {
    const h = harness()
    h.touch('pointerdown', 400, 1)
    h.touch('pointerdown', 100, 2)
    h.touch('pointermove', 700, 2)
    expect(h.controller.aim.angle).toBe(0)
    h.touch('pointermove', 500, 1)
    expect(h.controller.aim.angle).toBeGreaterThan(0)
  })
})
