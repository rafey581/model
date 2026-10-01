import * as THREE from 'three'
import { BALL_IDS, TABLE_LENGTH, TABLE_WIDTH, BALL_RADIUS, BAULK_LINE_X, D_RADIUS, POCKET_RADIUS_CORNER, POCKET_RADIUS_MIDDLE, pocketPositions } from '@snooker/shared'
import type { FrameSnapshotData, AimState, RenderOptions } from './renderer.js'
import { computeAimGuide, objectDirection, type AimGuide, type AimGuideBall } from './aim.js'
import { setTableTransform } from './renderer.js'
import { ballColor } from './palette.js'
import {
  type CameraRigState,
  type HeadingLatch,
  initialRigState,
  initialHeadingLatch,
  stepCameraRig,
  stepHeadingLatch,
  addOrbit
} from './camera.js'
import {
  ballRadiusPx,
  ndcToPixel,
  pickCameraAt,
  pickCameraFromWorldMatrix,
  pixelToNdc,
  projectToNdc,
  screenToTable,
  type PickCamera
} from './cameraPick.js'
import { placementStatus } from './placement.js'

const HALF_L = TABLE_LENGTH / 2
const HALF_W = TABLE_WIDTH / 2
const CUSHION_H = 12
/**
 * The cue tip's position in the stick's own space. The stick's origin sits at the
 * centre of the shaft, so the tip is well short of half the length: with the
 * ferrule (to 627) and the chalk tip (to 641) crowning the shaft, the striking
 * end is at 641mm forward. Backing the stick off by half the length instead of by
 * this number left the tip floating a ball's width or more away from the ball it
 * was addressing.
 */
const STICK_TIP_Y = 641
/** How far the tip pulls back from the ball at rest, before any power draw-back. */
const STICK_REST_GAP = 8
/** How far the tip draws back at full power, as the player loads the shot. */
const STICK_POWER_DRAW = 190
const tableX = (x: number): number => x - HALF_L
const tableZ = (y: number): number => y - HALF_W
/** Stands in for an undrawn table, so the camera's per-frame walk allocates nothing. */
const NO_BALLS: readonly FrameSnapshotData['balls'][number][] = []
/**
 * How far below its resting height a ball starts its rise back onto the cloth.
 *
 * The same depth the sink drops through, and both are driven at the same rate, so a ball
 * that goes down and comes back spends equal time doing each.
 */
const RISE_DEPTH = 34
/** The scale a ball starts its rise at, growing to full size as it reaches the cloth. */
const RISE_START_SCALE = 0.6

const textureCache = new Map<string, THREE.CanvasTexture>()

function cachedTexture(key: string, make: () => THREE.CanvasTexture): THREE.CanvasTexture {
  let tex = textureCache.get(key)
  if (!tex) {
    tex = make()
    textureCache.set(key, tex)
  }
  return tex
}
const POCKETS = pocketPositions()

/**
 * A single shared anisotropy cap, set once when the renderer exists.
 *
 * Conservative on purpose — 4× is where a grazing cue-view angle stops shimmering
 * and a weak GPU stops paying for the wider sampling footprint. Captured rather
 * than queried per texture, because the answer never changes.
 */
let MAX_ANISO = 4

function feltTexture(): THREE.CanvasTexture {
  return cachedTexture('felt', () => {
    // 512×512, one tile across the whole bed. The old 2048×1024 canvas cost VRAM and
    // per-frame texture bandwidth for detail the lens cannot hold at any playable
    // distance; mipmapping does the smoothing work, and the markings are baked into
    // this one texture rather than drawn as separate meshes.
    const size = 512
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    // Rich baize green, flat: depth comes from the lighting, not painted gradients
    // that pull apart from the shaded geometry at grazing angles. Bright, saturated
    // tournament green — the tone reads vivid under the warm lamp and tone mapping.
    ctx.fillStyle = '#1ea838'
    ctx.fillRect(0, 0, size, size)

    // Seamless baize: wrap-around noise, four offset copies, so a mip edge never
    // shows a seam line and tiling stays invisible.
    let seed = 20260930
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    ctx.fillStyle = 'rgba(255,255,255,0.035)'
    for (let i = 0; i < 900; i++) {
      const x = rand() * size
      const y = rand() * size
      for (const dx of [-size, 0, size]) {
        for (const dy of [-size, 0, size]) {
          ctx.fillRect(x + dx, y + dy, 1.4, 1.4)
        }
      }
    }
    ctx.fillStyle = 'rgba(0,0,0,0.05)'
    for (let i = 0; i < 700; i++) {
      const x = rand() * size
      const y = rand() * size
      for (const dx of [-size, 0, size]) {
        for (const dy of [-size, 0, size]) {
          ctx.fillRect(x + dx, y + dy, 1.4, 1.4)
        }
      }
    }

    // Baulk line, the D and the spot marks, baked into the cloth: no line meshes,
    // no extra draw calls, and the markings mip down with the baize instead of
    // crawling over it.
    const mark = (tableXmm: number, tableYmm: number): void => {
      const u = (tableXmm / TABLE_LENGTH) * size
      const v = (tableYmm / TABLE_WIDTH) * size
      ctx.fillStyle = '#e6d9ae'
      ctx.beginPath()
      ctx.arc(u, v, 3, 0, Math.PI * 2)
      ctx.fill()
    }

    const bx = (BAULK_LINE_X / TABLE_LENGTH) * size
    const mid = size / 2
    ctx.strokeStyle = '#d8b15c'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(bx, 0)
    ctx.lineTo(bx, size)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(bx, mid, (D_RADIUS / TABLE_WIDTH) * size, Math.PI * 0.5, Math.PI * 1.5)
    ctx.stroke()

    mark(BAULK_LINE_X, TABLE_WIDTH / 2 + D_RADIUS * 0.9)
    mark(BAULK_LINE_X, TABLE_WIDTH / 2 - D_RADIUS * 0.9)
    mark(BAULK_LINE_X, TABLE_WIDTH / 2)
    mark(TABLE_LENGTH / 2, TABLE_WIDTH / 2)
    mark(TABLE_LENGTH * 0.75, TABLE_WIDTH / 2)
    mark(TABLE_LENGTH - 324, TABLE_WIDTH / 2)

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    // Trilinear mipmapping with the anisotropy cap is what stops the flicker:
    // minified baize sampled without it shimmers at every grazing angle the cue
    // camera has, and the shimmer reads as texture crawling during transitions.
    texture.generateMipmaps = true
    texture.minFilter = THREE.LinearMipmapLinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.anisotropy = MAX_ANISO
    return texture
  })
}

function contactShadowTexture(): THREE.CanvasTexture {
  return cachedTexture('shadow', () => {
    const size = 128
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const grad = ctx.createRadialGradient(size / 2, size / 2, 4, size / 2, size / 2, size / 2)
    grad.addColorStop(0, 'rgba(0,0,0,0.55)')
    grad.addColorStop(0.6, 'rgba(0,0,0,0.18)')
    grad.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
    return new THREE.CanvasTexture(canvas)
  })
}

function glowTexture(): THREE.CanvasTexture {
  return cachedTexture('glow', () => {
    const size = 128
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const grad = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2)
    grad.addColorStop(0, 'rgba(255,220,140,0.9)')
    grad.addColorStop(0.35, 'rgba(255,200,110,0.35)')
    grad.addColorStop(1, 'rgba(255,200,110,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
    return new THREE.CanvasTexture(canvas)
  })
}

function woodTexture(): THREE.CanvasTexture {
  return cachedTexture('wood', () => {
    const size = 256
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    // Mahogany: deep red-brown figure, the tone the rails read as under lamp light.
    ctx.fillStyle = '#5c2d1e'
    ctx.fillRect(0, 0, size, size)
    for (let y = 0; y < size; y += 4) {
      const tone = 70 + Math.random() * 45
      ctx.fillStyle = `rgb(${Math.round(tone * 1.15)}, ${Math.round(tone * 0.5)}, ${Math.round(tone * 0.34)})`
      ctx.fillRect(0, y, size, 2)
    }
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    for (let i = 0; i < 26; i++) {
      const x = Math.random() * size
      const y = Math.random() * size
      ctx.fillRect(x, y, 60, 1)
    }
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return texture
  })
}

/**
 * A straight-grained cue timber: ash for the shaft, dark maple for the butt.
 *
 * Cue grain runs lengthwise along the taper, so the canvas is ruled with long
 * vertical figure lines and only slight tone drift between them — a cue's beauty
 * is in its even, narrow stripes rather than the wide irregular plank figure the
 * table wood uses.
 */
function cueWoodTexture(key: string, base: { r: number; g: number; b: number }, figure: number): THREE.CanvasTexture {
  return cachedTexture(key, () => {
    const size = 256
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = `rgb(${base.r}, ${base.g}, ${base.b})`
    ctx.fillRect(0, 0, size, size)
    for (let x = 0; x < size; x++) {
      const wobble = Math.sin(x * 0.35) * 6 + Math.sin(x * 0.11) * 10
      const tone = base.r + Math.sin(x * 0.8 + wobble) * figure
      ctx.fillStyle = `rgba(${Math.round(Math.max(0, tone))}, ${Math.round(base.g * (tone / base.r))}, ${Math.round(base.b * (tone / base.r))}, 0.5)`
      ctx.fillRect(x, 0, 1, size)
    }
    ctx.fillStyle = 'rgba(255,255,255,0.05)'
    for (let i = 0; i < 12; i++) {
      const y = Math.random() * size
      ctx.fillRect(0, y, size, 1)
    }
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return texture
  })
}

/**
 * The inner shading of a pocket: darkness at the bottom fading up the walls.
 *
 * Painted onto a cylinder lining the pocket's drop, it is what turns a hole into
 * a depth: a flat black disc reads as a decal, a shaded throat reads as somewhere
 * for the ball to go.
 */
function pocketDepthTexture(): THREE.CanvasTexture {
  return cachedTexture('pocket-depth', () => {
    const size = 128
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const grad = ctx.createRadialGradient(size / 2, size / 2, 4, size / 2, size / 2, size / 2)
    grad.addColorStop(0, 'rgba(0,0,0,1)')
    grad.addColorStop(0.55, 'rgba(0,0,0,0.85)')
    grad.addColorStop(1, 'rgba(30,18,10,0.25)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
    return new THREE.CanvasTexture(canvas)
  })
}

function envTexture(): THREE.CanvasTexture {
  return cachedTexture('env', () => {
    const w = 1024
    const h = 512
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    const grad = ctx.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, '#0d1117')
    grad.addColorStop(0.42, '#262c36')
    grad.addColorStop(0.5, '#b8a57f')
    grad.addColorStop(0.58, '#3f2f20')
    grad.addColorStop(1, '#15181d')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(255,244,214,0.85)'
    ctx.fillRect(w * 0.28, h * 0.36, w * 0.44, 6)
    ctx.fillRect(w * 0.3, h * 0.4, w * 0.4, 4)
    ctx.fillStyle = 'rgba(120,90,60,0.9)'
    ctx.fillRect(0, h * 0.6, w, 26)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.mapping = THREE.EquirectangularReflectionMapping
    return texture
  })
}

class BallRig {
  group = new THREE.Group()
  sphere: THREE.Mesh
  material: THREE.MeshStandardMaterial
  blob: THREE.Mesh
  target = new THREE.Vector3()
  firstSeen = true
  sinking = false
  sinkT = 0
  sinkStart = new THREE.Vector3()
  sinkTarget = new THREE.Vector3()
  rising = false
  riseT = 0
  riseFrom = new THREE.Vector3()

  constructor(radius: number, color: number, shadowTex: THREE.CanvasTexture) {
    // Phenolic resin look, without the clearcoat pass. A tight roughness with a
    // strong environment map gives the hard specular highlight the ball is known by;
    // MeshPhysicalMaterial's extra clearcoat layer cost a second shading pass per
    // ball for a sheen the env map already supplies. Emissive stays zero: it is only
    // ever set on highlight, and setting it costs nothing while unlit.
    this.material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.12,
      metalness: 0.0,
      emissive: 0x000000,
      envMapIntensity: 1.2
    })
    this.sphere = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 28), this.material)
    // Balls never cast into the scene's one static shadow map: a shadow baked at
    // frame one would sit forever where the ball first stood. Grounding is sold by
    // the soft contact blob under the ball instead, which moves with it and costs
    // no shadow renders.
    this.sphere.castShadow = false
    this.group.add(this.sphere)
    const blobMat = new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      depthWrite: false
    })
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(radius * 3.4, radius * 3.4), blobMat)
    this.blob.rotation.x = -Math.PI / 2
    this.blob.position.y = 0.6
    this.blob.renderOrder = 1
    this.group.add(this.blob)
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible
  }

  startSink(targetX: number, targetZ: number): void {
    this.sinking = true
    this.sinkT = 0
    this.sinkStart.copy(this.group.position)
    this.sinkTarget.set(targetX, this.group.position.y - 8, targetZ)
  }

  /**
   * Puts a ball back into play, the counterpart to the sink.
   *
   * A ball that comes back — the cue ball into hand after an in-off, a colour the rules
   * re-spot — used to be teleported onto its spot, which reads as a glitch rather than
   * as the table being re-racked. It comes up off the cloth instead, over the same
   * fraction of a second the sink takes going down, so the two ends of a ball's journey
   * off and back onto the table look like one motion.
   */
  startRise(targetX: number, targetZ: number): void {
    // A sink still in flight is abandoned rather than raced. The ball is back on the
    // table, so letting the drop finish would take it away again a moment later.
    this.sinking = false
    this.rising = true
    this.riseT = 0
    this.riseFrom.set(targetX, BALL_RADIUS - RISE_DEPTH, targetZ)
    this.group.position.copy(this.riseFrom)
    this.group.scale.set(RISE_START_SCALE, RISE_START_SCALE, RISE_START_SCALE)
  }

  aim(targetX: number, targetZ: number, highlight: boolean, reset: boolean): void {
    if (reset) {
      this.group.position.set(targetX, BALL_RADIUS, targetZ)
      this.firstSeen = false
    }
    this.target.set(targetX, BALL_RADIUS, targetZ)
    this.material.emissive.setHex(highlight ? 0x7a5c10 : 0x000000)
  }

  dispose(): void {
    this.sphere.geometry.dispose()
    this.material.dispose()
    ;(this.blob.material as THREE.MeshBasicMaterial).dispose()
    this.blob.geometry.dispose()
  }
}

export class Scene3D {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private balls = new Map<number, BallRig>()
  /**
   * Whether each ball was potted in the previous update, so a ball coming back onto the
   * table can be told from one that is merely being aimed at a new position. Kept here
   * rather than passed in because the renderer is the only thing that sees every frame.
   */
  private wasPotted = new Map<number, boolean>()
  private shadowTexCache: THREE.CanvasTexture | null = null
  private cvw: number
  private cvh: number
  private aimLine!: THREE.Line
  private aimDot!: THREE.Mesh
  private aimGlow!: THREE.Mesh
  private contactRing!: THREE.Mesh
  private contactDot!: THREE.Mesh
  private objectArrow!: THREE.LineSegments
  private cuePathLine!: THREE.Line
  private spinLine!: THREE.Line
  private stick!: THREE.Group
  private lastTime = 0
  private immediate = false
  /**
   * The camera's own memory: where it is, and the heading it has turned to so far.
   *
   * Held here rather than recomputed from the pose, because the heading is the one thing
   * with two ways round it: easing it from the pose would swing the table the long way
   * when the aim crosses 180 degrees.
   */
  private rig: CameraRigState
  /**
   * The one shadow-casting lamp, kept for `render()`: the shadow pass pins its
   * shadow camera's basis before the map is baked, so the bake cannot inherit a
   * view-dependent orientation from whichever camera happens to be drawing.
   */
  private lamp!: THREE.SpotLight
  /** Which view the player has asked for. The rig follows it unless a shot overrides it. */
  private cameraMode: 'AIM' | 'TOP_DOWN' = 'AIM'
  /** True while a shot is being watched, which is when the camera follows the balls. */
  private tracking = false
  /** The snapshot last handed to `update`, which is what the camera reads its cue ball from. */
  private lastSnapshot: FrameSnapshotData | null = null
  /**
   * The aim the player is setting right now. It turns the cue; it never turns the
   * camera, which is what the latch below is for.
   */
  private lastAimAngle = 0
  /**
   * Where the camera is pointed: the heading latched when the last shot was played,
   * plus the player's own look-around. Aiming does not touch it.
   */
  private latch: HeadingLatch = initialHeadingLatch()
  /** Ring + baulk line segment marking the D during break-off placement. Built once, shown on demand. */
  private dZoneRing!: THREE.Mesh
  /**
   * The felt's texture, kept for the artifact guards in `selfCheck`: the banding
   * regression this scene once had was a texture configured without mipmaps, and
   * a one-line check at build time is cheaper than ever rediscovering it by eye.
   */
  private feltTex: THREE.CanvasTexture | null = null
  /** Translucent disc shading the legal D area during break-off placement. */
  private dZoneFill!: THREE.Mesh
  /** Ghost cue ball the player moves while placing; hidden when not placing. */
  private ghostBall!: THREE.Mesh
  /** Current ghost position in table millimetres, so the follow easing has memory. */
  private ghostPos = new THREE.Vector2(BAULK_LINE_X, TABLE_WIDTH / 2)
  /** Whether the ghost is being shown at all this frame. */
  private placementActive = false

  static create(canvas: HTMLCanvasElement, width: number, height: number): Scene3D | null {
    try {
      return new Scene3D(canvas, width, height)
    } catch {
      return null
    }
  }

  private constructor(canvas: HTMLCanvasElement, width: number, height: number) {
    this.cvw = width
    this.cvh = height
    // The canvas backing store is already sized with the device pixel ratio by the
    // caller (capped at 1.5 in main.ts), so the renderer draws at one pixel per backing
    // pixel. AA is decided once from the device rather than asked for unconditionally:
    // MSAA costs fill rate on every pass, and a weak GPU with a small backing store
    // does better spending it on pixels than on edges.
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: (window.devicePixelRatio || 1) < 1.75,
      powerPreference: 'high-performance'
    })
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(width, height, false)
    // One query, one clamp, shared by every texture built after this line.
    MAX_ANISO = Math.min(this.renderer.capabilities.getMaxAnisotropy(), 4)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    // Everything this light can see is static, so the map is rendered exactly once —
    // the flag is raised after the scene is fully built and never touched again.
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.35
    // sRGB output, by its current name (outputEncoding was retired in r152).
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    this.scene.background = new THREE.Color('#161d27')

    // Near plane at 0.1: a camera pulled close to a cushion nose or over a pocket
    // jaw must never have the geometry it is looking at clipped by the near plane.
    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 20000)
    this.rig = initialRigState(width / height)
    this.camera.position.set(0, 1400, 1750)
    this.camera.lookAt(0, 0, 0)

    this.buildLighting()
    this.buildTable()
    this.buildAim()
    this.buildPlacement()

    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromEquirectangular(envTexture()).texture
    pmrem.dispose()

    // The one and only shadow bake, over the finished static set: cushions, pockets,
    // floor, lamp shade. Every later frame reuses this map at zero shadow cost.
    this.renderer.shadowMap.needsUpdate = true

    this.selfCheck()
  }

  /**
   * Build-time guards on the mechanisms behind cloth banding artifacts.
   *
   * The first guard is the one that actually killed the stripes: the bed never
   * samples the depth map, so no shadow-map artifact of any bias, frustum depth
   * or camera angle can land on it. The texture guards keep the felt's own
   * sampling calm (moire without mipmaps, shimmer without aniso). A violation
   * means somebody reintroduced a bug that took real diagnosis to find, so it is
   * announced rather than suffered silently.
   */
  private selfCheck(): void {
    const problems: string[] = []
    // The invariant that matters most is structural: find the cloth by its texture
    // and assert it never became a shadow receiver again.
    let clothReceives = false
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.isMesh && (mesh.material as THREE.MeshStandardMaterial)?.map === this.feltTex && mesh.receiveShadow) {
        clothReceives = true
      }
    })
    if (clothReceives) problems.push('cloth is receiving depth-map shadows (shadow acne will return)')
    const tex = this.feltTex
    if (tex) {
      if (!tex.generateMipmaps) problems.push('felt texture is missing mipmaps')
      if (tex.minFilter !== THREE.LinearMipmapLinearFilter) problems.push('felt texture is not trilinearly filtered')
      if (tex.anisotropy <= 0) problems.push('felt texture has no anisotropic filtering')
    }
    if (problems.length) {
      // Console, not a throw: a cosmetic guard must never take the table down.
      console.warn('[scene3d] rendering artifact guards failed:', problems.join('; '))
    }
  }

  private buildLighting(): void {
    // One lamp over the table, like a real snooker room: a warm cone strictly over the
    // bed, the only shadow caster in the scene. It used to be three shadow-casting
    // spotlights with 1024² maps — three shadow renders every frame for pools of light
    // that baked textures and contact blobs already supply — which is exactly the
    // overhead a low-end GPU does not have to spend.
    const lamp = (this.lamp = new THREE.SpotLight(0xffd9a0, 4600000, 0, Math.PI / 4.6, 0.6, 2))
    lamp.position.set(0, 1750, 0)
    lamp.target.position.set(0, 0, 0)
    lamp.castShadow = true
    // 2048² costs nothing per frame — the map is baked once over the static set —
    // and the finer texels are what let the acne fixes stay gentle.
    lamp.shadow.mapSize.set(2048, 2048)
    // The frustum is squeezed onto the table. Stripe artifacts on the baize are a
    // depth-precision problem: with near 400 and far 4000 the map spread 3600mm of
    // depth over 2048² texels and the cloth's minified sampling landed several
    // texels deep inside the cushions' shadows, drawing banded stripes across the
    // bed. Everything that casts or receives sits between ~1730mm (cushion tops)
    // and ~2600mm (the arena floor) below the lamp, so a tight band holds them all
    // and each texel now resolves a fraction of the depth it used to.
    lamp.shadow.camera.near = 1600
    lamp.shadow.camera.far = 2800
    lamp.shadow.camera.updateProjectionMatrix()
    // Stripe artifacts come from self-shadowing surfaces the depth map cannot
    // resolve: the bias pulls the sample back along the light ray, the normalBias
    // pushes the sampled surface out along its own normal. Together they clear the
    // banding without visibly detaching shadows from their casters.
    lamp.shadow.bias = -0.0001
    lamp.shadow.normalBias = 0.02
    lamp.shadow.radius = 3
    this.scene.add(lamp)
    this.scene.add(lamp.target)

    // The arena has to read as a lit venue, not a void: an ambient base over the
    // whole scene, the warm hemisphere for the room, and two balanced directionals
    // so walls, floor and hoardings all carry colour from more than one side.
    // Balanced for "evenly lit, no pitch-black corners, no blown-out patches":
    // the ambient lifts the shadows off pure black, the hemisphere keeps the room
    // warm from above and dark at the floor, and the two directionals put colour
    // on every wall from more than one side. Intensities sit well under the lamp's
    // contribution so the cloth keeps a soft gradient rather than a hot centre.
    const ambient = new THREE.AmbientLight(0xdfe8ff, 0.5)
    this.scene.add(ambient)

    const hemi = new THREE.HemisphereLight(0xffe2b8, 0x2e2419, 0.5)
    this.scene.add(hemi)

    const fill = new THREE.DirectionalLight(0x9fc0e8, 0.45)
    fill.position.set(2200, 1200, -1100)
    this.scene.add(fill)

    const warm = new THREE.DirectionalLight(0xffd9a8, 0.3)
    warm.position.set(-2200, 1400, 1600)
    this.scene.add(warm)
  }

  private buildTable(): void {
    const pad = 64
    const cloth = new THREE.Mesh(
      new THREE.PlaneGeometry(TABLE_LENGTH, TABLE_WIDTH),
      // High-grade matte baize: 0.88 roughness, a whisper of metalness. The texture
      // carries the colour (mapped white, so tinting stays in one place) and the
      // baked markings; mipmapping on that texture is what keeps this surface calm
      // from the low cue angle.
      new THREE.MeshStandardMaterial({
        map: (this.feltTex = feltTexture()),
        color: 0xffffff,
        roughness: 0.88,
        metalness: 0.02
      })
    )
    cloth.rotation.x = -Math.PI / 2
    // The bed never samples the depth map. A coplanar-ish plane lit from above is
    // the textbook generator of shadow acne: every texel of a 2048² map stretched
    // across the bed self-shadows in bands, and the artifacts move with the camera
    // angle. The lamp washes the cloth directly, the baked AO lives in the texture,
    // and grounding is sold by the ball contact blobs — no depth reception needed.
    cloth.receiveShadow = false
    this.scene.add(cloth)

    const apron = new THREE.Mesh(
      new THREE.BoxGeometry(TABLE_LENGTH + pad, 130, TABLE_WIDTH + pad),
      // Glossy polished mahogany: low roughness picks up the env map's lamp band as
      // a specular streak along the rail, which is the polished-wood read.
      new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.3, metalness: 0.05, envMapIntensity: 1.0 })
    )
    apron.position.y = -66
    apron.castShadow = true
    this.scene.add(apron)

    const legGeo = new THREE.BoxGeometry(90, 470, 90)
    const legMat = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.45, metalness: 0.05, envMapIntensity: 0.8 })
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(legGeo, legMat)
        leg.position.set(sx * (HALF_L + pad / 2 - 80), -308, sz * (HALF_W + pad / 2 - 80))
        this.scene.add(leg)
      }
    }

    const brassMat = new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.25, metalness: 0.85 })
    const halfInner = pad / 2 - 10
    const trimDepth = 12
    const trimSpecs: Array<[number, number, number, number, number]> = [
      [TABLE_LENGTH + pad - 14, 14, trimDepth, 0, -HALF_W - halfInner],
      [TABLE_LENGTH + pad - 14, 14, trimDepth, 0, HALF_W + halfInner],
      [trimDepth, 14, TABLE_WIDTH + pad - 14, -HALF_L - halfInner, 0],
      [trimDepth, 14, TABLE_WIDTH + pad - 14, HALF_L + halfInner, 0]
    ]
    const trimGeo = new THREE.BoxGeometry(1, 1, 1)
    for (const [tw, th, td, tx, tz] of trimSpecs) {
      const trim = new THREE.Mesh(trimGeo, brassMat)
      trim.scale.set(tw, th, td)
      trim.position.set(tx, 2.5, tz)
      this.scene.add(trim)
    }
    const cornerGeo = new THREE.CylinderGeometry(26, 26, 8, 24)
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const corner = new THREE.Mesh(cornerGeo, brassMat)
        corner.position.set(sx * (HALF_L + halfInner), 5, sz * (HALF_W + halfInner))
        this.scene.add(corner)
      }
    }

    // Cushions read as the same family of baize but a step darker and slightly
    // glossier than the bed: real cushion rubber is cloth-covered but catches the
    // light along its nose, and the tone step is what keeps the raised edge from
    // melting into the playing surface.
    const cushionMat = new THREE.MeshStandardMaterial({ color: 0x157a33, roughness: 0.52, side: THREE.DoubleSide })
    const noseMat = new THREE.MeshStandardMaterial({ color: 0x1d9e43, roughness: 0.45, side: THREE.DoubleSide })
    const gapHalf = POCKET_RADIUS_CORNER
    const midGapHalf = POCKET_RADIUS_MIDDLE
    const longSegments: Array<[number, number]> = [
      [-HALF_L + gapHalf, -midGapHalf],
      [midGapHalf, HALF_L - gapHalf]
    ]
    const addBox = (width: number, depth: number, x: number, z: number): void => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, CUSHION_H, depth), cushionMat)
      mesh.position.set(x, CUSHION_H / 2, z)
      mesh.castShadow = true
      mesh.receiveShadow = true
      this.scene.add(mesh)
    }
    const addNoseLong = (width: number, x: number, innerZ: number): void => {
      const nose = new THREE.Mesh(new THREE.BoxGeometry(width, CUSHION_H, 10), noseMat)
      nose.position.set(x, CUSHION_H / 2, innerZ + (innerZ < 0 ? 5 : -5))
      this.scene.add(nose)
    }
    const addNoseShort = (length: number, innerX: number): void => {
      const side = innerX < 0 ? 1 : -1
      const nose = new THREE.Mesh(new THREE.BoxGeometry(10, CUSHION_H, length), noseMat)
      nose.position.set(innerX + side * 5, CUSHION_H / 2, 0)
      this.scene.add(nose)
    }
    for (const [fromX, toX] of longSegments) {
      const midX = (fromX + toX) / 2
      const width = toX - fromX
      addBox(width, 44, midX, -HALF_W - 22)
      addNoseLong(width, midX, -HALF_W)
      addBox(width, 44, midX, HALF_W + 22)
      addNoseLong(width, midX, HALF_W)
    }
    const shortLen = TABLE_WIDTH - gapHalf * 2
    addBox(44, shortLen, -HALF_L - 22, 0)
    addNoseShort(shortLen, -HALF_L)
    addBox(44, shortLen, HALF_L + 22, 0)
    addNoseShort(shortLen, HALF_L)

    // Leather drop pockets: a shaded throat cylinder recessed below the bed, a
    // dark inner drop, and a leather-look rim ring. The depth texture on the
    // throat's inside face is what makes the hole read as a cavity rather than a
    // flat decal — darkness pooling at the bottom, leather tone up the walls.
    const throatMat = new THREE.MeshStandardMaterial({
      map: pocketDepthTexture(),
      color: 0x2a1a10,
      roughness: 0.9,
      metalness: 0,
      side: THREE.BackSide
    })
    const dropMat = new THREE.MeshBasicMaterial({ color: 0x000000 })
    const mouthShadowMat = new THREE.MeshBasicMaterial({
      map: contactShadowTexture(),
      transparent: true,
      depthWrite: false
    })
    const leatherMat = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.75, metalness: 0.05 })
    const brassLipMat = new THREE.MeshStandardMaterial({ color: 0xd8b15c, roughness: 0.3, metalness: 0.8 })
    const pocketGeo = new Map<
      number,
      { throat: THREE.BufferGeometry; drop: THREE.BufferGeometry; lip: THREE.BufferGeometry; shadow: THREE.BufferGeometry }
    >()
    const geoFor = (radius: number) => {
      const cached = pocketGeo.get(radius)
      if (cached) return cached
      const made = {
        throat: new THREE.CylinderGeometry(radius * 0.98, radius * 0.8, 90, 28, 1, true),
        drop: new THREE.CircleGeometry(radius * 0.8, 24),
        lip: new THREE.TorusGeometry(radius + 4, 4.5, 14, 36),
        shadow: new THREE.CircleGeometry(radius * 1.35, 28)
      }
      pocketGeo.set(radius, made)
      return made
    }
    for (const p of POCKETS) {
      const x = tableX(p.x)
      const z = tableZ(p.y)
      const geo = geoFor(p.radius)
      // Inner shadow ring on the bed around the mouth, softening the cloth edge.
      const shadow = new THREE.Mesh(geo.shadow, mouthShadowMat)
      shadow.rotation.x = -Math.PI / 2
      shadow.position.set(x, CUSHION_H + 1.1, z)
      shadow.renderOrder = 4
      this.scene.add(shadow)
      // The throat: open-ended cylinder seen from inside, recessed below the bed.
      const throat = new THREE.Mesh(geo.throat, throatMat)
      throat.position.set(x, CUSHION_H + 1.2 - 45, z)
      throat.renderOrder = 5
      this.scene.add(throat)
      // The bottom of the drop.
      const drop = new THREE.Mesh(geo.drop, dropMat)
      drop.rotation.x = -Math.PI / 2
      drop.position.set(x, CUSHION_H + 1.2 - 90, z)
      this.scene.add(drop)
      // Leather cushion rim, brass-lipped.
      const lip = new THREE.Mesh(geo.lip, leatherMat)
      lip.rotation.x = -Math.PI / 2
      lip.position.set(x, CUSHION_H + 2.4, z)
      this.scene.add(lip)
      const brass = new THREE.Mesh(geo.lip, brassLipMat)
      brass.rotation.x = -Math.PI / 2
      brass.scale.set(0.82, 0.82, 1.35)
      brass.position.set(x, CUSHION_H + 3.0, z)
      this.scene.add(brass)
    }

    // Burgundy arena carpet, bright enough to read as a lit floor rather than a void.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(16000, 9000),
      new THREE.MeshStandardMaterial({ color: 0x6b2731, roughness: 0.55, metalness: 0.0, envMapIntensity: 0.5 })
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -790
    floor.receiveShadow = true
    this.scene.add(floor)

    const backWall = new THREE.Mesh(
      new THREE.PlaneGeometry(14000, 7000),
      new THREE.MeshStandardMaterial({ color: 0x27344a, roughness: 0.9 })
    )
    backWall.position.set(0, 500, -4600)
    this.scene.add(backWall)

    // The fixture meshes stay in the scene graph but are not rendered: the shade
    // sits exactly on the line between the overhead camera and the table centre, so
    // in the top-down view it filled the frame with a brown cone. The light itself
    // lives in buildLighting and is untouched — only the geometry is hidden.
    const shade = new THREE.Mesh(
      new THREE.CylinderGeometry(80, 330, 260, 28),
      new THREE.MeshStandardMaterial({ color: 0x8a6a34, roughness: 0.35, metalness: 0.6 })
    )
    shade.position.set(0, 1900, 0)
    shade.visible = false
    this.scene.add(shade)
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(60, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff3cf })
    )
    bulb.position.set(0, 1790, 0)
    bulb.visible = false
    this.scene.add(bulb)

    // The whole set built above — cloth, cushions, pockets, floor, lamp shade — is
    // static. Freezing every matrix here means the one static shadow frame and every
    // later render skip their matrix recalculations, and the fixture part of the
    // shadow map is settled before the first frame is ever drawn.
    this.scene.traverse((obj) => {
      obj.matrixAutoUpdate = false
      obj.updateMatrix()
    })
  }

  private buildAim(): void {
    const lineMat = new THREE.LineDashedMaterial({
      color: 0xf5f0e0,
      dashSize: 26,
      gapSize: 20,
      transparent: true,
      opacity: 0.85
    })
    this.aimLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), lineMat)
    this.aimLine.visible = false
    this.aimLine.frustumCulled = false
    this.scene.add(this.aimLine)

    this.aimDot = new THREE.Mesh(
      new THREE.CircleGeometry(20, 24),
      new THREE.MeshBasicMaterial({ color: 0xffd76a, transparent: true, opacity: 0.9 })
    )
    this.aimDot.rotation.x = -Math.PI / 2
    this.aimDot.visible = false
    this.scene.add(this.aimDot)

    // Marks the exact spot the cue ball is lined up to touch on the target ball.
    this.contactRing = new THREE.Mesh(
      new THREE.RingGeometry(BALL_RADIUS * 0.72, BALL_RADIUS * 1.05, 32),
      new THREE.MeshBasicMaterial({ color: 0xffd76a, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    )
    this.contactRing.rotation.x = -Math.PI / 2
    this.contactRing.visible = false
    this.scene.add(this.contactRing)

    this.contactDot = new THREE.Mesh(
      new THREE.CircleGeometry(BALL_RADIUS * 0.3, 20),
      new THREE.MeshBasicMaterial({ color: 0xfff3d0, transparent: true, opacity: 0.95 })
    )
    this.contactDot.rotation.x = -Math.PI / 2
    this.contactDot.visible = false
    this.scene.add(this.contactDot)

    // The object-ball departure arrow: one shaft plus two barbs, drawn as three
    // separate segments so the whole arrowhead can be built from a single line.
    this.objectArrow = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(), new THREE.Vector3(),
        new THREE.Vector3(), new THREE.Vector3(),
        new THREE.Vector3(), new THREE.Vector3()
      ]),
      new THREE.LineBasicMaterial({ color: 0xffd76a, transparent: true, opacity: 0.95 })
    )
    this.objectArrow.visible = false
    this.objectArrow.frustumCulled = false
    this.objectArrow.renderOrder = 3
    this.scene.add(this.objectArrow)

    // The cue ball's own route after the contact, which turns at the cushions. Four
    // points cover a first contact plus two bounces, which is as far as the
    // prediction is carried; unused points are collapsed onto the last one.
    this.cuePathLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(), new THREE.Vector3(),
        new THREE.Vector3(), new THREE.Vector3()
      ]),
      new THREE.LineBasicMaterial({ color: 0x96cdff, transparent: true, opacity: 0.8 })
    )
    this.cuePathLine.visible = false
    this.cuePathLine.frustumCulled = false
    this.cuePathLine.renderOrder = 3
    this.scene.add(this.cuePathLine)

    this.aimGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(90, 90),
      new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
    )
    this.aimGlow.rotation.x = -Math.PI / 2
    this.aimGlow.visible = false
    this.aimGlow.renderOrder = 2
    this.scene.add(this.aimGlow)

    this.spinLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0xffb84a, transparent: true, opacity: 0.95 })
    )
    this.spinLine.visible = false
    this.spinLine.frustumCulled = false
    this.scene.add(this.spinLine)

    // A proper cue: ash shaft with lengthwise grain, maple butt section, a brass
    // ferrule and a chalked blue tip. Geometry shares the stick's own axis (+y is
    // toward the tip), so every part is positioned along it.
    this.stick = new THREE.Group()
    const shaftMat = new THREE.MeshStandardMaterial({
      map: cueWoodTexture('cue-ash', { r: 214, g: 178, b: 122 }, 26),
      roughness: 0.42,
      metalness: 0.0
    })
    const buttMat = new THREE.MeshStandardMaterial({
      map: cueWoodTexture('cue-maple', { r: 74, g: 44, b: 26 }, 16),
      roughness: 0.38,
      metalness: 0.0
    })
    const ferruleMat = new THREE.MeshStandardMaterial({ color: 0xd8b15c, roughness: 0.25, metalness: 0.9 })
    const chalkMat = new THREE.MeshStandardMaterial({ color: 0x3a6ea5, roughness: 0.95, metalness: 0.0 })
    // Shaft: taper from the 9mm tip end to the 12.5mm joint, 1200mm long.
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 12.5, 1200, 20), shaftMat)
    shaft.position.y = 0
    // Same rule as the balls: the stick moves, the shadow map does not.
    shaft.castShadow = false
    // Butt extension past the joint, 300mm, flaring slightly.
    const butt = new THREE.Mesh(new THREE.CylinderGeometry(12.5, 14, 300, 20), buttMat)
    butt.position.y = -750
    butt.castShadow = false
    // Brass ferrule at the tip end of the shaft.
    const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(5.4, 5.6, 30, 16), ferruleMat)
    ferrule.position.y = 612
    // Chalk-blue tip crowning the ferrule.
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.4, 14, 16), chalkMat)
    tip.position.y = 634
    // A thin decorative ring where the two timbers meet.
    const joint = new THREE.Mesh(new THREE.CylinderGeometry(12.7, 12.7, 10, 20), ferruleMat)
    joint.position.y = -598
    this.stick.add(shaft, butt, ferrule, tip, joint)
    this.stick.visible = false
    this.scene.add(this.stick)
  }

  /**
   * The placement overlay: a D indicator for break-off and a ghost cue ball for
   * every in-hand. Built once like the rest of the scene; the meshes only cost
   * anything while they are visible, which is only while a placement is live.
   */
  private buildPlacement(): void {
    // The legal D area, shaded. Flat-lit and transparent so it reads as an overlay,
    // not as a patch of different cloth; depthWrite off so it never fights the bed.
    this.dZoneFill = new THREE.Mesh(
      new THREE.CircleGeometry(D_RADIUS, 48, Math.PI * 0.5, Math.PI),
      new THREE.MeshBasicMaterial({
        color: 0x9fe8b0,
        transparent: true,
        opacity: 0.14,
        depthWrite: false
      })
    )
    this.dZoneFill.rotation.x = -Math.PI / 2
    this.dZoneFill.position.set(tableX(BAULK_LINE_X), 0.8, tableZ(TABLE_WIDTH / 2))
    this.dZoneFill.renderOrder = 6
    this.dZoneFill.visible = false
    this.scene.add(this.dZoneFill)

    // The D's own edge: the half-circle arc plus the baulk-line chord, one ring
    // segment. LineDashed would fight the bed's markings; a thin tube reads at
    // every angle without aliasing.
    this.dZoneRing = new THREE.Mesh(
      new THREE.TorusGeometry(D_RADIUS, 3.5, 8, 64, Math.PI),
      new THREE.MeshBasicMaterial({ color: 0xd9f5df, transparent: true, opacity: 0.8, depthWrite: false })
    )
    this.dZoneRing.rotation.x = -Math.PI / 2
    this.dZoneRing.rotation.z = 0
    // Torus arc runs 0..π counterclockwise from +x; rotated flat, that spans the
    // half-circle on the baulk side once centred on the D's middle point.
    this.dZoneRing.position.set(tableX(BAULK_LINE_X), 1.2, tableZ(TABLE_WIDTH / 2))
    this.dZoneRing.renderOrder = 7
    this.dZoneRing.visible = false
    this.scene.add(this.dZoneRing)

    // The ghost cue ball: same size as the real one, half transparent, sitting at
    // cloth height. It is the thing the player is actually pointing at.
    this.ghostBall = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_RADIUS, 32, 20),
      new THREE.MeshStandardMaterial({
        color: 0xf4f9ff,
        roughness: 0.35,
        metalness: 0,
        transparent: true,
        opacity: 0.55,
        depthWrite: false
      })
    )
    this.ghostBall.visible = false
    this.scene.add(this.ghostBall)
  }

  /**
   * Shows or hides ball-in-hand placement overlays.
   *
   * `inD` is the snapshot's `cueInHandInD`: true only at break-off, where the D
   * indicator is shown. A mid-frame in-hand shows no D — the whole table is legal
   * and a stale D highlight would claim otherwise.
   */
  setPlacementMode(active: boolean, inD: boolean): void {
    this.placementActive = active
    this.dZoneRing.visible = active && inD
    this.dZoneFill.visible = active && inD
    this.ghostBall.visible = active
    if (!active) return
    // Park the ghost on the D centre (break-off) or the table centre (mid-frame)
    // so it is somewhere sensible the first frame before the pointer moves it.
    const start = inD ? { x: BAULK_LINE_X, y: TABLE_WIDTH / 2 } : { x: TABLE_LENGTH / 2, y: TABLE_WIDTH / 2 }
    this.ghostPos.set(start.x, start.y)
    this.ghostBall.position.set(tableX(start.x), BALL_RADIUS, tableZ(start.y))
  }

  /**
   * Moves the ghost to the table point the pointer is over and tints it by legality.
   *
   * The validity test mirrors the server's own rules, but is only a preview: the
   * server still rejects an illegal placement authoritatively. Red ghost means the
   * spot will not be accepted, with the reason readable from `status`.
   */
  updatePlacementGhost(
    target: { x: number; y: number } | null,
    inD: boolean,
    balls: Array<{ id: number; x: number; y: number; potted: boolean }>
  ): { ok: boolean; reason: string | null } {
    if (!this.placementActive || !target) {
      this.ghostBall.visible = false
      return { ok: false, reason: null }
    }
    this.ghostBall.visible = true
    this.ghostPos.set(target.x, target.y)
    this.ghostBall.position.set(tableX(target.x), BALL_RADIUS, tableZ(target.y))
    const status = placementStatus(target, inD, balls)
    const mat = this.ghostBall.material as THREE.MeshStandardMaterial
    mat.color.setHex(status.ok ? 0xf4f9ff : 0xff6b6b)
    return status
  }

  /** Hides the ghost for the frame where the pointer is off the cloth. */
  hidePlacementGhost(): void {
    this.ghostBall.visible = false
  }

  update(snapshot: FrameSnapshotData | null, options: RenderOptions = {}): void {
    this.immediate = options.immediate === true
    // Kept for the camera, which moves on its own clock in `render` rather than in here:
    // the balls it follows and the heading it turns to are both read from here.
    this.lastSnapshot = snapshot
    if (options.aim) {
      this.lastAimAngle = options.aim.angle
      // The aim is free to swing all it likes while the player hovers; the latch only
      // takes a new heading when a shot is actually played, so between shots the
      // camera stands exactly where it was.
      this.latch = stepHeadingLatch(this.latch, this.lastAimAngle, this.tracking)
    }
    if (!snapshot) {
      for (const rig of this.balls.values()) rig.setVisible(false)
      this.hideAim()
      return
    }

    if (!this.shadowTexCache) this.shadowTexCache = contactShadowTexture()
    const highlightId = this.resolveHighlight(snapshot)
    const seen = new Set<number>()
    for (const ball of snapshot.balls) {
      seen.add(ball.id)
      let rig = this.balls.get(ball.id)
      if (!rig) {
        rig = new BallRig(BALL_RADIUS, ballColor(ball.id), contactShadowTexture())
        this.balls.set(ball.id, rig)
        this.scene.add(rig.group)
      }
      rig.setVisible(!ball.potted || rig.sinking)
      if (!ball.potted) {
        const x = tableX(ball.x)
        const z = tableZ(ball.y)
        const moved = Math.hypot(rig.group.position.x - x, rig.group.position.z - z)
        rig.aim(x, z, ball.id === highlightId, rig.firstSeen || moved > 500)
        // A ball that was potted and is now on the table has been re-racked rather than
        // moved, so it rises onto its spot instead of being snapped there. The cue ball
        // into hand after an in-off is the case this exists for; a colour the rules
        // re-spot comes back the same way.
        if (this.wasPotted.get(ball.id) === true) rig.startRise(x, z)
      } else if (rig.group.visible && !rig.sinking) {
        const px = tableX(ball.x)
        const pz = tableZ(ball.y)
        let best = Infinity
        let targetX = px
        let targetZ = pz
        for (const p of POCKETS) {
          const dx = tableX(p.x) - px
          const dz = tableZ(p.y) - pz
          const d2 = dx * dx + dz * dz
          if (d2 < best) {
            best = d2
            targetX = tableX(p.x)
            targetZ = tableZ(p.y)
          }
        }
        rig.startSink(targetX, targetZ)
      } else {
        rig.firstSeen = true
      }
      // Remembered after the ball has been placed, so the next update can tell a
      // re-rack (potted, then not) apart from a ball that has only ever been on the
      // table, which must not rise.
      this.wasPotted.set(ball.id, ball.potted)
    }
    for (const [id, rig] of this.balls) {
      if (!seen.has(id)) rig.setVisible(false)
    }

    const cueBall = snapshot.balls.find((b) => b.id === 0 && !b.potted)
    const myTurn = options.youSeat !== undefined && snapshot.turnIndex === options.youSeat
    // The cue stick and the aim guide are only drawn on a settled table during the
    // player's own visit. Without the canAim test they would be re-anchored to a
    // cue ball that is still travelling, which dragged the stick diagonally across
    // the cloth behind a shot the player had already played.
    if (cueBall && options.aim && myTurn && options.canAim !== false) {
      this.showAim(cueBall, options.aim, snapshot.balls)
    } else {
      this.hideAim()
    }
  }

  private resolveHighlight(snapshot: FrameSnapshotData): number | null {
    if (snapshot.ballOn === 'RED') return null
    const match = /colour:(\d+)/.exec(snapshot.ballOn)
    return match ? Number(match[1]) : null
  }

  private showAim(cueBall: { x: number; y: number }, aim: AimState, balls: AimGuideBall[]): void {
    const cx = tableX(cueBall.x)
    const cz = tableZ(cueBall.y)
    const dir = { x: Math.cos(aim.angle), z: Math.sin(aim.angle) }

    // The guide runs out to the exact point the cue ball would touch a ball; on
    // an open table it falls back to a power-scaled stub so the line still reads.
    const guide = computeAimGuide({ ...cueBall, id: 0 }, aim.angle, balls)
    const length = guide ? Math.hypot(guide.contact.x - cueBall.x, guide.contact.y - cueBall.y) : 160 + aim.power * 340
    const aimAtBall = guide !== null
    // The line is drawn to the contact point, so its tip and the contact marker
    // are the same spot rather than a ball's width apart.
    const lineAngle = guide ? Math.atan2(guide.contact.y - cueBall.y, guide.contact.x - cueBall.x) : aim.angle
    const ex = cx + Math.cos(lineAngle) * length
    const ez = cz + Math.sin(lineAngle) * length

    this.setLine(this.aimLine, cx, 1.6, cz, ex, 1.6, ez)
    this.aimLine.computeLineDistances()
    const lineMat = this.aimLine.material as THREE.LineDashedMaterial
    lineMat.opacity = 0.4 + aim.power * 0.5

    this.aimDot.position.set(ex, 2.4, ez)
    this.aimDot.visible = !aimAtBall
    this.aimGlow.position.set(ex, 2.2, ez)
    this.aimGlow.visible = !aimAtBall
    const glowScale = 0.7 + aim.power * 1.1
    this.aimGlow.scale.set(glowScale, glowScale, 1)

    if (guide) {
      this.showContactMarker(guide)
    } else {
      // Nothing in the way, so no contact dot, no ring and no departure arrow.
      // Every one has to be cleared: a stale arrow left on the cloth would claim
      // a ball was going to be struck when nothing is there.
      this.contactRing.visible = false
      this.contactDot.visible = false
      this.objectArrow.visible = false
      this.cuePathLine.visible = false
    }

    const spinX = aim.spinX ?? 0
    const spinY = aim.spinY ?? 0
    if (Math.hypot(spinX, spinY) > 0.01) {
      const px = -Math.sin(aim.angle)
      const py = Math.cos(aim.angle)
      const off = spinX * 40 + spinY * 16
      this.setLine(this.spinLine, ex, 2.4, ez, ex + px * off, 2.4, ez + py * off)
    } else {
      this.spinLine.visible = false
    }

    // The tip sits `tipGap` behind the ball's centre, and the stick extends a
    // further STICK_TIP_Y forward of its own origin, so the origin goes back by
    // the sum of the two.
    const tipGap = BALL_RADIUS + STICK_REST_GAP + aim.power * STICK_POWER_DRAW
    const backOff = tipGap + STICK_TIP_Y
    this.stick.visible = true
    this.stick.position.set(cx - dir.x * backOff, 21, cz - dir.z * backOff)
    const up = new THREE.Vector3(0, 1, 0)
    const target = new THREE.Vector3(dir.x, 0, dir.z).normalize()
    this.stick.quaternion.setFromUnitVectors(up, target)
  }

  /**
   * Rings the target ball, drops a bright dot on the exact point the cue ball is
   * lined up to touch, and draws the object-ball departure arrow: the line of
   * centres continued out of the contact point, arrowhead on the end.
   */
  private showContactMarker(guide: AimGuide): void {
    // The contact point is on the target's surface, so the target's centre is one
    // radius further along the line of centres. The ring goes round that ball.
    const targetX = guide.contact.x + guide.lineOfCentres.x * BALL_RADIUS
    const targetY = guide.contact.y + guide.lineOfCentres.y * BALL_RADIUS
    this.contactRing.position.set(tableX(targetX), 1.2, tableZ(targetY))
    this.contactRing.visible = true

    this.contactDot.position.set(tableX(guide.contact.x), 1.4, tableZ(guide.contact.y))
    this.contactDot.visible = true

    // Shaft and the two barbs, laid out flat on the cloth just above it.
    const arrow = objectDirection(guide)
    const y = 1.5
    const attr = this.objectArrow.geometry.getAttribute('position') as THREE.BufferAttribute
    attr.setXYZ(0, tableX(arrow.from.x), y, tableZ(arrow.from.y))
    attr.setXYZ(1, tableX(arrow.to.x), y, tableZ(arrow.to.y))
    attr.setXYZ(2, tableX(arrow.to.x), y, tableZ(arrow.to.y))
    attr.setXYZ(3, tableX(arrow.barbs[0].x), y, tableZ(arrow.barbs[0].y))
    attr.setXYZ(4, tableX(arrow.to.x), y, tableZ(arrow.to.y))
    attr.setXYZ(5, tableX(arrow.barbs[1].x), y, tableZ(arrow.barbs[1].y))
    attr.needsUpdate = true
    this.objectArrow.geometry.computeBoundingSphere()
    this.objectArrow.visible = true

    this.showCuePath(guide)
  }

  /**
   * Lays the predicted cue-ball route onto the cloth, turning where it meets a
   * cushion. Kept off the object-ball arrow deliberately: the two are different
   * facts about different balls, and a player judging a safety needs to see them
   * separately.
   */
  private showCuePath(guide: AimGuide): void {
    if (guide.cuePath.length === 0) {
      // A full ball leaves the cue ball with nothing to show.
      this.cuePathLine.visible = false
      return
    }

    const attr = this.cuePathLine.geometry.getAttribute('position') as THREE.BufferAttribute
    const y = 1.4
    // One start point plus one per segment. A shorter path collapses its unused
    // points onto the last real one, so no stray vertex trails off the cloth.
    let previous = guide.cuePath[0]!.from
    attr.setXYZ(0, tableX(previous.x), y, tableZ(previous.y))
    for (let i = 0; i < 3; i++) {
      const segment = guide.cuePath[i]
      previous = segment ? segment.to : previous
      attr.setXYZ(i + 1, tableX(previous.x), y, tableZ(previous.y))
    }
    attr.needsUpdate = true
    this.cuePathLine.geometry.computeBoundingSphere()
    this.cuePathLine.visible = true
  }

  private setLine(line: THREE.Line, ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    const attr = line.geometry.getAttribute('position') as THREE.BufferAttribute
    attr.setXYZ(0, ax, ay, az)
    attr.setXYZ(1, bx, by, bz)
    attr.needsUpdate = true
    line.geometry.computeBoundingSphere()
    line.visible = true
  }

  private hideAim(): void {
    this.aimLine.visible = false
    this.aimDot.visible = false
    this.aimGlow.visible = false
    this.spinLine.visible = false
    this.contactRing.visible = false
    this.contactDot.visible = false
    this.objectArrow.visible = false
    this.cuePathLine.visible = false
    if (this.stick) this.stick.visible = false
  }

  /**
   * Asks for one of the two views the player controls: the camera behind the cue ball, or
   * the overhead one. Nothing is cut — the rig eases between them — so this can be called
   * as often as the button is pressed.
   */
  setCameraMode(mode: 'AIM' | 'TOP_DOWN'): void {
    this.cameraMode = mode
  }

  /**
   * Tells the camera whether a shot is on screen.
   *
   * While one is, the camera stops being a view the player chose and becomes a view of the
   * balls: it follows where they are going. When it ends, the rig eases back to whichever
   * view the player had asked for, which is why this is a flag rather than a mode — the
   * choice underneath is remembered across every shot.
   */
  setTracking(tracking: boolean): void {
    this.tracking = tracking
  }

  /**
   * Adds one drag step to the player's look-around, in radians.
   *
   * This is the only way the aim-mode camera turns between shots: a deliberate
   * right- or middle-button drag, never a hovering pointer.
   */
  orbitBy(delta: number): void {
    this.latch = addOrbit(this.latch, delta)
  }

  /** The view the camera is being asked for, for the toggle to reflect. */
  currentCameraMode(): 'AIM' | 'TOP_DOWN' {
    return this.cameraMode
  }

  /**
   * Where the camera is looking at the moment, in the form the picking maths needs.
   *
   * Read off the live camera rather than worked out again from the pose, so the two can
   * never disagree: whatever the lens is actually pointing at is what a pointer is cast
   * through. The renderer's world axes are turned into table millimetres on the way out,
   * which is the one conversion the pure module knows nothing about.
   */
  private pickCamera(): PickCamera {
    return pickCameraFromWorldMatrix(
      this.camera.position,
      this.camera.matrixWorld.elements,
      this.camera.fov,
      this.camera.aspect
    )
  }

  /**
   * The point on the cloth under a canvas pixel, cast through the live camera.
   *
   * This is what makes the pointer mean the same thing from behind the cue ball and from
   * overhead: the ray starts at the lens, goes through the pixel, and meets the cloth where
   * the table is. Null when the pixel is above the horizon, so a caller can leave the aim
   * alone rather than guessing.
   */
  screenToTable(px: number, py: number): { x: number; y: number } | null {
    if (this.cvw <= 0 || this.cvh <= 0) return null
    const ndc = pixelToNdc(px, py, this.cvw, this.cvh)
    return screenToTable(ndc.x, ndc.y, this.pickCamera())
  }

  /**
   * Where a point on the cloth is drawn, in canvas pixels.
   *
   * The other half of the same question, and what the press-and-release test uses to ask
   * "was that on the cue ball". Null when the point is behind the lens.
   */
  tableToScreen(x: number, y: number): { x: number; y: number } | null {
    if (this.cvw <= 0 || this.cvh <= 0) return null
    const ndc = projectToNdc({ x, y }, 0, this.pickCamera())
    if (!ndc) return null
    return ndcToPixel(ndc.x, ndc.y, this.cvw, this.cvh)
  }

  /** How wide a ball is drawn at a point on the cloth, in canvas pixels. */
  ballRadiusPx(x: number, y: number, radiusMm: number): number {
    if (this.cvw <= 0 || this.cvh <= 0) return 0
    return ballRadiusPx({ x, y }, radiusMm, this.cvw, this.cvh, this.pickCamera())
  }

  /** The heading the camera is easing towards, which is the last aim it was given. */
  cameraYaw(): number {
    return this.rig.yaw
  }

  resize(width: number, height: number): void {
    this.cvw = width
    this.cvh = height
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  /**
   * Moves the camera one frame towards whatever it has been asked to be doing.
   *
   * Called before the scene is drawn and after the balls have been moved, so the frame that
   * gets drawn is the one the rig has just eased to. Everything it needs is already here:
   * the cue ball and the balls worth following come out of the snapshot it is drawing, and
   * the heading is the last aim the player gave, which during a shot is the line the shot
   * was played along.
   */
  private stepCamera(dt: number): void {
    let cue: { x: number; y: number } | null = null
    let sumX = 0
    let sumY = 0
    let count = 0
    // Runs before the table has ever been drawn as well as after, so the empty case wants a
    // real empty array rather than a fresh one every frame.
    const balls = this.lastSnapshot?.balls ?? NO_BALLS
    for (const ball of balls) {
      if (ball.potted) continue
      sumX += ball.x
      sumY += ball.y
      count++
      if (ball.id === BALL_IDS.CUE) cue = { x: ball.x, y: ball.y }
    }
    // The spread is the radius of the smallest circle round the centre that holds them all,
    // which is what tells the tracking camera how far back it has to stand.
    let spread = 0
    if (count > 0) {
      const midX = sumX / count
      const midY = sumY / count
      for (const ball of balls) {
        if (ball.potted) continue
        spread = Math.max(spread, Math.hypot(ball.x - midX, ball.y - midY))
      }
    }
    this.rig = stepCameraRig(
      this.rig,
      {
        mode: this.tracking ? 'TRACK' : this.cameraMode,
        aspect: this.cvw / Math.max(1, this.cvh),
        cue,
        aimAngle: this.lastAimAngle,
        latch: this.latch,
        focus: count > 0 ? { x: sumX / count, y: sumY / count, spread } : null
      },
      dt
    )
    const pose = this.rig.pose
    this.camera.position.set(tableX(pose.x), pose.height, tableZ(pose.y))
    this.camera.lookAt(tableX(pose.lookX), pose.lookHeight, tableZ(pose.lookY))
    if (this.camera.fov !== pose.fov) {
      this.camera.fov = pose.fov
      this.camera.updateProjectionMatrix()
    }
  }

  render(): void {
    const now = performance.now()
    const dt = Math.min(0.05, (now - this.lastTime) / 1000)
    this.lastTime = now
    if (dt > 0) {
      // A streamed shot hands over positions that are already sampled from the
      // simulation, so they are applied as-is instead of being smoothed again.
      const k = this.immediate ? 1 : 1 - Math.exp(-dt * 14)
      for (const rig of this.balls.values()) {
        if (rig.group.visible && !rig.sinking && !rig.rising) rig.group.position.lerp(rig.target, k)
      }
      for (const rig of this.balls.values()) {
        if (rig.rising) {
          // Eased out, so the ball leaves the cloth briskly and settles onto it, which is
          // the reverse of the sink's ease-in.
          rig.riseT += dt * 3.4
          const t = Math.min(1, rig.riseT)
          const eased = 1 - (1 - t) * (1 - t)
          rig.group.position.set(
            rig.riseFrom.x,
            rig.riseFrom.y + (BALL_RADIUS - rig.riseFrom.y) * eased,
            rig.riseFrom.z
          )
          const s = RISE_START_SCALE + (1 - RISE_START_SCALE) * eased
          rig.group.scale.set(s, s, s)
          if (t >= 1) {
            rig.rising = false
            rig.group.scale.set(1, 1, 1)
            // Handed back to the ordinary target, so the ball keeps tracking a spot that
            // moves for any reason other than the re-rack itself.
            rig.group.position.set(rig.target.x, BALL_RADIUS, rig.target.z)
          }
        }
      }
      for (const rig of this.balls.values()) {
        if (!rig.sinking) continue
        rig.sinkT += dt * 3.4
        const t = Math.min(1, rig.sinkT)
        const eased = t * t
        rig.group.position.set(
          rig.sinkStart.x + (rig.sinkTarget.x - rig.sinkStart.x) * eased,
          rig.sinkStart.y - eased * 34,
          rig.sinkStart.z + (rig.sinkTarget.z - rig.sinkStart.z) * eased
        )
        const s = 1 - eased * 0.55
        rig.group.scale.set(s, s, s)
        if (t >= 1) {
          rig.sinking = false
          rig.setVisible(false)
          rig.group.scale.set(1, 1, 1)
          rig.firstSeen = true
        }
      }
    }
    // The camera eases after the balls have been moved, so the frame that goes to the
    // screen is the one the rig has just settled towards rather than the one before.
    this.stepCamera(dt)
    this.camera.updateMatrixWorld(true)
    const center = new THREE.Vector3(0, 0, 0).project(this.camera)
    const ax = new THREE.Vector3(600, 0, 0).project(this.camera)
    const az = new THREE.Vector3(0, 0, 600).project(this.camera)
    const toScreen = (v: THREE.Vector3): { x: number; y: number } => ({
      x: (v.x * 0.5 + 0.5) * this.cvw,
      y: (1 - (v.y * 0.5 + 0.5)) * this.cvh
    })
    const sc = toScreen(center)
    const sx = (toScreen(ax).x - sc.x) / 600
    const sz = (toScreen(az).y - sc.y) / 600
    const scale = (sx + sz) / 2
    // Handed back every frame: the 2D HUD's power rail picks table points, and the
    // cue controller's fallback projection reads the same transform. Cutting this
    // from the render pass desynced those from the live camera.
    setTableTransform({
      offsetX: sc.x - scale * (TABLE_LENGTH / 2),
      offsetY: sc.y - scale * (TABLE_WIDTH / 2),
      scale
    })
    // No per-frame shadow work happens here: the map was baked once, and moving balls
    // are shaded by the lamp itself, so they read as lit rather than floating — their
    // contact with the cloth is sold by the textured blobs under them, which move
    // with the balls and cost no shadow renders.
    //
    // Before any render that might be the one shadow pass, the shadow camera's basis
    // is pinned: three.js derives that basis from the render camera's orientation at
    // the moment it renders the shadow map, and the bake frame would otherwise be
    // whichever view happened to be on screen first. A map baked under one view and
    // sampled under the other is the mechanism behind the diagonal stripe artifacts
    // that appeared when toggling between the two views — the depth matrix disagreed
    // with itself by a rotation. Pinning it to the world axes makes the map, and every
    // sample of it, view-independent by construction.
    if (this.renderer.shadowMap.needsUpdate) {
      const shadowCam = this.lamp.shadow.camera
      shadowCam.position.set(0, 1750, 0)
      shadowCam.up.set(0, 0, -1)
      shadowCam.lookAt(0, 0, 0)
      shadowCam.updateMatrixWorld(true)
    }
    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.renderer.dispose()
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) for (const m of mat) m.dispose()
      else mat?.dispose()
    })
    for (const rig of this.balls.values()) rig.dispose()
    this.balls.clear()
    this.wasPotted.clear()
  }
}
