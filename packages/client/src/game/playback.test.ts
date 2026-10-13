import { describe, expect, it } from 'vitest'
import { BALL_IDS, TABLE_LENGTH, TABLE_WIDTH } from '@snooker/shared'
import type { ShotPlayback } from '@snooker/shared'
import { SHOT_PLAYBACK_SPEED, ShotPlayer, type PlaybackBall } from './playback.js'

/**
 * The contract a potted cue ball relies on, which the renderer turns into a sink and
 * then a rise.
 *
 * The simulation stamps every pot with the time it happened, the cue ball included, and
 * the rules then put the cue back in hand — so the same ball arrives at the renderer as
 * potted partway through a replay and back on the table at the end of it. Both halves
 * are asserted here because the sink and the rise are keyed off the two in turn.
 */
const CUE_POT_AT = 1.25

function table(overrides: Partial<PlaybackBall> = {}): PlaybackBall[] {
  return [
    { id: BALL_IDS.CUE, x: 400, y: 400, potted: false, ...overrides },
    { id: BALL_IDS.RED_MIN, x: 2800, y: 889, potted: false }
  ]
}

function shot(pots: Array<[number, number]> = [[BALL_IDS.CUE, CUE_POT_AT]]): ShotPlayback {
  return {
    duration: 2,
    keyframes: [
      { t: 0, balls: [[BALL_IDS.CUE, 400, 400], [BALL_IDS.RED_MIN, 2800, 889]] },
      { t: CUE_POT_AT, balls: [[BALL_IDS.CUE, 400, 400], [BALL_IDS.RED_MIN, 2800, 889]] },
      { t: 2, balls: [[BALL_IDS.CUE, 591, 889], [BALL_IDS.RED_MIN, 2800, 889]] }
    ],
    pots
  }
}

function cueOf(balls: PlaybackBall[]): PlaybackBall {
  return balls.find((b) => b.id === BALL_IDS.CUE)!
}

/**
 * Runs the replay clock to a point in simulated seconds.
 *
 * `advance` takes real seconds and multiplies by the playback speed, so a test that
 * wanted to sit just before the pot has to divide it out rather than assume the two
 * clocks are the same.
 */
function runTo(player: ShotPlayer, simSeconds: number): PlaybackBall[] {
  return player.advance(simSeconds / SHOT_PLAYBACK_SPEED)
}

describe('a potted cue ball', () => {
  it('is stamped with the moment it dropped, so the sink can start there', () => {
    // The pot list is the renderer's cue to begin the sink; a cue ball missing from it
    // would vanish with no animation and no sound.
    const player = new ShotPlayer(shot(), table())
    expect(player.takeDuePots()).toEqual([])
    runTo(player, CUE_POT_AT)
    expect(player.takeDuePots()).toEqual([BALL_IDS.CUE])
  })

  it('reads as potted from the moment it dropped, not from the end of the replay', () => {
    const player = new ShotPlayer(shot(), table())
    expect(cueOf(runTo(player, CUE_POT_AT - 0.01)).potted).toBe(false)
    expect(cueOf(runTo(player, 0.01)).potted).toBe(true)
  })

  it('stays on the table throughout a shot that does not pot it', () => {
    const player = new ShotPlayer(shot([]), table())
    expect(cueOf(runTo(player, 2)).potted).toBe(false)
  })

  it('stays potted to the last frame of the replay, and the frame brings it back', () => {
    // The replay deliberately does not un-pot the cue ball: it sank, and it has to stay
    // down until the shot is over. What puts it back is the authoritative frame, whose
    // last keyframe already carries the spot the rules re-racked it onto. That handover —
    // potted in one snapshot, on the table in the next — is the transition the renderer
    // turns into the rise, so both sides of it are asserted here.
    const player = new ShotPlayer(shot(), table())
    const lastFrame = cueOf(runTo(player, 2))
    expect(player.finished).toBe(true)
    expect(lastFrame.potted, 'the cue ball must not reappear before the replay ends').toBe(true)

    // The frame the server sends for that same moment: in hand, in the D, not in a pocket.
    const frameCue = { id: BALL_IDS.CUE, x: 591, y: TABLE_WIDTH / 2, potted: false }
    expect(lastFrame.potted && !frameCue.potted, 'the rise keys off exactly this handover').toBe(true)
    expect(frameCue.x).toBeLessThan(TABLE_LENGTH)
  })
})
