import { describe, expect, it } from 'vitest'
import { CAMERA_KEYS, cameraAt, progressForViewport } from './camera-path'

describe('camera path', () => {
  it('starts on the hero and ends overhead', () => {
    expect(cameraAt(0)).toEqual(CAMERA_KEYS[0]?.shot)
    expect(cameraAt(1)).toEqual(CAMERA_KEYS[CAMERA_KEYS.length - 1]?.shot)
    const mid = cameraAt(0.5)
    expect(Number.isFinite(mid.position.y)).toBe(true)
    expect(mid.position.z).not.toBeCloseTo(cameraAt(0).position.z)
  })

  it('follows scene windows without leaving 0..1', () => {
    const marks = [
      { center: 400, at: 0 },
      { center: 1600, at: 0.38 },
      { center: 3200, at: 1 }
    ]
    expect(progressForViewport(marks, 0)).toBe(0)
    expect(progressForViewport(marks, 5000)).toBe(1)
    const between = progressForViewport(marks, 1000)
    expect(between).toBeGreaterThan(0)
    expect(between).toBeLessThan(0.38)
    expect(progressForViewport([], 10)).toBe(0)
  })
})
