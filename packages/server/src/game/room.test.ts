import { describe, expect, it } from 'vitest'
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
