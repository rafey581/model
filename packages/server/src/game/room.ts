import type { Server } from 'socket.io'
import {
  createMatch,
  createFrame,
  newFrameForMatch,
  applyStroke,
  applyCuePlacement,
  applyFrameWinner,
  applyTimeoutFoul,
  maybeEndFrame,
  matchWinnerIndex,
  frameSnapshot,
  seededRandom
} from '@snooker/shared'
import type { MatchState, FrameState, ShotInput, ShotPlayback } from '@snooker/shared'
import { SHOT_PLAYBACK_SPEED } from '@snooker/shared'
import type { PracticeAiLevel } from '@snooker/shared'
import { computeBotShot } from '../bot/bot.js'
import { config } from '../config.js'

/**
 * Keyframes sent per second of simulated shot time. 30 keeps ball motion smooth
 * at full-power break speed; a full-rack break comes to roughly 56KB of JSON
 * (about 18KB gzipped) sent once per shot.
 */
const SHOT_KEYFRAME_RATE = 30

/**
 * How long a placement hold may last before the room releases it by itself.
 *
 * Comfortably longer than finding a legal spot ever takes, and short enough that a
 * placement left open cannot hold a match up. This is a safety net, not a time limit on
 * the player: letting it expire costs nothing but the pause itself, so it cannot be
 * turned into a timeout by accident.
 */
const PLACEMENT_HOLD_MS = 120_000

export interface GameUpdateEvent {
  matchId: string
  seq: number
  type: string
  data: unknown
}

export interface RoomCallbacks {
  board: Server
  persist: (events: GameUpdateEvent[]) => Promise<void>
  onFrameEnd: (matchId: string, frameWinner: number, scores: { player0: number; player1: number }) => Promise<void>
  onMatchEnd: (matchId: string, matchWinner: number, reason: string) => Promise<void>
  log: (msg: string) => void
}

export type ShotInputDto = Pick<ShotInput, 'aimAngle' | 'power' | 'spin' | 'cuePos'>

/**
 * The execution states the room moves through, in the order a stroke experiences them.
 *
 * This is the vocabulary for the pacing gates below; it is a read-only view of the
 * flags the room already keeps (`simulating`, `awaitingPlayback`, the frame's phase
 * and `cueInHand`), not a second state machine running beside them. Rules are only
 * ever applied inside `applyStroke`, which runs after the physics simulation has
 * settled every ball, so rule evaluation is structurally pinned to the state after
 * `PHYSICS_SIMULATION` and cannot fire early.
 *
 * `SHOT_EXECUTING` has no observable instant of its own — executing the shot runs the
 * simulation to rest synchronously — so it is folded into `PHYSICS_SIMULATION` here.
 */
export type ExecutionState =
  | 'BALL_IN_HAND_PLACEMENT'
  | 'PLAYER_AIMING'
  | 'PHYSICS_SIMULATION'
  | 'RULE_EVALUATION'
  | 'TURN_TRANSITION'

/** How long the bot waits, after being given a settled table, before it fires. */
export const BOT_SHOT_DELAY_MS = 1200

export class GameRoom {
  readonly matchId: string
  readonly matchType: string
  readonly aiLevel?: PracticeAiLevel
  match: MatchState
  seatOfUser = new Map<string, number>()
  socketIds = new Map<number, Set<string>>()
  started = false
  stopped = false
  private seq = 0
  private simulating = false
  private botTimer: NodeJS.Timeout | null = null
  private turnTimer: NodeJS.Timeout | null = null
  /**
   * The seat that has declared it is placing its cue ball right now, or null when
   * nobody is.
   *
   * The clock is held for exactly this long as long as it is set. Placement is not a
   * shot and not part of aiming: it is the striker arranging the table before they take
   * one, so time spent flying the camera in, hunting for a legal spot and flying it back
   * is not time spent not shooting. Counting it spent the strike clock while the player
   * was still doing the thing the game had just asked them to do, and the frame ended in
   * a timeout foul the player had no way to avoid.
   *
   * Stored rather than inferred from `frame.cueInHand` because the ball-in-hand flag
   * outlives the placement: it stays true until the ball is actually put down. The clock
   * may only be held while a placement is genuinely in progress.
   */
  private placementSeat: number | null = null
  /**
   * How much of the strike clock was left when placement began.
   *
   * The hold stops the clock; it must not reset it. Arming a fresh 30 seconds on
   * resume would quietly hand every placing player an extra half minute of time they had
   * not earned, so the remainder is carried across the hold and the clock is restarted
   * from exactly where it stopped.
   */
  private placementRemainingMs: number | null = null
  /**
   * The backstop that makes a hold impossible to leave on forever.
   *
   * A player who starts a placement and then closes their laptop would otherwise hold
   * the room's clock for good, and the frame would sit there forever. This is the
   * promise that the hold ends one way or another: if no confirmation arrives within the
   * window, the hold is released and the strike clock resumes on its own. It deliberately
   * does NOT foul the player for standing still. No time out during a legal placement is
   * the whole point of the hold, so the backstop cannot be a cheaper version of the thing
   * the hold was added to stop.
   */
  private placementGuardTimer: NodeJS.Timeout | null = null
  /**
   * Set while a streamed shot is animating on the players' screens, and cleared
   * when a client reports that the animation has finished.
   *
   * Nothing new may be played while this is set. Without it the bot simply waited
   * 800-2300ms after the update was sent and then fired, which lands well inside a
   * full-power break's several seconds of animation. The result was that a shot
   * arrived mid-replay, the client dropped the replay in flight, and several shots
   * worth of ball movement appeared in a single jump.
   */
  private awaitingPlayback = false
  /**
   * Identifies the shot currently being held for, so an acknowledgement can be
   * matched against the shot it claims to have watched.
   *
   * A client that reconnects mid-replay, or whose queued `shot:done` is delivered
   * after the server has already moved on, must not be able to release a *newer*
   * hold it never saw. The token is bumped for every held shot, so a stale
   * acknowledgement is simply ignored instead of cutting the next animation short.
   */
  private playbackToken = 0
  /**
   * The token of the shot whose playback is being held right now, or null when
   * nothing is held.
   *
   * This is deliberately not the same thing as `playbackToken`. That counter moves on
   * for every shot, including the many that create no hold at all because nobody was
   * connected to watch them, so it names the most recent shot rather than the shot
   * someone is actually watching. Matching an acknowledgement against it would let a
   * client holding a stale token for a shot that was never held release the current
   * hold early, which is the thing the hold exists to prevent.
   */
  private heldToken: number | null = null
  /**
   * The sockets that were attached when the current hold started, and so may still
   * be watching the replay it is protecting.
   *
   * This is what makes an acknowledgement mean something. "Is seated in this match"
   * is not enough: a seated player's tab can have joined late, reconnected, or already
   * finished and moved on, and any of those sends a report about a shot it never saw.
   * A socket that arrived after the hold began is deliberately not listed, because a
   * client that joins is sent the settled snapshot and abandons whatever replay it was
   * showing. When the list empties, nobody is left who can end the hold, so it is
   * released rather than left to stall against the backstop.
   */
  private replayWatchers = new Set<string>()
  /**
   * Backstop for the playback gate. A client that never reports back, because it
   * was closed or its tab was backgrounded, must not stall the match for ever, so
   * the hold is released after a generous multiple of the shot's own playback time.
   */
  private playbackTimer: NodeJS.Timeout | null = null
  private readonly turnTimeoutSec: number
  /**
   * When the current visit's clock runs out, in server epoch milliseconds.
   *
   * The authoritative deadline, as opposed to the `setTimeout` that enforces it. A
   * client cannot work the deadline out for itself: it does not know when the hold on
   * the room was released, and it has no way to know how far its own clock is from the
   * server's. It is null whenever no clock is running — before the match starts, while
   * a shot is still being watched, and on a disconnected or non-human seat.
   */
  private turnDeadlineAt: number | null = null
  private callbacks: RoomCallbacks
  private disconnectedAt = new Map<number, number>()
  private deliveredSeqByUser = new Map<string, number>()

  constructor(
    matchId: string,
    matchType: string,
    format: string,
    breakFirst = 0,
    aiLevel?: PracticeAiLevel,
    callbacks?: RoomCallbacks,
    turnTimeoutSec?: number
  ) {
    this.matchId = matchId
    this.matchType = matchType
    this.aiLevel = aiLevel
    this.callbacks = callbacks ?? defaultCallbacks()
    this.turnTimeoutSec = turnTimeoutSec ?? config.MATCH_TURN_TIMEOUT_SEC
    this.match = createMatch(matchId, matchType, format)
    this.match.currentFrame = createFrame(breakFirst)
  }

  registerSocket(userId: string, seat: number, socketId: string): void {
    this.seatOfUser.set(userId, seat)
    const set = this.socketIds.get(seat) ?? new Set<string>()
    set.add(socketId)
    this.socketIds.set(seat, set)
    if (this.disconnectedAt.delete(seat)) {
      this.broadcast('opponent:reconnected', { seat })
    }
    // A socket that arrives while a shot is being held is sent the settled snapshot
    // and abandons the replay it was showing, so it can never end that hold. Dropping
    // it here is what lets the hold be released once the sockets that really were
    // watching have gone, instead of stalling the match to the backstop.
    this.replayWatchers.delete(socketId)
    this.releaseHoldIfNoWatchers()
    this.armTurnTimer()
    // Re-arming on a rejoin hands the striker a fresh turn, and the player who sat
    // through the departure is still drawing the stopped clock. Announcing the new
    // deadline is what sets their ring running again. Before the match has started
    // there is no clock of its own to announce, and match:start carries it anyway.
    if (this.started) this.broadcastTurnClock()
  }

  unregisterSocket(userId: string, socketId: string): void {
    const seat = this.seatOfUser.get(userId)
    if (seat === undefined) return
    const set = this.socketIds.get(seat)
    if (set) {
      set.delete(socketId)
      if (set.size === 0) {
        this.disconnectedAt.set(seat, Date.now())
        this.callbacks.log(`${userId} disconnected from ${this.matchId}`)
        this.broadcast('opponent:disconnected', { seat })
      }
    }
    this.replayWatchers.delete(socketId)
    this.releaseHoldIfNoWatchers()
    // A clock must not keep running against a seat that has just gone quiet. The
    // player is not there to see the countdown, and the foul it would eventually
    // charge them is a foul for a turn they were never given the chance to play. The
    // clock is only stopped when the seat that left is the one at the table: if the
    // other player dropped out, the striker is still sitting there and must not be
    // handed the turn again from the top.
    if (seat === this.match.currentFrame?.turnIndex) {
      this.stopTurnTimer()
      // The clients holding the ring cannot know the room stopped counting, so the
      // stop is said out loud: without this every clock out there is left counting
      // down a turn that is no longer being timed.
      this.broadcastTurnClock()
    }
  }

  /**
   * Stops the turn clock without starting a new one.
   *
   * Separate from arming, because the two are not opposites. Re-arming a striker whose
   * opponent has dropped out would give that striker their whole turn back.
   */
  private stopTurnTimer(): void {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer)
      this.turnTimer = null
    }
    // A hold has to go with the clock it was holding. Left standing it would block
    // every later arming in the room, and the striker who came back would find their
    // clock permanently held by a placement that is no longer in progress.
    this.abandonPlacementHold()
    this.turnDeadlineAt = null
  }

  /**
   * Releases a playback hold once no client is left who could end it.
   *
   * The hold exists to stop the next shot arriving before the current animation has
   * been seen. When every socket that was watching has gone, or has rejoined and
   * abandoned the replay, there is no animation left to protect: waiting out the
   * backstop would only stall the match for the full grace period before anything
   * could happen. Whoever comes back gets the authoritative snapshot and the settled
   * state, which is the truth anyway.
   */
  private releaseHoldIfNoWatchers(): void {
    if (!this.awaitingPlayback) return
    if (this.replayWatchers.size > 0) return
    this.releasePlayback()
  }

  /** True while at least one seated player still has a socket attached. */
  private anySocketWatching(): boolean {
    for (const sockets of this.socketIds.values()) {
      if (sockets.size > 0) return true
    }
    return false
  }

  /** Every socket currently attached to a seat. */
  private allSocketIds(): string[] {
    const ids: string[] = []
    for (const sockets of this.socketIds.values()) {
      for (const id of sockets) ids.push(id)
    }
    return ids
  }

  getSeat(userId: string): number | undefined {
    return this.seatOfUser.get(userId)
  }

  /**
   * Which execution state the room is in right now.
   *
   * Derived, never stored: every branch below reads a flag that is already
   * maintained on the exact code paths that change it, so this can never drift
   * from the truth it reports. The mapping is deliberately conservative — anything
   * not provably a settled, playable table is reported as something other than
   * `PLAYER_AIMING`, which is the state every gate below wants to be sure of.
   */
  executionState(): ExecutionState {
    const frame = this.match.currentFrame
    if (!frame || frame.phase === 'FRAME_END') return 'TURN_TRANSITION'
    if (this.simulating) return 'PHYSICS_SIMULATION'
    // The verdict for the shot on screen is settled and persisted; the hold is the
    // pipeline between it and the next visit, and no new decision may be made
    // until every client has seen it.
    if (this.awaitingPlayback) return 'RULE_EVALUATION'
    if (this.placementSeat !== null) return 'BALL_IN_HAND_PLACEMENT'
    if (frame.cueInHand) return 'BALL_IN_HAND_PLACEMENT'
    return 'PLAYER_AIMING'
  }

  isSeatDisconnected(seat: number): boolean {
    return this.disconnectedAt.has(seat)
  }

  connectedSeats(): number[] {
    const seats = new Set<number>(this.seatOfUser.values())
    return [...seats].filter((s) => !this.disconnectedAt.has(s))
  }

  disconnectedSeats(): number[] {
    const seats = new Set<number>(this.seatOfUser.values())
    return [...seats].filter((s) => this.disconnectedAt.has(s))
  }

  userIdForSeat(seat: number): string | undefined {
    for (const [userId, s] of this.seatOfUser) {
      if (s === seat) return userId
    }
    return undefined
  }

  currentSeq(): number {
    return this.seq
  }

  deliveredSeqForUser(userId: string): number {
    return this.deliveredSeqByUser.get(userId) ?? 0
  }

  snapshot() {
    const frame = this.match.currentFrame
    return frame ? frameSnapshot(frame) : null
  }

  allUsers(): string[] {
    return [...this.seatOfUser.keys()]
  }

  tryStart(): boolean {
    if (this.started) return false
    const ready = this.matchType === 'PRACTICE' || this.seatOfUser.size >= 2
    if (!ready) return false
    this.started = true
    this.armTurnTimer()
    this.broadcast('match:start', { snapshot: this.snapshot(), frameIndex: this.match.frameIndex + 1 })
    this.scheduleBotIfNeeded()
    return true
  }

  isBotTurn(): boolean {
    const frame = this.match.currentFrame
    if (!frame) return false
    return this.matchType === 'PRACTICE' && frame.turnIndex === 1
  }

  private isHumanTurn(seat: number): boolean {
    if (this.matchType !== 'PRACTICE') return true
    return seat !== 1
  }

  private armTurnTimer(remainingMs?: number): void {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer)
      this.turnTimer = null
    }
    // A placement hold is checked before the deadline is cleared, and deliberately.
    // The deadline a client is holding in place is the deadline the room resumes from,
    // so wiping it here would blank the player's ring for the whole placement and leave
    // the resume counting from a value nobody was ever shown. The arming request is
    // dropped, the held deadline stays.
    if (this.placementSeat !== null) return
    // The deadline is cleared with the timeout, so every early return below leaves the
    // room with no clock running rather than a stale one from the previous visit.
    this.turnDeadlineAt = null
    if (!this.started || this.stopped) return
    if (this.awaitingPlayback) return
    const frame = this.match.currentFrame
    if (!frame || frame.phase === 'FRAME_END') return
    const seat = frame.turnIndex
    // The clock is armed on the robot's visit too. The ring is a shared view of whose
    // visit it is, so it must attach to whichever avatar is at the table; what a
    // timeout must never do is foul the robot, and `onTurnTimeout` still refuses that.
    if (this.isSeatDisconnected(seat)) return
    if (this.turnTimeoutSec <= 0) return
    // `remainingMs` is how the clock is restarted after a placement hold: from the time
    // that was left when the hold began, not from a fresh full visit. It is clamped so a
    // caller cannot hand out a longer clock than the configuration allows.
    const duration = Math.max(
      1,
      Math.min(remainingMs ?? this.turnTimeoutSec * 1000, this.turnTimeoutSec * 1000)
    )
    this.turnDeadlineAt = Date.now() + duration
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null
      this.onTurnTimeout()
    }, duration)
  }

  /**
   * The turn timing a client needs in order to show the shot clock.
   *
   * `serverNow` travels with the deadline so the client can work out how far its own
   * clock is from the server's and correct for it. Without that, a client whose machine
   * runs fast would show time that had already expired, or hide time the player still
   * had, and the two would disagree about when a foul is coming.
   *
   * A zero duration means the turn clock is switched off; a null deadline means no
   * clock is running at all. Neither is a licence for the client to invent a deadline.
   *
   * `paused` is the one state that must not be read as "no clock": the deadline is
   * still reported, and it is still the deadline the room will resume from. A client
   * that treated a paused clock as absent would draw an empty ring for the whole
   * placement, hiding the seconds the player still has.
   */
  turnTiming(): { turnDeadlineAt: number | null; turnDurationMs: number; serverNow: number; paused: boolean } {
    return {
      turnDeadlineAt: this.turnDeadlineAt,
      turnDurationMs: this.turnTimeoutSec > 0 ? this.turnTimeoutSec * 1000 : 0,
      serverNow: Date.now(),
      paused: this.placementSeat !== null
    }
  }

  /**
   * Says out loud what the clock is doing right now.
   *
   * The deadline travels with the table broadcasts, but the clock also changes between
   * them: it restarts the moment a replay is released, and it stops when the striker
   * goes away. Those moments carry no table state of their own, so without this
   * announcement every client would keep drawing the last clock it was told about —
   * frozen at empty, or counting down a turn nobody is timing any more.
   */
  private broadcastTurnClock(): void {
    this.broadcast('turn:clock', { turn: this.turnTiming() })
  }

  private onTurnTimeout(): void {
    if (this.stopped) return
    // The timeout is a foul for an aiming turn that was never used. Balls moving or
    // a replay being watched are not that; the clock is stopped for both of them
    // anyway. A placement in progress is not that either: the clock is held for the
    // whole of it, so this timer cannot be sitting here waiting to expire. The room
    // cannot stall on a player who never places, but that is now the backstop's job,
    // and the backstop releases the hold rather than punishing the player for it.
    const state = this.executionState()
    if (state === 'PHYSICS_SIMULATION' || state === 'RULE_EVALUATION' || state === 'TURN_TRANSITION') return
    const frame = this.match.currentFrame
    if (!frame) return
    const seat = frame.turnIndex
    if (!this.isHumanTurn(seat) || this.isSeatDisconnected(seat)) return
    this.simulating = true
    try {
      const { foulValue, reason } = applyTimeoutFoul(frame, seat, 'turn timeout')
      const events = [
        this.event('FOUL', { penalty: foulValue, reason, bySeat: seat }),
        this.event('TURN_CHANGE', { turnSeat: frame.turnIndex })
      ]
      const end = maybeEndFrame(frame)
      this.commit(events, frame, end.frameEnded, end.frameWinner)
      this.callbacks.log(`turn timed out for seat ${seat} on ${this.matchId}`)
    } finally {
      this.simulating = false
    }
  }

  /**
   * The pacing refusal this player's shot would get right now, or null if that is not
   * the reason it would be turned away. This asks only about the one case where a
   * refused shot is the player doing as they were told, so a caller can exempt it
   * without exempting a shot that is out of turn, from another match, or malformed.
   */
  pacingRejection(userId: string): string | null {
    const frame = this.match.currentFrame
    if (!frame) return null
    // Only the striker is ever waiting on a replay. Anyone else refused while a replay
    // runs is refused for their own reasons, and must still be counted.
    if (this.seatOfUser.get(userId) !== frame.turnIndex) return null
    return this.awaitingPlayback ? 'wait for the table to settle' : null
  }

  handleShot(userId: string, shot: ShotInputDto): { accepted: boolean; error?: string } {
    const frame = this.match.currentFrame
    if (!frame) return { accepted: false, error: 'frame not running' }
    const seat = this.seatOfUser.get(userId)
    if (seat === undefined) return { accepted: false, error: 'not in match' }
    if (seat !== frame.turnIndex) return { accepted: false, error: 'not your turn' }
    if (this.simulating) return { accepted: false, error: 'balls still moving' }
    // A shot may only be played once the table has settled. Firing into an
    // animation already in flight was accepted before, and abandoned that
    // animation partway through.
    if (this.awaitingPlayback) return { accepted: false, error: 'wait for the table to settle' }
    if (this.isBotTurn()) return { accepted: false, error: 'robot is thinking' }
// A shot may not be played through the back of a placement. The ball has to be
      // down first, or `applyStroke` would be handed no `cuePos` with the ball still in
      // hand and place it wherever the rules layer happens to start from.
      if (frame.cueInHand) return { accepted: false, error: 'place the cue ball first' }
      // A placement hold means the camera is still flying home. The player cannot shoot
      // until `placement:done` releases the hold.
      if (this.placementSeat === seat) return { accepted: false, error: 'placement in progress' }
    return this.executeShot(seat, shot)
  }

  /**
   * The striker declares that it is placing its cue ball, and the clock is held for it.
   *
   * Separate from `handleShot` because placing is not shooting. It was previously
   * carried as a shot with a position and no power, which is a thing the rules layer
   * cannot tell apart from a striker who swung at nothing, and answered accordingly.
   * Separating the two is what lets this method exist at all: there is now a moment,
   * before the ball is down, at which the room knows the player is still arranging the
   * table and can stop the strike clock without touching a single rule.
   *
   * Idempotent, and deliberately forgiving about a second call. A client that re-sends
   * `placement:begin` after a reconnect, or one that has simply been holding its own
   * state for a while, must land on the hold that is already running rather than
   * starting a second one, and must never be handed the remainder as a fresh clock.
   */
  handlePlacementBegin(userId: string): { accepted: boolean; error?: string } {
    const frame = this.match.currentFrame
    if (!frame) return { accepted: false, error: 'frame not running' }
    const seat = this.seatOfUser.get(userId)
    if (seat === undefined) return { accepted: false, error: 'not in match' }
    if (seat !== frame.turnIndex) return { accepted: false, error: 'not your turn' }
    if (this.isBotTurn()) return { accepted: false, error: 'robot is thinking' }
    if (this.simulating || this.awaitingPlayback) return { accepted: false, error: 'wait for the table to settle' }
    if (!frame.cueInHand) return { accepted: false, error: 'cue ball is not in hand' }
    // Already held for this seat: nothing to do. Re-announcing is harmless, and the
    // clock is not re-held and the backstop is not restarted, so a chatty client cannot
    // stretch the window out indefinitely by saying this repeatedly.
    if (this.placementSeat === seat) return { accepted: true }

    const remaining = this.turnDeadlineAt === null ? null : Math.max(0, this.turnDeadlineAt - Date.now())
    if (this.turnTimer) {
      clearTimeout(this.turnTimer)
      this.turnTimer = null
    }
    this.placementSeat = seat
    this.placementRemainingMs = remaining
    if (this.placementGuardTimer) clearTimeout(this.placementGuardTimer)
    this.placementGuardTimer = setTimeout(() => {
      this.placementGuardTimer = null
      this.releasePlacementHold('backstop')
    }, PLACEMENT_HOLD_MS)
    // The deadline is left exactly where it was: it is the deadline the player is still
    // shown, and the one the resume counts from.
    this.broadcastTurnClock()
    this.callbacks.log(`placement hold for seat ${seat} on ${this.matchId}`)
    return { accepted: true }
  }

  /**
   * Puts the cue ball down where the striker chose, and lets the clock run again.
   *
   * The placement itself is {@link applyCuePlacement}, which changes nothing but the
   * ball's position. There is deliberately no `applyStroke` here and no `SHOT` event:
   * nothing was struck, so there is no shot to announce, nothing to resolve against the
   * rules, no foul to raise, no penalty to add and no turn to hand over. The visit is
   * still the striker's, and the shot they take next is the first thing anyone has hit.
   *
   * Idempotent by way of `applyCuePlacement`: a confirmation that arrives twice finds
   * the ball already down, reports `alreadyPlaced`, and lands on the same table without
   * moving anything.
   */
  handlePlacementConfirm(
    userId: string,
    cuePos: { x: number; y: number }
  ): { accepted: boolean; error?: string; alreadyPlaced?: boolean } {
    const frame = this.match.currentFrame
    if (!frame) return { accepted: false, error: 'frame not running' }
    const seat = this.seatOfUser.get(userId)
    if (seat === undefined) return { accepted: false, error: 'not in match' }
    if (seat !== frame.turnIndex) return { accepted: false, error: 'not your turn' }
    if (this.simulating) return { accepted: false, error: 'balls still moving' }
    if (this.awaitingPlayback) return { accepted: false, error: 'wait for the table to settle' }

    const outcome = applyCuePlacement(frame, cuePos)
    if (!outcome.ok) {
      // Refused on the rules, so the hold stays up and the player can try again. The
      // refusal is returned rather than broadcast: nothing about the table changed, and
      // a frame update would imply that something had.
      return { accepted: false, error: outcome.reason ?? 'illegal placement' }
    }

// A placement that put the ball down is table state, so it goes out as a
      // `game:update`: every client needs the snapshot, and the log needs the fact that
      // this visit began with the ball in hand. There are no gameplay events attached -
      // a placement is not a pot, a foul or a turn change, and inventing an event for it
      // would be claiming on the log that something happened to the game that did not.
//
// The hold is *not* lifted here. The camera is still flying back from the placement, and
// the player is not aiming yet, so the clock waits for the `placement:done` that says the
// flight landed. `commit` arms as it always does, which is a no-op under a hold, so the
// broadcast goes out carrying the held clock and the placed ball together.
this.commit([], frame, false, null)
return { accepted: true, alreadyPlaced: outcome.alreadyPlaced }
}

/**
   * The second half of a placement: the client reports that the camera has landed back at
   * the gameplay view, and the clock resumes from the time the hold preserved.
   *
   * Separate from the confirmation because that is the instant the player is actually able
   * to shoot. Lifting the hold on the confirmation instead would start the clock while the
   * camera was still in the air, so the first seconds of every placement were spent
   * watching a transition the player could not do anything about.
   */
handlePlacementDone(userId: string): { accepted: boolean; error?: string } {
const frame = this.match.currentFrame
if (!frame) return { accepted: false, error: 'frame not running' }
const seat = this.seatOfUser.get(userId)
if (seat === undefined) return { accepted: false, error: 'not in match' }
if (seat !== frame.turnIndex) return { accepted: false, error: 'not your turn' }
if (this.simulating) return { accepted: false, error: 'balls still moving' }
// The ball has to be down. A `done` for a placement that never landed would otherwise
// resume the clock with the ball still in hand, which is the state this whole flow exists
// to avoid.
if (frame.cueInHand) return { accepted: false, error: 'cue ball not placed' }
// Nothing to lift is not a failure. The client sends this on the way out of *any*
// placement flow, including one that never declared a hold, and a duplicate is the
// normal case for a client that retries after a reconnect.
if (this.placementSeat === null || this.placementSeat !== seat) return { accepted: true }
this.releasePlacementHold('confirmed')
return { accepted: true }
}

  /**
   * Lifts a placement hold and restarts the strike clock from the time it had left.
   *
   * `from` changes only what the clock is restarted from. Both callers mean the same thing
   * about the game: the hold is over and the player has whatever they had left.
   *
   * This is deliberately separate from putting the ball down. A placement ends in two
   * steps, because the player experiences it in two steps: the ball goes down, and then the
   * camera comes home. The confirmation publishes the placed ball and leaves the hold up,
   * so the clock is still the held value while the camera flies back, and this lifts it
   * only once the client reports that flight has landed. Resuming at confirmation instead
   * would count the player's own camera transition against their shot clock.
   */
  private releasePlacementHold(from: 'confirmed' | 'backstop'): void {
    if (this.placementGuardTimer) {
      clearTimeout(this.placementGuardTimer)
      this.placementGuardTimer = null
    }
    if (this.placementSeat === null) return
    this.placementSeat = null
    const remaining = this.placementRemainingMs
    this.placementRemainingMs = null
    // The backstop releases the hold without the player having placed anything, so the
    // ball is still in hand and the clock must not be resumed from a remainder that was
    // measured before a flight the player may still be sitting through. A full visit is
    // re-armed there, and the ordinary timeout applies from then on as it always did.
    const armWith = from === 'backstop' ? undefined : remaining ?? undefined
    this.armTurnTimer(armWith)
    this.broadcastTurnClock()
    this.scheduleBotIfNeeded()
    this.callbacks.log(`placement hold released (${from}) on ${this.matchId}`)
  }

  /**
   * Drops a placement hold without resuming anything, for when the visit is over for a
   * reason that has its own handling — the striker disconnected, the frame ended, the
   * room is closing. Leaving the hold in place across any of those would have the next
   * visit inherit it, and leaving the carried remainder would hand that visit a clock
   * measured from a placement that no longer happened.
   */
  private abandonPlacementHold(): void {
    if (this.placementGuardTimer) {
      clearTimeout(this.placementGuardTimer)
      this.placementGuardTimer = null
    }
    this.placementSeat = null
    this.placementRemainingMs = null
  }

  placementStateFor(userId: string): { placing: boolean; seat: number | null } {
    const seat = this.seatOfUser.get(userId)
    return { placing: this.placementSeat !== null && this.placementSeat === seat, seat: this.placementSeat }
  }

  private executeShot(seat: number, shot: ShotInputDto): { accepted: boolean; error?: string } {
    const frame = this.match.currentFrame
    if (!frame) return { accepted: false, error: 'frame not running' }
    if (this.simulating) return { accepted: false, error: 'busy' }
    this.simulating = true
    try {
      const normalized: ShotInput = {
        aimAngle: shot.aimAngle ?? 0,
        power: Math.min(1, Math.max(0, shot.power ?? 0)),
        spin: { x: shot.spin.x ?? 0, y: shot.spin.y ?? 0 },
        timestamp: 0,
        cuePos: shot.cuePos ?? undefined
      }
      const outcome = applyStroke(frame, seat, normalized, { playback: { rate: SHOT_KEYFRAME_RATE } })
      const shotEvent = this.event('SHOT', { byIndex: seat, shot: normalized })
      const events: GameUpdateEvent[] = []
      for (const id of outcome.sim.pottedIds) {
        events.push(this.event('BALL_POTTED', { ballId: id, bySeat: seat }))
      }
      if (outcome.resolution.foul) {
        events.push(this.event('FOUL', { penalty: outcome.resolution.foulValue, reason: outcome.resolution.reason, bySeat: seat }))
      }
      if (outcome.resolution.turnSwitches) {
        events.push(this.event('TURN_CHANGE', { turnSeat: frame.turnIndex }))
      }
      const playback: ShotPlayback | undefined = outcome.sim.keyframes?.length
        ? {
            duration: outcome.sim.simSeconds,
            keyframes: outcome.sim.keyframes,
            pots: outcome.sim.pots ?? []
          }
        : undefined
      this.commit(events, frame, outcome.frameEnded, outcome.frameWinner, [shotEvent], playback)
      return { accepted: true }
    } finally {
      this.simulating = false
    }
  }

  private commit(
    events: GameUpdateEvent[],
    frame: FrameState,
    frameEnded: boolean,
    frameWinner: number | null,
    persistOnly: GameUpdateEvent[] = [],
    rawPlayback?: ShotPlayback
  ): void {
    // The token is claimed before the shot is broadcast, so the `shot:done` that comes
    // back for this animation can be matched against it.
    const playback = this.claimPlayback(rawPlayback)
    this.noteDelivered(events)
    void this.callbacks.persist([...persistOnly, ...events])
    if (frameEnded && frameWinner !== null) {
      void this.handleFrameEnd(frameWinner, frame, playback)
    } else {
      // The hold is taken before the clock is armed, so a turn that begins while a
      // shot is still being watched does not start counting down behind the
      // animation. The clock is armed before the broadcast, because the broadcast is
      // what tells the clients when the turn runs out, and a deadline sent a moment
      // before it was set would leave every client counting from the wrong instant.
      this.holdForPlayback(playback)
      this.armTurnTimer()
      this.broadcast('game:update', { frame: frameSnapshot(frame), events, playback })
      this.scheduleBotIfNeeded()
    }
  }

  /**
   * Stamps a playback payload with the token for the shot it describes.
   *
   * Bumping here, before the broadcast, is what makes the token meaningful: a
   * `shot:done` carrying this token can only have come from a client that received
   * this exact animation.
   */
  private claimPlayback(playback?: ShotPlayback): ShotPlayback | undefined {
    if (!playback) return undefined
    this.playbackToken += 1
    return { ...playback, token: this.playbackToken }
  }

  private async handleFrameEnd(frameWinner: number, endedFrame: FrameState, playback?: ShotPlayback): Promise<void> {
    // The frame-ending broadcast must not carry the striker's spent deadline: it was
    // consumed by the shot that ended the frame, and a client that drew it would show
    // an empty clock across the whole ceremony that follows.
    this.turnDeadlineAt = null
    const scores = { player0: endedFrame.scores.player0, player1: endedFrame.scores.player1 }
    const frameEnd = this.event('FRAME_END', { winnerSeat: frameWinner, scores })
    this.noteDelivered([frameEnd])
    this.broadcast('game:update', {
      frame: frameSnapshot(endedFrame),
      events: [frameEnd],
      playback
    })
    void this.callbacks.persist([frameEnd])
    // The frame-winning shot animates too, so the room is held for it. The client
    // queues the frame:start broadcast below behind that same replay, which keeps
    // the re-rack from cutting the last shot of the frame off mid-flight.
    this.holdForPlayback(playback)
    await this.callbacks.onFrameEnd(this.matchId, frameWinner, scores)
    const matchEnded = applyFrameWinner(this.match, frameWinner)
    if (matchEnded) {
      const winner = matchWinnerIndex(this.match)
      this.broadcast('match:end', { winnerSeat: winner, framesWon: this.match.framesWon })
      await this.callbacks.onMatchEnd(this.matchId, winner, 'frames')
    } else {
      const nextBreak = frameWinner === 0 ? 1 : 0
      const nextFrame = newFrameForMatch(this.match, nextBreak)
      // Armed before the broadcast, for the same reason as in commit(): the broadcast
      // carries the deadline the new frame's turn runs out at.
      this.armTurnTimer()
      this.broadcast('frame:start', {
        frameIndex: this.match.frameIndex + 1,
        snapshot: frameSnapshot(nextFrame)
      })
      this.scheduleBotIfNeeded()
    }
  }

  handleConcede(userId: string): string | null {
    const seat = this.seatOfUser.get(userId)
    if (seat === undefined) return null
    const winnerSeat = seat === 0 ? 1 : 0
    const winnerUserId = [...this.seatOfUser.entries()].find(([, s]) => s === winnerSeat)?.[0] ?? null
    if (winnerUserId) {
      this.broadcast('match:end', { winnerSeat, reason: 'concede' })
      void this.callbacks.onMatchEnd(this.matchId, winnerSeat, 'concede')
    }
    return winnerUserId
  }

  private scheduleBotIfNeeded(): void {
    if (!this.isBotTurn()) return
    if (this.botTimer) clearTimeout(this.botTimer)
    // The bot must not fire while the table is still animating: its shot would be
    // broadcast into the middle of the previous replay.
    if (this.awaitingPlayback) return
    const level = this.aiLevel ?? 'MEDIUM'
    // A fixed think time. The old randomised 800-2300ms let a short roll of the dice
    // fire the bot while the room was still in RULE_EVALUATION on a slow client, which
    // read as the bot playing before the balls had stopped. The delay is now measured
    // from the moment the room is actually giving the bot a settled turn, and the
    // fire-time gate below refuses anything else.
    this.botTimer = setTimeout(() => {
      this.botTimer = null
      const frame = this.match.currentFrame
      if (!frame || frame.turnIndex !== 1 || this.simulating || this.awaitingPlayback) return
      // A placement hold is a human's, and `handlePlacementBegin` refuses the robot
      // outright, so this cannot normally be set here. It is checked anyway: the one
      // thing that must never happen is the bot walking onto the table to play while a
      // player is still in the middle of the placement flow, and a guard that is only
      // correct because of a rule three files away is not a guard.
      if (this.placementSeat !== null) return
      // Strict execution-state gate. The bot fires only with a settled table under its
      // control: PLAYER_AIMING, or BALL_IN_HAND_PLACEMENT, where the stroke it is about
      // to commit carries the cue ball's own legal placement (computeBotShot returns a
      // cuePos whenever the cue is in hand, so its shot completes the placement).
      // Every other state — balls moving, a verdict still being watched, the frame
      // handing over — refuses the shot and reschedules rather than playing out of sync.
      const state = this.executionState()
      if (state !== 'PLAYER_AIMING' && state !== 'BALL_IN_HAND_PLACEMENT') {
        this.scheduleBotIfNeeded()
        return
      }
      const bot = computeBotShot(frame, level, this.matchId)
      this.executeShot(1, { aimAngle: bot.shot.aimAngle, power: bot.shot.power, spin: bot.shot.spin, cuePos: bot.shot.cuePos })
    }, BOT_SHOT_DELAY_MS)
  }

  /**
   * Holds the room while a shot animates, so no further shot is broadcast until
   * the players have actually watched it through.
   *
   * The hold ends when a client reports `shot:done`, or when the backstop timer
   * fires for a client that never will. The backstop is deliberately generous: it
   * only exists so a dead client cannot wedge the match, and is never what ends a
   * hold in normal play.
   *
   * A shot broadcast while every player is disconnected is not held at all. Nobody
   * can watch an animation that has already finished unseen, so holding would only
   * make the room sit out the backstop before it could move on. The frames the shot
   * produced are already persisted, so a player who comes back rejoins a settled
   * position rather than a stalled one.
   */
  private holdForPlayback(playback?: ShotPlayback): void {
    if (!playback) return
    if (!this.anySocketWatching()) return
    this.awaitingPlayback = true
    // Record what is being held, not merely what was last played, so an
    // acknowledgement can only ever end the hold it is actually about.
    this.heldToken = playback.token ?? this.playbackToken
    // Everyone attached right now is about to start watching this shot, so each of
    // them is able to end the hold. Sockets that arrive later are not added.
    this.replayWatchers = new Set(this.allSocketIds())
    if (this.playbackTimer) clearTimeout(this.playbackTimer)
    const budgetMs = (playback.duration / SHOT_PLAYBACK_SPEED) * 1000
    this.playbackTimer = setTimeout(() => {
      this.playbackTimer = null
      this.releasePlayback()
    }, budgetMs * 2 + 15000)
  }

  /**
   * Called when a client reports that a shot has finished animating. The room
   * resumes: the turn clock restarts and the bot takes its turn if it has one.
   *
   * The report has to clear four bars, and each one closes a way of ending a shot
   * that somebody is still watching.
   *
   * Seat membership: without it any client that guessed the match id could release
   * another player's hold.
   *
   * A hold being active: with nothing held there is no animation to protect, so a
   * report is meaningless rather than something to act on.
   *
   * The token matching the *held* shot: a client that is behind never received a
   * token at all, and one that is ahead sends the token of a shot already released.
   * Comparing against the held shot rather than the most recent one stops a stale
   * participant ending the current animation early, because the most recent token
   * also belongs to shots that were never held.
   *
   * The reporting socket having watched: this is what a seat check cannot do. Being
   * seated says nothing about which animation the client is looking at, so a tab that
   * joined late, reconnected, or has already moved on would otherwise be able to end
   * a hold belonging to a shot it never saw.
   */
  noteShotPlayed(userId: string, token: number | undefined, socketId: string): void {
    if (this.seatOfUser.get(userId) === undefined) return
    if (!this.awaitingPlayback) return
    if (this.heldToken === null) return
    // The token has to match exactly. A missing token used to be taken as a wildcard,
    // which let a stale report end the wrong shot's hold; every client echoes the
    // token it was sent, so there is no legitimate reason to accept one without it.
    if (token !== this.heldToken) return
    if (!this.replayWatchers.has(socketId)) return
    this.releasePlayback()
  }

  private releasePlayback(): void {
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer)
      this.playbackTimer = null
    }
    if (!this.awaitingPlayback) return
    this.awaitingPlayback = false
    // Drop the held token and the watchers with the hold. A report still carrying
    // either is now talking about a shot that is over, and there is nothing left for
    // it to release.
    this.heldToken = null
    this.replayWatchers = new Set()
    this.armTurnTimer()
    // The release is the moment the next visit's clock actually starts, and no table
    // broadcast follows it, so the fresh deadline is announced here. This is what
    // makes the ring reappear at 30 instead of staying frozen wherever it stopped.
    this.broadcastTurnClock()
    this.scheduleBotIfNeeded()
  }

  private noteDelivered(events: GameUpdateEvent[]): void {
    if (events.length === 0) return
    const maxSeq = Math.max(...events.map((e) => e.seq))
    for (const [userId, seat] of this.seatOfUser) {
      const set = this.socketIds.get(seat)
      if (!set || set.size === 0) continue
      const prev = this.deliveredSeqByUser.get(userId) ?? 0
      this.deliveredSeqByUser.set(userId, Math.max(prev, maxSeq))
    }
  }

  private event(type: string, data: unknown): GameUpdateEvent {
    const seq = ++this.seq
    return { matchId: this.matchId, seq, type, data }
  }

  /**
   * The events whose payload describes the state of the table, and therefore the
   * moment any turn clock attached to it.
   *
   * Enumerated here rather than attached at each call site so that a new broadcast
   * carrying frame state cannot be added without a client learning the deadline, and
   * so the two cannot drift apart. The deadline is read as the broadcast is made, so
   * every caller must have armed the clock first.
   */
  private static readonly TIMED_EVENTS = new Set(['game:update', 'frame:start', 'match:start'])

  broadcast(event: string, payload: unknown): void {
    if (GameRoom.TIMED_EVENTS.has(event) && payload !== null && typeof payload === 'object') {
      this.callbacks.board
        .to(`match:${this.matchId}`)
        .emit(event, { ...(payload as Record<string, unknown>), turn: this.turnTiming() })
      return
    }
    this.callbacks.board.to(`match:${this.matchId}`).emit(event, payload)
  }

  dispose(): void {
    if (this.botTimer) clearTimeout(this.botTimer)
    this.botTimer = null
    if (this.turnTimer) clearTimeout(this.turnTimer)
    this.turnTimer = null
    this.abandonPlacementHold()
    this.turnDeadlineAt = null
    this.stopped = true
  }
}

function defaultCallbacks(): RoomCallbacks {
  return {
    board: undefined as unknown as Server,
    persist: async () => {},
    onFrameEnd: async () => {},
    onMatchEnd: async () => {},
    log: () => {}
  }
}