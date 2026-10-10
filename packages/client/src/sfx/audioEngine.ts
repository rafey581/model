import { SAMPLE_RATE, biquad, mulberry32, normalise, silence } from './dsp.js'
import { SFX_CONFIG, dbToGain, type SfxConfig, type SfxTier } from './sfxConfig.js'

/**
 * The audio graph, and the only place a Web Audio node is made for the new sounds.
 *
 *   sfx bus ──┬──────────────┐
 *             └─ room (high) ┤
 *   rolling bus ─────────────┼─ mute ─ master ─ limiter ─ meter ─ out
 *   ui bus ──────────────────┘
 *
 * It does not own an `AudioContext`. It is handed the game's existing one through
 * `setContextProvider`, so there is still one context for the game's sounds and this
 * never makes another. Every entry point is wrapped: if Web Audio is missing, blocked,
 * suspended or throws, the call returns false and the game carries on in silence.
 */

export type BusName = 'sfx' | 'rolling' | 'ui'

export interface PlayRequest {
  /** The buffer to play, by its `bufferKey`. */
  key: string
  /** Output level in dB. The buffers share one peak, so this is close to the peak out. */
  gainDb: number
  /** Left to right, -1 to 1. */
  pan?: number
  bus?: BusName
  /** Start this long from now, in ms. For a sequence such as drop then net. */
  delayMs?: number
  /** Playback speed, and so pitch: 1 is as recorded. */
  rate?: number
  /** Play through a low-pass at this corner, in Hz. Left out, the sound is untouched. */
  lowpassHz?: number
}

/** What the gameplay code needs of the engine. Small, so a test can stand in for it. */
export interface SfxPlayer {
  play(request: PlayRequest): boolean
}

/** One sounding impact, as the voice pool remembers it. */
export interface VoiceInfo {
  gainDb: number
  startedAt: number
}

/**
 * Which voice to cut when the pool is full: the quietest, and among equals the oldest.
 * A quiet hit that is already ringing out is the one nobody will miss.
 */
export function chooseVictim(voices: readonly VoiceInfo[]): number {
  let victim = -1
  for (let i = 0; i < voices.length; i++) {
    if (victim < 0) {
      victim = i
      continue
    }
    const a = voices[i]!
    const b = voices[victim]!
    if (a.gainDb < b.gainDb || (a.gainDb === b.gainDb && a.startedAt < b.startedAt)) victim = i
  }
  return victim
}

interface Voice extends VoiceInfo {
  source: AudioBufferSourceNode
  gain: GainNode
  panner: StereoPannerNode | null
  filter: BiquadFilterNode | null
}

export interface AudioEngine extends SfxPlayer {
  /** Where the context comes from. Asked lazily, so nothing is created before a gesture. */
  setContextProvider(provider: () => AudioContext | null): void
  /** Where the mute state comes from: the game's existing setting. */
  setMuteSource(isMuted: () => boolean): void
  /** Hands over rendered samples. Wrapped into an `AudioBuffer` once there is a context. */
  store(key: string, samples: Float32Array): void
  has(key: string): boolean
  /** The context and a bus, for the rolling voices to build their own chain on. Null until ready. */
  graph(): { context: AudioContext; bus: (name: BusName) => AudioNode; buffer: (key: string) => AudioBuffer | null } | null
  /** Re-reads the mute state. Called on every play, and by anything that runs on a timer. */
  syncMute(): void
  setBusDb(name: BusName, db: number): void
  setMasterDb(db: number): void
  /** The current peak on the master, in dBFS, or -Infinity. For the debug meter. */
  peakDb(): number
  activeVoices(): number
  /** Whether a sound asked for now would actually be heard. */
  audible(): boolean
  dispose(): void
}

/** A short room: decaying noise, rolled off, generated rather than loaded. */
function impulseResponse(context: AudioContext, config: SfxConfig): AudioBuffer {
  const rate = context.sampleRate
  const data = silence(config.room.seconds * 1000, rate)
  const rand = mulberry32(0x7007)
  const tau = config.room.seconds / 5
  for (let i = 0; i < data.length; i++) data[i] = (rand() * 2 - 1) * Math.exp(-i / rate / tau)
  biquad(data, 'lowpass', config.room.lowpassHz, Math.SQRT1_2, rate)
  normalise(data, 0.5)
  const buffer = context.createBuffer(1, data.length, rate)
  buffer.copyToChannel(data as Float32Array<ArrayBuffer>, 0)
  return buffer
}

export function createAudioEngine(tier: SfxTier, config: SfxConfig = SFX_CONFIG): AudioEngine {
  let provider: () => AudioContext | null = () => null
  let isMuted: () => boolean = () => false
  let context: AudioContext | null = null
  let buses: Record<BusName, GainNode> | null = null
  let mute: GainNode | null = null
  let master: GainNode | null = null
  let analyser: AnalyserNode | null = null
  let meter: Float32Array<ArrayBuffer> | null = null
  let mutedNow: boolean | null = null
  let disposed = false
  const pending = new Map<string, Float32Array>()
  const buffers = new Map<string, AudioBuffer>()
  const voices: Voice[] = []
  const maxVoices = config.tiers[tier].impactVoices
  const busDb: Record<BusName, number> = { ...config.busDb }
  let masterDb = config.masterDb

  const wrap = (key: string, samples: Float32Array): void => {
    if (!context) return
    const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE)
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0)
    buffers.set(key, buffer)
  }

  /** Builds the graph the first time there is a context to build it on. */
  const ensure = (): AudioContext | null => {
    if (disposed) return null
    if (context) return context
    try {
      const next = provider()
      if (!next) return null
      context = next
      master = context.createGain()
      master.gain.value = dbToGain(masterDb)
      const limiter = context.createDynamicsCompressor()
      limiter.threshold.value = config.limiter.thresholdDb
      limiter.knee.value = config.limiter.knee
      limiter.ratio.value = config.limiter.ratio
      limiter.attack.value = config.limiter.attackMs / 1000
      limiter.release.value = config.limiter.releaseMs / 1000
      analyser = context.createAnalyser()
      analyser.fftSize = 1024
      meter = new Float32Array(analyser.fftSize)
      mute = context.createGain()
      mute.connect(master)
      master.connect(limiter)
      limiter.connect(analyser)
      analyser.connect(context.destination)
      const make = (name: BusName): GainNode => {
        const node = context!.createGain()
        node.gain.value = dbToGain(busDb[name])
        node.connect(mute!)
        return node
      }
      buses = { sfx: make('sfx'), rolling: make('rolling'), ui: make('ui') }
      if (config.tiers[tier].room) {
        const send = context.createGain()
        send.gain.value = config.room.wet
        const room = context.createConvolver()
        room.buffer = impulseResponse(context, config)
        buses.sfx.connect(send)
        send.connect(room)
        room.connect(mute)
      }
      for (const [key, samples] of pending) wrap(key, samples)
      pending.clear()
      mutedNow = null
      return context
    } catch {
      context = null
      buses = null
      return null
    }
  }

  const syncMute = (): void => {
    try {
      if (!context || !mute) return
      const muted = isMuted()
      if (muted === mutedNow) return
      mutedNow = muted
      mute.gain.setTargetAtTime(muted ? 0 : 1, context.currentTime, 0.01)
    } catch {
      // The mute could not be read or written. Nothing else depends on it.
    }
  }

  const release = (voice: Voice): void => {
    const index = voices.indexOf(voice)
    if (index >= 0) voices.splice(index, 1)
    try {
      voice.source.disconnect()
      voice.filter?.disconnect()
      voice.gain.disconnect()
      voice.panner?.disconnect()
    } catch {
      // Already gone.
    }
  }

  const onVisibility = (): void => {
    try {
      if (!context) return
      // Hidden: the context is stopped, so nothing queues up to burst out on return.
      if (document.hidden) void context.suspend()
      else void context.resume()
    } catch {
      // Suspend and resume are best effort.
    }
  }
  const onGesture = (): void => {
    try {
      const c = ensure()
      if (c && c.state !== 'running' && !document.hidden) void c.resume()
    } catch {
      // No audio. The game is unaffected.
    }
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
    document.addEventListener('pointerdown', onGesture, { passive: true })
    document.addEventListener('keydown', onGesture, { passive: true })
  }

  return {
    setContextProvider(next): void {
      provider = next
    },
    setMuteSource(source): void {
      isMuted = source
      mutedNow = null
    },
    store(key, samples): void {
      try {
        if (context) wrap(key, samples)
        else pending.set(key, samples)
      } catch {
        // A buffer that cannot be made is a sound that is skipped.
      }
    },
    has(key): boolean {
      return buffers.has(key) || pending.has(key)
    },
    graph() {
      const c = ensure()
      if (!c || !buses) return null
      const all = buses
      return { context: c, bus: (name) => all[name], buffer: (key) => buffers.get(key) ?? null }
    },
    syncMute,
    setBusDb(name, db): void {
      busDb[name] = db
      try {
        if (context && buses) buses[name].gain.setTargetAtTime(dbToGain(db), context.currentTime, 0.02)
      } catch {
        // Kept for when the graph exists.
      }
    },
    setMasterDb(db): void {
      masterDb = db
      try {
        if (context && master) master.gain.setTargetAtTime(dbToGain(db), context.currentTime, 0.02)
      } catch {
        // Kept for when the graph exists.
      }
    },
    peakDb(): number {
      try {
        if (!analyser || !meter) return -Infinity
        analyser.getFloatTimeDomainData(meter)
        let peak = 0
        for (let i = 0; i < meter.length; i++) peak = Math.max(peak, Math.abs(meter[i]!))
        return peak > 0 ? 20 * Math.log10(peak) : -Infinity
      } catch {
        return -Infinity
      }
    },
    activeVoices(): number {
      return voices.length
    },
    audible(): boolean {
      return context !== null && context.state === 'running' && !isMuted()
    },
    play(request): boolean {
      try {
        const c = ensure()
        if (!c || !buses) return false
        syncMute()
        // Not running: suspended by the browser, or the tab is hidden. The sound is
        // dropped, never queued — a sound that arrives late is worse than none.
        if (c.state !== 'running') return false
        const buffer = buffers.get(request.key)
        if (!buffer) return false
        if (voices.length >= maxVoices) {
          const victim = voices[chooseVictim(voices)]
          if (victim) {
            try {
              victim.source.stop()
            } catch {
              // Already stopped.
            }
            release(victim)
          }
        }
        const source = c.createBufferSource()
        source.buffer = buffer
        if (request.rate && request.rate > 0) source.playbackRate.value = Math.max(0.5, Math.min(2, request.rate))
        const gain = c.createGain()
        gain.gain.value = dbToGain(request.gainDb)
        // The low-pass, when asked for, sits straight after the source.
        let filter: BiquadFilterNode | null = null
        let head: AudioNode = source
        if (request.lowpassHz && request.lowpassHz < c.sampleRate * 0.45) {
          filter = c.createBiquadFilter()
          filter.type = 'lowpass'
          filter.frequency.value = Math.max(200, request.lowpassHz)
          filter.Q.value = 0.5
          source.connect(filter)
          head = filter
        }
        let panner: StereoPannerNode | null = null
        if (request.pan && typeof c.createStereoPanner === 'function') {
          panner = c.createStereoPanner()
          panner.pan.value = Math.max(-1, Math.min(1, request.pan))
          head.connect(gain)
          gain.connect(panner)
          panner.connect(buses[request.bus ?? 'sfx'])
        } else {
          head.connect(gain)
          gain.connect(buses[request.bus ?? 'sfx'])
        }
        const voice: Voice = { source, gain, panner, filter, gainDb: request.gainDb, startedAt: c.currentTime }
        voices.push(voice)
        source.onended = () => release(voice)
        source.start(c.currentTime + Math.max(0, request.delayMs ?? 0) / 1000)
        return true
      } catch {
        return false
      }
    },
    dispose(): void {
      disposed = true
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
        document.removeEventListener('pointerdown', onGesture)
        document.removeEventListener('keydown', onGesture)
      }
      for (const voice of [...voices]) {
        try {
          voice.source.stop()
        } catch {
          // Already stopped.
        }
        release(voice)
      }
      try {
        if (buses) for (const bus of Object.values(buses)) bus.disconnect()
        mute?.disconnect()
        master?.disconnect()
        analyser?.disconnect()
      } catch {
        // Nothing left to disconnect.
      }
      // The context is the game's, not this module's, so it is left open.
      context = null
      buses = null
      buffers.clear()
      pending.clear()
    }
  }
}
