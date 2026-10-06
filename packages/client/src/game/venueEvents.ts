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
  /** Steps the crowd, the banner and the cue. `dt` in seconds. */
  step(dt: number): void
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

export function buildVenueEvents(host: VenueHost, config: VenueConfig = VENUE_CONFIG): VenueEvents {
  const audience: Audience = buildAudience(host.venueSeats, config)
  const audio: CrowdAudio = buildCrowdAudio(config)
  const banner: TurnBanner = buildTurnBanner(config)
  const cue: OpponentCue = buildOpponentCue(config)

  host.venueGroup.add(audience.group, cue.group)

  let socket: Socket | null = null
  let attached = false
  let mySeat: number | undefined
  let lastTurn: number | undefined
  /** Queued applause, so it lands when the ball lands rather than when the packet does. */
  let clapAt = 0
  let clapPots = 0

  /* --- the subscription --------------------------------------------- */

  const onUpdate = (raw: unknown): void => {
    const data = raw as GameUpdateMessage
    if (!data?.frame) return
    const turn = data.frame.turnIndex

    if (lastTurn !== undefined && turn !== lastTurn) announceTurn(turn)
    lastTurn = turn
    banner.setChip(mySeat !== undefined && turn === mySeat)

    for (const event of data.events ?? []) {
      if (event.type === 'BALL_POTTED') {
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
      // Only ever the opponent's: my own shot is one I aimed, and putting a cue in front
      // of me for a shot I just played would be a second, wrong answer to the same view.
      if (mySeat !== undefined && turn !== mySeat) {
        const read = readOpponentShot(playback)
        if (read) host.showOpponentCue({ x: read.x, y: read.y, angle: read.angle, power: read.power })
      }
    }
  }

  const announceTurn = (turn: number): void => {
    const mine = mySeat !== undefined && turn === mySeat
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
    lastTurn = data.snapshot?.turnIndex
    banner.setChip(lastTurn === mySeat)
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
    step(dt: number): void {
      attach()
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