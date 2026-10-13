/**
 * The adaptive render scale: how many pixels the 3D scene is drawn at, as a fraction of
 * the most this screen could take.
 *
 * The scene is fill-rate bound — the cost of a frame is very nearly the number of pixels
 * shaded — so resolution is the one dial that moves the frame time on any GPU, and the
 * only one that can be turned mid-match without rebuilding anything. This watches the
 * frame time the game is actually getting and turns it: down as soon as the frame rate
 * is being missed, by however much the miss says is needed, and back up, cautiously, once
 * there has been room for a while.
 *
 * Plain arithmetic on numbers, with no renderer in sight, so the behaviour that matters —
 * it converges, it does not hunt, a stall does not trip it — is testable without a GPU.
 */

/** The frame time being aimed for, in milliseconds: sixty a second. */
export const TARGET_FRAME_MS = 1000 / 60
/** A smoothed frame time above this is a missed frame rate, not a hiccup. */
export const SLOW_FRAME_MS = 21
/** A smoothed frame time under this is comfortably on the frame rate. */
export const FAST_FRAME_MS = 18.5
/** How many slow frames in a row it takes before the scale is turned down. */
export const SLOW_FRAMES_TO_DROP = 36
/** The least and most one downward step may cut the scale by. */
export const DROP_FACTOR_MIN = 0.6
export const DROP_FACTOR_MAX = 0.9
/** How much one cautious step back up restores. */
export const RAISE_FACTOR = 1 / 0.88
/** How long the scale has to have been comfortable before a step up is tried, at first. */
export const RAISE_AFTER_MS = 20000
/** The longest the wait before another try is ever stretched to. */
export const RAISE_AFTER_MAX_MS = 600000
/** A drop this soon after a step up means the step up was the cause. */
export const PROBE_WINDOW_MS = 8000
/** Frames ignored after any change, while the new buffers are allocated. */
export const SETTLE_MS = 400
/** Frames ignored at the start of a match, while shaders compile and textures upload. */
export const WARM_UP_MS = 1000
/** A frame longer than this is counted as this: a hidden tab or a debugger is not the GPU. */
export const STALL_FRAME_MS = 100

export interface RenderScaler {
  /** The current scale, between the floor it was given and 1. */
  readonly scale: number
  /**
   * Feeds one frame's duration in. Returns true when the scale changed and the canvas
   * has to be resized.
   */
  step(frameMs: number, nowMs: number): boolean
  /** Starts over for a new match, optionally from a scale remembered from the last one. */
  reset(scale: number, minScale: number): void
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}

export interface RenderScalerOptions {
  /**
   * Asked before resolution is cut for the first time: is there anything cheaper to give
   * up instead? Returns true when it gave something up, in which case the resolution is
   * left where it is and the frame time is measured afresh. Once it answers false it is
   * out of things to give and resolution is the only dial left.
   */
  cheapen?: () => boolean
}

export function createRenderScaler(options: RenderScalerOptions = {}): RenderScaler {
  let scale = 1
  let minScale = 1
  let ema = 0
  let slow = 0
  let settleUntil = 0
  let started = false
  let raiseAt = 0
  let raiseAfter = RAISE_AFTER_MS
  /** When the last step up was taken and what it stepped up from, while it is on trial. */
  let probe: { at: number; from: number } | null = null

  const changed = (now: number): true => {
    ema = 0
    slow = 0
    settleUntil = now + SETTLE_MS
    return true
  }

  return {
    get scale() {
      return scale
    },
    reset(next: number, floor: number): void {
      minScale = clamp(floor, 0.05, 1)
      scale = clamp(Number.isFinite(next) ? next : 1, minScale, 1)
      ema = 0
      slow = 0
      settleUntil = 0
      started = false
      raiseAt = 0
      raiseAfter = RAISE_AFTER_MS
      probe = null
    },
    step(frameMs: number, now: number): boolean {
      if (!started) {
        started = true
        settleUntil = now + WARM_UP_MS
        raiseAt = settleUntil + raiseAfter
      }
      if (now < settleUntil) return false
      // Capped rather than dropped: one stalled frame then cannot trip a cut by itself,
      // but a GPU that really is this slow on every frame still gets one.
      const ms = Math.min(frameMs, STALL_FRAME_MS)
      ema = ema === 0 ? ms : ema * 0.9 + ms * 0.1
      slow = ema > SLOW_FRAME_MS ? slow + 1 : 0

      if (slow >= SLOW_FRAMES_TO_DROP && scale > minScale) {
        if (probe && now - probe.at < PROBE_WINDOW_MS) {
          // The step up was one step too many. Go back to where it was comfortable and
          // wait a good deal longer before asking again, so the picture is not made to
          // stutter every few seconds to re-learn the same answer.
          scale = probe.from
          raiseAfter = Math.min(RAISE_AFTER_MAX_MS, raiseAfter * 3)
        } else if (options.cheapen?.()) {
          // Something off the picture's edges was given up instead. Resolution stays, and
          // the frame time is measured again from scratch before anything else is asked.
          changed(now)
          raiseAt = now + raiseAfter
          return false
        } else {
          // Frame time goes with the pixel count, which goes with the square of the
          // scale, so the square root of the miss is the cut that should land on target
          // in one step rather than creeping there through a second of bad frames.
          const factor = clamp(Math.sqrt(TARGET_FRAME_MS / ema), DROP_FACTOR_MIN, DROP_FACTOR_MAX)
          scale = Math.max(minScale, scale * factor)
        }
        probe = null
        raiseAt = now + raiseAfter
        return changed(now)
      }

      if (scale < 1 && ema < FAST_FRAME_MS && now >= raiseAt) {
        probe = { at: now, from: scale }
        scale = Math.min(1, scale * RAISE_FACTOR)
        raiseAt = now + raiseAfter
        return changed(now)
      }
      return false
    }
  }
}
