/**
 * A frame-rate readout for finding out why the game is slow on a particular machine.
 *
 * Off unless asked for: add `?perf=1` to the address (it is then remembered; `?perf=0`
 * forgets it). It shows the frame rate, the slowest frame of the last two seconds, how
 * long this page's own code took per frame, and what was being drawn — enough to tell a
 * graphics card that cannot keep up from code that is taking too long, which need
 * opposite fixes and look identical from the player's chair.
 *
 * It updates its text twice a second, not every frame, so that measuring does not become
 * part of what is measured.
 */

const STORAGE_KEY = 'snooker.perf'
const REPORT_EVERY_MS = 500
const WORST_WINDOW_FRAMES = 120

export interface PerfOverlay {
  /**
   * One frame: the time since the last one, how long the scene's update and its draw call
   * took on this thread, and a line describing what is being drawn.
   */
  frame(frameMs: number, updateMs: number, renderMs: number, describe: () => string): void
}

function wanted(): boolean {
  try {
    const asked = new URLSearchParams(window.location.search).get('perf')
    if (asked === '1') localStorage.setItem(STORAGE_KEY, '1')
    if (asked === '0') localStorage.removeItem(STORAGE_KEY)
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** The readout, or null when it has not been asked for. */
export function createPerfOverlay(): PerfOverlay | null {
  if (typeof document === 'undefined' || !wanted()) return null
  const el = document.createElement('pre')
  el.style.cssText =
    'position:fixed;right:8px;top:8px;z-index:99999;margin:0;padding:6px 9px;border-radius:6px;' +
    'background:rgba(0,0,0,0.72);color:#b8ffcf;font:11px/1.45 ui-monospace,Consolas,monospace;' +
    'pointer-events:none;white-space:pre;text-align:left'
  document.body.appendChild(el)

  const recent: number[] = []
  let frames = 0
  let elapsed = 0
  let update = 0
  let render = 0
  let slow = 0

  return {
    frame(frameMs, updateMs, renderMs, describe): void {
      frames++
      elapsed += frameMs
      update += updateMs
      render += renderMs
      // A frame that took more than two refreshes is one the player can see.
      if (frameMs > 34) slow++
      recent.push(frameMs)
      if (recent.length > WORST_WINDOW_FRAMES) recent.shift()
      if (elapsed < REPORT_EVERY_MS) return
      const fps = (frames * 1000) / elapsed
      const worst = Math.max(...recent)
      const code = (update + render) / frames
      // The draw call returns before the graphics card has finished, so a low frame rate
      // with little time spent in code means the card is what is behind.
      const verdict = fps >= 55 ? 'smooth' : code > 1000 / fps / 2 ? 'slow in CODE' : 'slow in GRAPHICS CARD'
      el.textContent =
        `${fps.toFixed(0)} fps   ${verdict}\n` +
        `worst frame ${worst.toFixed(0)} ms   slow frames ${slow}\n` +
        `code ${code.toFixed(1)} ms  (update ${(update / frames).toFixed(1)} + draw ${(render / frames).toFixed(1)})\n` +
        describe()
      frames = 0
      elapsed = 0
      update = 0
      render = 0
      slow = 0
    }
  }
}
