/**
 * Sample synthesis, in plain TypeScript.
 *
 * Nothing here touches the DOM or Web Audio: every function takes numbers and returns or
 * fills a `Float32Array`. That is what lets the sounds be rendered off the game loop, in
 * idle time, and tested in Node. Everything random comes from a seeded generator, so the
 * same seed always renders the same samples.
 */

export const SAMPLE_RATE = 44100

/** A small, fast, seedable generator. Returns numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A number between `low` and `high`, drawn from `rand`. */
export function between(rand: () => number, low: number, high: number): number {
  return low + (high - low) * rand()
}

/** A silent buffer `ms` long. */
export function silence(ms: number, sampleRate = SAMPLE_RATE): Float32Array {
  return new Float32Array(Math.max(1, Math.round((ms / 1000) * sampleRate)))
}

/** How long the attack ramp on every partial is, in seconds: 0.2ms, enough to avoid a click. */
const ATTACK_SECONDS = 0.0002

/**
 * Adds a decaying sine to `out`: one mode of something that has been struck.
 *
 * @param tauMs the time constant of the decay: the partial is at 37% after this long.
 */
export function addPartial(
  out: Float32Array,
  freq: number,
  tauMs: number,
  amplitude: number,
  sampleRate = SAMPLE_RATE,
  phase = 0
): void {
  const tau = Math.max(0.0001, tauMs / 1000)
  const w = (2 * Math.PI * freq) / sampleRate
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate
    const attack = t < ATTACK_SECONDS ? t / ATTACK_SECONDS : 1
    out[i] = out[i]! + amplitude * attack * Math.exp(-t / tau) * Math.sin(w * i + phase)
  }
}

/** Adds a decaying sine whose pitch falls from `fromHz` to `toHz` over `sweepMs`. */
export function addSweep(
  out: Float32Array,
  fromHz: number,
  toHz: number,
  sweepMs: number,
  tauMs: number,
  amplitude: number,
  sampleRate = SAMPLE_RATE
): void {
  const tau = Math.max(0.0001, tauMs / 1000)
  const sweep = Math.max(0.0001, sweepMs / 1000)
  let phase = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate
    const k = Math.min(1, t / sweep)
    const freq = fromHz + (toHz - fromHz) * k
    phase += (2 * Math.PI * freq) / sampleRate
    const attack = t < ATTACK_SECONDS ? t / ATTACK_SECONDS : 1
    out[i] = out[i]! + amplitude * attack * Math.exp(-t / tau) * Math.sin(phase)
  }
}

/** White noise in [-1, 1], `ms` long. */
export function whiteNoise(ms: number, rand: () => number, sampleRate = SAMPLE_RATE): Float32Array {
  const out = silence(ms, sampleRate)
  for (let i = 0; i < out.length; i++) out[i] = rand() * 2 - 1
  return out
}

/** Pink noise (equal energy per octave), by Paul Kellet's filter. Roughly in [-1, 1]. */
export function pinkNoise(ms: number, rand: () => number, sampleRate = SAMPLE_RATE): Float32Array {
  const out = silence(ms, sampleRate)
  let b0 = 0
  let b1 = 0
  let b2 = 0
  let b3 = 0
  let b4 = 0
  let b5 = 0
  let b6 = 0
  for (let i = 0; i < out.length; i++) {
    const white = rand() * 2 - 1
    b0 = 0.99886 * b0 + white * 0.0555179
    b1 = 0.99332 * b1 + white * 0.0750759
    b2 = 0.969 * b2 + white * 0.153852
    b3 = 0.8665 * b3 + white * 0.3104856
    b4 = 0.55 * b4 + white * 0.5329522
    b5 = -0.7616 * b5 - white * 0.016898
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11
    b6 = white * 0.115926
  }
  return out
}

export type BiquadKind = 'lowpass' | 'highpass' | 'bandpass'

/**
 * Filters `data` in place with one biquad section, coefficients from the RBJ cookbook.
 * The band-pass is the constant-peak-gain form, so a band of noise keeps its level.
 */
export function biquad(data: Float32Array, kind: BiquadKind, freq: number, q = Math.SQRT1_2, sampleRate = SAMPLE_RATE): Float32Array {
  const f = Math.min(sampleRate * 0.49, Math.max(10, freq))
  const w0 = (2 * Math.PI * f) / sampleRate
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * Math.max(0.05, q))
  let b0: number
  let b1: number
  let b2: number
  if (kind === 'lowpass') {
    b0 = (1 - cos) / 2
    b1 = 1 - cos
    b2 = (1 - cos) / 2
  } else if (kind === 'highpass') {
    b0 = (1 + cos) / 2
    b1 = -(1 + cos)
    b2 = (1 + cos) / 2
  } else {
    b0 = alpha
    b1 = 0
    b2 = -alpha
  }
  const a0 = 1 + alpha
  const a1 = -2 * cos
  const a2 = 1 - alpha
  const n0 = b0 / a0
  const n1 = b1 / a0
  const n2 = b2 / a0
  const d1 = a1 / a0
  const d2 = a2 / a0
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < data.length; i++) {
    const x = data[i]!
    const y = n0 * x + n1 * x1 + n2 * x2 - d1 * y1 - d2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    data[i] = y
  }
  return data
}

/** Band-passes `data` in place between two edges, by their geometric centre and width. */
export function bandpass(data: Float32Array, lowHz: number, highHz: number, sampleRate = SAMPLE_RATE): Float32Array {
  const centre = Math.sqrt(lowHz * highHz)
  return biquad(data, 'bandpass', centre, centre / Math.max(1, highHz - lowHz), sampleRate)
}

/**
 * Adds a burst of band-passed noise to `out`, starting at `atMs`, lasting `ms`, falling
 * away with time constant `tauMs`.
 */
export function addNoiseBurst(
  out: Float32Array,
  rand: () => number,
  lowHz: number,
  highHz: number,
  ms: number,
  tauMs: number,
  amplitude: number,
  atMs = 0,
  sampleRate = SAMPLE_RATE
): void {
  const burst = bandpass(whiteNoise(ms, rand, sampleRate), lowHz, highHz, sampleRate)
  const start = Math.round((atMs / 1000) * sampleRate)
  const tau = Math.max(0.0001, tauMs / 1000)
  // The filtered burst's own level depends on how wide the band is, so it is brought to a
  // known peak first: `amplitude` then means the same thing for every band.
  let peak = 0
  for (let i = 0; i < burst.length; i++) peak = Math.max(peak, Math.abs(burst[i]!))
  const scale = peak > 0 ? amplitude / peak : 0
  for (let i = 0; i < burst.length && start + i < out.length; i++) {
    const t = i / sampleRate
    const attack = t < ATTACK_SECONDS ? t / ATTACK_SECONDS : 1
    out[start + i] = out[start + i]! + burst[i]! * scale * attack * Math.exp(-t / tau)
  }
}

/** The largest absolute sample. */
export function peakOf(data: Float32Array): number {
  let peak = 0
  for (let i = 0; i < data.length; i++) {
    const v = Math.abs(data[i]!)
    if (v > peak) peak = v
  }
  return peak
}

/** Scales `data` in place so its peak is exactly `peak`. A silent buffer is left silent. */
export function normalise(data: Float32Array, peak = 0.9): Float32Array {
  const current = peakOf(data)
  if (!(current > 0)) return data
  const k = peak / current
  for (let i = 0; i < data.length; i++) data[i] = data[i]! * k
  return data
}

/** Fades the last `ms` of `data` to zero, in place, so it never ends on a click. */
export function fadeOut(data: Float32Array, ms = 5, sampleRate = SAMPLE_RATE): Float32Array {
  const n = Math.min(data.length, Math.round((ms / 1000) * sampleRate))
  for (let i = 0; i < n; i++) {
    const index = data.length - n + i
    data[index] = data[index]! * (1 - (i + 1) / n)
  }
  return data
}

/**
 * Makes a buffer loop without a seam: the last `ms` is blended into the first `ms`, and
 * the result is that much shorter. Equal-power, so the join is no quieter than the rest.
 */
export function crossfadeLoop(data: Float32Array, ms = 250, sampleRate = SAMPLE_RATE): Float32Array {
  const n = Math.min(Math.floor(data.length / 2), Math.round((ms / 1000) * sampleRate))
  const out = new Float32Array(data.length - n)
  out.set(data.subarray(0, data.length - n))
  for (let i = 0; i < n; i++) {
    const k = i / n
    const tail = data[data.length - n + i]!
    out[i] = out[i]! * Math.sin((k * Math.PI) / 2) + tail * Math.cos((k * Math.PI) / 2)
  }
  return out
}

/** Whether every sample is a finite number. */
export function isFiniteBuffer(data: Float32Array): boolean {
  for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i]!)) return false
  return true
}
