import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TABLE_LENGTH, TABLE_WIDTH } from '@snooker/shared'
import { createCueController, type AimState, type TableView } from './input.js'
import { setTableTransform } from './renderer.js'
import { aimPose, topDownPose } from './camera.js'
import { ndcToPixel, pickCameraAt, pixelToNdc, projectToNdc, screenToTable, type PickCamera } from './cameraPick.js'

const WIDTH = 2000
const HEIGHT = 1000
const SCALE = WIDTH / TABLE_LENGTH
const OFFSET_X = 0
/**
 * Centring the flat transform is what lets the overhead view be compared against it below.
 * A flat map offset from the centre is not a scaled copy of anything a camera can project —
 * the lens's principal point is always the middle of the frame — so an off-centre map would
 * be comparing two different mappings and calling the difference a regression.
 */
const OFFSET_Y = HEIGHT / 2 - (TABLE_WIDTH / 2) * SCALE
const CUE = { x: 900, y: 500 }

/**
 * The canvas the controller is handed, reduced to the four things it actually touches. It
 * exists so aiming and firing can be driven from a test at all; none of it changes what the
 * controller does with the numbers it is given.
 */
class FakeCanvas {
  width = WIDTH
  height = HEIGHT
  style: { touchAction: string } = { touchAction: '' }
  private readonly listeners = new Map<string, (event: Record<string, unknown>) => void>()

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    // Client coordinates and backing-store pixels are the same here, so a test can say
    // "at pixel 1234" and mean it.
    return { left: 0, top: 0, width: WIDTH, height: HEIGHT }
  }

  setPointerCapture(): void {}

  addEventListener(type: string, handler: (event: Record<string, unknown>) => void): void {
    this.listeners.set(type, handler)
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type)
  }

  fire(type: string, event: Record<string, unknown>): void {
    const handler = this.listeners.get(type)
    if (!handler) throw new Error(`nothing is listening for ${type}`)
    handler({ preventDefault(): void {}, ...event })
  }
}

/** The camera the scene would be holding for a given aim, built from the real pose. */
function aimCameraFor(angle: number, cue = CUE): PickCamera {
  const pose = aimPose(cue, angle)
  return pickCameraAt(
    { x: pose.x, y: pose.y, height: pose.height },
    { x: pose.lookX, y: pose.lookY, height: pose.lookHeight },
    pose.fov,
    WIDTH / HEIGHT
  )
}

/** Where a point on the cloth is drawn by a given camera. */
function pixelOf(point: { x: number; y: number }, camera: PickCamera): { x: number; y: number } {
  const ndc = projectToNdc(point, 0, camera)!
  return ndcToPixel(ndc.x, ndc.y, WIDTH, HEIGHT)
}

/** A 3D view over a real camera, standing in for the scene's. */
function viewOver(camera: PickCamera, ballRadiusPx = 24): TableView {
  return {
    screenToTable: (px, py) => {
      const ndc = pixelToNdc(px, py, WIDTH, HEIGHT)
      return screenToTable(ndc.x, ndc.y, camera)
    },
    tableToScreen: (x, y) => {
      const ndc = projectToNdc({ x, y }, 0, camera)
      return ndc ? ndcToPixel(ndc.x, ndc.y, WIDTH, HEIGHT) : null
    },
    ballRadiusPx: () => ballRadiusPx
  }
}

interface Harness {
  canvas: FakeCanvas
  shots: Array<{ aimAngle: number; power: number }>
  states: AimState[]
  aimNow: () => AimState
}

function harness(options: { view?: () => TableView | undefined; enabled?: () => boolean } = {}): Harness {
  const canvas = new FakeCanvas()
  const aim: AimState[] = []
  const shots: Array<{ aimAngle: number; power: number }> = []
  createCueController({
    canvas: canvas as unknown as HTMLCanvasElement,
    cuePosition: CUE,
    enabled: options.enabled ?? ((): boolean => true),
    onChange: (state) => aim.push({ ...state }),
    onShoot: (shot) => shots.push({ aimAngle: shot.aimAngle, power: shot.power }),
    view: options.view
  })
  return { canvas, shots, states: aim, aimNow: () => aim[aim.length - 1]! }
}

function pointer(x: number, y: number): Record<string, unknown> {
  return { clientX: x, clientY: y, pointerId: 1 }
}

/** Where the flat projection draws a table point, for the no-view assertions. */
function flatPixel(x: number, y: number): { x: number; y: number } {
  return { x: OFFSET_X + x * SCALE, y: OFFSET_Y + y * SCALE }
}

/** The overhead view, built from the real pose rather than by hand. */
function overheadCamera(): PickCamera {
  const pose = topDownPose(WIDTH / HEIGHT)
  return pickCameraAt(
    { x: pose.x, y: pose.y, height: pose.height },
    { x: pose.lookX, y: pose.lookY, height: pose.lookHeight },
    pose.fov,
    WIDTH / HEIGHT
  )
}

beforeEach(() => {
  setTableTransform({ offsetX: OFFSET_X, offsetY: OFFSET_Y, scale: SCALE })
  // The controller eases power on animation frames. Nothing here is testing that, and a frame
  // firing after a test finished would write into a torn-down harness.
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('aiming without a 3D view', () => {
  it('is the flat projection it has always been', () => {
    // The fallback renderer draws one fixed overhead table and has always answered through its
    // own projection. This is the behaviour that must not move: a pointer level with the cue
    // ball and to its right aims along the table's length, and one below it aims across.
    const h = harness()
    const cue = flatPixel(CUE.x, CUE.y)

    h.canvas.fire('pointermove', pointer(cue.x + 200, cue.y))
    expect(h.aimNow().angle).toBeCloseTo(0, 9)

    h.canvas.fire('pointermove', pointer(cue.x, cue.y + 200))
    expect(h.aimNow().angle).toBeCloseTo(Math.PI / 2, 9)
  })

  it('does nothing at all while the visit is not playable', () => {
    const h = harness({ enabled: () => false })
    h.canvas.fire('pointerdown', pointer(WIDTH / 2, HEIGHT / 2))
    h.canvas.fire('pointerup', pointer(WIDTH / 2, HEIGHT / 2))
    expect(h.shots).toHaveLength(0)
    expect(h.states).toHaveLength(0)
  })
})

describe('aiming through the camera', () => {
  it('aims at the point under the pointer, from behind the cue ball', () => {
    // The whole reason for the cast. From the aim camera the far half of the table is
    // compressed into a narrow band in the middle of the frame, so the pixel a ball is drawn
    // at and the line from the cue ball to that pixel do not agree. Pointing at the drawn
    // pixel has to come back as the angle to the ball.
    const camera = aimCameraFor(0)
    const h = harness({ view: () => viewOver(camera) })

    for (const target of [
      { x: 2400, y: 500 },
      { x: 900, y: 1100 },
      { x: 2400, y: 1100 }
    ]) {
      const pixel = pixelOf(target, camera)
      h.canvas.fire('pointermove', pointer(pixel.x, pixel.y))
      expect(h.aimNow().angle).toBeCloseTo(Math.atan2(target.y - CUE.y, target.x - CUE.x), 6)
    }
  })

it('gives the same answer as the flat projection does overhead', () => {
    // The check that matters for "the 2D view has not changed": aiming at a *table point*
    // means the same angle whether the point is found through the flat map or through an
    // overhead camera. The two mappings are not the same picture — the lens frames the table
    // with a margin and the flat map fills the canvas — so the comparison has to be made in
    // table space, by pointing at each mapping's own pixel for the same ball.
    const camera = overheadCamera()
    const flat = harness()
    const cast = harness({ view: () => viewOver(camera) })

    for (const target of [
      { x: 2400, y: 500 },
      { x: 900, y: 1100 },
      { x: 2600, y: 1100 },
      { x: 1200, y: 200 }
    ]) {
      const expected = Math.atan2(target.y - CUE.y, target.x - CUE.x)
      const flatPixelOfTarget = flatPixel(target.x, target.y)
      flat.canvas.fire('pointermove', pointer(flatPixelOfTarget.x, flatPixelOfTarget.y))
      expect(flat.aimNow().angle).toBeCloseTo(expected, 6)

      const castPixelOfTarget = pixelOf(target, camera)
      cast.canvas.fire('pointermove', pointer(castPixelOfTarget.x, castPixelOfTarget.y))
      expect(cast.aimNow().angle).toBeCloseTo(expected, 6)
    }
  })

  it('leaves the aim alone above the horizon, rather than snapping it', () => {
    // A ray through the sky never meets the cloth. The honest answer is "no answer", and the
    // aim stays where the player put it.
    const camera = aimCameraFor(0)
    const h = harness({ view: () => viewOver(camera) })
    const target = pixelOf({ x: 2400, y: 500 }, camera)
    h.canvas.fire('pointermove', pointer(target.x, target.y))
    const aimed = h.aimNow().angle

    h.canvas.fire('pointermove', pointer(0, 0))
    expect(h.aimNow().angle).toBe(aimed)
  })

  it('leaves the aim alone when the pointer is on the cue ball itself', () => {
    // There is no direction from the cue ball to itself, and pointing at the baulk end
    // because of it would be worse than leaving the shot where it was.
    const camera = aimCameraFor(0)
    const h = harness({ view: () => viewOver(camera) })
    const target = pixelOf({ x: 2400, y: 500 }, camera)
    h.canvas.fire('pointermove', pointer(target.x, target.y))
    const aimed = h.aimNow().angle

    const onBall = pixelOf(CUE, camera)
    h.canvas.fire('pointermove', pointer(onBall.x, onBall.y))
    expect(h.aimNow().angle).toBe(aimed)
  })

  it('falls back to the flat projection when the scene is gone', () => {
    // A graphics error can drop the 3D scene mid-game, leaving the flat renderer to draw.
    // The view provider says so, and the controller has to go on answering through the flat
    // projection rather than casting through a camera that is not drawing anything.
    let sceneAlive = true
    const h = harness({ view: () => (sceneAlive ? viewOver(aimCameraFor(0)) : undefined) })
    const cue = flatPixel(CUE.x, CUE.y)

    sceneAlive = false
    h.canvas.fire('pointermove', pointer(cue.x + 200, cue.y))
    expect(h.aimNow().angle).toBeCloseTo(0, 9)
  })
})

describe('firing', () => {
it('fires when released on the ball, in the direction it was pressed', () => {
    const h = harness()
    const cue = flatPixel(CUE.x, CUE.y)
    // A few pixels off centre rather than exactly on it. Pressing the ball's exact pixel
    // leaves the cue ball to pointer vector at zero length, and the angle of a zero-length
    // vector is whatever the rounding of the coordinate conversion happens to say — a
    // question no player can ask with a hand.
    const press = { x: cue.x + 4, y: cue.y + 2 }
    h.canvas.fire('pointerdown', pointer(press.x, press.y))
    h.canvas.fire('pointerup', pointer(press.x, press.y))
    expect(h.shots).toHaveLength(1)
    expect(h.shots[0]!.aimAngle).toBeCloseTo(Math.atan2(2, 4), 6)
  })

  it('cancels when released well away from the ball', () => {
    const h = harness()
    const cue = flatPixel(CUE.x, CUE.y)
    h.canvas.fire('pointerdown', pointer(cue.x, cue.y))
    h.canvas.fire('pointerup', pointer(cue.x + 120, cue.y))
    expect(h.shots).toHaveLength(0)
  })

  it('takes the release radius from the ball as it is drawn', () => {
    // A ball filling sixty pixels across is a sixty-pixel target, not a twelve-pixel one: the
    // gesture that means "release on the ball" has to mean the same thing whatever the view.
    const camera = aimCameraFor(0)
    const onBall = pixelOf(CUE, camera)

    const wide = harness({ view: () => viewOver(camera, 60) })
    wide.canvas.fire('pointerdown', pointer(onBall.x, onBall.y))
    // Well outside a twelve-pixel radius, well inside a sixty-pixel one.
    wide.canvas.fire('pointerup', pointer(onBall.x + 40, onBall.y))
    expect(wide.shots).toHaveLength(1)

    const narrow = harness({ view: () => viewOver(camera, 8) })
    narrow.canvas.fire('pointerdown', pointer(onBall.x, onBall.y))
    narrow.canvas.fire('pointerup', pointer(onBall.x + 40, onBall.y))
    expect(narrow.shots).toHaveLength(0)
  })
})