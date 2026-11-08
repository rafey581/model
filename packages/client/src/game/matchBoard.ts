import { frameForHud } from './hudFrame.js'

/**
 * Which match the table on screen belongs to, and how far its messages have been applied.
 *
 * Practice and multiplayer share one socket. Starting another match joins a new room
 * without the previous room being forgotten, and a `game:update` used to carry no match
 * id the client looked at. A timeout, a bot shot or a frame change from the match just
 * left then replaced the live score and the live balls together. The gate below is what
 * refuses that.
 */
export interface TableGate {
  activeMatchId: string | null
  /** Highest sequence applied for the active match. `-1` before the first message. */
  lastSeq: number
}

export interface TableEnvelope {
  matchId?: string | null
  seq?: number | null
}

export interface GateDecision {
  accept: boolean
  lastSeq: number
}

/**
 * Whether a message may change the score, the turn, the clock or the balls on screen.
 *
 * A join (`reset`) is the server handing over the whole table. It is allowed to land
 * even when its sequence is not newer than something this page applied in a previous
 * match, and it becomes the sequence later messages are compared with.
 *
 * A message with no match id is refused. That is the old wire shape, and applying it
 * is how a stale room overwrote the match in front of the player.
 */
export function gateTableEvent(gate: TableGate, event: TableEnvelope, reset = false): GateDecision {
  if (!gate.activeMatchId || event.matchId !== gate.activeMatchId) {
    return { accept: false, lastSeq: gate.lastSeq }
  }
  if (reset) return { accept: true, lastSeq: finiteSeq(event.seq) ?? gate.lastSeq }
  const seq = finiteSeq(event.seq)
  if (seq !== null && seq < gate.lastSeq) return { accept: false, lastSeq: gate.lastSeq }
  return { accept: true, lastSeq: seq ?? gate.lastSeq }
}

function finiteSeq(seq: number | null | undefined): number | null {
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : null
}

/** What opening or closing a match does to the gate, and which room must be left. */
export interface SessionStep {
  session: TableGate
  /** The match whose socket room and in-flight shot belong to the page being left. */
  leaveMatchId: string | null
}

/** Switches the page onto `matchId`. A different match that was open has to be left. */
export function openMatch(session: TableGate, matchId: string): SessionStep {
  const leaveMatchId = session.activeMatchId !== null && session.activeMatchId !== matchId ? session.activeMatchId : null
  return { session: { activeMatchId: matchId, lastSeq: -1 }, leaveMatchId }
}

/** Leaves the match on screen. Further table messages have nothing to apply to. */
export function closeMatch(session: TableGate): SessionStep {
  return { session: { activeMatchId: null, lastSeq: -1 }, leaveMatchId: session.activeMatchId }
}

export interface HudHold<T> {
  matchId: string | null
  shown: T | null
}

/**
 * The board the HUD may describe.
 *
 * While a replay is on screen the HUD keeps the board the replay started from, so the
 * score does not announce a pot that is still rolling. That held board is only legal
 * for the match it was taken from. A replay left over from the practice match before
 * this one must not keep painting that match's score onto this one.
 */
export function hudBoard<T>(
  hold: HudHold<T>,
  activeMatchId: string | null,
  replayRunning: boolean,
  authoritative: T | null
): HudHold<T> & { board: T | null } {
  if (!activeMatchId) return { matchId: null, shown: null, board: null }
  const sameMatch = hold.matchId === activeMatchId
  const shown = sameMatch ? hold.shown : null
  const board = frameForHud({ replayRunning, shown, authoritative })
  return { matchId: activeMatchId, shown: board, board }
}

/**
 * The table to draw on the frame a queued update is applied.
 *
 * The update has already replaced the authoritative frame. A queued replay is stepped
 * from that new frame on this same paint. A queued settle — the next frame's rack, a
 * respot, the balls put back after a foul — has no replay of its own. Drawing the
 * table from before the queue on that paint leaves the score (which reads the new
 * frame) describing one table and the balls showing another.
 */
export function tableAfterQueuedUpdate<T>(previous: T, next: T | null): T {
  return next ?? previous
}
