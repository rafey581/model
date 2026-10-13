import { BALL_IDS, MAX_CUE_SPEED, pocketPositions, type ShotPlayback, type SimContact } from '@snooker/shared'
import { USE_NEW_SFX } from '../lobby/flag.js'
import { SpeedTracker } from './rolling.js'
import { emitSfx } from './sfxEvents.js'

/**
 * Turns a shot being replayed into sound events, on the replay's own clock.
 *
 * The game replays a recorded shot: positions sampled thirty times a second, the moment
 * each ball went down, and the contacts the simulation made on the way. This walks that
 * recording alongside the replay and says what happened as the replay reaches it — never
 * when the message arrived, and never ahead of the picture. It is told three things by
 * the game (a replay began, the replay is now here, the replay is over) and tells the
 * game nothing back.
 *
 * It keeps its own place in the recording and its own copy of where the balls were drawn.
 * It never writes to the replay, the recording or the snapshot it is shown.
 */

interface ShownBall {
  id: number
  x: number
  y: number
  potted: boolean
}

export interface ReplaySfx {
  /** A replay has been set up for this recording. Nothing has moved yet. */
  shotStarted(playback: ShotPlayback, startBalls: ReadonlyArray<ShownBall>): void
  /**
   * The replay is at `simSeconds` into the shot, and these are the balls as drawn.
   * `speed` is how many simulated seconds pass per real second.
   */
  tick(simSeconds: number, speed: number, balls: ReadonlyArray<ShownBall>, nowMs: number): void
  /** The replay is over, or was thrown away. */
  shotEnded(): void
}

/** How long before a pot a jaw contact still counts as part of it, in simulated seconds. */
const JAW_BEFORE_POT_SECONDS = 0.25

/** The cue ball's first two samples: where the shot was played from, and how hard. */
function readStrike(playback: ShotPlayback): { power: number; x: number; y: number } | null {
  let from: { t: number; x: number; y: number } | null = null
  for (const keyframe of playback.keyframes) {
    const cue = keyframe.balls.find(([id]) => id === BALL_IDS.CUE)
    if (!cue) continue
    if (!from) {
      from = { t: keyframe.t, x: cue[1], y: cue[2] }
      continue
    }
    const span = keyframe.t - from.t
    if (span <= 0) return null
    const speed = Math.hypot(cue[1] - from.x, cue[2] - from.y) / span
    return { power: Math.min(1, speed / MAX_CUE_SPEED), x: from.x, y: from.y }
  }
  return null
}

/** How fast a ball was going just before it went down, and where, from its last samples. */
function readPot(playback: ShotPlayback, ballId: number, potTime: number): { speed: number; x: number; y: number } {
  let before: { t: number; x: number; y: number } | null = null
  let last: { t: number; x: number; y: number } | null = null
  for (const keyframe of playback.keyframes) {
    // The sample taken as the ball drops is the pocket's centre, not where the ball was.
    if (keyframe.t >= potTime - 1e-6) break
    const ball = keyframe.balls.find(([id]) => id === ballId)
    if (!ball) continue
    before = last
    last = { t: keyframe.t, x: ball[1], y: ball[2] }
  }
  if (!last) return { speed: 0, x: 0, y: 0 }
  if (!before || last.t - before.t <= 0) return { speed: 0, x: last.x, y: last.y }
  return { speed: Math.hypot(last.x - before.x, last.y - before.y) / (last.t - before.t), x: last.x, y: last.y }
}

export function createReplaySfx(): ReplaySfx {
  const pockets = pocketPositions()
  const tracker = new SpeedTracker()
  let playback: ShotPlayback | null = null
  let contacts: SimContact[] = []
  let pots: Array<[number, number]> = []
  let nextContact = 0
  let nextPot = 0
  let struck = false
  let rolling = false
  /** Reused every frame for the positions handed to the speed tracker. */
  const positions: Array<{ id: number; x: number; z: number }> = []

  const nearestPocket = (x: number, y: number): number => {
    let best = 0
    let bestDistance = Infinity
    for (let i = 0; i < pockets.length; i++) {
      const d = Math.hypot(pockets[i]!.x - x, pockets[i]!.y - y)
      if (d < bestDistance) {
        bestDistance = d
        best = i
      }
    }
    return best
  }

  return {
    shotStarted(next, startBalls): void {
      playback = next
      contacts = [...(next.contacts ?? [])].sort((a, b) => a[1] - b[1])
      pots = [...(next.pots ?? [])].sort((a, b) => a[1] - b[1])
      nextContact = 0
      nextPot = 0
      struck = false
      tracker.reset()
      // A ball that is on the table at the start of a shot can be potted in it. This is
      // what lets a colour that was potted and put back on its spot sound again.
      for (const ball of startBalls) if (!ball.potted) emitSfx({ type: 'respot', ballId: ball.id })
    },
    tick(simSeconds, speed, balls, nowMs): void {
      if (!playback) return
      const rate = speed > 0 ? speed : 1
      /** The real moment something at `t` in the shot was due, for the lateness rule. */
      const dueAt = (t: number): number => nowMs - ((simSeconds - t) / rate) * 1000

      if (!struck) {
        struck = true
        const strike = readStrike(playback)
        if (strike) {
          // When the cue ball meets something inside its first two samples, those samples
          // are of a ball that has already been slowed, and the shot reads as a tap. The
          // speed it met that first ball at is the better witness to how hard it was hit.
          const early = contacts.find((c) => c[0] === 0 && (c[2] === BALL_IDS.CUE || c[3] === BALL_IDS.CUE))
          const earlyPower = early && early[1] < 0.08 ? Math.min(1, early[4] / MAX_CUE_SPEED) : 0
          emitSfx({ type: 'cueStrike', power: Math.max(strike.power, earlyPower), x: strike.x, z: strike.y, at: dueAt(0) })
        }
      }

      while (nextContact < contacts.length && contacts[nextContact]![1] <= simSeconds) {
        const [kind, t, idA, idB, hit, x, y] = contacts[nextContact]!
        nextContact++
        // The step is the contact's own timestamp: two reports of one contact share it.
        const step = Math.round(t * 1000)
        if (kind === 0) emitSfx({ type: 'ballBall', idA, idB, speed: hit, x, z: y, at: dueAt(t), step })
        else if (kind === 1) emitSfx({ type: 'cushion', ballId: idA, cushion: idB, speed: hit, x, z: y, at: dueAt(t), step })
        else emitSfx({ type: 'jaw', ballId: idA, speed: hit, x, z: y, at: dueAt(t), step })
      }

      while (nextPot < pots.length && pots[nextPot]![1] <= simSeconds) {
        const [ballId, t] = pots[nextPot]!
        nextPot++
        const pot = readPot(playback, ballId, t)
        const jaw = contacts.some((c) => c[0] === 2 && c[2] === ballId && c[1] <= t && t - c[1] <= JAW_BEFORE_POT_SECONDS)
        emitSfx({ type: 'pocket', ballId, pocketIndex: nearestPocket(pot.x, pot.y), speed: pot.speed, x: pot.x, jaw, at: dueAt(t) })
      }

      // The roll, from the positions as drawn. The replay runs faster than the table, so
      // the speeds are brought back to the table's own before they are reported.
      positions.length = 0
      for (const ball of balls) if (!ball.potted) positions.push({ id: ball.id, x: ball.x, z: ball.y })
      const moving = tracker.update(positions, nowMs)
      for (const ball of moving) ball.speed /= rate
      emitSfx({ type: 'rollTick', balls: moving })
      rolling = true
    },
    shotEnded(): void {
      playback = null
      contacts = []
      pots = []
      tracker.reset()
      if (rolling) {
        rolling = false
        emitSfx({ type: 'rollTick', balls: [] })
      }
    }
  }
}

/**
 * The one adapter the game talks to, or null when the new sounds are off — in which case
 * the game's three calls into it are three checks against null and nothing else.
 */
export const replaySfx: ReplaySfx | null = USE_NEW_SFX ? createReplaySfx() : null
