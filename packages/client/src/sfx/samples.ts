import { SAMPLE_RATE, crossfadeLoop, fadeOut, normalise, peakOf } from './dsp.js'
import { BUFFER_PEAK, ROLLING_KEY, bufferKey } from './recipes.js'
import { LAYERS, type Layer, type SoundType } from './sfxConfig.js'

/**
 * Real recordings, in place of the generated sounds.
 *
 * A generated click is a model of a click, and it sounds like one. This lets recorded
 * audio take over: put the files in `public/audio/sfx/`, list them in `manifest.json`
 * there, and each one replaces the generated buffer of the same name. Everything else is
 * unchanged — when a sound plays, how loud, which strength, the burst rule — because all
 * of that works on buffer names and never knew where the samples came from.
 *
 * Nothing is required. With no manifest the generated sounds are used, and a sound the
 * manifest does not list keeps its generated version, so a partial set works.
 *
 * The files are ordinary audio (WAV, OGG, MP3 — whatever the browser decodes), but they
 * are best given an extension that is not an audio one, such as `.sfx`. Download-manager
 * browser extensions watch every request for names ending in `.wav` or `.mp3` and offer to
 * download them, which to a player is a queue of download prompts every time the game
 * loads. The decoder reads the bytes and does not care what the file is called.
 *
 * `manifest.json` maps a sound, or a sound at one strength, to a list of files:
 *
 *   {
 *     "ball:soft":   ["ball_soft_1.sfx", "ball_soft_2.sfx"],
 *     "ball:medium": ["ball_medium_1.sfx"],
 *     "ball:hard":   ["ball_hard_1.sfx", "ball_hard_2.sfx"],
 *     "cue":         ["cue_1.sfx", "cue_2.sfx"],
 *     "cushion":     ["cushion_1.sfx"],
 *     "drop":        ["pocket_1.sfx"],
 *     "rolling":     ["roll_loop.sfx"]
 *   }
 *
 * A sound given without a strength ("cue") is used for all three: the loudness still
 * follows the speed of the hit. Sounds: ball, cue, cushion (each optionally `:soft`,
 * `:medium`, `:hard`), jaw, drop, net, rolling, and uiClick, uiHover, placeTick,
 * turnTick, chalk, foul.
 */

export const SAMPLE_FOLDER = '/audio/sfx/'
export const SAMPLE_MANIFEST = `${SAMPLE_FOLDER}manifest.json`

export type SampleManifest = Record<string, string[]>

const LAYERED = new Set<string>(['ball', 'cue', 'cushion'])
const FLAT = new Set<string>(['jaw', 'drop', 'net', 'uiClick', 'uiHover', 'placeTick', 'turnTick', 'chalk', 'foul'])

/** Longest an impact recording is kept, in seconds. A tail longer than this is room, not ball. */
const MAX_IMPACT_SECONDS = 1.2
/** Below this, against the recording's own peak, the start of a file is treated as silence. */
const TRIM_THRESHOLD = 0.02

/**
 * Which buffer names each listed file fills.
 *
 * The game asks for a fixed number of variants per sound, decided by the quality tier.
 * However many files there are, they are dealt round those slots in turn: two recordings
 * and four slots is each recording twice, one recording is the same one in every slot.
 */
export function planSamples(manifest: SampleManifest, variants: number): Array<{ key: string; file: string; loop: boolean }> {
  const plan: Array<{ key: string; file: string; loop: boolean }> = []
  const deal = (type: SoundType, layer: Layer | 'one', files: string[], slots: number): void => {
    if (!files.length) return
    for (let v = 0; v < slots; v++) plan.push({ key: bufferKey(type, layer, v), file: files[v % files.length]!, loop: false })
  }
  for (const [name, files] of Object.entries(manifest)) {
    if (!Array.isArray(files)) continue
    const usable = files.filter((file) => typeof file === 'string' && /^[\w.-]+$/.test(file))
    const [type, layer] = name.split(':')
    if (type === 'rolling') {
      if (usable[0]) plan.push({ key: ROLLING_KEY, file: usable[0], loop: true })
    } else if (type && LAYERED.has(type)) {
      const layers = layer ? LAYERS.filter((l) => l === layer) : LAYERS
      // A strength named on its own wins over the same sound listed for all strengths.
      for (const l of layers) {
        if (!layer && manifest[`${type}:${l}`]?.length) continue
        deal(type as SoundType, l, usable, variants)
      }
    } else if (type && FLAT.has(type)) {
      const aux = !['jaw', 'drop', 'net'].includes(type)
      deal(type as SoundType, 'one', usable, aux ? 1 : variants)
    }
  }
  return plan
}

/**
 * Makes a recording fit where a generated buffer was: starts on the sound, not on the
 * silence before it; no longer than an impact needs to be; the same peak as every other
 * buffer, so the loudness set at play time means the same thing; and a faded end.
 */
export function prepareSample(input: Float32Array, loop: boolean, sampleRate = SAMPLE_RATE): Float32Array {
  const peak = peakOf(input)
  if (!(peak > 0)) return new Float32Array(1)
  if (loop) return normalise(crossfadeLoop(Float32Array.from(input), 250, sampleRate), BUFFER_PEAK)
  let start = 0
  while (start < input.length && Math.abs(input[start]!) < peak * TRIM_THRESHOLD) start++
  // A few samples of lead-in, so the attack is not cut into.
  start = Math.max(0, start - Math.round(sampleRate * 0.0005))
  const end = Math.min(input.length, start + Math.round(sampleRate * MAX_IMPACT_SECONDS))
  const out = Float32Array.from(input.subarray(start, end))
  normalise(out, BUFFER_PEAK)
  return fadeOut(out, end < input.length ? 40 : 5, sampleRate)
}

/** Folds a decoded file down to one channel. */
function toMono(buffer: AudioBuffer): Float32Array {
  const out = new Float32Array(buffer.length)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < out.length; i++) out[i] = out[i]! + data[i]! / buffer.numberOfChannels
  }
  return out
}

/**
 * Loads whatever recordings the manifest lists and hands each to `store`.
 *
 * Resolves to how many buffers were replaced. Never rejects: no manifest, a missing file
 * or a file that will not decode each just leave the generated sound where it was.
 */
export async function loadRecordedSamples(variants: number, store: (key: string, samples: Float32Array) => void): Promise<number> {
  try {
    if (typeof fetch !== 'function' || typeof OfflineAudioContext !== 'function') return 0
    const response = await fetch(SAMPLE_MANIFEST, { cache: 'no-cache' })
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) return 0
    const manifest = (await response.json()) as SampleManifest
    const plan = planSamples(manifest, variants)
    // An offline context decodes without waiting for a user gesture, and resamples every
    // file to the one rate the buffers are kept at.
    const decoder = new OfflineAudioContext(1, 1, SAMPLE_RATE)
    const decoded = new Map<string, Float32Array>()
    let replaced = 0
    for (const item of plan) {
      try {
        const name = `${item.file}|${item.loop}`
        let samples = decoded.get(name)
        if (!samples) {
          const file = await fetch(SAMPLE_FOLDER + item.file)
          if (!file.ok) continue
          const audio = await decoder.decodeAudioData(await file.arrayBuffer())
          samples = prepareSample(toMono(audio), item.loop)
          decoded.set(name, samples)
        }
        store(item.key, samples)
        replaced++
      } catch {
        // This one file could not be used. Its generated sound stays.
      }
    }
    return replaced
  } catch {
    return 0
  }
}
