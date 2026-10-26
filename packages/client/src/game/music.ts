import { sharedAudioContext, unlockAudio } from './audio.js'

/**
 * Slow background music, generated in the browser.
 *
 * There are no audio files. Each track is the same calm pentatonic phrase played
 * with a different oscillator and filter, so the APK stays small and nothing is
 * sampled from a recording. See CREDITS.md.
 */

export const MUSIC_TRACKS = ['piano', 'guitar', 'violin', 'flute', 'mix'] as const
export type MusicTrack = (typeof MUSIC_TRACKS)[number]
type Timbre = Exclude<MusicTrack, 'mix'>

const ON_KEY = 'snooker.music'
const VOL_KEY = 'snooker.music.volume'
const TRACK_KEY = 'snooker.music.track'
const DEFAULT_VOLUME = 0.3
/** How much of the slider becomes audible gain. Even 100% stays in the background. */
const GAIN_CEILING = 0.28
const DUCK = 0.22
const BEAT_SECONDS = 1.35
const PATTERN = [0, 2, 4, 2, 3, 1, 4, 0]
const STEPS = [0, 3, 5, 7, 10]
const TIMBRES: Timbre[] = ['piano', 'guitar', 'violin', 'flute']

export function phraseLength(): number {
  return PATTERN.length
}

const memoryStore = new Map<string, string>()

function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  try {
    if (globalThis.localStorage) return globalThis.localStorage
  } catch {
    /* private mode or a test runner without storage */
  }
  return {
    getItem: (key) => memoryStore.get(key) ?? null,
    setItem: (key, value) => {
      memoryStore.set(key, value)
    },
    removeItem: (key) => {
      memoryStore.delete(key)
    }
  }
}

export function musicEnabled(): boolean {
  return storage()?.getItem(ON_KEY) !== '0'
}

export function musicVolume(): number {
  const raw = storage()?.getItem(VOL_KEY)
  if (raw == null) return DEFAULT_VOLUME
  const n = Number(raw)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_VOLUME
}

export function musicTrack(): MusicTrack {
  const raw = storage()?.getItem(TRACK_KEY)
  return (MUSIC_TRACKS as readonly string[]).includes(raw ?? '') ? (raw as MusicTrack) : 'piano'
}

/** A3 pentatonic, one note of the looping phrase. Kept in a speaking range. */
export function noteFrequency(index: number): number {
  const degree = PATTERN[index % PATTERN.length] ?? 0
  const semi = STEPS[degree] ?? 0
  return 220 * 2 ** (semi / 12)
}

export function timbreFor(track: MusicTrack, step: number): Timbre {
  if (track !== 'mix') return track
  return TIMBRES[Math.floor(step / PATTERN.length) % TIMBRES.length] ?? 'piano'
}

let armed = false
let running = false
let ducked = false
let nextAt = 0
let stepIndex = 0
let bus: GainNode | null = null
let timer: ReturnType<typeof setInterval> | undefined

function audibleGain(): number {
  if (!running || !musicEnabled()) return 0
  const level = musicVolume() * GAIN_CEILING
  return ducked ? level * DUCK : level
}

function applyGain(): void {
  if (!bus) return
  bus.gain.setTargetAtTime(audibleGain(), bus.context.currentTime, 0.12)
}

function scheduleNote(ctx: BaseAudioContext, when: number, frequency: number, timbre: Timbre): void {
  if (!bus) return
  const osc = ctx.createOscillator()
  const filter = ctx.createBiquadFilter()
  const env = ctx.createGain()
  filter.type = 'lowpass'
  let attack = 0.02
  let release = 1.35
  let peak = 0.2
  let cutoff = 1800
  osc.type = 'sine'
  if (timbre === 'piano') {
    attack = 0.01
    release = 1.55
    peak = 0.22
    cutoff = 2400
  } else if (timbre === 'guitar') {
    osc.type = 'triangle'
    attack = 0.006
    release = 1.05
    peak = 0.16
    cutoff = 1100
  } else if (timbre === 'violin') {
    osc.type = 'sawtooth'
    attack = 0.2
    release = 1.4
    peak = 0.06
    cutoff = 880
  } else {
    attack = 0.14
    release = 1.25
    peak = 0.14
    cutoff = 1500
  }
  osc.frequency.setValueAtTime(frequency, when)
  if (timbre === 'violin' || timbre === 'flute') {
    const vibrato = ctx.createOscillator()
    const depth = ctx.createGain()
    vibrato.frequency.value = timbre === 'flute' ? 4.4 : 5
    depth.gain.value = frequency * 0.007
    vibrato.connect(depth)
    depth.connect(osc.frequency)
    vibrato.start(when)
    vibrato.stop(when + attack + release)
  }
  filter.frequency.setValueAtTime(cutoff, when)
  env.gain.setValueAtTime(0.0001, when)
  env.gain.exponentialRampToValueAtTime(peak, when + Math.max(0.01, attack))
  env.gain.exponentialRampToValueAtTime(0.0001, when + attack + release)
  osc.connect(filter)
  filter.connect(env)
  env.connect(bus)
  osc.start(when)
  osc.stop(when + attack + release + 0.05)
}

function pump(): void {
  if (!running || !bus) return
  const ctx = bus.context
  const track = musicTrack()
  while (nextAt < ctx.currentTime + 0.6) {
    scheduleNote(ctx, nextAt, noteFrequency(stepIndex), timbreFor(track, stepIndex))
    stepIndex += 1
    nextAt += BEAT_SECONDS
  }
}

function begin(): void {
  if (typeof document !== 'undefined' && document.hidden) return
  unlockAudio()
  const ctx = sharedAudioContext()
  if (!ctx) return
  if (!bus) {
    bus = ctx.createGain()
    bus.gain.value = 0
    bus.connect(ctx.destination)
  }
  if (!running) {
    running = true
    nextAt = Math.max(nextAt, ctx.currentTime + 0.12)
  }
  applyGain()
  if (timer === undefined) timer = setInterval(pump, 200)
  pump()
}

function halt(): void {
  running = false
  if (timer !== undefined) {
    clearInterval(timer)
    timer = undefined
  }
  if (bus) bus.gain.setTargetAtTime(0, bus.context.currentTime, 0.08)
}

export function armMusic(): void {
  armed = true
  if (musicEnabled()) begin()
}

export function setMusicEnabled(on: boolean): void {
  storage()?.setItem(ON_KEY, on ? '1' : '0')
  armed = true
  if (on) begin()
  else halt()
}

export function setMusicVolume(volume: number): void {
  const next = Math.min(1, Math.max(0, volume))
  storage()?.setItem(VOL_KEY, String(next))
  if (running) applyGain()
}

export function setMusicTrack(track: MusicTrack): void {
  if (!(MUSIC_TRACKS as readonly string[]).includes(track)) return
  storage()?.setItem(TRACK_KEY, track)
}

/** Lower the bed while balls are moving. The phrase keeps going. */
export function setMusicDucked(on: boolean): void {
  if (ducked === on) return
  ducked = on
  if (running) applyGain()
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      halt()
      return
    }
    if (armed && musicEnabled()) begin()
  })
}
