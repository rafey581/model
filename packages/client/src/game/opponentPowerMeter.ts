/**
 * How hard the opponent is about to hit it, as a meter at the edge of the screen.
 *
 * The spectator view looks at the whole table from high up, where the bar that rides
 * beside the opponent's cue is a few pixels long. This is the same reading on the same
 * rail the player's own power uses — the track, the heat-ramp fill and the percentage are
 * the HUD's own classes — stood at the left edge, opposite the player's rail on the right,
 * so the two are never mistaken for each other and neither is over the cloth.
 *
 * Presentation only: it is handed a number that was read off a recorded shot and shows it.
 * Built here rather than in the HUD for the reason the turn banner is: nothing in the game
 * asks for it, the venue reacts to a shot it has already been told about.
 */

export interface OpponentPowerMeter {
  /** Shows the meter at `power` (0..1), or takes it down. Safe to call every frame. */
  show(visible: boolean, power: number): void
  dispose(): void
}

const STYLE_ID = 'venue-opponent-power-styles'

const CSS = `
.venue-opponent-power {
  position: fixed;
  top: 50%;
  left: calc(env(safe-area-inset-left, 0px) + clamp(6px, 1.4vw, 18px));
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 30px;
  pointer-events: none;
  z-index: 39;
  opacity: 0;
  transition: opacity 180ms ease;
}
.venue-opponent-power.is-in { opacity: 1; }
.venue-opponent-power .power-rail-value { color: var(--text, #f0f6fc); font-size: 11px; }
.venue-opponent-power-label {
  font-family: var(--font-body, system-ui, sans-serif);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #9cc8ff;
  writing-mode: vertical-rl;
  transform: rotate(180deg);
}
`

const ensureStyles = (): void => {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

export function buildOpponentPowerMeter(): OpponentPowerMeter {
  ensureStyles()
  const root = document.createElement('div')
  root.className = 'venue-opponent-power'
  root.setAttribute('aria-hidden', 'true')
  const value = document.createElement('div')
  value.className = 'power-rail-value'
  const track = document.createElement('div')
  track.className = 'power-rail-track'
  const fill = document.createElement('div')
  fill.className = 'power-rail-fill'
  track.appendChild(fill)
  const label = document.createElement('div')
  label.className = 'venue-opponent-power-label'
  label.textContent = 'Opponent'
  root.append(value, track, label)
  document.body.appendChild(root)

  // The DOM is only written when what it shows changes: a whole percent, or in and out.
  let shownVisible = false
  let shownPercent = -1

  return {
    show(visible: boolean, power: number): void {
      if (visible !== shownVisible) {
        shownVisible = visible
        root.classList.toggle('is-in', visible)
      }
      if (!visible) return
      const percent = Math.round(Math.min(1, Math.max(0, power)) * 100)
      if (percent === shownPercent) return
      shownPercent = percent
      fill.style.transform = `scaleY(${percent / 100})`
      value.textContent = `${percent}%`
    },
    dispose(): void {
      root.remove()
    }
  }
}
