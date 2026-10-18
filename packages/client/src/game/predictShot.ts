import { buildInitialBalls, simulateStroke, vec, type BallState, type ShotPlayback } from '@snooker/shared'

/**
 * The player's own shot, played on this device the instant it is struck.
 *
 * Waiting for the server's recording of a shot before moving a ball cost half a second
 * and more between the cue meeting the ball and the ball leaving it: the shot's trip to
 * the server, the simulation there, and the recording's trip back. The physics is the
 * same shared code on both ends and starts from the same table, so the device works out
 * the very shot the server will and starts moving the balls at once. The server's own
 * recording takes over the moment it arrives (see main.ts), and everything that decides
 * anything — pots, fouls, the score, the turn — is still the server's alone.
 *
 * Picture only: nothing here is sent anywhere or changes the game.
 */

/**
 * How many samples a second the server records a shot at. It has to be the server's own
 * rate (SHOT_KEYFRAME_RATE in server/src/game/room.ts) for the two recordings to line up.
 */
export const PREDICTED_KEYFRAME_RATE = 60

/** A ball as the table snapshot carries it. */
export interface PredictBall {
  id: number
  x: number
  y: number
  potted: boolean
}

/** The shot as the player sent it. */
export interface PredictShotInput {
  aimAngle: number
  power: number
  spin: { x: number; y: number }
}

/**
 * The shot's recording as the server would make it, from the table as the snapshot has
 * it; null if there is nothing to play (or it could not be worked out).
 *
 * The input is tidied exactly as the server tidies it before simulating (see executeShot
 * in server/src/game/room.ts), so both ends simulate the same numbers.
 */
export function predictShot(balls: ReadonlyArray<PredictBall>, shot: PredictShotInput): ShotPlayback | null {
  const meta = new Map(buildInitialBalls().map((b) => [b.id, b] as const))
  const state: BallState[] = []
  for (const b of balls) {
    const base = meta.get(b.id)
    if (!base) return null
    state.push({ ...base, pos: vec(b.x, b.y), vel: vec(0, 0), spin: vec(0, 0), angularVel: 0, potted: b.potted })
  }
  const input = {
    aimAngle: shot.aimAngle ?? 0,
    power: Math.min(1, Math.max(0, shot.power ?? 0)),
    spin: { x: shot.spin?.x ?? 0, y: shot.spin?.y ?? 0 },
    timestamp: 0
  }
  const sim = simulateStroke(state, input, { playback: { rate: PREDICTED_KEYFRAME_RATE } })
  if (!sim.keyframes?.length) return null
  return {
    duration: sim.simSeconds,
    keyframes: sim.keyframes,
    pots: sim.pots ?? [],
    contacts: sim.contacts ?? []
  }
}
