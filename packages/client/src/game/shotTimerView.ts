import { TURN_URGENT_MS, clockOffsetMs, displayedSeconds, remainingMs, ringProgress, timerTone } from './shotTimer.js'
import type { TurnTiming } from './shotTimer.js'

export interface ShotTimerOptions {
  /**
   * The avatar frame of whoever is at the table, from the HUD.
   *
   * Asked for every frame rather than resolved once, because the frame changes hands
   * and the clock has to move with it. This is the hook Phase H1 left behind, and the
   * clock is drawn inside it rather than beside it: a clock in a corner of the screen
   * tells the player how long they have, not whose turn it is that they are spending.
   */
  turnFrame: () => HTMLElement | null
}

export interface ShotTimer {
  /** Adopts a deadline, or clears the clock when given null. */
  set: (timing: TurnTiming | null) => void
  destroy: () => void
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  return node
}

/**
 * The shot clock, drawn into the active player's turn frame.
 *
 * It runs its own animation frame and only ever writes a custom property and a text
 * node, so a 30-second clock costs a handful of style writes and no layout: the ring
 * is painted by the compositor from those two values. Nothing here is rebuilt while
 * the clock runs, and the loop stops itself entirely when no clock is running, so a
 * table with no turn clock on it costs nothing at all.
 */
export function createShotTimer(options: ShotTimerOptions): ShotTimer {
  const ring = el('div', 'shot-timer')
  ring.id = 'shot-timer'
  ring.setAttribute('aria-hidden', 'true')
  const arc = el('div', 'shot-timer-arc')
  const label = el('div', 'shot-timer-seconds')
  ring.append(arc, label)

  let timing: TurnTiming | null = null
  let offset = 0
  let frame = 0
  /** The frame the clock is currently drawn in, so it is moved only when it has to be. */
  let hosted: HTMLElement | null = null
  let lastArc = ''
  let lastLabel = ''
  let lastTone = ''

  function stop(): void {
    if (!frame) return
    cancelAnimationFrame(frame)
    frame = 0
  }

  function detach(): void {
    if (!hosted) return
    hosted.classList.remove('has-timer', 'is-warn', 'is-urgent')
    if (ring.parentElement === hosted) hosted.removeChild(ring)
    hosted = null
  }

  const step = (): void => {
    frame = 0
    if (!timing) return
    const target = options.turnFrame()
    // The turn changed hands: take the clock with it rather than leaving it on the
    // player it no longer belongs to.
    if (target !== hosted) {
      detach()
      if (target) {
        target.appendChild(ring)
        target.classList.add('has-timer')
        hosted = target
        // Force the tone to be re-applied after the move, so a clock that keeps its
        // urgency across a turn change does not stay the colour of the last player.
        lastTone = ''
      }
    }
    if (!hosted) {
      // No one is at the table yet. The deadline is still ours to hold, so the loop
      // keeps running until there is somebody to put it on.
      frame = requestAnimationFrame(step)
      return
    }

    const remaining = remainingMs(timing, Date.now(), offset)
    const progress = ringProgress(remaining, timing.turnDurationMs)
    // Two decimal places is below what a pixel can show, so this is a per-frame write
    // that never skips a visible change and never repeats one.
    const arcValue = progress.toFixed(3)
    if (arcValue !== lastArc) {
      arc.style.setProperty('--progress', arcValue)
      lastArc = arcValue
    }
    const text = String(displayedSeconds(remaining, timing.turnDurationMs))
    if (text !== lastLabel) {
      label.textContent = text
      lastLabel = text
    }
    const tone = timerTone(remaining)
    if (tone !== lastTone) {
      hosted.classList.toggle('is-warn', tone === 'warn')
      // The pulse is a CSS animation, so it starts and stops with a class rather than
      // being driven frame by frame.
      hosted.classList.toggle('is-urgent', tone === 'urgent')
      lastTone = tone
    }

    // Keep going a little past the end so the clock is seen to run out. The server
    // sends the next deadline, or none, and either replaces this outright.
    if (remaining > -TURN_URGENT_MS) frame = requestAnimationFrame(step)
    else stop()
  }

  return {
    set: (next) => {
      timing = next
      if (!next) {
        stop()
        detach()
        return
      }
      // Re-measured on every message, so a machine whose clock drifts — or one that
      // was asleep and woke up — corrects itself from the next thing the server says
      // instead of counting from wherever it had got to.
      offset = clockOffsetMs(next, Date.now())
      if (!frame) frame = requestAnimationFrame(step)
    },
    destroy: () => {
      timing = null
      stop()
      detach()
    }
  }
}
