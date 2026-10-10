import { createAudioEngine, type AudioEngine } from './audioEngine.js'
import { renderJobs, type RenderJob } from './recipes.js'
import { createRollingSound, type RollingSound } from './rolling.js'
import { loadRecordedSamples } from './samples.js'
import { subscribeSfx } from './sfxEvents.js'
import { SFX_CONFIG, type SfxConfig, type SfxTier, type SoundType } from './sfxConfig.js'
import { createSnookerSfx, type SnookerSfx } from './snookerSfx.js'

export { emitSfx, subscribeSfx, type SfxEvent } from './sfxEvents.js'
export { SFX_CONFIG } from './sfxConfig.js'

/**
 * The sound system, assembled: an engine, the rolling voices, the gameplay logic
 * listening on the event door, and the buffers rendering themselves in idle time.
 */
export interface SfxRuntime {
  engine: AudioEngine
  sfx: SnookerSfx
  rolling: RollingSound
  tier: SfxTier
  /** Renders one sound's buffers again from the config as it now stands, or all of them. */
  rerender(only?: SoundType): void
  /** How many buffers are still waiting to be rendered. */
  pendingRenders(): number
  /** How many buffers are real recordings from `public/audio/sfx/` rather than generated. */
  recordedBuffers(): number
  dispose(): void
}

export interface SfxStartOptions {
  tier: SfxTier
  /** The game's existing audio context. Asked for lazily. */
  context: () => AudioContext | null
  /** The game's existing mute setting. */
  isMuted: () => boolean
  config?: SfxConfig
}

type Idle = (run: () => void) => void

/** Runs `run` when the browser has nothing better to do, and soon regardless. */
const whenIdle: Idle = (run) => {
  const w = globalThis as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }
  if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(run, { timeout: 400 })
  else setTimeout(run, 16)
}

export function startSfx(options: SfxStartOptions): SfxRuntime {
  const config = options.config ?? SFX_CONFIG
  const engine = createAudioEngine(options.tier, config)
  engine.setContextProvider(options.context)
  engine.setMuteSource(options.isMuted)
  const rolling = createRollingSound(engine, options.tier, config)
  const sfx = createSnookerSfx(engine, { tier: options.tier, config, rolling })
  const unsubscribe = subscribeSfx((event) => sfx.handle(event))

  let queue: RenderJob[] = []
  /** Buffers that hold a recording. A generated version never overwrites one of these. */
  const recorded = new Set<string>()
  let running = false
  let disposed = false

  /**
   * One buffer per idle slot. The whole set is a few hundred milliseconds of arithmetic,
   * and done in one piece it would be a visible hitch in the lobby or on the loading
   * screen; done one at a time between frames it is not felt at all.
   */
  const pump = (): void => {
    if (disposed) return
    const job = queue.shift()
    if (!job) {
      running = false
      return
    }
    try {
      if (!recorded.has(job.key)) engine.store(job.key, job.render())
    } catch {
      // A sound that cannot be rendered is skipped; the rest still are.
    }
    whenIdle(pump)
  }

  const schedule = (jobs: RenderJob[]): void => {
    queue = queue.filter((queued) => !jobs.some((job) => job.key === queued.key)).concat(jobs)
    if (running) return
    running = true
    whenIdle(pump)
  }

  schedule(renderJobs(options.tier, config))
  // Recordings, if any have been put in `public/audio/sfx/`, take the place of the
  // generated sounds of the same name as they arrive. With none there, this is one request
  // that comes back empty.
  void loadRecordedSamples(config.tiers[options.tier].variants, (key, samples) => {
    if (disposed) return
    recorded.add(key)
    engine.store(key, samples)
  })

  return {
    engine,
    sfx,
    rolling,
    tier: options.tier,
    rerender(only): void {
      schedule(renderJobs(options.tier, config, only))
    },
    pendingRenders(): number {
      return queue.length
    },
    recordedBuffers(): number {
      return recorded.size
    },
    dispose(): void {
      disposed = true
      queue = []
      unsubscribe()
      rolling.dispose()
      engine.dispose()
    }
  }
}
