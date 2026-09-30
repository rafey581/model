import { describe, expect, it } from 'vitest'
import { BALL_RADIUS, TABLE_LENGTH, TABLE_WIDTH } from '@snooker/shared'
import { AIM_BACK_MM, AIM_HEIGHT_MM, AIM_LOOK_AHEAD_MM, TOP_DOWN_FOV_DEG, topDownHeight } from './camera.js'
import {
  PICK_PLANE_HEIGHT_MM,
  ballRadiusPx,
  cueAxisPixels,
  aimAngleTo,
  ndcToPixel,
  pickCameraAt,
  pickCameraFromWorldMatrix,
  pixelToNdc,
  projectToNdc,
  screenRay,
  screenToTable,
  type PickCamera
} from './cameraPick.js'

const DEG = Math.PI / 180
const HALF_L = TABLE_LENGTH / 2
const HALF_W = TABLE_WIDTH / 2
const ASPECT_2_TO_1 = 2

const cue = { x: 900, y: 889 }

/** The aim camera for a heading, built from the same numbers the rig uses. */
function aimCameraFor(angle: number, aspect = ASPECT_2_TO_1) {
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)
  return pickCameraAt(
    { x: cue.x - dx * AIM_BACK_MM, y: cue.y - dy * AIM_BACK_MM, height: AIM_HEIGHT_MM },
    { x: cue.x + dx * AIM_LOOK_AHEAD_MM, y: cue.y + dy * AIM_LOOK_AHEAD_MM, height: 0 },
    50,
    aspect
  )
}

const topDownCamera = (aspect = ASPECT_2_TO_1) =>
  pickCameraAt({ x: HALF_L, y: HALF_W, height: topDownHeight(aspect, TOP_DOWN_FOV_DEG) }, { x: HALF_L, y: HALF_W, height: 0 }, TOP_DOWN_FOV_DEG, aspect)

describe('picking in the overhead view', () => {
  it('puts the middle of the screen on the middle of the table', () => {
    const point = screenToTable(0, 0, topDownCamera())
    expect(point?.x).toBeCloseTo(HALF_L, 6)
    expect(point?.y).toBeCloseTo(HALF_W, 6)
  })

  it('sends the right of the screen to the right of the table, and down to down', () => {
    const right = screenToTable(1, 0, topDownCamera())
    const below = screenToTable(0, -1, topDownCamera())
    expect(right!.x).toBeGreaterThan(HALF_L)
    expect(right!.y).toBeCloseTo(HALF_W, 6)
    expect(below!.y).toBeGreaterThan(HALF_W)
    expect(below!.x).toBeCloseTo(HALF_L, 6)
  })

  it('lands where the field of view says it should, at the corners of the screen', () => {
    const camera = topDownCamera()
    const tanV = Math.tan((camera.fovDeg * Math.PI) / 360)
    const tanH = tanV * ASPECT_2_TO_1
    const corner = screenToTable(1, 1, camera)!
    expect(corner.x - HALF_L).toBeCloseTo(camera.height * tanH, 6)
    expect(HALF_W - corner.y).toBeCloseTo(camera.height * tanV, 6)
  })

  it('reaches all four corners of the table without leaving the frame', () => {
    const camera = topDownCamera()
    for (const target of [
      { x: 0, y: 0 },
      { x: TABLE_LENGTH, y: 0 },
      { x: 0, y: TABLE_WIDTH },
      { x: TABLE_LENGTH, y: TABLE_WIDTH }
    ]) {
      // Round-trip: where the corner projects, picking it returns the corner.
      const tanV = Math.tan((camera.fovDeg * Math.PI) / 360)
      const tanH = tanV * ASPECT_2_TO_1
      const ndcX = (target.x - HALF_L) / (camera.height * tanH)
      const ndcY = -(target.y - HALF_W) / (camera.height * tanV)
      expect(Math.abs(ndcX)).toBeLessThanOrEqual(1)
      expect(Math.abs(ndcY)).toBeLessThanOrEqual(1)
      const picked = screenToTable(ndcX, ndcY, camera)!
      expect(picked.x).toBeCloseTo(target.x, 3)
      expect(picked.y).toBeCloseTo(target.y, 3)
    }
  })
})

describe('picking in the aim view', () => {
  it('picks the cue ball back out of the pixel it is drawn at, for every heading', () => {
    // The invariant the input path depends on: whatever pixel a point on the cloth is drawn
    // at, that pixel answers with that point. Turn the camera and both the drawing and the
    // pick move with it, so the cue can never end up aiming somewhere the player is not
    // pointing.
    for (const degrees of [0, 30, 90, 145, -60, 180]) {
      const camera = aimCameraFor(degrees * DEG)
      const ndc = projectToNdc(cue, PICK_PLANE_HEIGHT_MM, camera)!
      expect(ndc).not.toBeNull()
      const point = screenToTable(ndc.x, ndc.y, camera)!
      expect(point.x).toBeCloseTo(cue.x, 3)
      expect(point.y).toBeCloseTo(cue.y, 3)
    }
  })

  it('answers with the point on the cloth under the ball, not the ball itself', () => {
    // A ball is drawn as a sphere sitting on the cloth, so its middle is a couple of
    // centimetres above the plane the pointer is cast at. Tapping the middle of a ball
    // therefore aims just past where it stands, along the line of sight. It is the right
    // way round: aiming is a decision about the bed of the table, and the shot line,
    // the object-ball line and the server all work in the same plane.
    const camera = aimCameraFor(0)
    const ndc = projectToNdc(cue, BALL_RADIUS, camera)!
    const point = screenToTable(ndc.x, ndc.y, camera)!
    expect(point.x).toBeGreaterThan(cue.x)
    expect(point.y).toBeCloseTo(cue.y, 3)
    // And the parallax runs the way the lens does: further out from the lens, not across.
    expect(point.x - cue.x).toBeLessThan(AIM_LOOK_AHEAD_MM)
  })

  it('puts the middle of the screen on the shot line, a fixed way ahead of the cue ball', () => {
    for (const degrees of [0, 47, 110, -80]) {
      const point = screenToTable(0, 0, aimCameraFor(degrees * DEG))!
      const along = (point.x - cue.x) * Math.cos(degrees * DEG) + (point.y - cue.y) * Math.sin(degrees * DEG)
      expect(along).toBeCloseTo(AIM_LOOK_AHEAD_MM, 3)
      const across = -(point.x - cue.x) * Math.sin(degrees * DEG) + (point.y - cue.y) * Math.cos(degrees * DEG)
      expect(across).toBeCloseTo(0, 3)
    }
  })

  it('answers the same table point for the same pixel whichever heading is aimed', () => {
    // Turning the camera turns the whole view about the cue ball, so the same pixel picks
    // the point rotated by the same angle. Round-tripped through the projection instead,
    // this is the statement that aim does not drift as the cue swings round.
    const first = screenToTable(0.4, -0.2, aimCameraFor(0))!
    const quarter = 90 * DEG
    const rotated = screenToTable(0.4, -0.2, aimCameraFor(quarter))!
    expect(rotated.x).toBeCloseTo(cue.x - (first.y - cue.y), 1)
    expect(rotated.y).toBeCloseTo(cue.y + (first.x - cue.x), 1)
  })

  it('has nothing to say above the horizon, which is the top of the aim view', () => {
    // Tilted down by about thirteen degrees with a fifty degree lens, the top of the frame
    // is still above the horizon — so the sky is a real part of this view and pointing at
    // it must leave the aim alone rather than inventing a point on the cloth.
    expect(screenToTable(0, 1, aimCameraFor(0))).toBeNull()
    // The middle of the frame, on the other hand, is cloth.
    expect(screenToTable(0, 0, aimCameraFor(0))).not.toBeNull()
  })

  it('has nothing to say when the lens is level with the cloth', () => {
    const level = pickCameraAt({ x: HALF_L, y: 0, height: 0 }, { x: HALF_L, y: 1000, height: 0 }, 50, 2)
    expect(screenToTable(0, 0, level)).toBeNull()
  })
})

describe('the ray itself', () => {
  it('is a unit vector', () => {
    const points: Array<[number, number]> = [
      [0, 0],
      [1, 1],
      [-1, -1],
      [0.7, -0.3]
    ]
    for (const [ndcX, ndcY] of points) {
      const ray = screenRay(ndcX, ndcY, topDownCamera())
      expect(Math.hypot(ray.x, ray.y, ray.h)).toBeCloseTo(1, 9)
    }
  })

  it('points down through the middle of the screen and outwards at the edges', () => {
    const camera = topDownCamera()
    expect(screenRay(0, 0, camera).h).toBeCloseTo(-1, 6)
    // The corners of the frame are further from the lens's axis than the middle.
    expect(Math.abs(screenRay(1, 1, camera).h)).toBeLessThan(1)
  })
})

describe('reading the renderer', () => {
  it('agrees with the renderer about which way the camera is facing', () => {
    // The identity matrix is a camera at the origin, unrotated: right along +X, up along
    // +Y, looking down -Z. Three's Z runs down the table, which is the table's -Y, so an
    // unrotated camera looks towards decreasing table y — the baulk end.
    const camera = pickCameraFromWorldMatrix({ x: 0, y: 0, z: 0 }, identityMatrix(), 50, 2)
    expectComponent(camera.forward, 0, -1, 0)
    expectComponent(camera.right, 1, 0, 0)
    expectComponent(camera.up, 0, 0, 1)
    // ...and its position comes back in table millimetres from the corner, not world units.
    expect(camera.x).toBeCloseTo(HALF_L, 6)
    expect(camera.y).toBeCloseTo(HALF_W, 6)
  })

  it('reads a pitched matrix, and finds what that camera was pointed at', () => {
    // The old fixed camera, built the way three builds it: above the far cushion, pitched
    // down at the middle of the table. Reading its basis back and casting through the
    // middle of the screen must land on the spot it was aimed at.
    const matrix = lookAtMatrix({ x: 0, y: 1400, z: 1750 }, { x: 0, y: 0, z: 0 })
    const camera = pickCameraFromWorldMatrix({ x: 0, y: 1400, z: 1750 }, matrix, 50, 2)
    // Forward is the direction to the middle of the table from the far cushion: along the
    // table's length, down, and across in the same ratio the two distances stand in. Note
    // the order — in this frame y is along the table and h is vertical.
    const span = Math.hypot(1400, 1750)
    expectComponent(camera.forward, 0, -1750 / span, -1400 / span)
    expect(camera.height).toBe(1400)
    const ndc = pixelToNdc(960, 540, 1920, 1080)
    const centre = screenToTable(ndc.x, ndc.y, camera)!
    expect(centre.x).toBeCloseTo(HALF_L, 6)
    expect(centre.y).toBeCloseTo(HALF_W, 6)
  })

  it('round-trips pixels through normalised coordinates', () => {
    const width = 3840
    const height = 1080
    for (const [px, py] of [
      [0, 0],
      [1920, 540],
      [3840, 1080],
      [1077, 220]
    ] as Array<[number, number]>) {
      const ndc = pixelToNdc(px, py, width, height)
      const back = ndcToPixel(ndc.x, ndc.y, width, height)
      expect(back.x).toBeCloseTo(px, 9)
      expect(back.y).toBeCloseTo(py, 9)
    }
    // Canvas y grows downwards, so the top of the canvas is the top of normalised space.
    // This flip is the single easiest thing in here to get backwards.
    expect(pixelToNdc(1920, 0, width, height).y).toBeCloseTo(1, 12)
    expect(pixelToNdc(1920, height, width, height).y).toBeCloseTo(-1, 12)
    expect(pixelToNdc(0, 540, width, height).x).toBeCloseTo(-1, 12)
  })

  it('picks and projects consistently at the pixel level, end to end', () => {
    // The bridge exactly as the scene uses it: a camera described by the renderer's own
    // matrix, a pointer reported in canvas pixels, and the two round-tripping.
    const position = { x: 0, y: 1400, z: 1750 }
    const camera = pickCameraFromWorldMatrix(position, lookAtMatrix(position, { x: 0, y: 0, z: 0 }), 50, 2)
    const ndc = projectToNdc(cue, 0, camera)!
    const pixel = ndcToPixel(ndc.x, ndc.y, 1920, 1080)
    const back = pixelToNdc(pixel.x, pixel.y, 1920, 1080)
    const point = screenToTable(back.x, back.y, camera)!
    expect(point.x).toBeCloseTo(cue.x, 6)
    expect(point.y).toBeCloseTo(cue.y, 6)
  })
})

/**
 * The world matrix three would build for a camera at `position` looking at `target`, in the
 * column-major layout the renderer hands over.
 *
 * Written out rather than taken from three so the test pins the layout — columns are the
 * camera's own axes — instead of trusting the same library it is testing.
 */
function lookAtMatrix(position: Vector3, target: Vector3): number[] {
  const z = normalise(subtract(position, target))
  const x = normalise(cross({ x: 0, y: 1, z: 0 }, z))
  const y = cross(z, x)
  const m = new Array<number>(16).fill(0)
  m[0] = x.x
  m[1] = x.y
  m[2] = x.z
  m[4] = y.x
  m[5] = y.y
  m[6] = y.z
  m[8] = z.x
  m[9] = z.y
  m[10] = z.z
  m[15] = 1
  return m
}

interface Vector3 {
  x: number
  y: number
  z: number
}

function subtract(a: Vector3, b: Vector3): Vector3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function cross(a: Vector3, b: Vector3): Vector3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  }
}

function normalise(v: Vector3): Vector3 {
  const length = Math.hypot(v.x, v.y, v.z) || 1
  return { x: v.x / length, y: v.y / length, z: v.z / length }
}

/** Component-wise comparison, so a negative zero does not fail as a different number. */
function expectComponent(actual: { x: number; y: number; h: number }, x: number, y: number, h: number): void {
  expect(actual.x).toBeCloseTo(x, 9)
  expect(actual.y).toBeCloseTo(y, 9)
  expect(actual.h).toBeCloseTo(h, 9)
}

/**
 * Compares two directions the way an angle does — 270 degrees and -90 degrees are the same
 * direction, and a plain closeness check says they are a half turn apart.
 */
function expectAngle(actual: number, expected: number): void {
  const difference = Math.atan2(Math.sin(actual - expected), Math.cos(actual - expected))
  expect(difference).toBeCloseTo(0, 6)
}

function identityMatrix(): number[] {
  const m = new Array<number>(16).fill(0)
  m[0] = 1
  m[5] = 1
  m[10] = 1
  m[15] = 1
  return m
}

describe('how wide a ball is drawn', () => {
  it('matches the flat mapping overhead, where the projection is near-affine', () => {
    // Overhead the answer should be the plain scale of the projection: the lens is
    // `height` above the cloth, so half the cloth's width falls inside
    // `height * tan(fov / 2) * aspect`, and a millimetre is worth `width / 2` over that.
    const camera = topDownCamera()
    const tanV = Math.tan((camera.fovDeg * Math.PI) / 360)
    const millimetresAcross = camera.height * tanV * camera.aspect
    const pixelsPerMm = 1920 / 2 / millimetresAcross
    expect(ballRadiusPx(cue, BALL_RADIUS, 1920, 1080, camera)).toBeCloseTo(BALL_RADIUS * pixelsPerMm, 6)
  })

  it('is bigger from behind the cue ball than from overhead', () => {
    // The ball is nearer the lens than the middle of the table, so it covers more of the
    // frame — which is the whole reason a fixed tap tolerance would have been the wrong
    // size in one of the two views.
    const overhead = ballRadiusPx(cue, BALL_RADIUS, 1920, 1080, topDownCamera())
    const behind = ballRadiusPx(cue, BALL_RADIUS, 1920, 1080, aimCameraFor(0))
    expect(behind).toBeGreaterThan(overhead)
  })

  it('measures across the view, not along it', () => {
    // Looking straight down the length of the table, a ball is as wide across the screen as
    // it ever is. Measuring along the view would report almost nothing for it.
    const down = ballRadiusPx(cue, BALL_RADIUS, 1920, 1080, aimCameraFor(0))
    const across = ballRadiusPx(cue, BALL_RADIUS, 1920, 1080, aimCameraFor(90 * DEG))
    expect(down).toBeCloseTo(across, 6)
  })

  it('shrinks with distance, so a far ball is a smaller target', () => {
    // The same ball, seen from two lenses at the same height: one close and one far back.
    const look = { x: cue.x, y: cue.y, height: 0 }
    const near = pickCameraAt({ x: cue.x - 400, y: cue.y, height: 350 }, look, 50, 1920 / 1080)
    const far = pickCameraAt({ x: cue.x - 2500, y: cue.y, height: 350 }, look, 50, 1920 / 1080)
    const nearPx = ballRadiusPx(cue, BALL_RADIUS, 1920, 1080, near)
    const farPx = ballRadiusPx(cue, BALL_RADIUS, 1920, 1080, far)
    expect(farPx).toBeLessThan(nearPx)
    expect(farPx).toBeGreaterThan(0)
  })
})

describe('the screen direction the cue points', () => {
  // The buffer matches the camera's own aspect, as the scene always keeps it. Skewing the
  // two apart — a 2:1 camera drawn into a 16:9 canvas — squashes one axis relative to the
  // other and quietly turns every screen angle, which would make these tests measure the
  // fixture instead of the geometry.
  const project =
    (camera: PickCamera) =>
    (x: number, y: number): { x: number; y: number } | null => {
      const height = 1080
      const width = height * camera.aspect
      const ndc = projectToNdc({ x, y }, PICK_PLANE_HEIGHT_MM, camera)
      return ndc ? ndcToPixel(ndc.x, ndc.y, width, height) : null
    }

  it('is a unit vector', () => {
    for (const degrees of [0, 90, 145, -60]) {
      const axis = cueAxisPixels(cue, degrees * DEG, BALL_RADIUS * 4, project(aimCameraFor(degrees * DEG)))!
      expect(Math.hypot(axis.x, axis.y)).toBeCloseTo(1, 9)
    }
  })

  it('comes down the frame whatever the aim, because the camera is behind the ball', () => {
    // The strongest thing that can be said about it, and the thing the drag gesture relies
    // on: the cue butt is always between the lens and the ball, so it is always drawn below
    // it, and always straight below — never off to one side. Pulling back down the screen is
    // adding power, in every aim direction and in both views.
    for (const degrees of [0, 30, 90, 145, -60, 180, 250]) {
      const axis = cueAxisPixels(cue, degrees * DEG, BALL_RADIUS * 4, project(aimCameraFor(degrees * DEG)))!
      expect(axis.x).toBeCloseTo(0, 6)
      expect(axis.y).toBeCloseTo(1, 6)
    }
  })

  it('runs along the table overhead, the way it always did', () => {
    // Top-down is the one view where the screen angle and the aim angle are the same angle,
    // which is why the old code was only ever right here — and the two views must not differ
    // in handedness, or switching between them would turn the table round under the player.
    // The butt is behind the ball along the aim, hence the half turn.
    for (const degrees of [0, 90, 145, -60]) {
      const axis = cueAxisPixels(cue, degrees * DEG, BALL_RADIUS * 4, project(topDownCamera()))!
      expectAngle(Math.atan2(axis.y, axis.x), degrees * DEG + Math.PI)
    }
  })

  it('refuses to guess when a point is behind the lens', () => {
    expect(cueAxisPixels(cue, 0, BALL_RADIUS * 4, () => null)).toBeNull()
  })
})

describe('the aim angle a pick implies', () => {
  it('points at the ball it was asked about', () => {
    const angle = aimAngleTo(cue, { x: 2000, y: 889 })!
    expect(angle).toBeCloseTo(0, 9)
    const angle2 = aimAngleTo(cue, { x: 900, y: 2000 })!
    expect(angle2).toBeCloseTo(90 * DEG, 9)
  })

  it('comes back to the heading the camera was built from, round tripping a pick', () => {
    for (const degrees of [0, 55, 120, -80, 200]) {
      const camera = aimCameraFor(degrees * DEG)
      const point = screenToTable(0, 0, camera)!
      const angle = aimAngleTo(cue, point)!
      const wrapped = Math.atan2(Math.sin(angle - degrees * DEG), Math.cos(angle - degrees * DEG))
      expect(wrapped).toBeCloseTo(0, 3)
    }
  })

  it('reports no direction when the point is the cue ball itself', () => {
    expect(aimAngleTo(cue, { ...cue })).toBeNull()
    expect(aimAngleTo(cue, { x: cue.x + 0.01, y: cue.y })).toBeNull()
  })
})