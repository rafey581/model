import { describe, expect, it } from 'vitest'
import { chooseVictim, createAudioEngine, type PlayRequest, type SfxPlayer } from './audioEngine.js'
import { SpeedTracker, assignRollingVoices, createRollingSound, rollingVoiceTarget } from './rolling.js'
import { emitSfx, subscribeSfx } from './sfxEvents.js'
import { SFX_CONFIG } from './sfxConfig.js'
import {
  Cooldowns,
  ImpactWindow,
  createSnookerSfx,
  denseCompensationDb,
  gainDbForSpeed,
  brightnessHz,
  isOnTime,
  jitteredRate,
  layerForSpeed,
  panForX,
  speedNorm
} from './snookerSfx.js'

const VMAX = SFX_CONFIG.vmax

/** A player that records what it was asked for, and a clock that only moves when told. */
function harness(tier: 'low' | 'medium' | 'high' = 'medium') {
  const played: PlayRequest[] = []
  const player: SfxPlayer = {
    play(request) {
      played.push(request)
      return true
    }
  }
  let time = 1000
  const released: number[] = []
  const sfx = createSnookerSfx(player, {
    tier,
    now: () => time,
    rolling: { update: () => {}, release: (id) => released.push(id), silence: () => {}, dispose: () => {} }
  })
  return {
    sfx,
    played,
    released,
    advance: (ms: number) => {
      time += ms
    },
    now: () => time
  }
}

describe('speed to sound', () => {
  it('scales speed against the game’s own maximum', () => {
    expect(VMAX).toBe(9000)
    expect(speedNorm(0)).toBe(0)
    expect(speedNorm(-5)).toBe(0)
    expect(speedNorm(VMAX / 2)).toBeCloseTo(0.5, 9)
    expect(speedNorm(VMAX * 3)).toBe(1)
  })

  it('picks the layer by the thresholds', () => {
    expect(layerForSpeed(0.05)).toBe('soft')
    expect(layerForSpeed(0.179)).toBe('soft')
    expect(layerForSpeed(0.18)).toBe('medium')
    expect(layerForSpeed(0.499)).toBe('medium')
    expect(layerForSpeed(0.5)).toBe('hard')
    expect(layerForSpeed(1)).toBe('hard')
  })

  it('runs loudness from the floor to the ceiling along the curve', () => {
    expect(gainDbForSpeed(0, -30, -10)).toBe(-30)
    expect(gainDbForSpeed(1, -30, -10)).toBe(-10)
    expect(gainDbForSpeed(5, -30, -10)).toBe(-10)
    // (0.5)^0.6 of the way up.
    expect(gainDbForSpeed(0.5, -30, -10)).toBeCloseTo(-30 + 20 * Math.pow(0.5, 0.6), 9)
    let previous = -Infinity
    for (let v = 0; v <= 1.0001; v += 0.05) {
      const db = gainDbForSpeed(v, -30, -10)
      expect(db).toBeGreaterThanOrEqual(previous)
      previous = db
    }
  })

  it('places a sound by where on the table it happened, half-width at most', () => {
    expect(panForX(SFX_CONFIG.halfLength)).toBe(0)
    expect(panForX(0)).toBeCloseTo(-0.5, 9)
    expect(panForX(SFX_CONFIG.halfLength * 2)).toBeCloseTo(0.5, 9)
    expect(panForX(99999)).toBeCloseTo(0.5, 9)
  })
})

describe('what is ignored', () => {
  it('drops contacts too gentle to hear, and keeps the ones just above', () => {
    const h = harness()
    h.sfx.handle({ type: 'ballBall', idA: 1, idB: 2, speed: 0.019 * VMAX, x: 0, z: 0 })
    h.sfx.handle({ type: 'cushion', ballId: 1, speed: 0.029 * VMAX, x: 0, z: 0 })
    expect(h.played.length).toBe(0)
    h.sfx.handle({ type: 'ballBall', idA: 3, idB: 4, speed: 0.021 * VMAX, x: 0, z: 0 })
    h.sfx.handle({ type: 'cushion', ballId: 5, speed: 0.031 * VMAX, x: 0, z: 0 })
    expect(h.played.map((p) => p.key.split(':')[0])).toEqual(['ball', 'cushion'])
  })

  it('does not play what is long past its moment, and plays what is not', () => {
    expect(isOnTime(undefined, 5000)).toBe(true)
    expect(isOnTime(4800, 5000)).toBe(true)
    expect(isOnTime(4750, 5000)).toBe(true)
    expect(isOnTime(4749, 5000)).toBe(false)
    const h = harness()
    h.sfx.handle({ type: 'ballBall', idA: 1, idB: 2, speed: VMAX / 2, x: 0, z: 0, at: h.now() - 251 })
    h.sfx.handle({ type: 'cueStrike', power: 0.5, x: 0, z: 0, at: h.now() - 2000 })
    expect(h.played.length).toBe(0)
    h.sfx.handle({ type: 'ballBall', idA: 1, idB: 2, speed: VMAX / 2, x: 0, z: 0, at: h.now() - 100 })
    expect(h.played.length).toBe(1)
  })
})

describe('one contact, one sound', () => {
  it('blocks the same pair in the same step and inside the cooldown, in either order', () => {
    const h = harness()
    h.sfx.handle({ type: 'ballBall', idA: 1, idB: 2, speed: VMAX / 2, x: 0, z: 0, step: 7 })
    h.sfx.handle({ type: 'ballBall', idA: 2, idB: 1, speed: VMAX / 2, x: 0, z: 0, step: 7 })
    h.advance(10)
    h.sfx.handle({ type: 'ballBall', idA: 1, idB: 2, speed: VMAX / 2, x: 0, z: 0, step: 8 })
    expect(h.played.length).toBe(1)
    h.advance(31)
    h.sfx.handle({ type: 'ballBall', idA: 1, idB: 2, speed: VMAX / 2, x: 0, z: 0, step: 12 })
    expect(h.played.length).toBe(2)
  })

  it('lets quick collisions between different balls all sound', () => {
    const h = harness()
    for (let i = 0; i < 6; i++) {
      h.sfx.handle({ type: 'ballBall', idA: 0, idB: 1 + i, speed: VMAX / 2, x: 0, z: 0, step: 3 })
      h.advance(2)
    }
    expect(h.played.length).toBe(6)
  })

  it('keeps cushions apart per ball and per cushion', () => {
    const h = harness()
    h.sfx.handle({ type: 'cushion', ballId: 1, cushion: 0, speed: VMAX / 2, x: 0, z: 0 })
    h.sfx.handle({ type: 'cushion', ballId: 1, cushion: 0, speed: VMAX / 2, x: 0, z: 0 })
    h.sfx.handle({ type: 'cushion', ballId: 1, cushion: 2, speed: VMAX / 2, x: 0, z: 0 })
    h.sfx.handle({ type: 'cushion', ballId: 2, cushion: 0, speed: VMAX / 2, x: 0, z: 0 })
    expect(h.played.length).toBe(3)
  })

  it('the cooldown table answers by key, step and time', () => {
    const c = new Cooldowns(30)
    expect(c.allow('a', 0, 1)).toBe(true)
    expect(c.allow('a', 100, 1)).toBe(false)
    expect(c.allow('a', 20, 2)).toBe(false)
    expect(c.allow('b', 20, 1)).toBe(true)
    expect(c.allow('a', 30, 2)).toBe(true)
  })

  it('walks the variants, so the same buffer is not heard twice running', () => {
    const h = harness('medium')
    for (let i = 0; i < 4; i++) h.sfx.handle({ type: 'ballBall', idA: 10 + i, idB: 20 + i, speed: VMAX * 0.3, x: 0, z: 0 })
    expect(h.played.map((p) => p.key)).toEqual(['ball:medium:0', 'ball:medium:1', 'ball:medium:2', 'ball:medium:0'])
  })
})

describe('a burst of impacts', () => {
  it('leaves the first four alone and turns the rest down by the square-root rule', () => {
    expect(denseCompensationDb(1)).toBe(0)
    expect(denseCompensationDb(4)).toBe(0)
    expect(denseCompensationDb(8)).toBeCloseTo(-3.0103, 3)
    expect(denseCompensationDb(16)).toBeCloseTo(-6.0206, 3)
    // The same thing as a gain of 1 / sqrt(n / 4).
    expect(Math.pow(10, denseCompensationDb(9) / 20)).toBeCloseTo(1 / Math.sqrt(9 / 4), 9)
  })

  it('counts only what is inside the window', () => {
    const w = new ImpactWindow(50)
    expect(w.add(0)).toBe(1)
    expect(w.add(10)).toBe(2)
    expect(w.add(49)).toBe(3)
    expect(w.add(61)).toBe(2)
    expect(w.add(200)).toBe(1)
  })

  it('makes a break-off quieter hit by hit, and lets the level come back afterwards', () => {
    const h = harness()
    const base = gainDbForSpeed(0.5, SFX_CONFIG.rangeDb.ball.min, SFX_CONFIG.rangeDb.ball.max)
    for (let i = 0; i < 12; i++) {
      h.sfx.handle({ type: 'ballBall', idA: i, idB: 100 + i, speed: VMAX / 2, x: 0, z: 0 })
      h.advance(2)
    }
    expect(h.played[3]!.gainDb).toBeCloseTo(base, 9)
    expect(h.played[4]!.gainDb).toBeCloseTo(base + denseCompensationDb(5), 9)
    expect(h.played[11]!.gainDb).toBeCloseTo(base + denseCompensationDb(12), 9)
    h.advance(200)
    h.sfx.handle({ type: 'ballBall', idA: 50, idB: 51, speed: VMAX / 2, x: 0, z: 0 })
    expect(h.played[12]!.gainDb).toBeCloseTo(base, 9)
  })
})

describe('shaping a recording as it is played', () => {
  it('plays a ball click higher than it was recorded, by the ratio of the two ball sizes', () => {
    // 57mm pool ball to 52.5mm snooker ball.
    expect(SFX_CONFIG.shape.pitch.ball).toBeCloseTo(57 / 52.5, 2)
  })

  it('never plays the same recording at exactly the same pitch twice, and never far off', () => {
    let seed = 1
    const random = (): number => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    const played: PlayRequest[] = []
    const sfx = createSnookerSfx({ play: (r) => (played.push(r), true) }, { tier: 'medium', now: () => played.length * 100, random })
    for (let i = 0; i < 20; i++) sfx.handle({ type: 'ballBall', idA: i, idB: 100 + i, speed: VMAX / 2, x: 0, z: 0 })
    const rates = played.map((p) => p.rate!)
    expect(new Set(rates.map((r) => r.toFixed(4))).size).toBeGreaterThan(15)
    for (const rate of rates) {
      expect(rate).toBeGreaterThanOrEqual(SFX_CONFIG.shape.pitch.ball * (1 - SFX_CONFIG.shape.jitter) - 1e-9)
      expect(rate).toBeLessThanOrEqual(SFX_CONFIG.shape.pitch.ball * (1 + SFX_CONFIG.shape.jitter) + 1e-9)
    }
    expect(jitteredRate(1, 0.5)).toBeCloseTo(1, 9)
  })

  it('dulls a gentle hit and leaves a hard one open', () => {
    expect(brightnessHz(0)).toBe(SFX_CONFIG.shape.brightness.softHz)
    expect(brightnessHz(1)).toBe(SFX_CONFIG.shape.brightness.hardHz)
    let previous = 0
    for (let v = 0; v <= 1.0001; v += 0.1) {
      expect(brightnessHz(v)).toBeGreaterThan(previous)
      previous = brightnessHz(v)
    }
    const h = harness()
    h.sfx.handle({ type: 'ballBall', idA: 1, idB: 2, speed: 0.05 * VMAX, x: 0, z: 0 })
    h.sfx.handle({ type: 'ballBall', idA: 3, idB: 4, speed: 0.9 * VMAX, x: 0, z: 0 })
    expect(h.played[0]!.lowpassHz!).toBeLessThan(h.played[1]!.lowpassHz!)
    // The pocket's sounds have no strength to filter by, and are left as recorded.
    h.sfx.handle({ type: 'pocket', ballId: 9, pocketIndex: 0, speed: 500 })
    expect(h.played[2]!.lowpassHz).toBeUndefined()
  })
})

describe('the voice pool', () => {
  it('cuts the quietest voice first, and the oldest among equals', () => {
    expect(chooseVictim([])).toBe(-1)
    expect(
      chooseVictim([
        { gainDb: -10, startedAt: 1 },
        { gainDb: -28, startedAt: 5 },
        { gainDb: -20, startedAt: 0 }
      ])
    ).toBe(1)
    expect(
      chooseVictim([
        { gainDb: -20, startedAt: 3 },
        { gainDb: -20, startedAt: 1 },
        { gainDb: -20, startedAt: 2 }
      ])
    ).toBe(1)
  })
})

describe('a pot', () => {
  it('plays its sequence once per ball, however often it is reported', () => {
    const h = harness()
    const pot = { type: 'pocket', ballId: 5, pocketIndex: 2, speed: 0.2 * VMAX, jaw: true } as const
    h.sfx.handle(pot)
    h.sfx.handle(pot)
    h.sfx.handle(pot)
    expect(h.played.map((p) => p.key.split(':')[0])).toEqual(['jaw', 'drop', 'net'])
    expect(h.played[2]!.delayMs).toBe(SFX_CONFIG.netDelayMs)
    expect(h.released).toEqual([5])
  })

  it('has no jaw knock unless the event says a jaw was hit', () => {
    const h = harness()
    h.sfx.handle({ type: 'pocket', ballId: 6, pocketIndex: 0, speed: 0.2 * VMAX })
    expect(h.played.map((p) => p.key.split(':')[0])).toEqual(['drop', 'net'])
  })

  it('can sound again once the ball is back on the table, or a new frame starts', () => {
    const h = harness()
    const pot = { type: 'pocket', ballId: 21, pocketIndex: 1, speed: 0.1 * VMAX } as const
    h.sfx.handle(pot)
    h.advance(500)
    h.sfx.handle({ type: 'respot', ballId: 21 })
    h.sfx.handle(pot)
    h.advance(500)
    h.sfx.handle({ type: 'frameStart' })
    h.sfx.handle(pot)
    expect(h.played.filter((p) => p.key.startsWith('drop')).length).toBe(3)
  })

  it('stays remembered when it was too late to play, so a repeat cannot play it after all', () => {
    const h = harness()
    h.sfx.handle({ type: 'pocket', ballId: 9, pocketIndex: 1, speed: 0.1 * VMAX, at: h.now() - 5000 })
    h.sfx.handle({ type: 'pocket', ballId: 9, pocketIndex: 1, speed: 0.1 * VMAX })
    expect(h.played.length).toBe(0)
  })
})

describe('the smaller sounds', () => {
  it('plays the interface ticks on their own bus, quieter than the table', () => {
    const h = harness()
    h.sfx.handle({ type: 'aux', sound: 'uiClick' })
    h.sfx.handle({ type: 'aux', sound: 'foul' })
    expect(h.played.every((p) => p.bus === 'ui')).toBe(true)
    expect(h.played[0]!.gainDb).toBeLessThanOrEqual(SFX_CONFIG.rangeDb.aux.max)
    expect(h.played[1]!.gainDb).toBe(SFX_CONFIG.rangeDb.aux.max)
    expect(SFX_CONFIG.rangeDb.aux.max).toBeLessThan(SFX_CONFIG.rangeDb.cue.min)
  })

  it('plays the cue once, layered by the power of the shot', () => {
    const h = harness()
    h.sfx.handle({ type: 'cueStrike', power: 0.1, x: 0, z: 0 })
    h.sfx.handle({ type: 'cueStrike', power: 0.95, x: 0, z: 0 })
    expect(h.played.map((p) => p.key.split(':').slice(0, 2).join(':'))).toEqual(['cue:soft', 'cue:hard'])
    expect(h.played[1]!.gainDb).toBeGreaterThan(h.played[0]!.gainDb)
  })
})

describe('rolling', () => {
  it('gives the voices to the fastest balls and leaves the slow ones silent', () => {
    const balls = [
      { id: 1, speedNorm: 0.2, pan: 0 },
      { id: 2, speedNorm: 0.5, pan: 0 },
      { id: 3, speedNorm: 0.001, pan: 0 },
      { id: 4, speedNorm: 0.3, pan: 0 },
      { id: 5, speedNorm: 0.1, pan: 0 }
    ]
    const assigned = assignRollingVoices([null, null, null], balls, 0.004)
    expect(assigned.map((b) => b?.id).sort()).toEqual([1, 2, 4])
  })

  it('keeps a ball on its voice while it is still among the fastest', () => {
    const first = assignRollingVoices([null, null], [{ id: 7, speedNorm: 0.3, pan: 0 }, { id: 8, speedNorm: 0.2, pan: 0 }], 0.004)
    const ids = first.map((b) => b?.id ?? null)
    // A faster ball arrives; ball 7 is still in the top two and must not move voices.
    const second = assignRollingVoices(ids, [{ id: 7, speedNorm: 0.25, pan: 0 }, { id: 8, speedNorm: 0.02, pan: 0 }, { id: 9, speedNorm: 0.4, pan: 0 }], 0.004)
    expect(second[ids.indexOf(7)]?.id).toBe(7)
    expect(second.map((b) => b?.id).sort()).toEqual([7, 9])
  })

  it('frees a voice when its ball stops', () => {
    const next = assignRollingVoices([3, 4], [{ id: 3, speedNorm: 0, pan: 0 }, { id: 4, speedNorm: 0.2, pan: 0 }], 0.004)
    expect(next).toEqual([null, { id: 4, speedNorm: 0.2, pan: 0 }])
  })

  it('rises in level and pitch with speed, smoothly, and is silent below the threshold', () => {
    expect(rollingVoiceTarget(0).gain).toBe(0)
    expect(rollingVoiceTarget(SFX_CONFIG.rolling.silentBelow * 0.9).gain).toBe(0)
    let previous = rollingVoiceTarget(SFX_CONFIG.rolling.silentBelow)
    for (let v = 0.01; v <= 0.6; v += 0.01) {
      const target = rollingVoiceTarget(v)
      expect(target.gain).toBeGreaterThanOrEqual(previous.gain)
      expect(target.bandHz).toBeGreaterThanOrEqual(previous.bandHz)
      // No step bigger than a small fraction of the range between neighbouring speeds.
      expect(target.gain - previous.gain).toBeLessThan(0.08)
      previous = target
    }
    const full = rollingVoiceTarget(1)
    expect(full.gain).toBe(1)
    expect(full.bandHz).toBeCloseTo(SFX_CONFIG.rolling.bandBaseHz + SFX_CONFIG.rolling.bandRangeHz, 9)
    expect(full.rate).toBeCloseTo(SFX_CONFIG.rolling.rateMax, 9)
  })

  it('works out speeds from positions without being handed any', () => {
    const tracker = new SpeedTracker()
    expect(tracker.update([{ id: 1, x: 0, z: 0 }], 1000)[0]!.speed).toBe(0)
    // 30mm in 1/60s is 1800mm/s.
    expect(tracker.update([{ id: 1, x: 30, z: 0 }], 1000 + 1000 / 60)[0]!.speed).toBeCloseTo(1800, 6)
    // A gap too long to mean anything (a hidden tab) reports no speed rather than a wild one.
    expect(tracker.update([{ id: 1, x: 3000, z: 0 }], 9000)[0]!.speed).toBe(0)
  })

  it('does not pass a potted ball to the rolling voices', () => {
    const seen: number[][] = []
    const sfx = createSnookerSfx(
      { play: () => true },
      {
        tier: 'low',
        now: () => 0,
        rolling: { update: (balls) => seen.push(balls.map((b) => b.id)), release: () => {}, silence: () => {}, dispose: () => {} }
      }
    )
    sfx.handle({ type: 'pocket', ballId: 2, pocketIndex: 0, speed: 100 })
    sfx.handle({ type: 'rollTick', balls: [{ id: 1, speed: 500, x: 0, z: 0 }, { id: 2, speed: 500, x: 0, z: 0 }] })
    expect(seen).toEqual([[1]])
  })
})

describe('with no audio at all', () => {
  it('never throws: no context, no Web Audio, a provider that fails', () => {
    const engine = createAudioEngine('medium')
    expect(engine.play({ key: 'ball:hard:0', gainDb: -10 })).toBe(false)
    engine.setContextProvider(() => {
      throw new Error('no audio here')
    })
    engine.store('ball:hard:0', new Float32Array(100))
    expect(engine.play({ key: 'ball:hard:0', gainDb: -10, pan: 0.3 })).toBe(false)
    expect(engine.graph()).toBeNull()
    expect(engine.peakDb()).toBe(-Infinity)
    expect(engine.audible()).toBe(false)
    engine.syncMute()
    engine.setBusDb('sfx', -6)
    engine.setMasterDb(-6)

    const rolling = createRollingSound(engine, 'medium')
    rolling.update([{ id: 1, speedNorm: 0.4, pan: 0 }], 1000)
    rolling.release(1)
    rolling.silence()

    const sfx = createSnookerSfx(engine, { tier: 'medium', rolling })
    sfx.handle({ type: 'cueStrike', power: 0.7, x: 100, z: 100 })
    sfx.handle({ type: 'ballBall', idA: 0, idB: 1, speed: 4000, x: 100, z: 100 })
    sfx.handle({ type: 'pocket', ballId: 1, pocketIndex: 0, speed: 900 })
    sfx.handle({ type: 'rollTick', balls: [{ id: 0, speed: 900, x: 0, z: 0 }] })
    sfx.handle({ type: 'aux', sound: 'foul' })
    rolling.dispose()
    engine.dispose()
  })

  it('never lets a listener that throws reach the game', () => {
    const stop = subscribeSfx(() => {
      throw new Error('a sound went wrong')
    })
    let heard = 0
    const stopSecond = subscribeSfx(() => {
      heard++
    })
    expect(() => emitSfx({ type: 'frameStart' })).not.toThrow()
    expect(heard).toBe(1)
    stop()
    stopSecond()
    emitSfx({ type: 'frameStart' })
    expect(heard).toBe(1)
  })
})
