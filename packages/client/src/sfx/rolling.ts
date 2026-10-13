import type { AudioEngine } from './audioEngine.js'
import { ROLLING_KEY } from './recipes.js'
import { SFX_CONFIG, dbToGain, type SfxConfig, type SfxTier } from './sfxConfig.js'

/**
 * The sound of balls running on the cloth.
 *
 * A handful of looping voices, made once and never again: filtered pink noise over a
 * faint low rumble. They are not one per ball. Twenty times a second the voices are
 * aimed at whichever balls are moving fastest, and their pitch and level are slid to
 * match, so a whole break is two or three voices and no node is created or destroyed
 * while anything is rolling.
 */

export interface RollingBall {
  id: number
  /** Speed as a fraction of the fastest a ball can be sent. */
  speedNorm: number
  /** Left to right, -1 to 1. */
  pan: number
}

/**
 * Which ball each voice should follow.
 *
 * The fastest balls get the voices. A ball that already has one keeps it for as long as
 * it is still among the fastest, so a voice does not hop from ball to ball every update
 * and its filter does not swing about; only a voice whose ball has stopped, slowed out of
 * the running or gone down is handed to somebody new.
 */
export function assignRollingVoices(
  previous: ReadonlyArray<number | null>,
  balls: ReadonlyArray<RollingBall>,
  silentBelow: number
): Array<RollingBall | null> {
  const moving = balls.filter((ball) => ball.speedNorm >= silentBelow).sort((a, b) => b.speedNorm - a.speedNorm)
  const chosen = moving.slice(0, previous.length)
  const byId = new Map(chosen.map((ball) => [ball.id, ball]))
  const out: Array<RollingBall | null> = previous.map((id) => (id !== null ? (byId.get(id) ?? null) : null))
  const placed = new Set(out.filter((ball): ball is RollingBall => ball !== null).map((ball) => ball.id))
  for (const ball of chosen) {
    if (placed.has(ball.id)) continue
    const free = out.indexOf(null)
    if (free < 0) break
    out[free] = ball
    placed.add(ball.id)
  }
  return out
}

/** What one voice should sound like for a ball at a speed. Pure, so it can be tested. */
export function rollingVoiceTarget(
  speedNorm: number,
  config: SfxConfig = SFX_CONFIG
): { gain: number; bandHz: number; rate: number } {
  const r = config.rolling
  if (speedNorm < r.silentBelow) return { gain: 0, bandHz: r.bandBaseHz, rate: r.rateMin }
  const k = Math.max(0, Math.min(1, speedNorm / r.fullAt))
  return {
    gain: Math.pow(k, r.gainExponent),
    bandHz: r.bandBaseHz + r.bandRangeHz * Math.pow(k, r.bandExponent),
    rate: r.rateMin + (r.rateMax - r.rateMin) * k
  }
}

/**
 * Works out how fast each ball is going from where it was drawn last time.
 *
 * Only used when nothing hands the sounds a speed. It keeps its own copy of the last
 * positions and never writes to anything it was given.
 */
export class SpeedTracker {
  private readonly last = new Map<number, { x: number; z: number }>()
  private lastAt = 0

  /** Speeds in the units of the positions, per second. Zero on the first call for a ball. */
  update(balls: ReadonlyArray<{ id: number; x: number; z: number }>, nowMs: number): Array<{ id: number; speed: number; x: number; z: number }> {
    const dt = (nowMs - this.lastAt) / 1000
    const usable = this.lastAt > 0 && dt > 0.001 && dt < 0.25
    const out: Array<{ id: number; speed: number; x: number; z: number }> = []
    const seen = new Set<number>()
    for (const ball of balls) {
      seen.add(ball.id)
      const was = this.last.get(ball.id)
      const speed = usable && was ? Math.hypot(ball.x - was.x, ball.z - was.z) / dt : 0
      out.push({ id: ball.id, speed, x: ball.x, z: ball.z })
      if (was) {
        was.x = ball.x
        was.z = ball.z
      } else {
        this.last.set(ball.id, { x: ball.x, z: ball.z })
      }
    }
    for (const id of [...this.last.keys()]) if (!seen.has(id)) this.last.delete(id)
    this.lastAt = nowMs
    return out
  }

  reset(): void {
    this.last.clear()
    this.lastAt = 0
  }
}

interface Voice {
  ballId: number | null
  source: AudioBufferSourceNode
  band: BiquadFilterNode
  gain: GainNode
  panner: StereoPannerNode | null
  rumble: OscillatorNode
  rumbleGain: GainNode
  flutter: OscillatorNode
  nodes: AudioNode[]
}

export interface RollingSound {
  /** Aims the voices. Cheap to call every frame: it only acts `updateHz` times a second. */
  update(balls: ReadonlyArray<RollingBall>, nowMs: number): void
  /** Lets go of a ball's voice at once: it has stopped, or gone down. */
  release(ballId: number): void
  /** Fades every voice out. For the end of a shot, a hidden tab, a match that is over. */
  silence(): void
  dispose(): void
}

export function createRollingSound(engine: AudioEngine, tier: SfxTier, config: SfxConfig = SFX_CONFIG): RollingSound {
  const r = config.rolling
  const count = config.tiers[tier].rollingVoices
  let voices: Voice[] | null = null
  let lastUpdate = -Infinity
  /**
   * Level that makes the loop about `fullDb` RMS at full speed. Pink noise at a 0.9 peak is
   * near 0.22 RMS, and the band-pass in front of the gain passes well under half of that;
   * 0.09 is what was measured coming out of the filter on the meter.
   */
  const fullGain = dbToGain(r.fullDb) / 0.09

  /** Builds the voices, once, the first time there is a context and a loop to play. */
  const build = (): Voice[] | null => {
    if (voices) return voices
    try {
      const graph = engine.graph()
      const loop = graph?.buffer(ROLLING_KEY)
      if (!graph || !loop) return null
      const c = graph.context
      const made: Voice[] = []
      for (let i = 0; i < count; i++) {
        const source = c.createBufferSource()
        source.buffer = loop
        source.loop = true
        const band = c.createBiquadFilter()
        band.type = 'bandpass'
        band.frequency.value = r.bandBaseHz
        band.Q.value = r.bandQ
        const high = c.createBiquadFilter()
        high.type = 'highpass'
        high.frequency.value = r.highpassHz
        const gain = c.createGain()
        gain.gain.value = 0
        // A slow wobble on the level, so a steady roll never settles into a drone.
        const flutter = c.createOscillator()
        flutter.frequency.value = r.flutterHzMin + ((r.flutterHzMax - r.flutterHzMin) * (i + 1)) / (count + 1)
        const flutterDepth = c.createGain()
        flutterDepth.gain.value = r.flutterDepth
        const wobble = c.createGain()
        wobble.gain.value = 1
        flutter.connect(flutterDepth)
        flutterDepth.connect(wobble.gain)
        const rumble = c.createOscillator()
        rumble.frequency.value = r.rumbleHzMin + ((r.rumbleHzMax - r.rumbleHzMin) * i) / Math.max(1, count - 1)
        const rumbleGain = c.createGain()
        rumbleGain.gain.value = dbToGain(r.rumbleDb)
        const panner = typeof c.createStereoPanner === 'function' ? c.createStereoPanner() : null
        source.connect(band)
        band.connect(high)
        high.connect(wobble)
        rumble.connect(rumbleGain)
        rumbleGain.connect(wobble)
        wobble.connect(gain)
        if (panner) {
          gain.connect(panner)
          panner.connect(graph.bus('rolling'))
        } else {
          gain.connect(graph.bus('rolling'))
        }
        source.start(0, (loop.duration * (i + 0.37)) / count)
        rumble.start()
        flutter.start()
        made.push({
          ballId: null,
          source,
          band,
          gain,
          panner,
          rumble,
          rumbleGain,
          flutter,
          nodes: [source, band, high, gain, flutter, flutterDepth, wobble, rumble, rumbleGain, ...(panner ? [panner] : [])]
        })
      }
      voices = made
      return voices
    } catch {
      return null
    }
  }

  const aim = (voice: Voice, ball: RollingBall | null, now: number): void => {
    const target = rollingVoiceTarget(ball?.speedNorm ?? 0, config)
    const rising = target.gain * fullGain > voice.gain.gain.value
    voice.gain.gain.setTargetAtTime(target.gain * fullGain, now, (rising ? r.attackMs : r.releaseMs) / 1000 / 3)
    if (!ball) return
    voice.band.frequency.setTargetAtTime(target.bandHz, now, 0.05)
    voice.source.playbackRate.setTargetAtTime(target.rate, now, 0.05)
    voice.panner?.pan.setTargetAtTime(Math.max(-1, Math.min(1, ball.pan)), now, 0.08)
  }

  return {
    update(balls, nowMs): void {
      try {
        if (nowMs - lastUpdate < 1000 / r.updateHz) return
        lastUpdate = nowMs
        engine.syncMute()
        const all = build()
        const graph = engine.graph()
        if (!all || !graph) return
        const assigned = assignRollingVoices(
          all.map((voice) => voice.ballId),
          balls,
          r.silentBelow
        )
        const now = graph.context.currentTime
        for (let i = 0; i < all.length; i++) {
          const voice = all[i]!
          const ball = assigned[i] ?? null
          voice.ballId = ball?.id ?? null
          aim(voice, ball, now)
        }
      } catch {
        // The roll is decoration. If it cannot be updated it is simply left as it was.
      }
    },
    release(ballId): void {
      try {
        const graph = engine.graph()
        if (!voices || !graph) return
        for (const voice of voices) {
          if (voice.ballId !== ballId) continue
          voice.ballId = null
          voice.gain.gain.setTargetAtTime(0, graph.context.currentTime, 0.02)
        }
      } catch {
        // Nothing to release.
      }
    },
    silence(): void {
      try {
        const graph = engine.graph()
        if (!voices || !graph) return
        for (const voice of voices) {
          voice.ballId = null
          voice.gain.gain.setTargetAtTime(0, graph.context.currentTime, r.releaseMs / 1000 / 3)
        }
      } catch {
        // Nothing to silence.
      }
    },
    dispose(): void {
      if (!voices) return
      for (const voice of voices) {
        try {
          voice.source.stop()
          voice.rumble.stop()
          voice.flutter.stop()
          for (const node of voice.nodes) node.disconnect()
        } catch {
          // Already stopped.
        }
      }
      voices = null
    }
  }
}
