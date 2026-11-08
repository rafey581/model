import { describe, expect, it } from 'vitest'
import {
  closeMatch,
  gateTableEvent,
  hudBoard,
  openMatch,
  tableAfterQueuedUpdate,
  type TableGate
} from './matchBoard.js'

interface Board {
  scores: { player0: number; player1: number }
  turnIndex: number
  balls: string
  ballOn: string
}

const rack = (over: Partial<Board> = {}): Board => ({
  scores: { player0: 0, player1: 0 },
  turnIndex: 0,
  balls: 'break',
  ballOn: 'RED',
  ...over
})

/**
 * What the client used to do with a socket message: the payload became the table.
 * `game:update` had no match id the handler read, and the socket was still in every
 * match room it had ever joined.
 */
function unguardedApply(event: { frame: Board }): Board {
  return event.frame
}

describe('practice score and table stay on the active match', () => {
  const live: TableGate = { activeMatchId: 'practice-2', lastSeq: 4 }
  const onScreen = rack({ scores: { player0: 8, player1: 1 }, balls: 'practice-2-after-red', turnIndex: 1 })

  it('used to replace the live score and balls with the previous practice match', () => {
    const stale = {
      matchId: 'practice-1',
      seq: 12,
      frame: rack({ scores: { player0: 34, player1: 22 }, balls: 'practice-1-colours', turnIndex: 0, ballOn: 'BLACK' })
    }
    // Before the gate, the message was the table. Score, turn, ball on and ball
    // positions moved together onto the match that was no longer on screen.
    expect(unguardedApply(stale)).toEqual(stale.frame)
    expect(unguardedApply(stale).scores).toEqual({ player0: 34, player1: 22 })
    expect(unguardedApply(stale).balls).toBe('practice-1-colours')

    const decision = gateTableEvent(live, stale)
    expect(decision.accept).toBe(false)
    expect(decision.lastSeq).toBe(live.lastSeq)
    // The board on screen is left exactly as it was: score and balls stay a pair.
    expect(onScreen).toEqual(rack({ scores: { player0: 8, player1: 1 }, balls: 'practice-2-after-red', turnIndex: 1 }))
  })

  it('refuses a table message that names no match', () => {
    expect(gateTableEvent(live, { seq: 9 }).accept).toBe(false)
    expect(gateTableEvent(live, { matchId: null, seq: 9 }).accept).toBe(false)
  })

  it('refuses every table message once the player has left', () => {
    const closed = closeMatch(live)
    expect(closed.leaveMatchId).toBe('practice-2')
    expect(closed.session.activeMatchId).toBeNull()
    expect(gateTableEvent(closed.session, { matchId: 'practice-2', seq: 5 }).accept).toBe(false)
    expect(gateTableEvent(closed.session, { matchId: 'practice-2', seq: 100 }, true).accept).toBe(false)
  })

  it('applies a later message for the match on screen, score and balls together', () => {
    const next = rack({ scores: { player0: 9, player1: 1 }, balls: 'practice-2-after-red-again', turnIndex: 1 })
    const decision = gateTableEvent(live, { matchId: 'practice-2', seq: 5 })
    expect(decision).toEqual({ accept: true, lastSeq: 5 })
    // One message owns the whole board. The score is not taken from a different frame
    // than the balls.
    expect(next.scores.player0).toBe(9)
    expect(next.balls).toBe('practice-2-after-red-again')
  })

  it('drops a late message that is older than the board already showing', () => {
    const late = gateTableEvent(live, { matchId: 'practice-2', seq: 2 })
    expect(late.accept).toBe(false)
    expect(late.lastSeq).toBe(4)
    // A clock or a settle with no sequence still belongs to this match.
    expect(gateTableEvent(live, { matchId: 'practice-2' }).accept).toBe(true)
  })

  it('lets a rejoin replace the board even when the page still remembers a higher sequence', () => {
    const rejoined = gateTableEvent({ activeMatchId: 'practice-2', lastSeq: 40 }, { matchId: 'practice-2', seq: 6 }, true)
    expect(rejoined).toEqual({ accept: true, lastSeq: 6 })
  })

  it('leaves the previous match when a new one is opened and forgets its sequence', () => {
    const opened = openMatch(live, 'practice-3')
    expect(opened.leaveMatchId).toBe('practice-2')
    expect(opened.session).toEqual({ activeMatchId: 'practice-3', lastSeq: -1 })
    // The first real message of the new match is not blocked by the old one's sequence.
    expect(gateTableEvent(opened.session, { matchId: 'practice-3', seq: 0 }).accept).toBe(true)
    // And the match just left cannot write the new table, however high its sequence.
    expect(gateTableEvent(opened.session, { matchId: 'practice-2', seq: 99 }).accept).toBe(false)
    // Opening the match that is already open does not ask for it to be torn down.
    expect(openMatch(opened.session, 'practice-3').leaveMatchId).toBeNull()
  })
})

describe('the HUD board and the drawn table stay one match', () => {
  const previous = rack({ scores: { player0: 34, player1: 12 }, balls: 'before-shot' })
  const after = rack({ scores: { player0: 41, player1: 12 }, balls: 'red-gone', ballOn: 'YELLOW' })

  it('holds the pre-shot board through a replay of this match', () => {
    const held = hudBoard({ matchId: 'practice-2', shown: previous }, 'practice-2', true, after)
    expect(held.board).toEqual(previous)
    expect(held.shown).toEqual(previous)
  })

  it('catches the HUD up when the replay ends', () => {
    const caught = hudBoard({ matchId: 'practice-2', shown: previous }, 'practice-2', false, after)
    expect(caught.board).toEqual(after)
  })

  it('does not keep the previous match on the HUD while its replay flag is still set', () => {
    // enterMatch used to leave the replay player running and the HUD holding that
    // replay's frame, so the new table opened under the old score.
    const held = hudBoard({ matchId: 'practice-1', shown: previous }, 'practice-2', true, null)
    expect(held.board).toBeNull()
    expect(held.matchId).toBe('practice-2')
  })

  it('shows the new match as soon as its own snapshot arrives', () => {
    const shown = hudBoard({ matchId: null, shown: previous }, 'practice-2', false, after)
    expect(shown.board).toEqual(after)
    expect(shown.matchId).toBe('practice-2')
  })

  it('clears the HUD when the match is left', () => {
    expect(hudBoard({ matchId: 'practice-2', shown: previous }, null, true, after).board).toBeNull()
  })

  it('draws a queued respot or new frame immediately instead of the table before it', () => {
    const fresh = rack({ scores: { player0: 0, player1: 0 }, balls: 'new-rack', turnIndex: 1 })
    // The score readout follows `fresh` on this paint. The balls have to as well.
    expect(tableAfterQueuedUpdate(previous, fresh)).toEqual(fresh)
    expect(tableAfterQueuedUpdate(previous, null)).toEqual(previous)
  })
})
