let ctx: AudioContext | null = null
let muted = false
let master: GainNode | null = null

function ensure(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const AC = window.AudioContext
    if (!AC) return null
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = muted ? 0 : 0.5
    master.connect(ctx.destination)
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

export function unlockAudio(): void {
  ensure()
}

export function setSoundMuted(value: boolean): void {
  muted = value
  if (master && ctx) master.gain.setTargetAtTime(value ? 0 : 0.5, ctx.currentTime, 0.01)
}

export function isSoundMuted(): boolean {
  return muted
}

function blip(freq: number, duration: number, type: OscillatorType, level: number, when = 0): void {
  const c = ensure()
  if (!c || !master || muted) return
  const t0 = c.currentTime + when
  const osc = c.createOscillator()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t0)
  const gain = c.createGain()
  gain.gain.setValueAtTime(0.0001, t0)
  gain.gain.exponentialRampToValueAtTime(level, t0 + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)
  osc.connect(gain)
  gain.connect(master)
  osc.start(t0)
  osc.stop(t0 + duration + 0.05)
}

function thud(level: number, when = 0): void {
  const c = ensure()
  if (!c || !master || muted) return
  const t0 = c.currentTime + when
  const buffer = c.createBuffer(1, c.sampleRate * 0.14, c.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 3)
  }
  const src = c.createBufferSource()
  src.buffer = buffer
  const filter = c.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 900
  const gain = c.createGain()
  gain.gain.setValueAtTime(level, t0)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13)
  src.connect(filter)
  filter.connect(gain)
  gain.connect(master)
  src.start(t0)
}

export function playPot(batch: number): void {
  const n = Math.min(batch, 4)
  for (let i = 0; i < n; i++) {
    blip(320 + i * 60, 0.07, 'triangle', 0.16, i * 0.045)
  }
  thud(0.22)
}

export function playCushion(): void {
  blip(140, 0.05, 'square', 0.05)
}

export function playFoul(): void {
  blip(240, 0.22, 'sawtooth', 0.08)
  blip(170, 0.28, 'sawtooth', 0.06, 0.12)
}

export function playFrameEnd(): void {
  blip(523.25, 0.14, 'triangle', 0.14)
  blip(659.25, 0.16, 'triangle', 0.14, 0.1)
  blip(783.99, 0.24, 'triangle', 0.14, 0.2)
}

export function playMatchEnd(): void {
  blip(261.63, 0.16, 'triangle', 0.16)
  blip(329.63, 0.16, 'triangle', 0.16, 0.12)
  blip(392.0, 0.2, 'triangle', 0.16, 0.24)
  blip(523.25, 0.32, 'triangle', 0.16, 0.36)
}
/**
 * The context this module's sounds play on, for the procedural sound effects in `src/sfx/`
 * to share rather than make another. Same rules as every sound here: created on first
 * use, resumed if the browser had it suspended, null where there is no Web Audio.
 */
export function sharedAudioContext(): AudioContext | null {
  return ensure()
}

// Starts the procedural sound effects if their flag or `?sfxdebug=1` asks for them, and
// does nothing otherwise. Loaded on the side so that nothing in it can hold up, or break,
// the module the game's existing sounds live in.
if (typeof window !== 'undefined') void import('../sfx/boot.js').catch(() => undefined)
