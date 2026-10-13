import { describe, expect, it } from 'vitest'
import { PRACTICE_AI_LEVELS } from '@snooker/shared'
import {
  DEFAULT_DIFFICULTY,
  DIFFICULTIES,
  HOME_BAR,
  HOME_CARDS,
  barDestination,
  cardDestination,
  comingSoonMessage,
  isAppScreen
} from './lobbyModel.js'

const SVG_OPEN =
  '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'

const allIcons = HOME_BAR.map((b) => ({ where: `bar ${b.id}`, svg: b.icon }))

describe('the home screen cards', () => {
  it('is exactly the three the screen is meant to have', () => {
    expect(HOME_CARDS.map((c) => c.label)).toEqual(['Practice', 'Multiplayer', 'Tournament'])
  })

  it('gives every card a title and a one-line description', () => {
    for (const card of HOME_CARDS) {
      expect(card.label.length).toBeGreaterThan(0)
      expect(card.blurb.length).toBeGreaterThan(0)
      // One line: a description that wraps to four is a paragraph wearing a card's clothes.
      expect(card.blurb.length).toBeLessThanOrEqual(90)
      expect(card.blurb.endsWith('.')).toBe(true)
    }
  })

  it('draws every card its own emblem, in code, with no image to fetch', () => {
    for (const card of HOME_CARDS) {
      // Drawn, not loaded: a card with a picture file in it is a request that can fail, a
      // thing to letterbox and a second art slot to keep in step. One inline SVG, and the
      // ids inside it are unique per card so three of them can share the page.
      expect(card.emblem.startsWith('<svg'), `${card.id} has no emblem`).toBe(true)
      expect(card.emblem.endsWith('</svg>'), `${card.id} emblem does not close`).toBe(true)
      expect(card.emblem).not.toMatch(/<image\b|xlink:href|href=/)
      expect(card.emblem, `${card.id} emblem is not hidden from a screen reader`).toContain('aria-hidden="true"')
      expect(card.emblem, `${card.id} emblem has no gradient of its own`).toMatch(/<(linear|radial)Gradient/)
      for (const id of card.emblem.match(/id="([^"]+)"/g) ?? []) {
        expect(HOME_CARDS.filter((c) => c !== card).map((c) => c.emblem).join('')).not.toContain(id)
      }
    }
  })

  it('gives every card a category badge and one fact promoted to its state', () => {
    for (const card of HOME_CARDS) {
      expect(card.badge.length).toBeGreaterThan(0)
      // The state is one of the two facts rather than a third claim, so the card cannot end
      // up printing the same words twice.
      expect([0, 1]).toContain(card.statusIndex)
      expect(card.chips[card.statusIndex]).toBeTruthy()
    }
    expect(HOME_CARDS.map((c) => c.badge)).toEqual(['Training', 'Online', 'Knockout'])
    expect(HOME_CARDS.map((c) => c.chips[c.statusIndex])).toEqual(['Free play', 'Real players', '8 players'])
  })

  it('states two facts per card, and no price or prize among them', () => {
    for (const card of HOME_CARDS) {
      expect(card.chips.length).toBe(2)
      for (const chip of card.chips) {
        expect(chip.length).toBeGreaterThan(0)
        // Stakes and payouts are decided by the server's settings at runtime, so a chip
        // that named one would be a number this screen could not keep true.
        expect(chip, `${card.id} names a price or a prize`).not.toMatch(/\bCR\b|\$|%|credits \d/i)
      }
    }
  })

  it('has three distinct ids, which is how the wiring addresses them', () => {
    expect(new Set(HOME_CARDS.map((c) => c.id)).size).toBe(HOME_CARDS.length)
  })

  it('sends Practice to the setup screen rather than straight into a match', () => {
    // The setup screen is where difficulty is chosen. A card that started the match
    // itself would have nowhere to put that choice.
    expect(cardDestination('practice')).toBe('practice')
  })

  it('sends Multiplayer and Tournament to the flows that already exist', () => {
    expect(cardDestination('multiplayer')).toBe('multiplayer')
    expect(cardDestination('tournament')).toBe('tournaments')
  })

  it('has no card that goes nowhere', () => {
    for (const card of HOME_CARDS) expect(cardDestination(card.id)).not.toBeNull()
  })

  it('answers nothing for a card that does not exist', () => {
    expect(cardDestination('nope')).toBeNull()
  })
})

describe('the bottom bar', () => {
  it('carries all five entries, in the order the screen shows them', () => {
    expect(HOME_BAR.map((b) => b.id)).toEqual(['shop', 'friends', 'leaderboard', 'settings', 'more'])
    expect(HOME_BAR.map((b) => b.label)).toEqual(['Shop', 'Friends', 'Leaderboard', 'Settings', 'More'])
  })

  it('navigates for the two that have a screen behind them', () => {
    expect(barDestination('leaderboard')).toBe('leaderboard')
    expect(barDestination('settings')).toBe('settings')
  })

  it('goes nowhere for the three that have no backend yet', () => {
    // Shop, Friends and More are front-end only in this phase. The point of the test is
    // that the wiring cannot grow a destination for them by accident: adding one here is
    // a deliberate act with a server behind it, not a side effect of a refactor.
    for (const id of ['shop', 'friends', 'more']) {
      const item = HOME_BAR.find((b) => b.id === id)
      expect(item?.target).toBe('soon')
      expect(barDestination(id)).toBeNull()
    }
  })

  it('says which entry is coming soon, rather than a generic failure', () => {
    expect(comingSoonMessage('Shop')).toBe('Shop is coming soon.')
    expect(comingSoonMessage('More')).toBe('More is coming soon.')
  })

  it('answers nothing for an entry that does not exist', () => {
    expect(barDestination('nope')).toBeNull()
  })
})

describe('the icon set', () => {
  it('is drawn in one style, so the bar does not read as five different languages', () => {
    for (const { where, svg } of allIcons) {
      expect(svg.startsWith(SVG_OPEN), `${where} opens differently`).toBe(true)
      expect(svg.endsWith('</svg>'), `${where} closes differently`).toBe(true)
    }
  })

  it('takes its colour from the element rather than baking one in', () => {
    // A hardcoded fill would be invisible against one theme and glaring against another.
    for (const { where, svg } of allIcons) {
      expect(svg, `${where} bakes in a colour`).not.toMatch(/fill="(?!none)/)
      expect(svg).toContain('stroke="currentColor"')
    }
  })

  it('carries no text, so an icon never repeats its own label', () => {
    for (const { where, svg } of allIcons) {
      // Everything outside the tags is text content, and an icon should have none: the
      // label beside it already says what it is.
      expect(svg.replace(/<[^>]*>/g, ''), `${where} has text in it`).toBe('')
    }
  })
})

describe('the practice difficulty selector', () => {
  it('offers exactly the levels the server accepts, in the server order', () => {
    expect(DIFFICULTIES.map((d) => d.level)).toEqual([...PRACTICE_AI_LEVELS])
    expect(DIFFICULTIES).toHaveLength(3)
  })

  it('offers Easy, Medium and Hard', () => {
    expect(DIFFICULTIES.map((d) => d.label)).toEqual(['Easy', 'Medium', 'Hard'])
  })

  it('describes each level in one line', () => {
    for (const d of DIFFICULTIES) {
      expect(d.blurb.length).toBeGreaterThan(0)
      expect(d.blurb.length).toBeLessThanOrEqual(90)
    }
  })

  it('opens on Medium, which is what the server defaults to', () => {
    expect(DEFAULT_DIFFICULTY).toBe('MEDIUM')
    expect(DIFFICULTIES.some((d) => d.level === DEFAULT_DIFFICULTY)).toBe(true)
  })
})

describe('the screen guard', () => {
  it('accepts every screen this build can draw', () => {
    for (const screen of ['home', 'practice', 'multiplayer', 'tournaments', 'leaderboard', 'settings'] as const) {
      expect(isAppScreen(screen)).toBe(true)
    }
  })

  it('refuses anything else, so a stale value cannot blank the app', () => {
    for (const value of [null, undefined, '', 'admin', 'match', 7, {}]) expect(isAppScreen(value)).toBe(false)
  })
})