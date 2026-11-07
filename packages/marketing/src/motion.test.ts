import { describe, expect, it } from 'vitest'
import { cappedDevicePixelRatio, menuOpenAfterKey, shouldShowSticky, webglMode } from './motion'

describe('webgl gate', () => {
  const ready = { reducedMotion: false, saveData: false, webgl: true, forcedStatic: false }

  it('animates on a capable device', () => {
    expect(webglMode(ready)).toBe('animate')
  })

  it('keeps a still frame when motion is reduced', () => {
    expect(webglMode({ ...ready, reducedMotion: true })).toBe('static-frame')
  })

  it('skips the scene without webgl, on data saver, on low memory, or when forced', () => {
    expect(webglMode({ ...ready, webgl: false })).toBe('skip')
    expect(webglMode({ ...ready, saveData: true })).toBe('skip')
    expect(webglMode({ ...ready, deviceMemoryGb: 2 })).toBe('skip')
    expect(webglMode({ ...ready, forcedStatic: true })).toBe('skip')
    expect(webglMode({ ...ready, deviceMemoryGb: 4 })).toBe('animate')
  })
})

describe('pixel ratio cap', () => {
  it('caps phones harder than desktops', () => {
    expect(cappedDevicePixelRatio(3, 390)).toBe(1.25)
    expect(cappedDevicePixelRatio(3, 1440)).toBe(1.75)
    expect(cappedDevicePixelRatio(1, 1440)).toBe(1)
    expect(cappedDevicePixelRatio(Number.NaN, 1440)).toBe(1)
  })
})

describe('sticky call to action', () => {
  it('shows only on a narrow screen away from the hero and the final download', () => {
    expect(shouldShowSticky({ narrow: true, heroVisible: false, finalVisible: false, menuOpen: false })).toBe(true)
    expect(shouldShowSticky({ narrow: true, heroVisible: true, finalVisible: false, menuOpen: false })).toBe(false)
    expect(shouldShowSticky({ narrow: true, heroVisible: false, finalVisible: true, menuOpen: false })).toBe(false)
    expect(shouldShowSticky({ narrow: false, heroVisible: false, finalVisible: false, menuOpen: false })).toBe(false)
    expect(shouldShowSticky({ narrow: true, heroVisible: false, finalVisible: false, menuOpen: true })).toBe(false)
  })
})

describe('menu keyboard', () => {
  it('closes on escape and ignores other keys', () => {
    expect(menuOpenAfterKey(true, 'Escape')).toBe(false)
    expect(menuOpenAfterKey(false, 'Escape')).toBeNull()
    expect(menuOpenAfterKey(true, 'Tab')).toBeNull()
  })
})
