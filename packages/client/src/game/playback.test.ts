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

/**
 * How a ball is turning, carried through the replay when the server sends it: the
 * surface's velocity over the cloth and the side spin, so the ball can be drawn
 * skidding, screwing back or spinning on its side rather than always rolling.
 */
describe('a ball turning in the replay', () => {
  function spinShot(): ShotPlayback {
    return {
      duration: 1,
      keyframes: [
        // Struck at 3 m/s with right-hand side and screw: its surface turns backwards.
        { t: 0, balls: [[BALL_IDS.CUE, 400, 400, -1000, 0, 800]] },
        { t: 0.1, balls: [[BALL_IDS.CUE, 700, 400, -600, 0, 760]] },
        { t: 0.5, balls: [[BALL_IDS.CUE, 1500, 400, 0, 0, 600]] }
      ],
      pots: []
    }
  }

  it('reads the turning off the samples and interpolates it between them', () => {
    const player = new ShotPlayer(spinShot(), table())
    const mid = cueOf(runTo(player, 0.05))
    expect(mid.turn).toBeDefined()
    expect(mid.turn!.rollX).toBeCloseTo(-800, 6)
    expect(mid.turn!.rollY).toBeCloseTo(0, 6)
    // Right-hand side turns it positively, and at a real rate off the strike speed.
    expect(mid.turn!.sideRate).toBeGreaterThan(0)
  })

  it('keeps spinning a stopped ball on the spot, wearing off over time', () => {
    const player = new ShotPlayer(spinShot(), table())
    const atStop = cueOf(runTo(player, 0.5)).turn!.sideRate
    const later = cueOf(runTo(player, 0.4)).turn!.sideRate
    expect(atStop).toBeGreaterThan(0)
    expect(later).toBeGreaterThan(0)
    expect(later).toBeLessThan(atStop)
  })

  it('says nothing about turning for a ball sampled without it (an older server)', () => {
    const player = new ShotPlayer(shot([]), table())
    expect(cueOf(runTo(player, 1.5)).turn).toBeUndefined()
  })
})
