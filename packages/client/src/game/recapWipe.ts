/**
 * The wipe in and out of a recap.
 *
 * A run of slanted bars in the game's colours sweeps across the screen from the left; while
 * it covers the screen the picture underneath is changed (into the replay, or back out of
 * it), and the bars carry on off to the right. No words: the sweep itself says "this is a
 * replay", the way a television broadcast cuts to one.
 *
 * Picture only, and self-cleaning: the bars are removed when they have gone, and the
 * callback runs once, at the moment the screen is covered, whatever else happens.
 */

const STYLE_ID = 'recap-wipe-styles'

const CSS = `
.recap-wipe {
  position: fixed;
  inset: 0;
  z-index: 60;
  overflow: hidden;
  pointer-events: none;
}
.recap-wipe-bar {
  position: absolute;
  top: -10%;
  bottom: -10%;
  width: 34%;
  transform: translateX(-160%) skewX(-14deg);
  will-change: transform;
  box-shadow: 0 0 30px rgba(0, 0, 0, 0.35);
}
`

/** The bars, front to back: their colour and how far behind the first each one starts. */
const BARS: Array<{ color: string; left: string; delay: number }> = [
  { color: '#0b1020', left: '-14%', delay: 0 },
  { color: '#16295e', left: '18%', delay: 40 },
  { color: '#22c55e', left: '40%', delay: 80 },
  { color: '#f5c542', left: '62%', delay: 120 },
  { color: '#c81e2c', left: '84%', delay: 160 }
]

/** How long one bar takes to cross in, and to cross out, in milliseconds. */
const SWEEP_MS = 300
/** How long the screen stays covered while the picture underneath is changed. */
const HOLD_MS = 90

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

/**
 * Sweeps the bars across, calls `onCovered` while they cover the screen, and sweeps them
 * off. Without animation support, or with reduced motion asked for, the change is simply
 * made at once.
 */
export function playRecapWipe(onCovered: () => void): void {
  let covered = false
  const cover = (): void => {
    if (covered) return
    covered = true
    try {
      onCovered()
    } catch (error) {
      console.error('[recap] change under the wipe failed', error)
    }
  }
  let reduced = false
  try {
    reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    // No media queries: animate.
  }
  if (reduced || typeof document === 'undefined' || typeof Element.prototype.animate !== 'function') {
    cover()
    return
  }
  ensureStyles()
  const layer = document.createElement('div')
  layer.className = 'recap-wipe'
  layer.setAttribute('aria-hidden', 'true')
  const bars = BARS.map((spec) => {
    const bar = document.createElement('div')
    bar.className = 'recap-wipe-bar'
    bar.style.left = spec.left
    bar.style.background = `linear-gradient(90deg, ${spec.color}, ${spec.color} 70%, rgba(255,255,255,0.18))`
    layer.appendChild(bar)
    return bar
  })
  document.body.appendChild(layer)

  const lastDelay = BARS[BARS.length - 1]!.delay
  // In: every bar from off the left to its place, the front one first.
  bars.forEach((bar, i) => {
    bar.animate(
      [{ transform: 'translateX(-420%) skewX(-14deg)' }, { transform: 'translateX(0) skewX(-14deg)' }],
      { duration: SWEEP_MS, delay: BARS[i]!.delay, easing: 'cubic-bezier(0.55, 0, 0.35, 1)', fill: 'forwards' }
    )
  })
  const coveredAt = lastDelay + SWEEP_MS
  window.setTimeout(cover, coveredAt)
  // Out: carried on off to the right, in the same order.
  window.setTimeout(() => {
    let left = bars.length
    bars.forEach((bar, i) => {
      const out = bar.animate(
        [{ transform: 'translateX(0) skewX(-14deg)' }, { transform: 'translateX(420%) skewX(-14deg)' }],
        { duration: SWEEP_MS, delay: BARS[i]!.delay, easing: 'cubic-bezier(0.65, 0, 0.45, 1)', fill: 'forwards' }
      )
      out.onfinish = () => {
        left -= 1
        if (left === 0) layer.remove()
      }
    })
  }, coveredAt + HOLD_MS)
  // Whatever becomes of the animations, nothing is left on the screen for long.
  window.setTimeout(() => layer.remove(), coveredAt + HOLD_MS + SWEEP_MS + lastDelay + 600)
}
