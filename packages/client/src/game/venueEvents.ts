import * as THREE from 'three'
import type { Socket } from 'socket.io-client'
import { BALL_IDS, MAX_CUE_SPEED, SHOT_PLAYBACK_SPEED } from '@snooker/shared'
import type { GameUpdate, ShotPlayback } from '@snooker/shared'
import { getSocket } from './network.js'
import { buildAudience, type Audience } from './audience.js'
import { buildCrowdAudio, type CrowdAudio } from './crowdAudio.js'
import { buildTurnBanner, type TurnBanner } from './turnBanner.js'
import { buildOpponentCue, type OpponentCue, type OpponentShot } from './opponentCue.js'
import type { ArenaSeatPlacement } from './arenaEnvironment.js'
import { VENUE_CONFIG, type VenueConfig } from './venueConfig.js'
import { qualityConfig } from './qualityConfig.js'

/**
 * The venue's reactions: who is in the crowd, who is at the table, and what the room did.
 *
 * This is a *listener*, and nothing else. It subscribes to the two messages a match
 * already broadcasts and reads them; it never sends one, never asks the server for
 * anything, and never touches a rule. The turn it shows, the applause it plays and the
 * cue it swings are all consequences of shots that have already been decided and
 * simulated somewhere else. If this file were deleted the game would play identically and
 * the room would be silent and empty, which is the correct shape for a thing that is only
 * decoration.
 *
 * It finds its socket itself, on a heartbeat, rather than being handed one. The socket is
 * created by the login flow and replaced when the session is refreshed, and threading it
 * through from `main.ts` would mean a change to a file this has no business touching for
 * the sake of four subscriptions. Watching for the socket's identity costs one comparison
 * a frame and survives a reconnect without being told about it.
 */

/** What the 3D scene has to offer. Implemented by `Scene3D`; nothing here knows it. */
export interface VenueHost {
  /** The group the venue's own objects live in. */
  readonly venueGroup: THREE.Group
  /** The arena's seats, so the crowd can stand in them. */
  readonly venueSeats: readonly ArenaSeatPlacement[]
  /**
   * Opens a presentation delay. Snapshots handed to the scene from here on are shown
   * `seconds` late, in order, so a turn change can be read before the table moves.
   */
  beginPresentation(seconds: number): void
  /** Shows the opponent's wind-up. Table coordinates. */
  showOpponentCue(shot: OpponentShot): void
  /** Drops the cue and releases any hold. */
  endPresentation(): void
}

export interface VenueEvents {
  /**
   * Steps the crowd, the banner and the cue. `dt` in seconds. `replayRunning` is true
   * while a shot is animating, and its trailing edge is what a turn announcement held
   * behind the player's own shot is waiting for.
   */
  step(dt: number, replayRunning: boolean): void
  /** How many spectators are in the bowl. */
  crowdSize(): number
  /** Puts the opponent's cue up behind the cue ball. */
  showCue(shot: OpponentShot): void
  /**
   * Seconds the wind-up takes from the cue rising to the moment it strikes.
   *
   * The scene needs this to line the strike up with the first frame of the replay: the
   * cue is a picture that has to meet a picture that arrives later.
   */
  cuePreRoll(): number
  /** Takes it down. */
  hideCue(): void
  dispose(): void
}

/** The wire shape of `game:update`, as far as this listener cares. */
interface GameUpdateMessage {
  frame: { turnIndex: number; balls: Array<{ id: number; potted: boolean; x: number; y: number }> }
  events?: GameUpdate[]
  playback?: ShotPlayback
}

interface MatchJoinedMessage {
  seat: number
  snapshot: { turnIndex: number }
}

/**
 * The bot's aim and power, read back out of the recording of its shot.
 *
 * The server marks its own `SHOT` event persist-only, so this is reconstructing from the
 * only evidence that reaches a client: the opening of the playback. The first keyframes
 * are the cue ball a few hundredths of a second after contact, already slowed by cloth
 * friction, so the angle is very nearly exact and the power is a touch low. Both are read
 * off a recorded shot, not off the bot's intention.
 *
 * Returns null when the recording cannot say: no keyframes, no cue ball, or a ball that
 * has not actually moved yet.
 */
export function readOpponentShot(
  playback: ShotPlayback | undefined
): { angle: number; power: number; x: number; y: number } | null {
  if (!playback?.keyframes?.length) return null
  // The opening keyframes are the cue ball in the first hundredth of a second after
  // contact. The first sample is where the shot was played from, the next one or two are
  // where it went, and the interval between them is on the keyframe's own timestamp — so
  // the speed is read off the recording rather than assumed from a sampling rate.
  let from: { t: number; x: number; y: number } | null = null
  let to: { t: number; x: number; y: number } | null = null
  for (const keyframe of playback.keyframes.slice(0, 4)) {
    const cue = keyframe.balls.find(([id]) => id === BALL_IDS.CUE)
    if (!cue) continue
    if (!from) from = { t: keyframe.t, x: cue[1], y: cue[2] }
    else {
      to = { t: keyframe.t, x: cue[1], y: cue[2] }
      break
    }
  }
  if (!from || !to) return null
  const span = to.t - from.t
  if (span <= 0) return null
  const dx = to.x - from.x
  const dy = to.y - from.y
  const travelled = Math.hypot(dx, dy)
  // Below this the cue ball has stopped, and a direction taken from a millimetre of dust
  // is worse than no cue at all.
  if (travelled < 1) return null
  const speed = travelled / span
  return {
    angle: Math.atan2(dy, dx),
    power: Math.min(1, speed / MAX_CUE_SPEED),
    x: from.x,
    y: from.y
  }
}

/**
 * A crowd of nobody, for a venue built with the seats plan switched off: same shape, so
 * the scene can step, applaud and dispose without asking. It holds no meshes, so there is
 * nothing to add and nothing to run a frame.
 */
function emptyAudience(): Audience {
  const group = new THREE.Group()
  group.name = 'audience'
  return {
    group,
    step(): void {},
    applaud(): void {},
    clapping(): number {
      return 0
    },
    size(): number {
      return 0
    },
    dispose(): void {}
  }
}

/**
 * Seat remembered across Scene3D rebuilds inside the same match.
 *
 * `match:joined` can land before a fresh venue listener is attached (practice start,
 * canvas recreate). Without this, `mySeat` stays undefined and every banner reads as
 * the opponent's. Overwritten on every join; not cleared on dispose so a mid-match
 * canvas rebuild keeps the seat until the next `match:joined`.
 */
let rememberedSeat: number | undefined

/** Frames to wait for a promised replay to start before releasing a held turn. */
const REPLAY_START_GRACE_FRAMES = 3

export function buildVenueEvents(host: VenueHost, config: VenueConfig = VENUE_CONFIG): VenueEvents {
  // The tier's own say over the crowd: on 'off' nothing is built whatever the seats
  // plan says, so a low machine never pays for a bowl of people it was told to skip.
  // The scene's seat plan already filters for today (crowd off at every tier), so this
  // gate is dormant — it is the plumbing that goes live if that changes.
  const crowdAllowed = qualityConfig().crowd !== 'off'
  const audience: Audience = crowdAllowed && host.venueSeats.length ? buildAudience(host.venueSeats, config) : emptyAudience()
  const audio: CrowdAudio = buildCrowdAudio(config)
  const banner: TurnBanner = buildTurnBanner(config)
  const cue: OpponentCue = buildOpponentCue(config)

  host.venueGroup.add(audience.group, cue.group)

  let socket: Socket | null = null
  let attached = false
  // Seed from a join that may already have happened before this venue was built.
  let mySeat: number | undefined = rememberedSeat
  let lastTurn: number | undefined
  /**
   * Turn change held until balls are at rest. Covers every seat — the player's miss,
   * the opponent's miss coming back, practice — so banners and camera lifts never cut
   * in front of rolling balls.
   */
  let pendingTurn: number | undefined
  /** Whether the previous frame had a shot replay on screen. */
  let replayWasRunning = false
  /** Live replay flag from the host, updated every `step`. */
  let ballsMoving = false
  /**
   * Frames spent waiting for a deferred replay that has not started yet. Prevents a
   * soft-lock when playback was promised but never animates (no pre-shot snapshot).
   */
  let replayStartWait = 0
  /** Queued applause, so it lands when the ball lands rather than when the packet does. */
  let clapAt = 0
  let clapPots = 0

  const seatKnown = (): boolean => mySeat !== undefined

  const chipFor = (turn: number): void => {
    if (!seatKnown()) return
    banner.setChip(turn === mySeat)
  }

  const releasePendingTurn = (): void => {
    if (pendingTurn === undefined) return
    const turn = pendingTurn
    pendingTurn = undefined
    replayStartWait = 0
    announceTurn(turn)
    chipFor(turn)
  }

  /* --- the subscription --------------------------------------------- */

  const onUpdate = (raw: unknown): void => {
    const data = raw as GameUpdateMessage
    if (!data?.frame) return
    const turn = data.frame.turnIndex
    const previousTurn = lastTurn
    const turned = lastTurn !== undefined && turn !== lastTurn
    const hasReplay = (data.playback?.keyframes?.length ?? 0) > 0
    // Hard rule: no turn banner / camera lift while balls are rolling or about to.
    // Seat is not part of the defer test — practice can briefly miss `match:joined`,
    // and an opponent's miss must wait for rest the same way the player's does.
    const defer = turned && (hasReplay || ballsMoving)

    if (defer) {
      pendingTurn = turn
      replayStartWait = 0
    } else {
      if (turned) announceTurn(turn)
      chipFor(turn)
    }
    lastTurn = turn

    for (const event of data.events ?? []) {
      // Wire shape is `{ type, data }`; shared GameUpdate is flat. Accept both.
      const type = (event as { type?: string }).type
      if (type === 'BALL_POTTED') {
        // Counted rather than fired: a break arrives as four separate events in the same
        // message, and four claps on top of each other is a click, not applause.
        clapPots = Math.max(clapPots + 1, 1)
      }
    }

    const playback = data.playback
    if (playback) {
      if (playback.pots.length) {
        // Applause follows the ball down the replay, which runs at twice table speed, so
        // the wait is the pot's timestamp divided back down to wall-clock.
        const drop = Math.max(...playback.pots.map(([, at]) => at)) / SHOT_PLAYBACK_SPEED
        clapAt = drop
      }
      // Only ever the opponent's: "my own shot is one I aimed" is read off who shot,
      // which is the turn before this update — not the turn it lands on, which on a foul
      // or a miss has already flipped to the opponent and would wrongly put the
      // opponent's cue over my own replay.
      if (seatKnown() && previousTurn !== undefined && previousTurn !== mySeat) {
        const read = readOpponentShot(playback)
        if (read) host.showOpponentCue({ x: read.x, y: read.y, angle: read.angle, power: read.power })
      }
    }
  }

  const announceTurn = (turn: number): void => {
    // Without a seat, flashing would always show "OPPONENT'S TURN" — worse than silence.
    if (!seatKnown()) return
    const mine = turn === mySeat
    banner.flash(mine)
    // The room is given its beat either way. On the player's turn there is nothing to see
    // but a settled table, so the beat is only the banner; on the opponent's it is the cue
    // coming up behind the ball.
    host.beginPresentation(config.turnDelaySeconds)
  }

  const onJoined = (raw: unknown): void => {
    const data = raw as MatchJoinedMessage
    if (!data || typeof data.seat !== 'number') return
    mySeat = data.seat
    rememberedSeat = data.seat
    lastTurn = data.snapshot?.turnIndex
    if (lastTurn !== undefined) chipFor(lastTurn)
    // A join mid-hold (reconnect): apply the seat to any turn already waiting for rest
    // without releasing it early — release still waits for ballsAtRest in `step`.
  }

  /**
   * Hooks the current socket up, once.
   *
   * Called every frame from `step`, and almost always does nothing: the socket exists and
   * is the same object it was last time. When it does not — before the first match, or
   * after the session was replaced — the listeners move across.
   */
  const attach = (): void => {
    let current: Socket
    try {
      current = getSocket()
    } catch {
      return
    }
    if (current === socket && attached) return
    if (socket && attached) {
      socket.off('game:update', onUpdate)
      socket.off('match:joined', onJoined)
    }
    socket = current
    socket.on('game:update', onUpdate)
    socket.on('match:joined', onJoined)
    attached = true
  }

  return {
    step(dt: number, replayRunning: boolean): void {
      attach()
      ballsMoving = replayRunning
      audience.step(dt)
      cue.step(dt)
      banner.tick(dt)
      if (clapPots > 0) {
        clapAt -= dt
        if (clapAt <= 0) {
          const pots = clapPots
          clapPots = 0
          const seconds = Math.min(
            config.audio.maxSeconds,
            config.audio.minSeconds + (pots - 1) * config.audio.secondsPerExtraBall
          )
          audience.applaud(seconds, 1 + (pots - 1) * 0.25)
          audio.clap(pots)
        }
      }
      // Release held turn presentations only when balls are at rest.
      if (pendingTurn !== undefined) {
        if (replayRunning) {
          replayStartWait = 0
        } else if (replayWasRunning) {
          // Trailing edge of a real replay: balls stopped.
          releasePendingTurn()
        } else {
          // Playback was promised but never started (e.g. no pre-shot snapshot). Do not
          // soft-lock the banner — release after a short grace once rest is confirmed.
          replayStartWait += 1
          if (replayStartWait >= REPLAY_START_GRACE_FRAMES) releasePendingTurn()
        }
      } else {
        replayStartWait = 0
      }
      replayWasRunning = replayRunning
    },
    crowdSize(): number {
      return audience.size()
    },
    showCue(shot: OpponentShot): void {
      cue.show(shot)
    },
    cuePreRoll(): number {
      const c = config.cue
      return c.aimSeconds + c.backswingSeconds + c.strikeSeconds
    },
    hideCue(): void {
      cue.hide()
    },
    dispose(): void {
      if (socket && attached) {
        socket.off('game:update', onUpdate)
        socket.off('match:joined', onJoined)
      }
      attached = false
      host.endPresentation()
      host.venueGroup.remove(audience.group, cue.group)
      audience.dispose()
      audio.dispose()
      cue.dispose()
      banner.dispose()
    }
  }
}