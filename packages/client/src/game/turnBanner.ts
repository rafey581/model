import { VENUE_CONFIG, type VenueConfig } from './venueConfig.js'

/**
 * Who is at the table.
 *
 * Two pieces, because they answer two different questions. The banner answers "my turn
 * just started" — it is large, it arrives, and it leaves on its own. The chip answers
 * "whose turn is it" — it is small, it is always there, and it changes only when the
 * answer does. A visitor who has been in the room for an hour has only ever seen the chip.
 *
 * Both are built here rather than added to the HUD, because this is presentation and the
 * HUD is not: nothing in the game asks for a banner, the venue reacts to a turn it has
 * already been told about. The banner rides the same `.event-banner` classes the HUD
 * already uses for pot messages, so it inherits the existing look and the existing
 * reduced-motion handling, and its own stylesheet adds only the things the HUD's version
 * has no use for — the scale, the vertical position and the chip.
 */

export interface TurnBanner {
  /** Brings the banner up for `seconds`. A call while one is up restarts it. */
  flash(mine: boolean, seconds?: number): void
  /** Moves the always-on chip. Safe to call on every snapshot. */
  setChip(mine: boolean): void
  /** Hides both, for the end of a frame or a match. */
  clear(): void
  /**
   * Counts the banner's life down. Driven by the render loop rather than a timer, so a
   * tab that was in the background comes back to an empty screen instead of a banner that
   * should have gone an hour ago.
   */
  tick(dt: number): void
  dispose(): void
}

/** Injected once, and only once, however many banners are built. */
const STYLE_ID = 'venue-turn-banner-styles'

const CSS = `
.venue-turn-layer {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 22vh;
  pointer-events: none;
  z-index: 40;
}
.venue-turn-layer .event-banner {
  padding: 10px 30px;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  border-color: rgba(255, 255, 255, 0.22);
  background: rgba(9, 13, 18, 0.55);
}
.venue-turn-chip {
  position: fixed;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 14px;
  border-radius: 999px;
  background: var(--glass-fill, rgba(13, 20, 27, 0.62));
  border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.09));
  backdrop-filter: blur(12px) saturate(125%);
  -webkit-backdrop-filter: blur(12px) saturate(125%);
  color: var(--banner-tone, #f0f6fc);
  font-family: var(--font-body, system-ui, sans-serif);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  pointer-events: none;
  z-index: 41;
  opacity: 0;
  transition: opacity 260ms cubic-bezier(0.2, 0.9, 0.25, 1);
}
.venue-turn-chip.is-in { opacity: 1; }
.venue-turn-chip.tone-you { --banner-tone: var(--turn, #c9a84c); }
.venue-turn-chip.tone-them { --banner-tone: #9cc8ff; }
.venue-turn-chip::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
@media (prefers-reduced-motion: reduce) {
  .venue-turn-layer .event-banner { transition: opacity 200ms ease; transform: none; }
}
`

const ensureStyles = (): void => {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

export function buildTurnBanner(config: VenueConfig = VENUE_CONFIG): TurnBanner {
  ensureStyles()
  const cfg = config.banner
  let hideIn = 0
  let shown = false

  const layer = document.createElement('div')
  layer.className = 'venue-turn-layer'
  const banner = document.createElement('div')
  banner.className = 'event-banner'
  const bannerText = document.createElement('span')
  bannerText.className = 'event-banner-text'
  banner.appendChild(bannerText)
  layer.appendChild(banner)

  const chip = document.createElement('div')
  chip.className = 'venue-turn-chip'
  chip.setAttribute('role', 'status')
  chip.setAttribute('aria-live', 'polite')
  const chipText = document.createElement('span')
  chip.appendChild(chipText)

  document.body.append(layer, chip)

  /** Takes the banner down. Separate from `clear` because a flash ends on a timer. */
  const lower = (): void => {
    if (!shown) return
    shown = false
    banner.classList.remove('is-in')
    banner.classList.add('is-out')
  }

  return {
    flash(mine: boolean, seconds?: number): void {
      bannerText.textContent = mine ? cfg.youText : cfg.opponentText
      banner.classList.remove('tone-good', 'tone-bad', 'tone-info')
      // Green for your own visit, blue for theirs: the same two tones the HUD already uses
      // for good and neutral, so nothing new has to be learned to read them.
      banner.classList.add(mine ? 'tone-good' : 'tone-info')
      banner.classList.remove('is-out')
      banner.classList.add('is-in')
      shown = true
      hideIn = (seconds ?? cfg.holdMs) / 1000
    },
    setChip(mine: boolean): void {
      chipText.textContent = mine ? cfg.chipYouText : cfg.chipOpponentText
      chip.classList.remove('tone-you', 'tone-them')
      chip.classList.add(mine ? 'tone-you' : 'tone-them')
      chip.classList.add('is-in')
    },
    clear(): void {
      lower()
      hideIn = 0
      chip.classList.remove('is-in')
    },
    tick(dt: number): void {
      if (hideIn <= 0) return
      hideIn -= dt
      if (hideIn <= 0) lower()
    },
    dispose(): void {
      layer.remove()
      chip.remove()
      hideIn = 0
    }
  }
}