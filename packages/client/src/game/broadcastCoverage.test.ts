import { describe, expect, it } from 'vitest'
import { TABLE_LENGTH, TABLE_WIDTH } from '@snooker/shared'
import {
  broadcastPose,
  resolveCameraTarget,
  sidePose,
  initialHeadingLatch,
  type CameraPose
} from './camera.js'
import { pickCameraAt, projectToNdc } from './cameraPick.js'
import { coverageTransitionSeconds, replayPhase, televisionCoverage } from './broadcastCoverage.js'

const CORNERS = [
  { x: 0, y: 0 },
  { x: TABLE_LENGTH, y: 0 },
  { x: 0, y: TABLE_WIDTH },
  { x: TABLE_LENGTH, y: TABLE_WIDTH }
]

function tableInFrame(pose: CameraPose, aspect: number): boolean {
  const cam = pickCameraAt(
    { x: pose.x, y: pose.y, height: pose.height },
    { x: pose.lookX, y: pose.lookY, height: pose.lookHeight },
    pose.fov,
    aspect
  )
  return CORNERS.every((corner) => {
    const ndc = projectToNdc(corner, 0, cam)
    return ndc !== null && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1
  })
}

describe('television coverage leaves the aiming view alone', () => {
  const base = { replaying: true, inputActive: false, selected: 'AIM' as const, calm: false, progress: 0.5 }

  it('does not move the camera while the player is aiming, charging or placing', () => {
    expect(televisionCoverage({ ...base, replaying: false, inputActive: true, progress: 0 })).toBeNull()
    expect(televisionCoverage({ ...base, inputActive: true })).toBeNull()
  })

  it('does not cover a shot when the player has chosen their own angle', () => {
    for (const selected of ['BROADCAST', 'END', 'SIDE', 'FAR', 'TOP_DOWN'] as const) {
      expect(televisionCoverage({ ...base, selected })).toBeNull()
    }
  })

  it('walks a replay from the baulk end to the side to the black end, and stops there', () => {
    expect(replayPhase(0)).toBe('wide')
    expect(replayPhase(0.33)).toBe('wide')
    expect(replayPhase(0.34)).toBe('side')
    expect(replayPhase(0.66)).toBe('side')
    expect(replayPhase(0.67)).toBe('end')
    expect(replayPhase(1)).toBe('end')
    expect(televisionCoverage({ ...base, progress: 0.1 })).toBe('BROADCAST')
    expect(televisionCoverage({ ...base, progress: 0.5 })).toBe('SIDE')
    expect(televisionCoverage({ ...base, progress: 0.9 })).toBe('END')
    // The phase is a step, not a heading. Two moments inside one phase are the same camera.
    expect(televisionCoverage({ ...base, progress: 0.4 })).toBe(televisionCoverage({ ...base, progress: 0.6 }))
  })

  it('holds the wide end camera for the whole shot when motion should stay calm', () => {
    for (const progress of [0, 0.2, 0.5, 0.8, 1]) {
      expect(televisionCoverage({ ...base, calm: true, progress })).toBe('BROADCAST')
    }
    expect(coverageTransitionSeconds(true)).toBeLessThan(coverageTransitionSeconds(false))
  })

  it('ignores a progress figure that is not a number', () => {
    expect(replayPhase(Number.NaN)).toBe('wide')
    expect(replayPhase(-2)).toBe('wide')
    expect(replayPhase(4)).toBe('end')
  })
})

describe('the end and far cameras hold the whole table', () => {
  const aspects = [16 / 9, 2, 1, 0.56]

  function pose(mode: 'END' | 'FAR' | 'BROADCAST' | 'SIDE' | 'TOP_DOWN', aspect: number): CameraPose {
    return resolveCameraTarget({
      mode,
      aspect,
      cue: { x: TABLE_LENGTH / 2, y: TABLE_WIDTH / 2 },
      aimAngle: 1.4,
      latch: initialHeadingLatch(1.4),
      focus: null
    })
  }

  it('frames every cushion from the black end and the far side, on a phone and a desktop', () => {
    for (const aspect of aspects) {
      expect(tableInFrame(pose('END', aspect), aspect)).toBe(true)
      expect(tableInFrame(pose('FAR', aspect), aspect)).toBe(true)
      expect(tableInFrame(pose('BROADCAST', aspect), aspect)).toBe(true)
      expect(tableInFrame(pose('SIDE', aspect), aspect)).toBe(true)
    }
  })

  it('stands opposite the baulk and side cameras and does not follow the aim', () => {
    const end = pose('END', 16 / 9)
    const baulk = broadcastPose(16 / 9, 0)
    expect(end.x).toBeGreaterThan(baulk.x)
    expect(end.lookX).toBeCloseTo(baulk.lookX, 6)
    const far = pose('FAR', 16 / 9)
    const side = sidePose(16 / 9, 0)
    expect(far.y).toBeGreaterThan(side.y)
    const aimed = resolveCameraTarget({
      mode: 'END',
      aspect: 16 / 9,
      cue: { x: 400, y: 400 },
      aimAngle: 2.2,
      latch: initialHeadingLatch(0),
      focus: null
    })
    expect(aimed).toEqual(end)
  })

  it('keeps the lens above the cloth', () => {
    for (const mode of ['END', 'FAR', 'BROADCAST', 'SIDE', 'TOP_DOWN'] as const) {
      expect(pose(mode, 16 / 9).height).toBeGreaterThan(0)
    }
  })
})
