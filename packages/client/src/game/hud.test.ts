import { describe, expect, it } from 'vitest'
import { BALL_IDS, COLOR_ORDER, TOTAL_REDS } from '@snooker/shared'
import {
  computePrizeCredits,
  describeBallOn,
  deriveHudState,
  formatCredits,
  type HudInput,
  type HudSnapshot
} from './hud.js'
import { ballColorHex } from './palette.js'

/**
 * A frame as the server would send it: 15 reds and 6 colours on the table, nothing
 * potted, the opening break with a red on.
 */
function fullTable(overrides: Partial<HudSnapshot> = {}): HudSnapshot {
  const balls = [
    { id: BALL_IDS.CUE, potted: false },
    ...Array.from({ length: TOTAL_REDS }, (_, i) => ({ id: BALL_IDS.RED_MIN + i, potted: false })),
    ...COLOR_ORDER.map((id) => ({ id, potted: false }))
  ]
  return {
    turnIndex: 0,
    ballOn: 'RED',
    scores: { player0: 0, player1: 0 },
    breakScore: 0,
    remainingReds: TOTAL_REDS,
    balls,
    ...overrides
  }
}

function input(overrides: Partial<HudInput> = {}): HudInput {
  return {
    snapshot: fullTable(),
    you: { name: 'player', isBot: false },
    opponent: { name: 'Robot', isBot: true },
    mySeat: 0,
    showMatchResult: true,
    prizeCredits: 180,
    framesWon: [0, 0],
    frameIndex: 1,
    format: 'BO3',
    practice: false,
    ...overrides
  }
}

/** Marks a ball potted in a snapshot without rebuilding the whole table. */
function pot(snapshot: HudSnapshot, id: number): HudSnapshot {
  return {
    ...snapshot,
    balls: snapshot.balls.map((b) => (b.id === id ? { ...b, potted: true } : b))
  }
}

describe('balls strip: reds remaining', () => {
  it('starts with a full set of fifteen reds', () => {
    const state = deriveHudState(input())
    expect(state.reds.total).toBe(TOTAL_REDS)
    expect(state.reds.remaining).toBe(TOTAL_REDS)
    expect(state.reds.onTable).toHaveLength(TOTAL_REDS)
    expect(state.reds.onTable.every(Boolean)).toBe(true)
  })

  it('drops one dot per red the server says is potted', () => {
    let snapshot = fullTable()
    for (let i = 0; i < 4; i++) snapshot = pot(snapshot, BALL_IDS.RED_MIN + i)
    // A real snapshot keeps the count and the flags in step, so both move together.
    snapshot = { ...snapshot, remainingReds: 11 }
    const state = deriveHudState(input({ snapshot }))
    expect(state.reds.remaining).toBe(11)
    expect(state.reds.onTable.filter(Boolean)).toHaveLength(11)
    // The first four dots are the ones the reds went from.
    expect(state.reds.onTable.slice(0, 4)).toEqual([false, false, false, false])
  })

  it('puts a respotted red back on the strip', () => {
    // A red potted in a foul is re-spotted by the rules, so the authoritative flag
    // goes back to false on the next snapshot and the dot has to come back with it.
    const before = deriveHudState(input({ snapshot: pot(fullTable(), BALL_IDS.RED_MIN) }))
    expect(before.reds.onTable.filter(Boolean)).toHaveLength(TOTAL_REDS - 1)
    const after = deriveHudState(input({ snapshot: fullTable() }))
    expect(after.reds.onTable.filter(Boolean)).toHaveLength(TOTAL_REDS)
  })

  it('reads the count from the server rather than counting dots', () => {
    const snapshot = { ...fullTable(), remainingReds: 7 }
    const state = deriveHudState(input({ snapshot }))
    expect(state.reds.remaining).toBe(7)
  })
})

describe('balls strip: colours', () => {
  it('lists all six colours in value order', () => {
    const state = deriveHudState(input())
    expect(state.colours.map((c) => c.id)).toEqual(COLOR_ORDER)
    expect(state.colours.map((c) => c.value)).toEqual([2, 3, 4, 5, 6, 7])
    expect(state.colours.map((c) => c.name)).toEqual([
      'yellow',
      'green',
      'brown',
      'blue',
      'pink',
      'black'
    ])
  })

  it('dims a colour once it is off the table', () => {
    const snapshot = pot(pot(fullTable(), BALL_IDS.BLUE), BALL_IDS.PINK)
    const state = deriveHudState(input({ snapshot }))
    const blue = state.colours.find((c) => c.id === BALL_IDS.BLUE)!
    const pink = state.colours.find((c) => c.id === BALL_IDS.PINK)!
    const black = state.colours.find((c) => c.id === BALL_IDS.BLACK)!
    expect(blue.onTable).toBe(false)
    expect(pink.onTable).toBe(false)
    expect(black.onTable).toBe(true)
  })

  it('brings a colour back when the rules re-spot it', () => {
    // Re-spotting a colour is the rules' job, not the HUD's. What the HUD owes is to
    // follow the authoritative pot flag in both directions, so a colour that has
    // been put back on the table is no longer dimmed.
    const out = deriveHudState(input({ snapshot: pot(fullTable(), BALL_IDS.YELLOW) }))
    expect(out.colours.find((c) => c.id === BALL_IDS.YELLOW)!.onTable).toBe(false)
    const back = deriveHudState(input({ snapshot: fullTable() }))
    expect(back.colours.find((c) => c.id === BALL_IDS.YELLOW)!.onTable).toBe(true)
  })

  it('never dims a colour it has not been told about', () => {
    const partial: HudSnapshot = { ...fullTable(), balls: [{ id: BALL_IDS.CUE, potted: false }] }
    const state = deriveHudState(input({ snapshot: partial }))
    expect(state.colours.every((c) => c.onTable)).toBe(true)
  })
})

describe('balls strip: what is on', () => {
  it('highlights nothing but the reds when a red is on', () => {
    const state = deriveHudState(input())
    expect(state.redsOn).toBe(true)
    expect(state.colours.every((c) => !c.on)).toBe(true)
  })

  it('highlights exactly the named colour', () => {
    const snapshot = { ...fullTable(), ballOn: `colour:${BALL_IDS.BLUE}`, remainingReds: 0 }
    const state = deriveHudState(input({ snapshot }))
    expect(state.redsOn).toBe(false)
    expect(state.colours.filter((c) => c.on).map((c) => c.id)).toEqual([BALL_IDS.BLUE])
  })

  it('highlights every colour still on the table when any colour is on', () => {
    const snapshot = { ...fullTable(), ballOn: 'ANY_COLOUR', remainingReds: 0 }
    const state = deriveHudState(input({ snapshot }))
    expect(state.colours.filter((c) => c.on)).toHaveLength(COLOR_ORDER.length)
  })

  it('does not highlight a colour that has already gone', () => {
    const snapshot = { ...pot(fullTable(), BALL_IDS.BLACK), ballOn: 'ANY_COLOUR', remainingReds: 0 }
    const state = deriveHudState(input({ snapshot }))
    const black = state.colours.find((c) => c.id === BALL_IDS.BLACK)!
    expect(black.onTable).toBe(false)
    expect(black.on).toBe(false)
  })
})

describe('balls are global table state, not player property', () => {
  /*
   * The mistake this guards against is the one 8-ball invites: a scorecard that shows
   * "your balls" and "their balls". Snooker has no such split, so the two player
   * objects must never grow a ball field, and the strip must be derived from the one
   * shared snapshot rather than from either side.
   */
  it('gives a player side nothing but a name, a score and whose turn it is', () => {
    const state = deriveHudState(input())
    for (const side of [state.you, state.opponent]) {
      expect(Object.keys(side).sort()).toEqual(['active', 'avatarUrl', 'isBot', 'name', 'points'])
    }
  })

  it('reads the same single set of balls whichever player is at the table', () => {
    const mine = deriveHudState(input({ mySeat: 0, snapshot: fullTable({ turnIndex: 0 }) }))
    const theirs = deriveHudState(input({ mySeat: 0, snapshot: fullTable({ turnIndex: 1 }) }))
    // Only whose turn it is may differ. The reds, the colours and the ball on are the
    // table's, so two clients watching the same frame must agree on all of them.
    expect(theirs.reds).toEqual(mine.reds)
    expect(theirs.colours).toEqual(mine.colours)
    expect(theirs.ballOnLabel).toBe(mine.ballOnLabel)
  })

  it('does not move a ball indicator to the player who potted it', () => {
    // A red potted while sitting at the table is a red off the table. It leaves the
    // shared count and it does not become anything belonging to the striker.
    const snapshot: HudSnapshot = { ...pot(fullTable(), BALL_IDS.RED_MIN), remainingReds: TOTAL_REDS - 1 }
    const state = deriveHudState(input({ mySeat: 0, snapshot }))
    expect(state.reds.remaining).toBe(TOTAL_REDS - 1)
    expect(state.reds.onTable[0]).toBe(false)
    expect(Object.keys(state.you)).not.toContain('reds')
  })

  it('reads the count from the server rather than counting the dots', () => {
    // The number and the dots are two different things in a snapshot, and the number
    // is the server's. A client that counted its own dots would be doing arithmetic
    // the game is supposed to be doing, and would be wrong the moment a snapshot
    // arrived mid-replay.
    const partial: HudSnapshot = { ...fullTable(), remainingReds: 9 }
    expect(deriveHudState(input({ snapshot: partial })).reds.remaining).toBe(9)
  })
})

describe('top bar: the turn', () => {
  it('marks the player whose seat the server says is at the table', () => {
    const mine = deriveHudState(input({ mySeat: 0, snapshot: fullTable({ turnIndex: 0 }) }))
    expect(mine.you.active).toBe(true)
    expect(mine.opponent.active).toBe(false)

    const theirs = deriveHudState(input({ mySeat: 0, snapshot: fullTable({ turnIndex: 1 }) }))
    expect(theirs.you.active).toBe(false)
    expect(theirs.opponent.active).toBe(true)
  })

  it('flips the other way when this client is in seat 1', () => {
    const state = deriveHudState(input({ mySeat: 1, snapshot: fullTable({ turnIndex: 0 }) }))
    expect(state.you.active).toBe(false)
    expect(state.opponent.active).toBe(true)
  })

  it('marks nobody before the server has said which seat this is', () => {
    const state = deriveHudState(input({ mySeat: undefined }))
    expect(state.you.active).toBe(false)
    expect(state.opponent.active).toBe(false)
  })
})

describe('top bar: prize and frames', () => {
  it('shows the prize and the frames score in a real match', () => {
    const state = deriveHudState(input({ framesWon: [1, 0], prizeCredits: 180 }))
    expect(state.prize).toBe('180 CR')
    expect(state.frames).toBe('1 : 0')
  })

  it('shows neither in practice against the robot', () => {
    const state = deriveHudState(input({ practice: true, framesWon: [2, 1] }))
    expect(state.prize).toBeNull()
    expect(state.frames).toBeNull()
  })

  it('shows neither when the caller says the match is not a staked one', () => {
    const state = deriveHudState(input({ showMatchResult: false }))
    expect(state.prize).toBeNull()
    expect(state.frames).toBeNull()
  })

  it('shows no prize when nothing is on the table', () => {
    expect(deriveHudState(input({ prizeCredits: 0 })).prize).toBeNull()
  })

  it('shows the frame points under each name in a real match', () => {
    const snapshot = fullTable({ scores: { player0: 34, player1: 12 } })
    const state = deriveHudState(input({ snapshot, mySeat: 0 }))
    expect(state.you.points).toBe(34)
    expect(state.opponent.points).toBe(12)
  })

  it('withholds the frame points in practice', () => {
    const snapshot = fullTable({ scores: { player0: 34, player1: 12 } })
    const state = deriveHudState(input({ snapshot, practice: true }))
    expect(state.you.points).toBeNull()
    expect(state.opponent.points).toBeNull()
  })

  it('withholds the frame points until a snapshot has arrived', () => {
    const state = deriveHudState(input({ snapshot: null }))
    expect(state.you.points).toBeNull()
    expect(state.opponent.points).toBeNull()
  })
})

describe('prize arithmetic', () => {
  it('matches the server: pool is both stakes, the fee is a share of the pool', () => {
    // The server does round(stake * 2), then round(pool * fee), then round(pool - fee).
    expect(computePrizeCredits(100, 0.1)).toBe(180)
    expect(computePrizeCredits(500, 0.1)).toBe(900)
    expect(computePrizeCredits(1000, 0.1)).toBe(1800)
  })

  it('is zero for a free table', () => {
    expect(computePrizeCredits(0, 0.1)).toBe(0)
  })

  it('handles a commission of zero without float dust', () => {
    expect(computePrizeCredits(100, 0)).toBe(200)
    expect(formatCredits(computePrizeCredits(100, 0))).toBe('200 CR')
  })
})

describe('ball on wording', () => {
  it('is the same sentence whichever half of the screen asks', () => {
    expect(describeBallOn('RED')).toBe('Ball on: red')
    expect(describeBallOn(undefined)).toBe('Ball on: red')
    expect(describeBallOn('ANY_COLOUR')).toBe('Ball on: any colour')
    expect(describeBallOn(`colour:${BALL_IDS.PINK}`)).toBe('Ball on: pink')
    expect(describeBallOn('colour:999')).toBe('Ball on: colour')
    expect(describeBallOn('nonsense')).toBe('Ball on: colour')
  })

  it('is carried into the state the HUD renders', () => {
    expect(deriveHudState(input()).ballOnLabel).toBe('Ball on: red')
    expect(deriveHudState(input({ snapshot: { ...fullTable(), ballOn: `colour:${BALL_IDS.BLACK}` } })).ballOnLabel).toBe(
      'Ball on: black'
    )
  })
})

describe('break score', () => {
  it('shows the running break and nothing at zero', () => {
    expect(deriveHudState(input({ snapshot: fullTable({ breakScore: 24 }) })).breakLabel).toBe('Break 24')
    expect(deriveHudState(input()).breakLabel).toBeNull()
  })
})

describe('ball in hand', () => {
  it('points the break-off at the D', () => {
    const state = deriveHudState(input({ snapshot: fullTable({ cueInHand: true, cueInHandInD: true }) }))
    expect(state.cueInHand).toBe(true)
    expect(state.cueInHandInD).toBe(true)
  })

  it('lets a mid-frame in-hand go anywhere on the table', () => {
    const state = deriveHudState(input({ snapshot: fullTable({ cueInHand: true, cueInHandInD: false }) }))
    expect(state.cueInHand).toBe(true)
    expect(state.cueInHandInD).toBe(false)
  })

  it('reads an absent flag as unrestricted rather than as a break-off', () => {
    const state = deriveHudState(input({ snapshot: fullTable({ cueInHand: true }) }))
    expect(state.cueInHandInD).toBe(false)
  })
})

describe('the HUD uses the same colours as the table', () => {
  it('paints each chip with the ball it stands for', () => {
    const state = deriveHudState(input())
    for (const chip of state.colours) {
      expect(ballColorHex(chip.id)).toMatch(/^#[0-9a-f]{6}$/)
    }
    expect(ballColorHex(BALL_IDS.YELLOW)).toBe('#f4c430')
    expect(ballColorHex(BALL_IDS.BLUE)).toBe('#1e6fd9')
    expect(ballColorHex(BALL_IDS.BLACK)).toBe('#1a1a1e')
  })

  it('falls back to the red for the fifteen reds', () => {
    expect(ballColorHex(BALL_IDS.RED_MIN)).toBe('#d62828')
    expect(ballColorHex(BALL_IDS.RED_MAX)).toBe('#d62828')
  })
})
