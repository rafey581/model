import {
  SAMPLE_RATE,
  addNoiseBurst,
  addPartial,
  addSweep,
  between,
  biquad,
  crossfadeLoop,
  fadeOut,
  mulberry32,
  normalise,
  pinkNoise,
  silence
} from './dsp.js'
import {
  LAYERS,
  SFX_CONFIG,
  type AuxSound,
  type FlatSound,
  type Layer,
  type LayeredSound,
  type RecipeParams,
  type SfxConfig,
  type SfxTier,
  type SoundType
} from './sfxConfig.js'

/**
 * The sounds, built from the pieces in `dsp.ts`.
 *
 * Each is a small modal model of the thing being struck: a few decaying partials for
 * what rings, a low sine for its body, and a couple of milliseconds of filtered noise
 * for the contact itself. Nothing is sampled. A variant draws its own small offsets —
 * pitch, decay, the noise — once, from a seed, so the same variant is the same sound on
 * every load, and no two variants of a sound are quite alike.
 */

/** Peak every buffer is normalised to. Loudness is set at play time, not here. */
export const BUFFER_PEAK = 0.9

/** The name a rendered buffer is stored under. */
export function bufferKey(type: SoundType, layer: Layer | 'one', variant: number): string {
  return `${type}:${layer}:${variant}`
}

function seedFor(type: string, layer: string, variant: number): number {
  let h = 2166136261
  const text = `${type}/${layer}/${variant}`
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** The per-variant offsets: pitch within 4 percent, decays between 0.8 and 1.25 times. */
function variation(rand: () => number): { pitch: number; decay: number } {
  return { pitch: between(rand, 0.96, 1.04), decay: between(rand, 0.8, 1.25) }
}

function finish(out: Float32Array, lowpassHz: number): Float32Array {
  biquad(out, 'lowpass', lowpassHz)
  normalise(out, BUFFER_PEAK)
  fadeOut(out, 5)
  // The fade can only have lowered samples, and the peak sits in the attack, far from the
  // tail, so the peak is still the normalised one.
  return out
}

/** Two snooker balls: short and bright, hard phenolic resin, with a little weight under it. */
function renderBall(p: RecipeParams, s: number, seed: number): Float32Array {
  const rand = mulberry32(seed)
  const v = variation(rand)
  const out = silence(p.lengthMs)
  const f1 = between(rand, p.baseFreqMin, p.baseFreqMax) * v.pitch
  const bright = 0.4 + s
  addPartial(out, f1, p.decayMs * v.decay, 1)
  addPartial(out, f1 * 1.58, p.decayMs * (9 / 14) * v.decay, 0.55 * bright)
  addPartial(out, f1 * 2.31, p.decayMs * (6 / 14) * v.decay, 0.3 * bright)
  if (s > 0.5) addPartial(out, f1 * 3.12, p.decayMs * (4 / 14) * v.decay, 0.18 * bright)
  addPartial(out, between(rand, p.bodyFreqMin, p.bodyFreqMax), p.bodyDecayMs * v.decay, p.bodyLevel)
  addNoiseBurst(out, rand, 3000, 7000, between(rand, 1.5, 3), 1.2, p.noiseLevel)
  return finish(out, p.lowpassBase + p.lowpassRange * s)
}

/** The tip on the cue ball: a woody tock, not a click. */
function renderCue(p: RecipeParams, s: number, seed: number): Float32Array {
  const rand = mulberry32(seed)
  const v = variation(rand)
  const out = silence(p.lengthMs)
  addPartial(out, between(rand, p.baseFreqMin, p.baseFreqMax) * v.pitch, p.decayMs * v.decay, 1)
  addPartial(out, between(rand, p.bodyFreqMin, p.bodyFreqMax) * v.pitch, p.bodyDecayMs * v.decay, p.bodyLevel)
  addNoiseBurst(out, rand, 2000, 5000, 2, 1.2, p.noiseLevel)
  if (s > 0.6) addPartial(out, 2400 * v.pitch, 8 * v.decay, 0.3)
  return finish(out, p.lowpassBase + p.lowpassRange * s)
}

/** A cushion: a soft rubber thump, muffled when the ball arrives gently. */
function renderCushion(p: RecipeParams, s: number, seed: number): Float32Array {
  const rand = mulberry32(seed)
  const v = variation(rand)
  const out = silence(p.lengthMs)
  const from = between(rand, p.baseFreqMin, p.baseFreqMax) * v.pitch
  const to = between(rand, p.bodyFreqMin, p.bodyFreqMax) * v.pitch
  addSweep(out, from, to, p.bodyDecayMs, p.decayMs * v.decay, p.bodyLevel)
  addNoiseBurst(out, rand, 600, 1800, 80, 25 * v.decay, p.noiseLevel)
  if (s > 0.5) addNoiseBurst(out, rand, 3200, 4800, 2, 1, 0.25 * s)
  return finish(out, p.lowpassBase + p.lowpassRange * s)
}

/** The jaw of a pocket: the ball click, duller, on leather. */
function renderJaw(p: RecipeParams, seed: number): Float32Array {
  const rand = mulberry32(seed)
  const v = variation(rand)
  const out = silence(p.lengthMs)
  const f1 = between(rand, p.baseFreqMin, p.baseFreqMax) * v.pitch
  addPartial(out, f1, p.decayMs * v.decay, 1)
  addPartial(out, f1 * 1.58, p.decayMs * 0.64 * v.decay, 0.5)
  addPartial(out, between(rand, p.bodyFreqMin, p.bodyFreqMax), p.bodyDecayMs * v.decay, p.bodyLevel)
  addNoiseBurst(out, rand, 1500, 4000, 2, 1.2, p.noiseLevel)
  return finish(out, p.lowpassBase)
}

/** The ball going down: a low thud falling in pitch, with the rush of the pocket round it. */
function renderDrop(p: RecipeParams, seed: number): Float32Array {
  const rand = mulberry32(seed)
  const v = variation(rand)
  const out = silence(p.lengthMs)
  const from = between(rand, p.baseFreqMin, p.baseFreqMax) * v.pitch
  const to = between(rand, p.bodyFreqMin, p.bodyFreqMax) * v.pitch
  addSweep(out, from, to, 110, p.decayMs * v.decay, p.bodyLevel)
  addNoiseBurst(out, rand, 400, 1200, p.bodyDecayMs * 2, (p.bodyDecayMs / 3) * v.decay, p.noiseLevel)
  return finish(out, p.lowpassBase)
}

/** The net: three to five tiny ticks, unevenly spaced, each quieter than the last. */
function renderNet(p: RecipeParams, seed: number): Float32Array {
  const rand = mulberry32(seed)
  const out = silence(p.lengthMs)
  const ticks = 3 + Math.floor(rand() * 3)
  let at = 0
  let level = p.noiseLevel
  for (let i = 0; i < ticks; i++) {
    addNoiseBurst(out, rand, p.baseFreqMin, p.baseFreqMax, 3, Math.max(0.6, p.decayMs / 3), level, at)
    at += between(rand, p.bodyFreqMin, p.bodyFreqMax)
    level *= 0.68
  }
  return finish(out, p.lowpassBase)
}

/** The quiet ticks for the interface and the small moments of a frame. */
function renderAux(type: AuxSound, seed: number): Float32Array {
  const rand = mulberry32(seed)
  if (type === 'foul') {
    // Two low notes, the second a third below the first. A sigh, not a buzzer.
    const out = silence(420)
    addPartial(out, 330, 90, 1)
    addPartial(out, 660, 50, 0.12)
    const second = silence(240)
    addPartial(second, 262, 110, 0.9)
    addPartial(second, 524, 60, 0.1)
    const offset = Math.round(0.17 * SAMPLE_RATE)
    for (let i = 0; i < second.length && offset + i < out.length; i++) out[offset + i] = out[offset + i]! + second[i]!
    return finish(out, 2200)
  }
  if (type === 'chalk') {
    const out = silence(80)
    addNoiseBurst(out, rand, 2000, 6000, 70, 22, 1)
    return finish(out, 7000)
  }
  const shape: Record<Exclude<AuxSound, 'foul' | 'chalk'>, { hz: number; tau: number; ms: number; noise: number; lowpass: number }> = {
    uiClick: { hz: 1700, tau: 7, ms: 45, noise: 0.3, lowpass: 5000 },
    uiHover: { hz: 2300, tau: 4, ms: 30, noise: 0.15, lowpass: 6000 },
    placeTick: { hz: 880, tau: 14, ms: 70, noise: 0.25, lowpass: 3500 },
    turnTick: { hz: 1180, tau: 20, ms: 80, noise: 0.1, lowpass: 4000 }
  }
  const a = shape[type]
  const out = silence(a.ms)
  addPartial(out, a.hz, a.tau, 1)
  addPartial(out, a.hz * 0.5, a.tau * 1.4, 0.3)
  addNoiseBurst(out, rand, 2000, 6000, 2, 1, a.noise)
  return finish(out, a.lowpass)
}

/** Renders one layered sound at one strength. */
export function renderLayered(type: LayeredSound, layer: Layer, variant: number, config: SfxConfig = SFX_CONFIG): Float32Array {
  const p = config.recipes[type]
  const s = config.layerStrength[layer]
  const seed = seedFor(type, layer, variant)
  if (type === 'ball') return renderBall(p, s, seed)
  if (type === 'cue') return renderCue(p, s, seed)
  return renderCushion(p, s, seed)
}

/** Renders one of the pocket's three sounds. */
export function renderFlat(type: FlatSound, variant: number, config: SfxConfig = SFX_CONFIG): Float32Array {
  const p = config.recipes[type]
  const seed = seedFor(type, 'one', variant)
  if (type === 'jaw') return renderJaw(p, seed)
  if (type === 'drop') return renderDrop(p, seed)
  return renderNet(p, seed)
}

export function renderAuxSound(type: AuxSound): Float32Array {
  return renderAux(type, seedFor(type, 'one', 0))
}

/** The rolling loop: pink noise, with its ends blended so it repeats without a seam. */
export function renderRollingLoop(config: SfxConfig = SFX_CONFIG): Float32Array {
  const ms = config.rolling.loopSeconds * 1000 + 250
  const loop = crossfadeLoop(pinkNoise(ms, mulberry32(0x5f0c1e)), 250)
  return normalise(loop, BUFFER_PEAK)
}

export const ROLLING_KEY = 'rolling:loop:0'
export const AUX_SOUNDS: readonly AuxSound[] = ['uiClick', 'uiHover', 'placeTick', 'turnTick', 'chalk', 'foul']
export const FLAT_SOUNDS: readonly FlatSound[] = ['jaw', 'drop', 'net']
export const LAYERED_SOUNDS: readonly LayeredSound[] = ['ball', 'cue', 'cushion']

export interface RenderJob {
  key: string
  render: () => Float32Array
}

/**
 * Everything there is to render for a tier, as a list of small jobs.
 *
 * A list rather than one big function so the caller can do one, yield, and do the next:
 * the whole set takes a noticeable fraction of a second and must never be done in one go
 * while the lobby or the loading screen is on screen.
 */
export function renderJobs(tier: SfxTier, config: SfxConfig = SFX_CONFIG, only?: SoundType): RenderJob[] {
  const variants = config.tiers[tier].variants
  const jobs: RenderJob[] = []
  for (const type of LAYERED_SOUNDS) {
    if (only && only !== type) continue
    for (const layer of LAYERS) {
      for (let v = 0; v < variants; v++) {
        jobs.push({ key: bufferKey(type, layer, v), render: () => renderLayered(type, layer, v, config) })
      }
    }
  }
  for (const type of FLAT_SOUNDS) {
    if (only && only !== type) continue
    for (let v = 0; v < variants; v++) {
      jobs.push({ key: bufferKey(type, 'one', v), render: () => renderFlat(type, v, config) })
    }
  }
  for (const type of AUX_SOUNDS) {
    if (only && only !== type) continue
    jobs.push({ key: bufferKey(type, 'one', 0), render: () => renderAuxSound(type) })
  }
  if (!only) jobs.push({ key: ROLLING_KEY, render: () => renderRollingLoop(config) })
  return jobs
}
