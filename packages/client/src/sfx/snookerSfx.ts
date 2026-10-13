import type { SfxPlayer } from './audioEngine.js'
import { bufferKey } from './recipes.js'
import type { RollingBall, RollingSound } from './rolling.js'
import type { SfxEvent } from './sfxEvents.js'
import { SFX_CONFIG, type Layer, type SfxConfig, type SfxTier, type SoundType } from './sfxConfig.js'

/**
 * What the table sounds like: which sound, how loud, and whether at all.
 *
 * Everything here is decided from events the game hands over. Nothing is guessed, nothing
 * is timed, and nothing in the game is read back or changed: an event comes in, and at
 * most one request to play a prepared buffer goes out.
 */

/** A speed as a fraction of the fastest a ball can be sent, clamped to 0..1. */
export function speedNorm(speed: number, config: SfxConfig = SFX_CONFIG): number {
  if (!(speed > 0)) return 0
  return Math.min(1, speed / config.vmax)
}

/** Which of the three strengths a hit at this speed is. */
export function layerForSpeed(norm: number, config: SfxConfig = SFX_CONFIG): Layer {
  if (norm < config.layerBelow.soft) return 'soft'
  if (norm < config.layerBelow.medium) return 'medium'
  return 'hard'
}

/**
 * How loud a hit at this speed is, in dB: `minDb` at the softest, `maxDb` at the hardest,
 * along a curve that gives the quiet end most of the range, the way an ear hears it.
 */
export function gainDbForSpeed(norm: number, minDb: number, maxDb: number, config: SfxConfig = SFX_CONFIG): number {
  const t = Math.max(0, Math.min(1, Math.pow(Math.max(0, norm), config.gainCurve)))
  return minDb + (maxDb - minDb) * t
}

/** Where on the table, left to right, as a pan. */
export function panForX(x: number, config: SfxConfig = SFX_CONFIG): number {
  const k = (x - config.halfLength) / config.halfLength
  return Math.max(-1, Math.min(1, k)) * config.panWidth
}

/**
 * How much the newest of a burst of impacts is turned down, in dB.
 *
 * Up to `free` impacts inside the window sound at their own level. Past that, each new
 * one is scaled by `1 / sqrt(n / free)`, so a break-off of fifteen reds adds up to about
 * the loudness of four hits and not of thirty. The limiter is behind this, not instead.
 */
export function denseCompensationDb(impactsInWindow: number, config: SfxConfig = SFX_CONFIG): number {
  if (impactsInWindow <= config.dense.free) return 0
  return -10 * Math.log10(impactsInWindow / config.dense.free)
}

/**
 * Remembers when each thing last sounded, so the same contact reported twice is one sound.
 *
 * A key may not sound again in the same simulation step, nor inside the cooldown. Two
 * different keys never block each other, so a run of quick, distinct collisions all sound.
 */
export class Cooldowns {
  private readonly last = new Map<string, { at: number; step: number | undefined }>()

  constructor(private readonly cooldownMs: number) {}

  /** True if `key` may sound now, and if so, records that it did. */
  allow(key: string, nowMs: number, step?: number): boolean {
    const was = this.last.get(key)
    if (was) {
      if (step !== undefined && was.step === step) return false
      if (nowMs - was.at < this.cooldownMs) return false
    }
    this.last.set(key, { at: nowMs, step })
    // Kept small: anything long past its cooldown can never block again.
    if (this.last.size > 256) {
      for (const [k, v] of this.last) if (nowMs - v.at > this.cooldownMs * 4) this.last.delete(k)
    }
    return true
  }

  clear(): void {
    this.last.clear()
  }
}

/** Counts the impacts inside a sliding window of real time. */
export class ImpactWindow {
  private readonly times: number[] = []

  constructor(private readonly windowMs: number) {}

  /** Records an impact at `nowMs` and returns how many are in the window, this one included. */
  add(nowMs: number): number {
    while (this.times.length && nowMs - this.times[0]! > this.windowMs) this.times.shift()
    this.times.push(nowMs)
    return this.times.length
  }

  clear(): void {
    this.times.length = 0
  }
}

/**
 * The low-pass a hit at this speed is played through, in Hz: dull for a kiss, wide open
 * for a crack. This is what lets one recording stand for every strength in between.
 */
export function brightnessHz(norm: number, config: SfxConfig = SFX_CONFIG): number {
  const b = config.shape.brightness
  const t = Math.pow(Math.max(0, Math.min(1, norm)), b.exponent)
  return b.softHz + (b.hardHz - b.softHz) * t
}

/** A playback rate around `base`, moved off it by up to the configured jitter. */
export function jitteredRate(base: number, random: number, config: SfxConfig = SFX_CONFIG): number {
  return base * (1 + (random * 2 - 1) * config.shape.jitter)
}

/** Whether an event's moment is close enough to now to be worth playing. */
export function isOnTime(at: number | undefined, nowMs: number, config: SfxConfig = SFX_CONFIG): boolean {
  if (at === undefined) return true
  return nowMs - at <= config.catchUpMs
}

export interface SnookerSfx {
  /** Takes one event from the game. Never throws. */
  handle(event: SfxEvent): void
  /** Forgets everything: cooldowns, potted balls, the burst counter. */
  reset(): void
}

export interface SnookerSfxOptions {
  tier: SfxTier
  config?: SfxConfig
  /** The clock, in ms. Injected so the timing rules can be tested. */
  now?: () => number
  /** Random numbers in [0, 1), for the small differences between one hit and the next. */
  random?: () => number
  rolling?: RollingSound | null
}

export function createSnookerSfx(player: SfxPlayer, options: SnookerSfxOptions): SnookerSfx {
  const config = options.config ?? SFX_CONFIG
  const now = options.now ?? (() => performance.now())
  const random = options.random ?? Math.random
  const variants = config.tiers[options.tier].variants
  const cooldowns = new Cooldowns(config.cooldownMs)
  const burst = new ImpactWindow(config.dense.windowMs)
  const potted = new Set<number>()
  const nextVariant = new Map<string, number>()

  /** Variants are walked in turn per sound, so the same one is never heard twice running. */
  const variantFor = (name: string): number => {
    const v = nextVariant.get(name) ?? 0
    nextVariant.set(name, (v + 1) % variants)
    return v
  }

  /** One impact: the burst rule is applied to all of them together. */
  const impact = (
    type: SoundType,
    layer: Layer | 'one',
    gainDb: number,
    x: number | undefined,
    delayMs = 0,
    norm?: number
  ): void => {
    const dense = denseCompensationDb(burst.add(now() + delayMs), config)
    const pitch = config.shape.pitch[type as keyof typeof config.shape.pitch] ?? 1
    player.play({
      key: bufferKey(type, layer, variantFor(`${type}:${layer}`)),
      gainDb: gainDb + dense,
      pan: x === undefined ? 0 : panForX(x, config),
      bus: 'sfx',
      delayMs,
      rate: jitteredRate(pitch, random(), config),
      // Only the sounds whose strength is known are filtered by it.
      ...(norm === undefined ? {} : { lowpassHz: brightnessHz(norm, config) })
    })
  }

  const handle = (event: SfxEvent): void => {
    const t = now()
    switch (event.type) {
      case 'cueStrike': {
        if (!isOnTime(event.at, t, config)) return
        const norm = Math.max(0, Math.min(1, event.power))
        const range = config.rangeDb.cue
        impact('cue', layerForSpeed(norm, config), gainDbForSpeed(norm, range.min, range.max, config), event.x, 0, norm)
        return
      }
      case 'ballBall': {
        if (!isOnTime(event.at, t, config)) return
        const norm = speedNorm(event.speed, config)
        if (norm < config.ignoreBelow.ball) return
        const key = `b:${Math.min(event.idA, event.idB)}:${Math.max(event.idA, event.idB)}`
        if (!cooldowns.allow(key, t, event.step)) return
        const range = config.rangeDb.ball
        impact('ball', layerForSpeed(norm, config), gainDbForSpeed(norm, range.min, range.max, config), event.x, 0, norm)
        return
      }
      case 'cushion': {
        if (!isOnTime(event.at, t, config)) return
        const norm = speedNorm(event.speed, config)
        if (norm < config.ignoreBelow.cushion) return
        if (!cooldowns.allow(`c:${event.ballId}:${event.cushion ?? 'any'}`, t, event.step)) return
        const range = config.rangeDb.cushion
        impact('cushion', layerForSpeed(norm, config), gainDbForSpeed(norm, range.min, range.max, config), event.x, 0, norm)
        return
      }
      case 'jaw': {
        if (!isOnTime(event.at, t, config)) return
        const norm = speedNorm(event.speed, config)
        if (norm < config.ignoreBelow.jaw) return
        if (!cooldowns.allow(`j:${event.ballId}`, t, event.step)) return
        const range = config.rangeDb.jaw
        impact('jaw', 'one', gainDbForSpeed(norm, range.min, range.max, config), event.x)
        return
      }
      case 'pocket': {
        // Once per ball per pot, however many times it is reported. The ball is
        // remembered even when the sound is skipped for being late, so a second report
        // of the same pot cannot play it after all.
        if (potted.has(event.ballId)) return
        potted.add(event.ballId)
        options.rolling?.release(event.ballId)
        if (!isOnTime(event.at, t, config)) return
        const norm = speedNorm(event.speed, config)
        if (event.jaw) {
          const jaw = config.rangeDb.jaw
          impact('jaw', 'one', gainDbForSpeed(norm, jaw.min, jaw.max, config), event.x)
        }
        const drop = config.rangeDb.drop
        impact('drop', 'one', gainDbForSpeed(Math.max(norm, 0.08), drop.min, drop.max, config), event.x)
        const net = config.rangeDb.net
        impact('net', 'one', gainDbForSpeed(Math.max(norm, 0.08), net.min, net.max, config), event.x, config.netDelayMs)
        return
      }
      case 'respot':
        potted.delete(event.ballId)
        return
      case 'frameStart':
        potted.clear()
        cooldowns.clear()
        burst.clear()
        options.rolling?.silence()
        return
      case 'rollTick': {
        if (!options.rolling) return
        // Nothing moving: let go at once. An update is only acted on twenty times a
        // second, and the last word of a shot must not be the one that is skipped.
        if (event.balls.length === 0) {
          options.rolling.silence()
          return
        }
        const balls: RollingBall[] = []
        for (const ball of event.balls) {
          if (potted.has(ball.id)) continue
          balls.push({ id: ball.id, speedNorm: speedNorm(ball.speed, config), pan: panForX(ball.x, config) })
        }
        options.rolling.update(balls, t)
        return
      }
      case 'aux': {
        if (!isOnTime(event.at, t, config)) return
        const range = config.rangeDb.aux
        // The foul tone is the one of these a player has to notice.
        const db = event.sound === 'foul' ? range.max : event.sound === 'uiHover' ? range.min : (range.min + range.max) / 2
        player.play({ key: bufferKey(event.sound, 'one', 0), gainDb: db, bus: 'ui' })
        return
      }
    }
  }

  return {
    handle(event): void {
      try {
        handle(event)
      } catch {
        // Sound is never allowed to be the reason something else fails.
      }
    },
    reset(): void {
      cooldowns.clear()
      burst.clear()
      potted.clear()
      nextVariant.clear()
    }
  }
}
