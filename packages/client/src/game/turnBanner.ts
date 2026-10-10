import { VENUE_CONFIG, type VenueConfig } from './venueConfig.js'

/**
 * Whose turn it is, announced once in the middle of the screen.
 *
 * One piece: a plate that arrives when a visit changes hands, holds for a moment and
 * leaves. It is the same plate the HUD uses for a foul or a ball in hand, put into the same
 * layer, so two announcements that land together — a foul and the turn it hands over —
 * stack one under the other instead of being drawn on top of each other.
 *
 * There used to be a second piece, a small always-on chip at the top of the screen. It sat
 * over the players' names in the score capsule, and the capsule already marks whose visit
 * it is, so it is gone.
 *
 * Built here rather than added to the HUD, because this is presentation and the HUD is not:
 * nothing in the game asks for a turn announcement, the venue reacts to a turn it has
 * already been told about.
 */

export interface TurnBanner {
  /** Brings the plate up for `seconds`. A call while one is up replaces it. */
  flash(mine: boolean, seconds?: number): void
  /** Kept for callers that used to move the always-on chip. There is no chip now. */
  setChip(mine: boolean): void
  /** Takes the plate down, for the end of a frame or a match. */
  clear(): void
  /** Sends the plate off now, with its usual exit. For a shot that starts while it is still up. */
  dismiss(): void
  /**
   * Counts the plate's life down. Driven by the render loop rather than a timer, so a tab
   * that was in the background comes back to an empty screen instead of a plate that
   * should have gone an hour ago.
   */
  tick(dt: number): void
  dispose(): void
}

/** How long the plate takes to leave, in seconds. Matches the stylesheet's exit. */
const EXIT_SECONDS = 0.45

export function buildTurnBanner(config: VenueConfig = VENUE_CONFIG): TurnBanner {
  const cfg = config.banner
  let plate: HTMLElement | null = null
  let hideIn = 0
  let removeIn = 0

  /** The HUD's own announcement layer, or the page if this is running without a HUD. */
  const layer = (): HTMLElement => document.getElementById('event-banner-layer') ?? document.body

  const drop = (): void => {
    plate?.remove()
    plate = null
    hideIn = 0
    removeIn = 0
  }

  return {
    flash(mine: boolean, seconds?: number): void {
      drop()
      const next = document.createElement('div')
      // Gold for your own visit, blue for theirs: the two tones the score capsule uses.
      next.className = `event-banner is-turn ${mine ? 'tone-turn' : 'tone-info'}`
      next.setAttribute('role', 'status')
      const kicker = document.createElement('span')
      kicker.className = 'event-banner-kicker'
      kicker.textContent = mine ? 'At the table' : 'Watching'
      const text = document.createElement('span')
      text.className = 'event-banner-text'
      text.textContent = mine ? cfg.youText : cfg.opponentText
      next.append(kicker, text)
      layer().appendChild(next)
      plate = next
      // One frame for the starting styles to be committed, so the entrance is a
      // transition and not a jump to its end.
      requestAnimationFrame(() => {
        if (plate === next) next.classList.add('is-in')
      })
      hideIn = (seconds ?? cfg.holdMs) / 1000
    },
    setChip(): void {},
    clear(): void {
      drop()
    },
    dismiss(): void {
      if (!plate || hideIn <= 0) return
      hideIn = 0
      plate.classList.remove('is-in')
      plate.classList.add('is-out')
      removeIn = EXIT_SECONDS
    },
    tick(dt: number): void {
      if (hideIn > 0) {
        hideIn -= dt
        if (hideIn <= 0 && plate) {
          plate.classList.remove('is-in')
          plate.classList.add('is-out')
          removeIn = EXIT_SECONDS
        }
        return
      }
      if (removeIn > 0) {
        removeIn -= dt
        if (removeIn <= 0) drop()
      }
    },
    dispose(): void {
      drop()
    }
  }
}
