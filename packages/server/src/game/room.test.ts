import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GameRoom, type RoomCallbacks, type ShotInputDto } from './room.js'

/**
 * The playback hold is the room's pacing gate: a shot may not be broadcast until
 * the one before it has been watched through. These cover who is allowed to end
 * that wait, because a hold ended by the wrong report either lets the next shot
 * land on top of an animation or wedges the match for the whole backstop.
 */

const MATCH_ID = 'match-hold'

const SHOT: ShotInputDto = { aimAngle: 0, power: 0.5, spin: { x: 0, y: 0 } }

function callbacks(): RoomCallbacks & { broadcasts: { event: string; payload: any }[] } {
  const broadcasts: { event: string; payload: any }[] = []
  return {
    broadcasts,
    board: {
      to: () => ({ emit: (event: string, payload: any) => broadcasts.push({ event, payload }) })
    } as unknown as RoomCallbacks['board'],
    persist: async () => {},
    onFrameEnd: async () => {},
    onMatchEnd: async () => {},
    log: () => {}
  }
}

/**
 * A room where A is connected and B is seated but has no socket, so the turn can
 * alternate to B between shots while only A is ever watching.
 */
function seatedRoom(opts: { connect?: ('a' | 'b')[] } = {}) {
  const connect = opts.connect ?? ['a']
  const cbs = callbacks()
  const room = new GameRoom(MATCH_ID, 'RANKED', 'BO1', 0, undefined, cbs, 30)
  for (const seat of ['a', 'b'] as const) {
    const userId = seat === 'a' ? 'user-a' : 'user-b'
    if (connect.includes(seat)) {
      room.registerSocket(userId, seat === 'a' ? 0 : 1, `sock-${seat}`)
    } else {
      room.seatOfUser.set(userId, seat === 'a' ? 0 : 1)
    }
  }
  return { room, cbs }
}

/** The token on the most recent game:update, which is what a client echoes back. */
function lastToken(cbs: ReturnType<typeof callbacks>): number | undefined {
  const updates = cbs.broadcasts.filter((b) => b.event === 'game:update')
  return updates[updates.length - 1]?.payload?.playback?.token
}

/** The user id of whoever currently holds the turn in this match. */
function currentStriker(room: GameRoom): 'user-a' | 'user-b' {
  return room.match.currentFrame?.turnIndex === 1 ? 'user-b' : 'user-a'
}

/**
 * Puts the cue ball down through the placement path, if the frame has it in hand.
 *
 * A striker no longer places by playing a zero-power shot with a `cuePos` attached -
 * that is precisely the bug this suite now pins - so anything that needs a playable
 * table has to place the cue properly first. The ball goes down on its own layout
 * spot, which is a legal D placement, and no stroke is played: the visit is still the
 * striker's afterwards.
 */
function placeCueIfInHand(room: GameRoom): void {
  const frame = room.match.currentFrame
  if (!frame?.cueInHand) return
  const turn = frame.turnIndex
  const userId = turn === 1 ? 'user-b' : 'user-a'
  const cue = frame.balls.find((b) => b.isCue)
  if (!cue) throw new Error('frame has no cue ball')
  const spot = { x: cue.pos.x, y: cue.pos.y }
  expect(room.handlePlacementBegin(userId).accepted).toBe(true)
  expect(room.handlePlacementConfirm(userId, spot).accepted).toBe(true)
  // The two-phase flow requires the client to report camera-home before the hold lifts.
  expect(room.handlePlacementDone(userId).accepted).toBe(true)
}

/**
 * Rejection reason for a shot that is not allowed right now, or null if allowed.
 *
 * Probed as whoever currently holds the turn. The turn alternates after every shot,
 * and `handleShot` checks the turn before the playback hold, so asking a player who
 * is not on would always answer "not your turn" and hide the hold entirely.
 *
 * This really does play the shot when it is allowed, which is how the hold is
 * started. Where a test only needs to *look* at the hold, use `isHeld` instead.
 */
function blockedReason(room: GameRoom): string | null {
  placeCueIfInHand(room)
  const turn = room.match.currentFrame?.turnIndex
  const userId = turn === 1 ? 'user-b' : 'user-a'
  const result = room.handleShot(userId, SHOT)
  return result.accepted ? null : (result.error ?? 'unknown')
}

/**
 * Whether a shot by the player on would be refused for being mid-animation.
 *
 * Read without playing anything, so a test can assert on the hold without the
 * probe itself advancing the match.
 */
function isHeld(room: GameRoom): boolean {
  placeCueIfInHand(room)
  const turn = room.match.currentFrame?.turnIndex
  const userId = turn === 1 ? 'user-b' : 'user-a'
  return room.handleShot(userId, SHOT).error === 'wait for the table to settle'
}

describe('playback hold', () => {
  it('refuses a second shot until the current one has been acknowledged', () => {
    const { room, cbs } = seatedRoom()
    expect(blockedReason(room)).toBeNull()
    const token = lastToken(cbs)
    expect(typeof token).toBe('number')

    // The table is animating, so nothing else may be played into it.
    expect(blockedReason(room)).toBe('wait for the table to settle')

    room.noteShotPlayed('user-a', token, 'sock-a')
    expect(blockedReason(room)).toBeNull()
  })

  it('ignores an acknowledgement carrying no token', () => {
    const { room, cbs } = seatedRoom()
    blockedReason(room)
    const token = lastToken(cbs)

    // A client that is behind has never been told a token. It cannot be talking
    // about the animation on screen, so the hold has to survive.
    room.noteShotPlayed('user-a', undefined, 'sock-a')
    expect(blockedReason(room)).toBe('wait for the table to settle')

    room.noteShotPlayed('user-a', token, 'sock-a')
    expect(blockedReason(room)).toBeNull()
  })

  it('reports a pacing refusal only to the striker it is actually blocking', () => {
    // The rate limiter exempts a shot refused purely for pacing, so it has to be able
    // to tell that case apart from every other refusal. If it guessed wrong it would
    // hand a flooder a free, unmetered path through the only guard on the shot handler.
    const { room, cbs } = seatedRoom()
    // Whoever is on to begin with is not waiting on anything yet.
    expect(room.pacingRejection(currentStriker(room))).toBeNull()

    blockedReason(room)
    const token = lastToken(cbs)

    // The hold belongs to whoever is at the table now, which is not necessarily who
    // played the shot, because a foul passes the turn while the replay is still on.
    const on = currentStriker(room)
    const off = on === 'user-a' ? 'user-b' : 'user-a'
    // That is the one shot the exemption is allowed to cover: the striker, who is
    // being told to wait.
    expect(room.pacingRejection(on)).toBe('wait for the table to settle')
    // The player now off is refused for being out of turn, not for pacing. Exempting
    // that would let anyone pump shots at any rate.
    expect(room.pacingRejection(off)).toBeNull()
    // Nor is somebody who is not in this match.
    expect(room.pacingRejection('user-outsider')).toBeNull()

    // Once the replay is released the exemption stops applying, so the next shot is
    // metered by the bucket like any other. Only A has a socket here, so A is the one
    // that can report the playback finished.
    room.noteShotPlayed('user-a', token, 'sock-a')
    expect(room.pacingRejection(on)).toBeNull()
  })

  it('ignores an acknowledgement for a shot that has already been released', () => {
    const { room, cbs } = seatedRoom()
    blockedReason(room)
    const first = lastToken(cbs)
    room.noteShotPlayed('user-a', first, 'sock-a')

    // The next shot gets a new token, and the old one must not end its hold.
    blockedReason(room)
    const second = lastToken(cbs)
    expect(second).not.toBe(first)
    room.noteShotPlayed('user-a', first, 'sock-a')
    expect(blockedReason(room)).toBe('wait for the table to settle')

    room.noteShotPlayed('user-a', second, 'sock-a')
    expect(blockedReason(room)).toBeNull()
  })

  it('only accepts an acknowledgement from a player seated in the match', () => {
    const { room, cbs } = seatedRoom()
    blockedReason(room)
    const token = lastToken(cbs)

    // An outsider who guessed the match id must not be able to release the hold.
    room.noteShotPlayed('intruder', token, 'sock-a')
    expect(blockedReason(room)).toBe('wait for the table to settle')

    // Only the socket that was actually watching may end it.
    room.noteShotPlayed('user-a', token, 'sock-a')
    expect(blockedReason(room)).toBeNull()
  })

  it('refuses an acknowledgement from a seated player who was not watching', () => {
    // The other player is in the match but has no socket, so they were never sent the
    // replay and have seen none of it. Their report carries a token they could only
    // have guessed, and accepting it would end the shooter's animation the moment it
    // started, which is exactly what the hold exists to prevent.
    const { room, cbs } = seatedRoom()
    blockedReason(room)
    const token = lastToken(cbs)

    room.noteShotPlayed('user-b', token, 'sock-b')
    expect(blockedReason(room)).toBe('wait for the table to settle')
  })

  it('releases the hold when the last connected player disconnects', () => {
    const { room, cbs } = seatedRoom({ connect: ['a', 'b'] })
    expect(blockedReason(room)).toBeNull()
    const token = lastToken(cbs)
    expect(isHeld(room)).toBe(true)

    // One player leaving is not enough: the other is still watching.
    room.unregisterSocket('user-a', 'sock-a')
    expect(isHeld(room)).toBe(true)

    room.unregisterSocket('user-b', 'sock-b')
    // Releasing the hold must not itself broadcast anything, so the shot that was
    // being held is still the last one sent.
    expect(lastToken(cbs)).toBe(token)
    // With nobody left to watch, holding only stalls the match for the backstop.
    expect(isHeld(room)).toBe(false)
  })

  it('does not hold a shot taken while every player is disconnected', () => {
    // Nobody is connected, so nothing can watch this animation. Holding it would
    // make the room sit out the backstop, and a player returning would find the
    // match stalled rather than merely settled.
    const cbs = callbacks()
    const room = new GameRoom(MATCH_ID, 'RANKED', 'BO1', 0, undefined, cbs, 30)
    // Both players seated in the match, but with no socket attached.
    room.seatOfUser.set('user-a', 0)
    room.seatOfUser.set('user-b', 1)
    expect(blockedReason(room)).toBeNull()
    // The shot played, and because nobody was watching there is nothing to wait for.
    expect(isHeld(room)).toBe(false)
  })

  it('keeps holding while one of several connections remains', () => {
    const { room, cbs } = seatedRoom()
    // A second window for the same player.
    room.registerSocket('user-a', 0, 'sock-a2')
    blockedReason(room)
    const token = lastToken(cbs)

    // Closing one window leaves the other watching, so the hold stands.
    room.unregisterSocket('user-a', 'sock-a')
    expect(isHeld(room)).toBe(true)

    room.unregisterSocket('user-a', 'sock-a2')
    expect(isHeld(room)).toBe(false)
  })

  it('gives every shot a fresh token, in order', () => {
    const { room, cbs } = seatedRoom()
    const tokens: number[] = []
    for (let i = 0; i < 3; i++) {
      blockedReason(room)
      const token = lastToken(cbs)
      tokens.push(token!)
      // Whoever is on acknowledges; a seated player may ack any shot they watched.
      room.noteShotPlayed('user-a', token, 'sock-a')
      room.noteShotPlayed('user-b', token, 'sock-b')
    }
    expect(tokens).toHaveLength(3)
    for (let i = 1; i < tokens.length; i++) {
      expect(tokens[i]!).toBeGreaterThan(tokens[i - 1]!)
    }
  })

  it('ignores a repeated acknowledgement for the same shot', () => {
    const { room, cbs } = seatedRoom()
    blockedReason(room)
    const first = lastToken(cbs)
    room.noteShotPlayed('user-a', first, 'sock-a')
    room.noteShotPlayed('user-b', first, 'sock-b')
    // The next shot starts a new hold under a new token.
    blockedReason(room)
    const second = lastToken(cbs)
    expect(second).toBeGreaterThan(first!)
    expect(isHeld(room)).toBe(true)

    // The duplicate belongs to the first shot, which is long gone, so it must not
    // end the second shot's hold.
    room.noteShotPlayed('user-a', first, 'sock-a')
    room.noteShotPlayed('user-b', first, 'sock-b')
    expect(isHeld(room)).toBe(true)
  })

  it('refuses an acknowledgement for a shot that was never held', () => {
    // The token counter moves on for every shot, including the ones nobody was
    // connected to watch and which therefore create no hold at all. A player
    // sitting on such a token is a participant, and their report looks perfectly
    // current next to the live one, but it is about a different shot and must not
    // end this one early.
    const cbs = callbacks()
    const room = new GameRoom(MATCH_ID, 'RANKED', 'BO1', 0, undefined, cbs, 30)
    room.seatOfUser.set('user-a', 0)
    room.seatOfUser.set('user-b', 1)

    // Neither player has a socket, so these two shots are played with nobody
    // watching and are never held.
    expect(blockedReason(room)).toBeNull()
    const unheld = lastToken(cbs)
    expect(typeof unheld).toBe('number')
    expect(blockedReason(room)).toBeNull()
    expect(lastToken(cbs)).not.toBe(unheld)

    // Now a player connects and the next shot is held for real.
    room.registerSocket('user-a', 0, 'sock-a')
    expect(blockedReason(room)).toBeNull()
    const held = lastToken(cbs)
    expect(held).toBeGreaterThan(unheld!)
    expect(isHeld(room)).toBe(true)

    // Acking from the socket that is genuinely watching, so the socket check cannot
    // be what rejects this. The token is a real one the client was sent, just not the
    // one for the shot on screen, and it must not end that shot early.
    room.noteShotPlayed('user-a', unheld, 'sock-a')
    expect(isHeld(room)).toBe(true)

    // Only the token of the shot actually being held releases it.
    room.noteShotPlayed('user-a', held, 'sock-a')
    expect(isHeld(room)).toBe(false)
  })

  it('ignores an acknowledgement when nothing is being held', () => {
    const { room, cbs } = seatedRoom()
    blockedReason(room)
    const token = lastToken(cbs)
    room.noteShotPlayed('user-a', token, 'sock-a')
    expect(isHeld(room)).toBe(false)

    // A late duplicate arriving after the hold was already released has nothing to
    // end. It must be inert rather than clearing the hold the next shot is about to
    // create, which is why the room tracks the held token separately.
    room.noteShotPlayed('user-a', token, 'sock-a')
    blockedReason(room)
    const next = lastToken(cbs)
    expect(next).toBeGreaterThan(token!)
    expect(isHeld(room)).toBe(true)
    room.noteShotPlayed('user-a', token, 'sock-a')
    expect(isHeld(room)).toBe(true)
  })

  it('releases a hold once the only watching socket has gone', () => {
    // A blip on the one watching connection, and the rejoin arrives before the old
    // socket is reaped. The room therefore never sees a moment with nobody watching,
    // and the reconnecting client is sent the settled snapshot, so it abandons the
    // replay and will never report back. Once the abandoned socket is finally reaped
    // there is nobody left who can end the hold, and the match must not sit stalled
    // against the backstop.
    const { room } = seatedRoom()
    expect(blockedReason(room)).toBeNull()
    expect(isHeld(room)).toBe(true)

    // The reconnected window lands while the original is still attached, so the room
    // never sees a moment with nobody watching and the hold correctly stands. This
    // socket arrived after the shot, so it is sent the settled snapshot and abandons
    // the replay rather than being able to end it.
    room.registerSocket('user-a', 0, 'sock-a2')
    expect(isHeld(room)).toBe(true)

    // The original window finally drops. The reconnected one is still attached, so
    // the old "is anybody connected" rule would have kept the hold and stalled the
    // match against the backstop with nobody watching anything.
    room.unregisterSocket('user-a', 'sock-a')
    expect(isHeld(room)).toBe(false)
  })

  it('lets a socket that was watching when the shot started end the hold', () => {
    // The other half of the rule: joining the watcher list is not a formality. A
    // second window opened before the shot was played is watching it and must still
    // be able to release it, otherwise the hold would be unreachable.
    const { room, cbs } = seatedRoom()
    room.registerSocket('user-a', 0, 'sock-a2')
    expect(blockedReason(room)).toBeNull()
    const token = lastToken(cbs)
    expect(isHeld(room)).toBe(true)

    room.noteShotPlayed('user-a', token, 'sock-a2')
    expect(isHeld(room)).toBe(false)
  })

  it('keeps a hold while another player is still connected and watching', () => {
    // The same reconnect, but the opponent never dropped. They are part-way through
    // the replay, which is the entire reason the hold exists, so their animation must
    // run to the end.
    const { room, cbs } = seatedRoom({ connect: ['a', 'b'] })
    expect(blockedReason(room)).toBeNull()
    const token = lastToken(cbs)
    expect(isHeld(room)).toBe(true)

    room.registerSocket('user-a', 0, 'sock-a2')
    expect(isHeld(room)).toBe(true)

    // The opponent finishes watching and ends the hold as normal.
    room.noteShotPlayed('user-b', token, 'sock-b')
    expect(isHeld(room)).toBe(false)
  })
})

/**
 * The turn clock.
 *
 * The deadline a client draws is not the timeout the server enforces, but it comes from
 * the same place, so these check both together: that a clock only runs when a human
 * really is at the table, that it never runs while a shot is still being watched, and
 * that a client which comes back is told the truth rather than left to guess.
 */
describe('turn clock', () => {
  // The clock is measured in milliseconds against the server's own clock, so the
  // tests move time rather than wait for it. Everything here is about *when* a deadline
  // is set, and waiting 30 real seconds to find out would be the only way to test it
  // without this.
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function startedRoom(opts: { connect?: ('a' | 'b')[]; timeoutSec?: number } = {}) {
    const cbs = callbacks()
    const room = new GameRoom(
      MATCH_ID,
      'RANKED',
      'BO1',
      0,
      undefined,
      cbs,
      opts.timeoutSec ?? 30
    )
    for (const seat of ['a', 'b'] as const) {
      const userId = seat === 'a' ? 'user-a' : 'user-b'
      if ((opts.connect ?? ['a']).includes(seat)) {
        room.registerSocket(userId, seat === 'a' ? 0 : 1, `sock-${seat}`)
      } else {
        room.seatOfUser.set(userId, seat === 'a' ? 0 : 1)
      }
    }
    room.tryStart()
    return { room, cbs }
  }

  /** The timing the most recent table-state broadcast carried. */
  function lastTiming(cbs: ReturnType<typeof callbacks>): any {
    const update = cbs.broadcasts.filter((b) =>
      ['game:update', 'frame:start', 'match:start'].includes(b.event)
    )
    return update[update.length - 1]?.payload?.turn
  }

  /**
   * Places the cue and plays and watches the break-off, so the frame is past its
   * opening ball-in-hand.
   *
   * Two separate things, and the split is the point. Placing happens first and plays
   * nothing: no stroke, no foul, no change of turn. Only then is the break-off struck,
   * and the acknowledgement hands the visit on.
   */
  function playBreak(room: GameRoom, cbs: ReturnType<typeof callbacks>): void {
    placeCueIfInHand(room)
    const placed = room.handleShot('user-a', SHOT)
    expect(placed.accepted).toBe(true)
    room.noteShotPlayed('user-a', lastToken(cbs), 'sock-a')
  }

  it('runs from the opening ball in hand, and keeps running after the break is watched', () => {
    const { room, cbs } = startedRoom()
    // BALL_IN_HAND_PLACEMENT is the striker's turn being used: placing is part of
    // aiming, so the clock is live from frame start. A break-off a player never
    // completes must time out like any other unused turn, not stall the frame.
    const opening = room.turnTiming()
    expect(opening.turnDeadlineAt).not.toBeNull()
    expect(opening.turnDeadlineAt! - opening.serverNow).toBe(30_000)
    expect(opening.turnDurationMs).toBe(30_000)
    playBreak(room, cbs)
    // The break has been watched and the next visit is genuinely aiming: a fresh
    // full turn, announced to the clients as always.
    const timing = room.turnTiming()
    expect(timing.turnDeadlineAt).not.toBeNull()
    expect(timing.turnDeadlineAt! - timing.serverNow).toBe(30_000)
    expect(timing.turnDurationMs).toBe(30_000)
  })

  it('fouls a break-off the striker never completes, instead of stalling the frame', () => {
    // The regression this pins: a frame opens in hand, and a clock that refused to
    // run across placement could never fire — the frame hung forever on a player
    // who placed nothing. The timeout has to reach a placement turn.
    const { room, cbs } = startedRoom({ timeoutSec: 1 })
    expect(room.executionState()).toBe('BALL_IN_HAND_PLACEMENT')
    vi.advanceTimersByTime(1_500)
    const foul = cbs.broadcasts.some(
      (b) => b.event === 'game:update' && b.payload?.events?.some((e: any) => e.type === 'FOUL' && e.data?.reason === 'turn timeout')
    )
    expect(foul).toBe(true)
  })

  it('reports a duration of zero and no deadline when the clock is switched off', () => {
    const { room, cbs } = startedRoom({ timeoutSec: 0 })
    const timing = lastTiming(cbs)
    expect(timing.turnDeadlineAt).toBeNull()
    expect(timing.turnDurationMs).toBe(0)
  })

  it('has no deadline before the match has started', () => {
    const cbs = callbacks()
    const room = new GameRoom(MATCH_ID, 'RANKED', 'BO1', 0, undefined, cbs, 30)
    room.registerSocket('user-a', 0, 'sock-a')
    room.registerSocket('user-b', 1, 'sock-b')
    expect(room.turnTiming().turnDeadlineAt).toBeNull()
  })

  it('stops the moment a shot is committed, and does not run while it is watched', () => {
    const { room, cbs } = startedRoom()
    placeCueIfInHand(room)
    room.handleShot('user-a', SHOT)
    // The update that commits the shot is broadcast with the hold already taken, so
    // the clock is absent from it: a client that drew a deadline from this message
    // would be counting down through an animation the player is watching.
    const timing = lastTiming(cbs)
    expect(timing.turnDeadlineAt).toBeNull()
    expect(room.turnTiming().turnDeadlineAt).toBeNull()
  })

  it('stays stopped for the whole of the replay, however long the hold lasts', () => {
    const { room, cbs } = startedRoom()
    placeCueIfInHand(room)
    room.handleShot('user-a', SHOT)
    // Time passes while the shot is watched. The clock must not appear in the meantime.
    vi.advanceTimersByTime(5_000)
    expect(room.turnTiming().turnDeadlineAt).toBeNull()
    // Until the client says the shot has been watched to the end.
    const token = lastToken(cbs)
    room.noteShotPlayed('user-a', token, 'sock-a')
    expect(room.turnTiming().turnDeadlineAt).not.toBeNull()
  })

  it('runs for the next turn once the hold is released, from the moment of release', () => {
    const { room, cbs } = startedRoom()
    placeCueIfInHand(room)
    room.handleShot('user-a', SHOT)
    const token = lastToken(cbs)
    const before = Date.now()
    room.noteShotPlayed('user-a', token, 'sock-a')
    const timing = room.turnTiming()
    expect(timing.turnDeadlineAt).not.toBeNull()
    // The turn that follows belongs to the other player, and it starts counting now,
    // not when the shot was taken.
    expect(timing.turnDeadlineAt! - timing.serverNow).toBe(30_000)
    expect(timing.turnDeadlineAt).toBeGreaterThanOrEqual(before + 30_000 - 50)
  })

  it('stops when a player disconnects, and starts again when they come back', () => {
    const { room, cbs } = startedRoom()
    playBreak(room, cbs)
    // The break has passed the visit to seat 1, so the striker going quiet is what
    // stops the clock: nobody may be fouled for a turn they are not there to play.
    room.unregisterSocket('user-b', 'sock-b')
    expect(room.turnTiming().turnDeadlineAt).toBeNull()
    room.registerSocket('user-b', 1, 'sock-b2')
    expect(room.turnTiming().turnDeadlineAt).not.toBeNull()
  })

  it('keeps telling a client the deadline it was last given, while the clock stands', () => {
    const { room, cbs } = startedRoom()
    playBreak(room, cbs)
    // The fresh deadline travelled on the turn:clock announcement that followed the
    // release, so the client's view of it is read from there rather than from an
    // older table broadcast that predates the clock.
    const told = room.turnTiming()
    expect(told.turnDeadlineAt).not.toBeNull()
    // Nothing has happened to the room, so the instant a client is holding is still the
    // instant the room is enforcing. A deadline that drifted between messages would put
    // the ring and the eventual foul in different places.
    expect(room.turnTiming().turnDeadlineAt).toBe(told.turnDeadlineAt)
  })

  it('gives a player who was away a full turn rather than the one they spent offline', () => {
    // A client that was disconnected has no countdown to draw, so it starts again at
    // full. The alternative — a deadline that expired while they were away would
    // foul a player for a turn they were never given the chance to play.
    const { room, cbs } = startedRoom()
    playBreak(room, cbs)
    room.unregisterSocket('user-b', 'sock-b')
    const before = Date.now()
    room.registerSocket('user-b', 1, 'sock-b2')
    const timing = room.turnTiming()
    expect(timing.turnDeadlineAt! - before).toBeGreaterThanOrEqual(30_000 - 50)
  })

  it('does not run the clock against the robot, which plays on its own schedule', () => {
    const cbs = callbacks()
    const room = new GameRoom(MATCH_ID, 'PRACTICE', 'BO1', 0, 'MEDIUM', cbs, 30)
    // In practice the human is seat 0 and the robot is seat 1, and the robot is the
    // only bot the room knows about: it is identified by that seat, not by a flag.
    room.registerSocket('user-a', 0, 'sock-a')
    room.tryStart()
    // The break is watched first: the clock does not run across the opening ball in
    // hand, so the human's clock only exists once the frame is past it.
    playBreak(room, cbs)
    // The visit has passed to the robot. The clock is armed on its visit too, so the
    // ring follows whoever is at the table — but the timeout must never charge the
    // robot a foul, because its think delay is its own business and always lands
    // well inside a turn.
    expect(room.isBotTurn()).toBe(true)
    expect(room.turnTiming().turnDeadlineAt).not.toBeNull()
    const clocks = cbs.broadcasts.filter((b) => b.event === 'turn:clock')
    const last = clocks[clocks.length - 1]?.payload?.turn
    expect(last?.turnDeadlineAt).not.toBeNull()
    // Far past where the robot's own clock would have expired, no timeout foul has
    // been charged to seat 1: the robot played instead, and any timeout that ever
    // lands belongs to the human.
    vi.advanceTimersByTime(60_000)
    const fouls = cbs.broadcasts.flatMap((b) => (b.payload?.events ?? []) as any[])
      .filter((e) => e.type === 'FOUL' && e.data?.reason === 'turn timeout')
    expect(fouls.some((e) => e.data?.bySeat === 1)).toBe(false)
  })

  it('leaves the striker clock alone when it is the other player who drops out', () => {
    const { room, cbs } = startedRoom({ connect: ['a', 'b'] })
    playBreak(room, cbs)
    // The break passed the visit to seat 1, so seat 0 is now the other player. Their
    // going quiet must not stop — or restart — the striker's clock.
    const before = room.turnTiming().turnDeadlineAt
    expect(before).not.toBeNull()
    room.unregisterSocket('user-a', 'sock-a')
    expect(room.turnTiming().turnDeadlineAt).toBe(before)
  })

  it('stops the clock when the turn actually times out', () => {
    const { room, cbs } = startedRoom({ timeoutSec: 1 })
    playBreak(room, cbs)
    expect(room.turnTiming().turnDeadlineAt).not.toBeNull()
    vi.advanceTimersByTime(1_500)
    // The expiry foul passed the visit on, so the clock now belongs to the other
    // player and nothing is left of the one that ran out.
    const foul = cbs.broadcasts.some(
      (b) => b.event === 'game:update' && b.payload?.events?.some((e: any) => e.type === 'FOUL' && e.data?.reason === 'turn timeout')
    )
    expect(foul).toBe(true)
    const timing = room.turnTiming()
    expect(timing.turnDeadlineAt === null || timing.turnDeadlineAt > Date.now()).toBe(true)
  })

  it('leaves no clock running once the room is disposed', () => {
    const { room } = startedRoom()
    room.dispose()
    expect(room.turnTiming().turnDeadlineAt).toBeNull()
  })

  it('announces a fresh deadline when the replay is released, so the clock visibly restarts', () => {
    // The regression behind a clock stuck at 0: the release is when the next visit's
    // clock actually starts, and no table broadcast follows it, so the room has to
    // say so on its own. Without this, clients kept drawing the stopped clock they
    // were last sent.
    const { room, cbs } = startedRoom()
    placeCueIfInHand(room)
    room.handleShot('user-a', SHOT)
    const token = lastToken(cbs)
    const before = Date.now()
    room.noteShotPlayed('user-a', token, 'sock-a')
    const clocks = cbs.broadcasts.filter((b) => b.event === 'turn:clock')
    expect(clocks.length).toBeGreaterThan(0)
    const last = clocks[clocks.length - 1]!.payload.turn
    expect(last.turnDeadlineAt).not.toBeNull()
    expect(last.turnDeadlineAt - last.serverNow).toBe(30_000)
    expect(last.turnDeadlineAt).toBeGreaterThanOrEqual(before + 30_000 - 50)
  })

  it('tells the clients when the striker clock stops on a disconnect', () => {
    // Same regression, the other way: stopping the room's clock without announcing
    // it leaves every ring counting down a turn nobody is timing.
    const { room, cbs } = startedRoom()
    room.unregisterSocket('user-a', 'sock-a')
    expect(room.turnTiming().turnDeadlineAt).toBeNull()
    const clocks = cbs.broadcasts.filter((b) => b.event === 'turn:clock')
    const last = clocks[clocks.length - 1]?.payload?.turn
    expect(last?.turnDeadlineAt).toBeNull()
  })

  it('announces the re-armed clock when a player returns', () => {
    const { room, cbs } = startedRoom()
    playBreak(room, cbs)
    room.unregisterSocket('user-b', 'sock-b')
    const before = Date.now()
    room.registerSocket('user-b', 1, 'sock-b2')
    const clocks = cbs.broadcasts.filter((b) => b.event === 'turn:clock')
    const last = clocks[clocks.length - 1]?.payload?.turn
    expect(last?.turnDeadlineAt).not.toBeNull()
    expect(last.turnDeadlineAt - before).toBeGreaterThanOrEqual(30_000 - 50)
  })

  it('ships no spent deadline with the frame-end broadcast', async () => {
    // The frame-ending shot consumed the striker's turn, so the deadline it carried
    // is spent. Stamped as-is, clients would draw an empty clock across the whole
    // frame ceremony.
    const { room, cbs } = startedRoom()
    playBreak(room, cbs)
    expect(room.turnTiming().turnDeadlineAt).not.toBeNull()
    await (room as unknown as { handleFrameEnd(w: number, f: unknown): Promise<void> }).handleFrameEnd(
      0,
      room.match.currentFrame
    )
    const frameEndUpdate = cbs.broadcasts.find(
      (b) => b.event === 'game:update' && (b.payload?.events ?? []).some((e: any) => e.type === 'FRAME_END')
    )
    expect(frameEndUpdate).toBeDefined()
    expect(frameEndUpdate!.payload.turn.turnDeadlineAt).toBeNull()
  })
})

describe('placement hold', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function started(opts: { connect?: ('a' | 'b')[]; timeoutSec?: number } = {}) {
    const cbs = callbacks()
    const room = new GameRoom(MATCH_ID, 'RANKED', 'BO1', 0, undefined, cbs, opts.timeoutSec ?? 30)
    for (const seat of ['a', 'b'] as const) {
      const userId = seat === 'a' ? 'user-a' : 'user-b'
      if ((opts.connect ?? ['a']).includes(seat)) {
        room.registerSocket(userId, seat === 'a' ? 0 : 1, `sock-${seat}`)
      } else {
        room.seatOfUser.set(userId, seat === 'a' ? 0 : 1)
      }
    }
    room.tryStart()
    return { room, cbs }
  }

  /** A legal D spot, which is the only kind of placement a fresh frame allows. */
  const IN_D = { x: 600, y: 889 }

  function eventsOfType(cbs: ReturnType<typeof callbacks>, type: string): any[] {
    return cbs.broadcasts.flatMap((b) =>
      b.event === 'game:update' ? ((b.payload?.events ?? []) as any[]).filter((e) => e.type === type) : []
    )
  }

  it('holds the clock while the player is placing', () => {
    const { room } = started({ timeoutSec: 1 })
    const deadline = room.turnTiming().turnDeadlineAt
    expect(deadline).not.toBeNull()
    expect(room.handlePlacementBegin('user-a').accepted).toBe(true)
    // The deadline is still there: this is a hold, not a cleared clock.
    expect(room.turnTiming().turnDeadlineAt).toBe(deadline)
    expect(room.turnTiming().paused).toBe(true)
  })

  // The bug as reported: the clock kept running across a legal placement and the frame
  // ended in a timeout foul while the player was still doing the thing they were asked.
  it('does not time out while a placement is in progress, however long it takes', () => {
    const { room, cbs } = started({ timeoutSec: 1 })
    expect(room.handlePlacementBegin('user-a').accepted).toBe(true)
    vi.advanceTimersByTime(60_000)
    const timeouts = eventsOfType(cbs, 'FOUL').filter((e) => e.data?.reason === 'turn timeout')
    expect(timeouts, 'a held clock must not foul').toHaveLength(0)
    expect(room.turnTiming().paused).toBe(true)
    // And the visit is untouched: no penalty, no turn change.
    expect(room.match.currentFrame?.turnIndex).toBe(0)
    expect(room.match.currentFrame?.scores.player1).toBe(0)
  })

it('resumes from the time that was left, not from a fresh turn', () => {
    const { room } = started({ timeoutSec: 30 })
    vi.advanceTimersByTime(5_000)
    expect(room.handlePlacementBegin('user-a').accepted).toBe(true)
    // The player spends well over the five seconds left searching for a spot.
    vi.advanceTimersByTime(45_000)
    expect(room.handlePlacementConfirm('user-a', IN_D).accepted).toBe(true)
    // The hold is still up - the camera is flying home. Clock is still paused.
    expect(room.turnTiming().paused).toBe(true)
    // Now the camera lands: the client reports done and the hold lifts.
    expect(room.handlePlacementDone('user-a').accepted).toBe(true)
    const timing = room.turnTiming()
    expect(timing.paused).toBe(false)
    // 25s of 30 were left when the placement began, and that is what comes back. Resetting
    // to a full 30 here would hand every placing player half a minute they never earned.
    expect(timing.turnDeadlineAt! - timing.serverNow).toBe(25_000)
  })

  it('reports the hold to clients, so the ring freezes rather than running on', () => {
    const { room, cbs } = started()
    room.handlePlacementBegin('user-a')
    const clock = cbs.broadcasts.filter((b) => b.event === 'turn:clock')
    expect(clock.length).toBeGreaterThan(0)
    expect(clock[clock.length - 1]!.payload.turn.paused).toBe(true)
    // The deadline travels with the pause, because it is the one the room will resume
    // from. A client that read a paused clock as "no clock" would hide the player's time.
    expect(clock[clock.length - 1]!.payload.turn.turnDeadlineAt).not.toBeNull()
  })

it('placing the cue is not a shot: no foul, no score, no turn change', () => {
    const { room, cbs } = started()
    const before = { ...room.match.currentFrame!.scores }
    room.handlePlacementBegin('user-a')
    expect(room.handlePlacementConfirm('user-a', IN_D).accepted).toBe(true)

    expect(eventsOfType(cbs, 'FOUL'), 'placing must not raise a foul').toHaveLength(0)
    expect(eventsOfType(cbs, 'SHOT'), 'placing must not announce a shot').toHaveLength(0)
    expect(eventsOfType(cbs, 'BALL_POTTED')).toHaveLength(0)
    expect(eventsOfType(cbs, 'TURN_CHANGE')).toHaveLength(0)
    expect(room.match.currentFrame!.scores).toEqual(before)
    expect(room.match.currentFrame!.turnIndex).toBe(0)
    // The ball is down, but the camera is still flying home - clock is still held.
    expect(room.match.currentFrame!.cueInHand).toBe(false)
    // While the hold is up, the execution state reflects the placement phase.
    expect(room.executionState()).toBe('BALL_IN_HAND_PLACEMENT')
    expect(room.turnTiming().paused).toBe(true)

    // The camera lands, the hold lifts, the clock resumes.
    expect(room.handlePlacementDone('user-a').accepted).toBe(true)
    expect(room.turnTiming().paused).toBe(false)
    // Now the player can aim.
    expect(room.executionState()).toBe('PLAYER_AIMING')
  })

it('broadcasts the placed ball so every client sees it', () => {
    const { room, cbs } = started()
    room.handlePlacementBegin('user-a')
    room.handlePlacementConfirm('user-a', IN_D)
    // The clock is still held while the camera flies home.
    expect(room.turnTiming().paused).toBe(true)
    const update = cbs.broadcasts.filter((b) => b.event === 'game:update').pop()
    // A snapshot ball is `{ id, x, y, potted }`, so the cue is found by its id, which is 0.
    const cue = update!.payload.frame.balls.find((b: any) => b.id === 0)
    expect(cue).toBeDefined()
    expect(cue.x).toBeCloseTo(IN_D.x, 5)
    expect(cue.y).toBeCloseTo(IN_D.y, 5)
    // The frame snapshot carries the paused clock, so clients see the held value.
    expect(update!.payload.frame.cueInHand).toBe(false)
    expect(update!.payload.turn.paused).toBe(true)
  })

it('lets the player shoot once the camera is home', () => {
    const { room } = started()
    room.handlePlacementBegin('user-a')
    room.handlePlacementConfirm('user-a', IN_D)
    // Shot is refused while the placement hold is still up.
    expect(room.handleShot('user-a', SHOT).accepted).toBe(false)
    // The camera lands, the hold lifts.
    expect(room.handlePlacementDone('user-a').accepted).toBe(true)
    // Now the player can shoot.
    expect(room.handleShot('user-a', SHOT).accepted).toBe(true)
  })

  it('refuses a shot through the back of a placement', () => {
    const { room } = started()
    room.handlePlacementBegin('user-a')
    const result = room.handleShot('user-a', SHOT)
    expect(result.accepted).toBe(false)
    expect(result.error).toBe('place the cue ball first')
  })

  describe('a refused spot is a retry, not a loss', () => {
    it('keeps the hold up and the ball in hand, so the player can try again', () => {
      const { room } = started()
      room.handlePlacementBegin('user-a')
      // Well outside the D, which a fresh frame forbids.
      const refused = room.handlePlacementConfirm('user-a', { x: 1200, y: 1400 })
      expect(refused.accepted).toBe(false)
      expect(refused.error).toBe('outside-D')
      expect(room.match.currentFrame!.cueInHand).toBe(true)
      expect(room.match.currentFrame!.turnIndex).toBe(0)
      // Still held: a rejected spot is not a reason to start charging the player time.
      expect(room.turnTiming().paused).toBe(true)
      // And the retry works.
      expect(room.handlePlacementConfirm('user-a', IN_D).accepted).toBe(true)
    })

    it('a full turn spent retrying still cannot end in a timeout', () => {
      const { room, cbs } = started({ timeoutSec: 1 })
      room.handlePlacementBegin('user-a')
      for (let i = 0; i < 20; i++) {
        room.handlePlacementConfirm('user-a', { x: 1200, y: 1400 })
        vi.advanceTimersByTime(1_000)
      }
      expect(eventsOfType(cbs, 'FOUL')).toHaveLength(0)
    })
  })

  describe('idempotency', () => {
    it('a repeated begin does not re-hold the clock or restart the backstop', () => {
      const { room } = started({ timeoutSec: 30 })
      vi.advanceTimersByTime(5_000)
      expect(room.handlePlacementBegin('user-a').accepted).toBe(true)
      const held = room.turnTiming().turnDeadlineAt
      vi.advanceTimersByTime(3_000)
      expect(room.handlePlacementBegin('user-a').accepted).toBe(true)
      // The hold is the same hold: a chatty client cannot stretch the window by repeating.
      expect(room.turnTiming().turnDeadlineAt).toBe(held)
    })

it('a repeated begin does not hand out a fresh clock', () => {
      const { room } = started({ timeoutSec: 30 })
      vi.advanceTimersByTime(5_000)
      room.handlePlacementBegin('user-a')
      vi.advanceTimersByTime(20_000)
      // The client re-declares part-way through, as one reconnecting would. It must not be
      // read as a new placement starting from the top of the clock.
      room.handlePlacementBegin('user-a')
      room.handlePlacementConfirm('user-a', IN_D)
      // Hold is still up; clock is paused.
      expect(room.turnTiming().paused).toBe(true)
      // Camera lands.
      room.handlePlacementDone('user-a')
      // Still the 25s that was left at the first declaration, not a re-hold of 30.
      expect(room.turnTiming().turnDeadlineAt! - room.turnTiming().serverNow).toBe(25_000)
    })

it('a repeated confirm lands on the same table without moving the ball', () => {
      const { room, cbs } = started()
      room.handlePlacementBegin('user-a')
      const first = room.handlePlacementConfirm('user-a', IN_D)
      expect(first.accepted).toBe(true)
      expect(first.alreadyPlaced).toBe(false)

      const second = room.handlePlacementConfirm('user-a', { x: 620, y: 900 })
      expect(second.accepted).toBe(true)
      expect(second.alreadyPlaced, 'the room must report this rather than re-place').toBe(true)
      // The ball must not have moved - check the latest broadcast snapshot.
      const update = cbs.broadcasts.filter((b) => b.event === 'game:update').pop()
      const cue = update!.payload.frame.balls.find((b: any) => b.id === 0)
      expect(cue).toBeDefined()
      expect(cue.x).toBeCloseTo(IN_D.x, 5)
      expect(cue.y).toBeCloseTo(IN_D.y, 5)
    })
  })

  describe('cannot outlive its own backstop', () => {
it('releases a placement nobody finished, without fouling the player', () => {
      // The hold must not be a way to freeze a match, but letting it lapse must not be a
      // timeout either - that is the fault the hold exists to remove.
      const { room, cbs } = started({ timeoutSec: 1 })
      room.handlePlacementBegin('user-a')
      // Everything a player could reasonably spend on a placement, several times over,
      // and still no foul.
      vi.advanceTimersByTime(119_000)
      expect(eventsOfType(cbs, 'FOUL'), 'a hold in progress must not foul').toHaveLength(0)
      expect(room.match.currentFrame!.turnIndex).toBe(0)

      // Just past the backstop but short of the clock it re-arms, so the two are not confused.
      vi.advanceTimersByTime(1_500)
      expect(room.turnTiming().paused, 'the hold ends on its own').toBe(false)
      expect(room.match.currentFrame!.turnIndex, 'and does not hand over the visit').toBe(0)
      // The clock is running again, which is what stops the frame stalling for good. It
      // is the ordinary clock, so it can still time the player out from here on - which
      // is the whole point of letting it go.
      expect(room.turnTiming().turnDeadlineAt).not.toBeNull()
      vi.advanceTimersByTime(1_000)
      const timeouts = eventsOfType(cbs, 'FOUL').filter((e) => e.data?.reason === 'turn timeout')
      expect(timeouts, 'the released clock still times an unused turn out').toHaveLength(1)
    })

    it('a player who never places at all is still timed out, so a frame cannot hang', () => {
      const { room, cbs } = started({ timeoutSec: 1 })
      // No `placement:begin`: nobody ever declared a placement, so the ordinary clock
      // runs exactly as it always did.
      vi.advanceTimersByTime(1_500)
      const timeouts = eventsOfType(cbs, 'FOUL').filter((e) => e.data?.reason === 'turn timeout')
      expect(timeouts).toHaveLength(1)
    })

    it('a placement still places correctly after the backstop has released it', () => {
      const { room } = started({ timeoutSec: 1 })
      room.handlePlacementBegin('user-a')
      vi.advanceTimersByTime(150_000)
      expect(room.handlePlacementConfirm('user-a', IN_D).accepted).toBe(true)
      expect(room.match.currentFrame!.cueInHand).toBe(false)
      expect(room.handleShot('user-a', SHOT).accepted).toBe(true)
    })
  })

  describe('who may hold it', () => {
    it('refuses a player who is not on', () => {
      const { room } = started()
      expect(room.handlePlacementBegin('user-b').accepted).toBe(false)
      expect(room.handlePlacementBegin('nobody').accepted).toBe(false)
    })

    it('refuses a begin when the ball is not in hand', () => {
      const { room, cbs } = started()
      placeCueIfInHand(room)
      const result = room.handlePlacementBegin('user-a')
      expect(result.accepted).toBe(false)
      expect(room.turnTiming().paused).toBe(false)
    })

    it('refuses a confirm from a player who is not on', () => {
      const { room } = started()
      room.handlePlacementBegin('user-a')
      expect(room.handlePlacementConfirm('user-b', IN_D).accepted).toBe(false)
      expect(room.match.currentFrame!.cueInHand).toBe(true)
    })

    it('never lets the robot begin a placement', () => {
      const cbs = callbacks()
      const room = new GameRoom(MATCH_ID, 'PRACTICE', 'BO1', 0, undefined, cbs, 30)
      room.seatOfUser.set('user-a', 0)
      room.seatOfUser.set('bot', 1)
      room.registerSocket('user-a', 0, 'sock-a')
      room.tryStart()
      // Put the robot on with the cue in hand.
      room.match.currentFrame!.turnIndex = 1
      room.match.currentFrame!.cueInHand = true
      expect(room.isBotTurn()).toBe(true)
      expect(room.handlePlacementBegin('bot').accepted).toBe(false)
    })

    it('the robot is not scheduled to play while a placement is in progress', () => {
      const cbs = callbacks()
      const room = new GameRoom(MATCH_ID, 'PRACTICE', 'BO1', 0, undefined, cbs, 30)
      room.seatOfUser.set('user-a', 0)
      room.seatOfUser.set('bot', 1)
      room.registerSocket('user-a', 0, 'sock-a')
      room.tryStart()
      room.match.currentFrame!.turnIndex = 1
      room.match.currentFrame!.cueInHand = true
// Force a hold onto the robot's seat to prove the bot gate is not merely relying on
      // `handlePlacementBegin` refusing it elsewhere. The leading semicolon is load-bearing:
      // without it the preceding `= true` is read as a call on the cast expression.
      const seat = room as unknown as { placementSeat: number | null }
      seat.placementSeat = 1
      const before = cbs.broadcasts.filter((b) => b.event === 'game:update').length
      vi.advanceTimersByTime(5_000)
      const after = cbs.broadcasts.filter((b) => b.event === 'game:update').length
      expect(after, 'the bot must not play while a placement is held').toBe(before)
      seat.placementSeat = null
    })
  })

  it('drops the hold when the striker disconnects, so a rejoin is not held forever', () => {
    const { room } = started()
    room.handlePlacementBegin('user-a')
    expect(room.turnTiming().paused).toBe(true)
    room.unregisterSocket('user-a', 'sock-a')
    expect(room.turnTiming().paused, 'a hold must not outlive its player').toBe(false)
    expect(room.turnTiming().turnDeadlineAt).toBeNull()

    // The player comes back and starts placing again: the clock is armed afresh, which
    // is the existing "a returner gets a full turn" rule, and the hold takes it again.
    room.registerSocket('user-a', 0, 'sock-a')
    expect(room.turnTiming().turnDeadlineAt).not.toBeNull()
    expect(room.handlePlacementBegin('user-a').accepted).toBe(true)
    expect(room.turnTiming().paused).toBe(true)
  })

  it('leaves no hold behind when the room is disposed', () => {
    const { room } = started()
    room.handlePlacementBegin('user-a')
    room.dispose()
    expect(room.turnTiming().paused).toBe(false)
  })
})
