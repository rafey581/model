export interface ShotInput {
  aimAngle: number
  power: number
  spin: Vec2
  timestamp: number
  cuePos?: Vec2
}

export interface SimShot {
  aimAngle: number
  power: number
  spin: Vec2
}

export type SimEventType = 'BALL_HIT' | 'CUSHION' | 'POTTED' | 'CUE_POTTED'

export interface SimEvent {
  type: SimEventType
  tick: number
  ballId: number
  otherBallId?: number
}

export interface SimResult {
  balls: BallState[]
  events: SimEvent[]
  firstContactId: number | null
  cuePotted: boolean
  pottedIds: number[]
  settled: boolean
  ticksUsed: number
  /**
   * Simulated seconds actually integrated. `ticksUsed` cannot be used for this:
   * a tick advances a ball by several substeps, so a shot that used 1097 ticks
   * took 1676 * TICK_DT = 13.97s of table time.
   */
  simSeconds: number
  /** Only present when `options.playback` was requested. */
  keyframes?: SimKeyframe[]
  /** Only present when `options.playback` was requested: [ballId, simSeconds]. */
  pots?: Array<[number, number]>
}

/**
 * One sampled instant of a shot.
 *
 * Positions are millimetres, rounded, and encoded as `[id, x, y]` tuples rather
 * than objects: a full-power break carries around 3600 ball samples, and the
 * key names alone account for roughly half the payload.
 */
export interface SimKeyframe {
  /** Simulated seconds since the cue strike. */
  t: number
  /**
   * Only balls that are still on the table and still moving. A ball is simply
   * absent from later keyframes once it stops or is potted, which keeps the
   * payload proportional to how much is actually in motion.
   */
  balls: Array<[id: number, x: number, y: number]>
}

/**
 * Server-to-client shot animation stream. Times are simulated seconds; the
 * client scales them by its own playback speed, so changing the speed never
 * needs a server change.
 */
export interface ShotPlayback {
  duration: number
  keyframes: SimKeyframe[]
  pots: Array<[number, number]>
}

/**
 * The event records the server writes to the match log.
 *
 * The payload shapes here are what the room actually broadcasts. They name the
 * seat rather than the player index, because a log row has to read sensibly on
 * its own once the match is over and the seats are no longer mapped to anybody.
 */
export type GameUpdate =
  | { type: 'SHOT'; seq: number; shot: ShotInput; byIndex: number }
  | { type: 'BALL_POTTED'; seq: number; ballId: number; bySeat: number }
  | { type: 'FOUL'; seq: number; penalty: number; reason: string; bySeat: number }
  | { type: 'TURN_CHANGE'; seq: number; turnSeat: number }
  | { type: 'FRAME_END'; seq: number; winnerSeat: number; scores: { player0: number; player1: number } }
  | { type: 'MATCH_END'; seq: number; winnerSeat: number; reason: string }

import type { BallState } from './state.js'
import type { Vec2 } from './vec.js'