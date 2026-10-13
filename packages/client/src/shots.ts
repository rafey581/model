/**
 * Throwaway render harness for the arena visual pass.
 *
 * Boots the real Scene3D against a synthetic settled frame, exposes a tiny API for
 * parking the camera in each pose the review asks for, and lets Playwright screenshot the
 * canvas. It also reports the numbers the review asks for — draw calls, triangles, frame
 * time and the luminance of the stands against the table — off `renderer.info` and a
 * `readPixels` of the live drawing buffer.
 *
 * Nothing here ships: it exists so the venue can be looked at rather than argued about,
 * and it is deleted as soon as the pass is signed off.
 *
 * `?crowd=0` / `?crowd=1` in the URL forces `CROWD_ENABLED` before the scene is built,
 * which is how both sides of the switch get screenshotted from one build.
 */
import { layoutTableBalls } from '@snooker/shared'
import { Scene3D } from './game/scene3d.js'
import { VENUE_CONFIG } from './game/venueConfig.js'
import type { PlayerCameraMode } from './game/camera.js'
import type { FrameSnapshotData, RenderOptions } from './game/renderer.js'

// A 960×540 frame keeps a software rasteriser honest about the build without asking it to
// spend the review's time on pixels nobody will read, which is what made the earlier
// 1280×720 runs smoke instead of completing.
const W = 960
const H = 540

const balls = layoutTableBalls().map((b) => ({
  id: b.id,
  x: b.pos.x,
  y: b.pos.y,
  potted: b.potted
}))

const snapshot: FrameSnapshotData = {
  turnIndex: 0,
  ballOn: 'RED',
  scores: { player0: 12, player1: 4 },
  breakScore: 12,
  remainingReds: 15,
  balls
}

const options: RenderOptions = {
  aim: { angle: 0.42, power: 0.55 },
  youSeat: 0,
  immediate: false,
  canAim: true
}

type View = 'play' | 'top' | 'corner' | 'tier' | 'broadcast' | 'side' | 'close' | 'move1' | 'move2' | 'move3'

/** Draw calls, triangles, frame time and where the light actually is. */
interface ShotsStats {
  calls: number
  triangles: number
  /** Mean milliseconds per `scene.render()` over {@link measure}'s sample. */
  frameMs: number
  crowdEnabled: boolean
  crowdSize: number
  /** Mean luminance 0..255 of the upper band: the far stands and the ceiling. */
  standsLuma: number
  /** Mean luminance 0..255 of the middle box: the table and the playing area. */
  tableLuma: number
  /** Mean luminance 0..255 of the whole frame. */
  frameLuma: number
  /** Brightest single pixel in the frame. */
  peakLuma: number
}

interface ShotsApi {
  ready: boolean
  error: string | null
  counts: { seats: number; audience: number }
  stats: ShotsStats | null
  view(name: View): void
  measure(): ShotsStats | null
}

const canvas = document.getElementById('c') as HTMLCanvasElement
const api: ShotsApi = { ready: false, error: null, counts: { seats: 0, audience: 0 }, stats: null, view: () => {}, measure: () => null }

// The switch is read when `VENUE_CONFIG` is built, and the scene reads the same object
// when it builds the crowd, so setting it here — before `boot()` runs — is the whole
// override. No query-string plumbing in the shipped config.
const forced = new URLSearchParams(location.search).get('crowd')
if (forced === '0' || forced === '1') VENUE_CONFIG.crowd.enabled = forced === '1'

function logPhase(what: string, at: number): void {
  // eslint-disable-next-line no-console
  console.log(`[shots] ${what} +${(performance.now() - at).toFixed(0)}ms`)
}

function boot(): void {
  const t0 = performance.now()
  console.log('[shots] boot start')
  const scene = Scene3dOrNull()
  logPhase('Scene3D.create', t0)
  if (!scene) {
    api.error = 'Scene3D.create returned null (WebGL unavailable)'
    api.ready = true
    return
  }

  const internals = scene as unknown as {
    camera: { position: { set(x: number, y: number, z: number): void }; lookAt(x: number, y: number, z: number): void }
    renderer: {
      info: { render: { calls: number; triangles: number; points: number; lines: number } }
      getContext(): WebGLRenderingContext
    }
    scene: { traverse(fn: (o: { name?: string; count?: number }) => void): void }
    venue?: { crowdSize(): number } | null
  }

  let mode: PlayerCameraMode = 'AIM'

  const step = (frames: number): void => {
    const t0 = performance.now()
    for (let i = 0; i < frames; i++) {
      scene.setCameraMode(mode)
      scene.setTracking(false)
      scene.update(snapshot, options)
      scene.render()
      if ((i + 1) % 20 === 0) logPhase(`step ${i + 1}/${frames}`, t0)
    }
    logPhase(`step done (${frames})`, t0)
  }

  const place = (px: number, py: number, pz: number, tx: number, ty: number, tz: number): void => {
    internals.camera.position.set(px, py, pz)
    internals.camera.lookAt(tx, ty, tz)
    scene.render()
  }

  /**
   * Where the light is, read back off the live drawing buffer.
   *
   * The stands band is the top 40% of the frame (far tiers, upper wall, ceiling) and the
   * table box is the middle 40% across the middle 40% down. The point of the numbers is
   * the review's own test: the table box has to out-read the stands band by a wide
   * margin, and the stands band has to be dark without going to zero.
   */
  const luma = (): Pick<ShotsStats, 'standsLuma' | 'tableLuma' | 'frameLuma' | 'peakLuma'> => {
    const gl = internals.renderer.getContext()
    const w = canvas.width
    const h = canvas.height
    const px = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)

    // readPixels is bottom-up; y measured from the *top* of the picture below.
    const at = (x: number, yFromTop: number): number => {
      const row = h - 1 - yFromTop
      const o = (row * w + x) * 4
      return 0.2126 * (px[o] as number) + 0.7152 * (px[o + 1] as number) + 0.0722 * (px[o + 2] as number)
    }

    let standsSum = 0
    let standsN = 0
    let tableSum = 0
    let tableN = 0
    let frameSum = 0
    let peak = 0
    const standsY0 = Math.floor(h * 0.06)
    const standsY1 = Math.floor(h * 0.46)
    const tableX0 = Math.floor(w * 0.3)
    const tableX1 = Math.floor(w * 0.7)
    const tableY0 = Math.floor(h * 0.3)
    const tableY1 = Math.floor(h * 0.7)
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const l = at(x, y)
        frameSum += l
        if (l > peak) peak = l
        if (y >= standsY0 && y < standsY1) {
          standsSum += l
          standsN++
        }
        if (x >= tableX0 && x < tableX1 && y >= tableY0 && y < tableY1) {
          tableSum += l
          tableN++
        }
      }
    }
    const samples = (w / 2) * (h / 2)
    return {
      standsLuma: standsN ? standsSum / standsN : 0,
      tableLuma: tableN ? tableSum / tableN : 0,
      frameLuma: frameSum / Math.max(1, samples),
      peakLuma: peak
    }
  }

  const measure = (): ShotsStats | null => {
    try {
      // Warm-up, so the sample is steady state rather than first-frame uploads.
      step(12)
      const times: number[] = []
      const runs = 30
      for (let i = 0; i < runs; i++) {
        const t0 = performance.now()
        scene.setCameraMode(mode)
        scene.setTracking(false)
        scene.update(snapshot, options)
        scene.render()
        times.push(performance.now() - t0)
      }
      times.sort((a, b) => a - b)
      const frameMs = times[Math.floor(times.length / 2)] as number
      const info = internals.renderer.info.render
      const stats: ShotsStats = {
        calls: info.calls,
        triangles: info.triangles,
        frameMs,
        crowdEnabled: VENUE_CONFIG.crowd.enabled,
        crowdSize: internals.venue?.crowdSize() ?? 0,
        ...luma()
      }
      api.stats = stats
      return stats
    } catch (e) {
      api.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      return null
    }
  }

  api.measure = measure

  api.view = (name: View): void => {
    try {
      // Enough frames for the rig's easing to have done its work at software-frame rates:
      // `render` advances the camera on real elapsed time, so the count also buys ~2s of
      // sim time instead of a mid-flight pose.
      const settle = 150
      switch (name) {
        case 'play':
          mode = 'AIM'
          step(settle)
          break
        case 'broadcast':
          mode = 'BROADCAST'
          step(settle)
          break
        case 'side':
          mode = 'SIDE'
          step(settle)
          break
        case 'close':
          mode = 'CLOSE'
          step(settle)
          break
        case 'top':
          mode = 'TOP_DOWN'
          step(settle)
          break
        case 'corner':
          step(settle)
          place(7600, 5400, 7600, 0, 400, 0)
          break
        case 'tier':
          step(settle)
          place(-400, 1450, 1400, 0, 950, 5600)
          break
        case 'move1':
          mode = 'TOP_DOWN'
          step(1)
          break
        case 'move2':
          step(14)
          break
        case 'move3':
          step(32)
          break
      }
    } catch (e) {
      api.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    }
  }

  // Warm the frame up so the first screenshot is not a half-built scene.
  mode = 'AIM'
  step(40)

  api.counts = {
    seats: countNamed(scene, 'arena-seats-deck'),
    audience: countNamed(scene, 'audience')
  }
  api.ready = true
}

function Scene3dOrNull(): Scene3D | null {
  return Scene3D.create(canvas, W, H)
}

function countNamed(scene: Scene3D, prefix: string): number {
  const root = (scene as unknown as { scene: { traverse(fn: (o: { name?: string; count?: number }) => void): void } }).scene
  let n = 0
  root.traverse((o) => {
    if (o.name && o.name.startsWith(prefix)) n += o.count ?? 0
  })
  return n
}

;(window as unknown as { __shots: ShotsApi }).__shots = api
void boot()
