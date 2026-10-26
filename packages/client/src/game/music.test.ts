import { beforeEach, describe, expect, it } from 'vitest'
import { musicEnabled, musicTrack, musicVolume, noteFrequency, phraseLength, setMusicEnabled, setMusicTrack, setMusicVolume, timbreFor } from './music.js'

beforeEach(() => {
  setMusicEnabled(true)
  setMusicVolume(0.3)
  setMusicTrack('piano')
})

describe('background music', () => {
  it('defaults to on, quiet, and piano, and remembers a change', () => {
    expect(musicEnabled()).toBe(true)
    expect(musicVolume()).toBeCloseTo(0.3)
    expect(musicTrack()).toBe('piano')
    setMusicEnabled(false)
    setMusicVolume(0.6)
    setMusicTrack('violin')
    expect(musicEnabled()).toBe(false)
    expect(musicVolume()).toBeCloseTo(0.6)
    expect(musicTrack()).toBe('violin')
  })

  it('keeps the phrase in a calm range and rotates timbres on mix', () => {
    for (let i = 0; i < phraseLength(); i++) {
      const hz = noteFrequency(i)
      expect(hz).toBeGreaterThan(100)
      expect(hz).toBeLessThan(800)
    }
    expect(timbreFor('flute', 3)).toBe('flute')
    expect(timbreFor('mix', 0)).toBe('piano')
    expect(timbreFor('mix', phraseLength())).toBe('guitar')
    expect(timbreFor('mix', phraseLength() * 2)).toBe('violin')
    expect(timbreFor('mix', phraseLength() * 3)).toBe('flute')
  })
})
