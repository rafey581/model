import { isSoundMuted } from './audio.js'
import { VENUE_CONFIG, type VenueConfig } from './venueConfig.js'

/**
 * The crowd's applause.
 *
 * The file on disk is an MP4 with a video track on it, and that is fine: `decodeAudioData`
 * pulls the audio track out of the container and ignores everything else, so the browser
 * gets a `AudioBuffer` of nothing but the sound. No transcode, no second copy of the
 * clip, no `ffmpeg` on the build machine.
 *
 * The buffer is decoded once, lazily, and then clipped. A pot takes a window out of the
 * middle of the recording rather than the whole thing, so two pots a few seconds apart do
 * not play the same applause twice over itself; the offset is random, which is what makes
 * repeated pots sound like a crowd and not like a loop.
 *
 * Every failure here is silent and permanent. A missing file, a browser that will not
 * decode it, a decode that races a match ending — none of them are worth a console error
 * in a game about snooker, and none of them are worth retrying on every pot.
 */

export interface CrowdAudio {
  /**
   * Applauds for a pot of `pots` balls.
   *
   * Returns true if it was actually heard. Longer applause for more balls, because a
   * colour is worth one beat and a break is worth a rising roar.
   */
  clap(pots: number): boolean
  /** Whether the clip has finished decoding and is ready to play. */
  ready(): boolean
  dispose(): void
}

/** Called once the clip has decoded, so the crowd and the sound can start together. */
export function buildCrowdAudio(config: VenueConfig = VENUE_CONFIG): CrowdAudio {
  const cfg = config.audio
  let ctx: AudioContext | null = null
  let buffer: AudioBuffer | null = null
  let failed = false
  let loading: Promise<void> | null = null
  let gain: GainNode | null = null
  const live: AudioBufferSourceNode[] = []

  /**
   * A context, created the first time one is needed.
   *
   * Autoplay policy means this starts suspended until the page has seen a gesture, which
   * is what `armUnlock` is for rather than a `resume()` at build time.
   */
  const context = (): AudioContext | null => {
    if (failed || typeof window === 'undefined') return null
    if (ctx) return ctx
    try {
      ctx = new AudioContext()
      gain = ctx.createGain()
      // A pass-through bus. The level that matters lives in the per-applause envelope,
      // because that is where the number of balls can change it.
      gain.gain.value = 1
      gain.connect(ctx.destination)
    } catch {
      failed = true
      return null
    }
    return ctx
  }

  /**
   * The browser's one chance to let us make noise without being asked.
   *
   * Armed at build time rather than at first applause, so the clip is fetched and decoded
   * the moment the player touches anything instead of when they first pot a ball — the
   * first pot of a frame is the one that has to sound right, and it arrives faster than a
   * download and a decode can.
   *
   * The listener that fires removes the rest, and a page that has been clicked once has
   * sticky user activation from then on, so this is a one-shot cost.
   */
  const armUnlock = (): void => {
    if (typeof window === 'undefined' || failed) return
    const listeners: Array<[EventTarget, string, EventListener]> = []
    const go = (): void => {
      for (const [target, type, handler] of listeners) target.removeEventListener(type, handler)
      listeners.length = 0
      const audio = context()
      if (!audio) return
      void load(audio)
      if (audio.state === 'suspended') void audio.resume().catch(() => undefined)
    }
    for (const type of ['pointerdown', 'touchstart', 'keydown']) {
      const handler: EventListener = () => go()
      listeners.push([window, type, handler])
      window.addEventListener(type, handler, { once: true, passive: true })
    }
  }

  /** Fetch and decode, once. */
  const load = async (audio: AudioContext): Promise<void> => {
    if (buffer || failed || loading) return loading ?? undefined
    loading = (async () => {
      try {
        const res = await fetch(cfg.path, { cache: 'force-cache' })
        if (!res.ok) throw new Error(`applause ${res.status}`)
        const bytes = await res.arrayBuffer()
        const decoded = await audio.decodeAudioData(bytes)
        if (decoded.duration < 0.2) throw new Error('applause is empty')
        buffer = decoded
      } catch {
        failed = true
      } finally {
        loading = null
      }
    })()
    return loading
  }

  /** Stops anything still running, for a match that ended mid-applause. */
  const silence = (): void => {
    for (const source of live.splice(0)) {
      try {
        source.stop()
      } catch {
        /* already ended */
      }
      source.disconnect()
    }
  }

  // Armed now, not on the first pot: the clip should be decoded and waiting before anybody
  // has anything to applaud.
  armUnlock()

  return {
    clap(pots: number): boolean {
      if (isSoundMuted()) return false
      const audio = context()
      if (!audio || !gain) return false
      // Not decoded yet: ask for it and stay quiet this once. The next pot gets the sound.
      if (!buffer) {
        void load(audio)
        return false
      }
      const clip = buffer
      const extra = Math.max(0, pots - 1)
      const seconds = Math.min(
        cfg.maxSeconds,
        cfg.minSeconds + extra * cfg.secondsPerExtraBall
      )
      const peak = Math.min(cfg.maxGain, cfg.volume + extra * cfg.gainPerExtraBall)
      try {
        // Random offset into the middle of the clip, so two pots in a row do not replay the
        // same half second of the same recording.
        const slack = Math.max(0, clip.duration - seconds - 0.1)
        const offset = cfg.randomStart && slack > 0 ? Math.random() * slack : 0
        const source = audio.createBufferSource()
        source.buffer = clip
        source.playbackRate.value = 0.94 + Math.random() * 0.12
        const envelope = audio.createGain()
        // A short fade either side: the recording does not start or end on silence, and a
        // hard edge on a wall of sound is audible as a click.
        envelope.gain.setValueAtTime(0, audio.currentTime)
        envelope.gain.linearRampToValueAtTime(peak, audio.currentTime + 0.06)
        envelope.gain.setValueAtTime(peak, audio.currentTime + Math.max(0.07, seconds - 0.25))
        envelope.gain.linearRampToValueAtTime(0, audio.currentTime + seconds)
        source.connect(envelope)
        envelope.connect(gain)
        source.start(0, offset, seconds)
        live.push(source)
        source.onended = (): void => {
          source.disconnect()
          envelope.disconnect()
          const at = live.indexOf(source)
          if (at >= 0) live.splice(at, 1)
        }
        return true
      } catch {
        failed = true
        return false
      }
    },
    ready(): boolean {
      return buffer !== null
    },
    dispose(): void {
      silence()
      void ctx?.close().catch(() => undefined)
      ctx = null
      gain = null
      buffer = null
    }
  }
}