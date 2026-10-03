import { PRACTICE_AI_LEVELS } from '@snooker/shared'
import type { PracticeAiLevel } from '@snooker/shared'
// Imported as text, not as a URL: the multiplayer card's artwork is drawn rather than
// photographed, and `?raw` keeps it a file the lobby can be pointed away from later
// without anything here having to change.
import multiplayerArt from './ui/multiplayerArt.svg?raw'

/**
 * The home screen's shape, as data.
 *
 * The screen itself is drawn in `main.ts`; what lives here is everything about it that is
 * a *decision* rather than a drawing: which cards there are, what each of the five bar
 * icons does, and which difficulties the practice screen offers. Keeping the decisions
 * here means the wiring cannot quietly grow a second meaning — a bar item's destination
 * is read from one record, so "Shop goes nowhere" is a property of the model rather than
 * an omission in a click handler nobody looks at twice.
 *
 * The difficulty list is derived from `PRACTICE_AI_LEVELS`, which is the same tuple the
 * server validates `aiLevel` against, so the selector cannot offer a level the API would
 * reject. The wording next to each level is presentation only.
 */

/** Every screen the home screen can reach. */
export type AppScreen = 'home' | 'practice' | 'multiplayer' | 'tournaments' | 'leaderboard' | 'settings'

/**
 * Where a tap goes.
 *
 * `soon` is a real destination: the entry point is finished and live, and the feature
 * behind it does not exist yet. It is deliberately not `null`, because an absent
 * destination and a not-yet-built one are different things and the UI says so out loud.
 */
export type NavTarget = AppScreen | 'soon'

/**
 * Inline SVG, one style throughout: a 24-unit box, a 1.7 stroke in `currentColor`, round
 * caps and joins, and nothing filled. This is the same hand-drawn-in-SVG approach the
 * header bell and the camera toggle already use, so the bar does not introduce a second
 * icon language. Nothing here is traced from another product's artwork.
 */
function icon(body: string): string {
  return (
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    body +
    '</svg>'
  )
}

const ICONS = {
  /** A cue ball with the cue coming into it. */
  practice: icon('<circle cx="8.4" cy="15.6" r="4.6"/><path d="M12.2 11.8 20.4 3.6"/><path d="m17.6 3.2 3.2 3.2"/>'),
  /** A table seen from above with a ball on each end. */
  multiplayer: icon('<rect x="3.2" y="7.2" width="17.6" height="9.6" rx="2.4"/><circle cx="8.2" cy="12" r="1.6"/><circle cx="15.8" cy="12" r="1.6"/>'),
  /** A cup, for the bracket. */
  tournament: icon(
    '<path d="M8.4 4.2h7.2v3.3a3.6 3.6 0 0 1-7.2 0V4.2Z"/>' +
      '<path d="M8.4 5.6H6v1.4a2.6 2.6 0 0 0 2.4 2.6"/>' +
      '<path d="M15.6 5.6H18V7a2.6 2.6 0 0 1-2.4 2.6"/>' +
      '<path d="M12 11.6v3.4"/><path d="M9.9 15h4.2l.5 4.2H9.4L9.9 15Z"/>'
  ),
  /** A shopping bag. */
  shop: icon('<path d="M5.6 8h12.8l-1 12.2H6.6L5.6 8Z"/><path d="M9.2 8V6.3a2.8 2.8 0 0 1 5.6 0V8"/>'),
  /** Two people, one behind the other. */
  friends: icon(
    '<circle cx="9.4" cy="8.8" r="3.1"/>' +
      '<path d="M3.8 19.4a5.7 5.7 0 0 1 11.2 0"/>' +
      '<path d="M16.2 6.4a3.1 3.1 0 0 1 0 6"/>' +
      '<path d="M17.6 14.4a5.7 5.7 0 0 1 2.8 4.6"/>'
  ),
  /** Three bars, tallest in the middle. */
  leaderboard: icon('<path d="M4 20.4h16"/><path d="M6.8 18.2V13"/><path d="M12 18.2V6.4"/><path d="M17.2 18.2v-4.6"/>'),
  /** Three sliders — the settings/tune glyph. */
  settings: icon(
    '<path d="M3.8 7.6h6.4"/><path d="M13.6 7.6h6.6"/><circle cx="12.4" cy="7.6" r="2.1"/>' +
      '<path d="M3.8 16.4h3.4"/><path d="M10.6 16.4h9.6"/><circle cx="9.4" cy="16.4" r="2.1"/>'
  ),
  /** An overflow ellipsis. */
  more: icon('<circle cx="5.8" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18.2" cy="12" r="1.5"/>')
} as const

export interface HomeCardSpec {
  id: string
  /** The word on the card, in the order the spec asks for: practice, multiplayer, tournament. */
  label: string
  blurb: string
  target: NavTarget
  /** The picture that sits on top of the card. */
  artUrl: string
  /**
   * Inline SVG for the same slot, for art that is drawn rather than photographed.
   * Mutually exclusive with `artUrl`: the card takes whichever is set.
   */
  artSvg: string | null
  /** Two facts about the mode, taken from what the app already knows. Never a price or a prize. */
  chips: readonly string[]
}

/** Where each card's picture comes from. `public/` is served at the site root by Vite. */
interface CardArt {
  url?: string
  svg?: string
}

const ART: Record<'practice' | 'multiplayer' | 'tournament', CardArt> = {
  practice: { url: '/bot.png' },
  multiplayer: { svg: multiplayerArt },
  tournament: { url: '/tournament.png' }
}

export interface HomeBarItem {
  id: string
  label: string
  target: NavTarget
  icon: string
}

/** The three cards, in the order they are drawn. */
export const HOME_CARDS: readonly HomeCardSpec[] = [
  {
    id: 'practice',
    label: 'Practice',
    blurb: 'Warm up against the robot at a level you choose.',
    target: 'practice',
    artUrl: ART.practice.url ?? '',
    artSvg: ART.practice.svg ?? null,
    chips: ['Easy / Medium / Hard', 'No credits']
  },
  {
    id: 'multiplayer',
    label: 'Multiplayer',
    blurb: 'Join a table by price, or open one and wait for an opponent.',
    target: 'multiplayer',
    artUrl: ART.multiplayer.url ?? '',
    artSvg: ART.multiplayer.svg ?? null,
    chips: ['Real players', 'Entry by price']
  },
  {
    id: 'tournament',
    label: 'Tournament',
    blurb: 'Enter an 8-player knockout bracket and go through to the final.',
    target: 'tournaments',
    artUrl: ART.tournament.url ?? '',
    artSvg: ART.tournament.svg ?? null,
    chips: ['8 players', 'Knockout']
  }
]

/**
 * The bottom bar, all five entries.
 *
 * Leaderboard and Settings already have working screens behind them, so they navigate.
 * Shop, Friends and More have no backend at all in this project, so they resolve to
 * `soon` and the UI answers with a toast. Building them anyway is the point: the bar is
 * the finished surface, and the three that wait are finished too — there is simply
 * nothing behind them yet.
 */
export const HOME_BAR: readonly HomeBarItem[] = [
  { id: 'shop', label: 'Shop', target: 'soon', icon: ICONS.shop },
  { id: 'friends', label: 'Friends', target: 'soon', icon: ICONS.friends },
  { id: 'leaderboard', label: 'Leaderboard', target: 'leaderboard', icon: ICONS.leaderboard },
  { id: 'settings', label: 'Settings', target: 'settings', icon: ICONS.settings },
  { id: 'more', label: 'More', target: 'soon', icon: ICONS.more }
]

export interface DifficultySpec {
  level: PracticeAiLevel
  label: string
  blurb: string
}

/**
 * The practice difficulty selector.
 *
 * Derived from the shared tuple rather than written out, so the selector is exactly the
 * set the server's `z.enum(PRACTICE_AI_LEVELS)` accepts. A level invented here would be
 * rejected at the API and the failure would look like a server problem.
 */
export const DIFFICULTIES: readonly DifficultySpec[] = PRACTICE_AI_LEVELS.map((level) => {
  const spec: Record<PracticeAiLevel, { label: string; blurb: string }> = {
    EASY: { label: 'Easy', blurb: 'The robot misses a lot. Good for learning the table.' },
    MEDIUM: { label: 'Medium', blurb: 'A real opponent. Clear the reds if you can.' },
    HARD: { label: 'Hard', blurb: 'It will not give you an easy frame.' }
  }
  return { level, ...spec[level] }
})

/** The level the setup screen opens on: the middle one, which is also the server default. */
export const DEFAULT_DIFFICULTY: PracticeAiLevel = 'MEDIUM'

/**
 * What a tap on a `soon` entry says.
 *
 * One sentence naming the entry, so the toast is about the thing that was tapped rather
 * than a generic "unavailable".
 */
export function comingSoonMessage(label: string): string {
  return `${label} is coming soon.`
}

/** Narrows an untrusted value to a screen this build can actually draw. */
export function isAppScreen(value: unknown): value is AppScreen {
  return value === 'home' || value === 'practice' || value === 'multiplayer' || value === 'tournaments' || value === 'leaderboard' || value === 'settings'
}

/**
 * The screen a bar entry opens.
 *
 * Returns `null` for a `soon` entry, which is how the caller tells "navigate somewhere"
 * apart from "tell the player it is not here yet" without re-deriving the rule.
 */
export function barDestination(id: string): AppScreen | null {
  const item = HOME_BAR.find((entry) => entry.id === id)
  if (!item || item.target === 'soon') return null
  return item.target
}

/** The same question for the three cards, which never come back `soon`. */
export function cardDestination(id: string): AppScreen | null {
  const card = HOME_CARDS.find((entry) => entry.id === id)
  if (!card) return null
  return isAppScreen(card.target) ? card.target : null
}