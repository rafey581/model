import { describe, expect, it } from 'vitest'
import { TABLE_LENGTH, TABLE_WIDTH } from '@snooker/shared'
import {
  CAMERA_REACH_MM,
  MAX_FOV_DEG,
  VISIBLE_HALF_LENGTH,
  VISIBLE_HALF_WIDTH,
  aimPose
} from './camera.js'
import {
  SPECTATOR_CAM,
  addressHeading,
  beginSpectatorTransition,
  fitSpectatorCamera,
  nextSpectating,
  projectFromPose,
  stepSpectatorTransition,
  type SpectatorCamConfig,
  type SpectatorSignal
} from './spectatorCamera.js'

const HALF_L = TABLE_LENGTH / 2
const HALF_W = TABLE_WIDTH / 2

/** The outer corners of everything that counts as the table: bed, cushions, pocket mouths. */
const CORNERS = [
  { x: HALF_L - VISIBLE_HALF_LENGTH, y: HALF_W - VISIBLE_HALF_WIDTH },
  { x: HALF_L + VISIBLE_HALF_LENGTH, y: HALF_W - VISIBLE_HALF_WIDTH },
  { x: HALF_L - VISIBLE_HALF_LENGTH, y: HALF_W + VISIBLE_HALF_WIDTH },
  { x: HALF_L + VISIBLE_HALF_LENGTH, y: HALF_W + VISIBLE_HALF_WIDTH }
]

const ASPECTS: Array<[string, number]> = [
  ['1920x1080', 1920 / 1080],
  ['1366x768', 1366 / 768],
  ['1024x768', 1024 / 768],
  ['800x450', 800 / 450],
  ['ultrawide 21:9', 21 / 9],
  ['square', 1],
  ['portrait 768x1024', 768 / 1024],
  ['portrait 450x800', 450 / 800],
  ['portrait 390x844', 390 / 844],
  ['sliver 320x900', 320 / 900]
]

describe('fitting the spectator camera', () => {
  it.each(ASPECTS)('holds the whole table inside the margin at %s', (_name, aspect) => {
    const fit = fitSpectatorCamera(aspect)
    expect(fit.fits).toBe(true)
    const limit = 1 - 2 * SPECTATOR_CAM.screenMargin
    let widest = 0
    let tallest = 0
    for (const corner of CORNERS) {
      const ndc = projectFromPose(fit.pose, aspect, corner)
      expect(ndc).not.toBeNull()
      expect(Math.abs(ndc!.x)).toBeLessThanOrEqual(limit + 1e-6)
      expect(Math.abs(ndc!.y)).toBeLessThanOrEqual(limit + 1e-6)
      widest = Math.max(widest, Math.abs(ndc!.x))
      tallest = Math.max(tallest, Math.abs(ndc!.y))
    }
    // Fitted, not merely contained: the table reaches the margin on at least one axis,
    // so it is as large as this screen allows rather than a speck in the middle of it.
    expect(Math.max(widest, tallest)).toBeGreaterThan(limit - 1e-3)
  })

  it('centres the table left to right, with no roll', () => {
    const aspect = 16 / 9
    const { pose } = fitSpectatorCamera(aspect)
    expect(pose.y).toBeCloseTo(HALF_W, 9)
    expect(pose.lookY).toBeCloseTo(HALF_W, 9)
    const left = projectFromPose(pose, aspect, CORNERS[0]!)!
    const right = projectFromPose(pose, aspect, CORNERS[2]!)!
    expect(left.x).toBeCloseTo(-right.x, 9)
    // No roll: the two ends of a rail sit at the same height on screen.
    expect(left.y).toBeCloseTo(right.y, 9)
  })

  it('looks down at the configured pitch, from over the configured end', () => {
    const foot = fitSpectatorCamera(16 / 9).pose
    const pitch = Math.atan2(foot.height - foot.lookHeight, Math.abs(foot.lookX - foot.x))
    expect((pitch * 180) / Math.PI).toBeCloseTo(SPECTATOR_CAM.pitchDeg, 6)
    expect(foot.x).toBeGreaterThan(TABLE_LENGTH)
    expect(foot.lookX).toBeLessThan(foot.x)

    const baulk = fitSpectatorCamera(16 / 9, { ...SPECTATOR_CAM, endSide: 'baulk' }).pose
    expect(baulk.x).toBeLessThan(0)
    expect(baulk.lookX).toBeGreaterThan(baulk.x)
    // The same view from the other end: mirrored about the middle of the table.
    expect(baulk.x - HALF_L).toBeCloseTo(-(foot.x - HALF_L), 6)
    expect(baulk.height).toBeCloseTo(foot.height, 6)
  })

  it('stands further back the narrower the screen, until it has to open the lens instead', () => {
    const wide = fitSpectatorCamera(21 / 9)
    const hd = fitSpectatorCamera(16 / 9)
    const square = fitSpectatorCamera(1)
    expect(wide.fovDeg).toBe(SPECTATOR_CAM.fovDeg)
    expect(hd.fovDeg).toBe(SPECTATOR_CAM.fovDeg)
    expect(hd.distance).toBeGreaterThanOrEqual(wide.distance)
    // What grows as the screen narrows is how much the lens takes in at the table: the
    // distance while the room allows it, the field of view once it does not.
    const reach = (fit: typeof hd): number => fit.distance * Math.tan((fit.fovDeg * Math.PI) / 360)
    const portrait = fitSpectatorCamera(9 / 16)
    expect(reach(square)).toBeGreaterThanOrEqual(reach(hd))
    expect(reach(portrait)).toBeGreaterThan(reach(square))
    expect(portrait.distance).toBeGreaterThan(square.distance)
    // A very tall, narrow screen: the room is not high enough, so the lens opens instead.
    const sliver = fitSpectatorCamera(320 / 900)
    expect(sliver.fovDeg).toBeGreaterThan(SPECTATOR_CAM.fovDeg)
    expect(sliver.fovDeg).toBeLessThanOrEqual(MAX_FOV_DEG)
    expect(sliver.pose.height).toBeCloseTo(SPECTATOR_CAM.maxHeight, 3)
  })

  it('never leaves the box the rig keeps every camera in', () => {
    for (const [, aspect] of ASPECTS) {
      const { pose } = fitSpectatorCamera(aspect)
      expect(pose.height).toBeLessThanOrEqual(SPECTATOR_CAM.maxHeight + 1e-6)
      expect(pose.height).toBeGreaterThanOrEqual(SPECTATOR_CAM.minHeight)
      expect(Math.abs(pose.x - HALF_L)).toBeLessThanOrEqual(CAMERA_REACH_MM + 1e-6)
    }
  })

  it('follows the config: a bigger margin is a smaller table on screen', () => {
    const roomy: SpectatorCamConfig = { ...SPECTATOR_CAM, screenMargin: 0.15 }
    const aspect = 16 / 9
    const fit = fitSpectatorCamera(aspect, roomy)
    for (const corner of CORNERS) {
      const ndc = projectFromPose(fit.pose, aspect, corner)!
      expect(Math.abs(ndc.x)).toBeLessThanOrEqual(0.7 + 1e-6)
      expect(Math.abs(ndc.y)).toBeLessThanOrEqual(0.7 + 1e-6)
    }
    expect(fit.distance).toBeGreaterThan(fitSpectatorCamera(aspect).distance)
  })
})

describe('deciding whether to spectate', () => {
  const signal = (overrides: Partial<SpectatorSignal> = {}): SpectatorSignal => ({
    enabled: true,
    seatKnown: true,
    liveOpponentTurn: false,
    liveReplay: false,
    replayByOpponent: false,
    settled: true,
    shownMyTurn: true,
    presentationHeld: false,
    placementActive: false,
    ...overrides
  })
  /** The opponent's visit, at rest. */
  const theirs = { liveOpponentTurn: true, shownMyTurn: false }

  it('stays in the normal view on my own turn', () => {
    expect(nextSpectating(false, signal())).toBe(false)
  })

  it('goes up when the turn is the opponent’s and the table has settled', () => {
    expect(nextSpectating(false, signal({ ...theirs }))).toBe(true)
  })

  it('lets my own shot finish, and be looked at, before it goes up', () => {
    // My miss: the turn has flipped already, but it is my shot that is rolling.
    expect(nextSpectating(false, signal({ ...theirs, liveReplay: true }))).toBe(false)
    // Stopped, but only just.
    expect(nextSpectating(false, signal({ ...theirs, settled: false }))).toBe(false)
    // Stopped for long enough.
    expect(nextSpectating(false, signal({ ...theirs }))).toBe(true)
  })

  it('goes up at once for an opponent’s shot, even if the table had not settled yet', () => {
    // The bug this replaces: a quick opponent played before the settle had run out, the
    // settle started again, and the whole of their shot was watched from the wrong view.
    expect(
      nextSpectating(false, signal({ ...theirs, liveReplay: true, replayByOpponent: true, settled: false }))
    ).toBe(true)
  })

  it('stays up for the whole of the opponent’s visit', () => {
    // Their shot.
    expect(nextSpectating(true, signal({ ...theirs, liveReplay: true, replayByOpponent: true, settled: false }))).toBe(true)
    // They potted: at rest between shots, settled or not.
    expect(nextSpectating(true, signal({ ...theirs, settled: false }))).toBe(true)
    expect(nextSpectating(true, signal({ ...theirs }))).toBe(true)
    // Their next shot.
    expect(nextSpectating(true, signal({ ...theirs, liveReplay: true, replayByOpponent: true, settled: false }))).toBe(true)
  })

  it('stays up while the opponent’s miss is still rolling, and for a moment after', () => {
    // The turn is mine already on the live game; it is their shot on the table.
    expect(nextSpectating(true, signal({ liveReplay: true, replayByOpponent: true, settled: false }))).toBe(true)
    // Stopped, not yet settled: their shot is still being looked at.
    expect(nextSpectating(true, signal({ settled: false }))).toBe(true)
    // Settled: back to my own view.
    expect(nextSpectating(true, signal())).toBe(false)
  })

  it('comes straight down if I play before it has', () => {
    expect(nextSpectating(true, signal({ liveReplay: true, replayByOpponent: false, settled: false }))).toBe(false)
  })

  it('does not move while a turn presentation is holding the table', () => {
    expect(nextSpectating(true, signal({ presentationHeld: true }))).toBe(true)
    expect(nextSpectating(false, signal({ ...theirs, presentationHeld: true }))).toBe(false)
  })

  it('is off whenever the flag is off, whatever the turn', () => {
    for (const current of [true, false]) {
      expect(nextSpectating(current, signal({ ...theirs, enabled: false }))).toBe(false)
    }
  })

  it('is off without a seat, and gives way to my own ball-in-hand view', () => {
    expect(nextSpectating(false, signal({ ...theirs, seatKnown: false }))).toBe(false)
    expect(nextSpectating(true, signal({ ...theirs, placementActive: true }))).toBe(false)
  })
})

describe('where the opponent’s cue rests before their shot is known', () => {
  const cue = { x: 1000, y: 800 }
  const balls = [
    { id: 0, x: 1000, y: 800, potted: false },
    { id: 3, x: 1500, y: 800, potted: false },
    { id: 7, x: 1000, y: 400, potted: false },
    { id: 9, x: 1050, y: 800, potted: true },
    { id: 21, x: 900, y: 800, potted: false }
  ]

  it('points at the nearest red when a red is on, ignoring potted balls and colours', () => {
    // The black is nearer and red 9 nearer still, but one is not on and one is off the table.
    expect(addressHeading(cue, balls, 'RED')).toBeCloseTo(-Math.PI / 2, 9)
  })

  it('points at the named colour when a colour is on', () => {
    expect(Math.abs(addressHeading(cue, balls, 'colour:21'))).toBeCloseTo(Math.PI, 9)
  })

  it('faces the middle of the table when nothing is on', () => {
    const heading = addressHeading(cue, [balls[0]!], 'RED')
    expect(heading).toBeCloseTo(Math.atan2(HALF_W - cue.y, HALF_L - cue.x), 9)
  })
})

describe('the move into and out of the view', () => {
  // The eased move itself, at the durations it is tuned for; the shipped config cuts.
  const FLY_IN_SECONDS = 0.9
  const FLY_OUT_SECONDS = 0.7
  const aspect = 16 / 9
  const aim = aimPose({ x: 900, y: 700 }, 0.4)
  const spectator = fitSpectatorCamera(aspect).pose

  /** Runs a transition to its end at 60 frames a second and hands back every pose. */
  const play = (from: typeof aim, to: typeof aim, seconds: number) => {
    let transition = beginSpectatorTransition(from, to, seconds)
    const poses = [from]
    for (let i = 0; i < 600 && transition.active; i++) {
      const stepped = stepSpectatorTransition(transition, 1 / 60)
      transition = stepped.transition
      poses.push(stepped.pose)
    }
    return { poses, transition }
  }

  it('starts on the pose it left and ends exactly on the one it was sent to', () => {
    const { poses, transition } = play(aim, spectator, FLY_IN_SECONDS)
    expect(transition.active).toBe(false)
    const first = poses[1]!
    // One frame in, it has barely left: the ease starts from rest.
    expect(Math.abs(first.height - aim.height)).toBeLessThan(5)
    const last = poses[poses.length - 1]!
    for (const key of ['x', 'y', 'height', 'lookX', 'lookY', 'lookHeight', 'fov'] as const) {
      expect(last[key]).toBeCloseTo(spectator[key], 9)
    }
    // And it took the time it was given, to the frame.
    expect(poses.length - 1).toBe(Math.ceil(FLY_IN_SECONDS * 60))
  })

  it('never blocks: watching a turn must not hold input', () => {
    let transition = beginSpectatorTransition(aim, spectator, FLY_IN_SECONDS)
    expect(transition.blocking).toBe(false)
    for (let i = 0; i < 20; i++) {
      transition = stepSpectatorTransition(transition, 1 / 60).transition
      expect(transition.blocking).toBe(false)
    }
  })

  it('cuts when given the instant duration', () => {
    const { poses } = play(aim, spectator, SPECTATOR_CAM.instantSeconds)
    // Three frames at sixty a second, and on the end pose.
    expect(poses.length - 1).toBeLessThanOrEqual(3)
    expect(poses[poses.length - 1]!.height).toBeCloseTo(spectator.height, 9)
  })

  it('retargets from wherever it is, with no jump', () => {
    let transition = beginSpectatorTransition(aim, spectator, FLY_IN_SECONDS)
    let pose = aim
    for (let i = 0; i < 24; i++) {
      const stepped = stepSpectatorTransition(transition, 1 / 60)
      transition = stepped.transition
      pose = stepped.pose
    }
    // Partway up, the turn comes back: turn round from here.
    expect(transition.active).toBe(true)
    const midway = { ...pose }
    transition = beginSpectatorTransition(pose, aim, FLY_OUT_SECONDS)
    const next = stepSpectatorTransition(transition, 1 / 60).pose
    for (const key of ['x', 'y', 'height', 'lookX', 'lookY', 'lookHeight'] as const) {
      // The first frame of the new move is a hair from where the old one was, not a leap.
      expect(Math.abs(next[key] - midway[key])).toBeLessThan(20)
    }
    const { poses } = play(pose, aim, FLY_OUT_SECONDS)
    expect(poses[poses.length - 1]!.height).toBeCloseTo(aim.height, 9)
  })
})
