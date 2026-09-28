import * as THREE from 'three'
import { TABLE_LENGTH, TABLE_WIDTH, BALL_RADIUS, BAULK_LINE_X, D_RADIUS, POCKET_RADIUS_CORNER, POCKET_RADIUS_MIDDLE, pocketPositions } from '@snooker/shared'
import type { FrameSnapshotData, AimState, RenderOptions } from './renderer.js'
import { computeAimGuide, objectDirection, type AimGuide, type AimGuideBall } from './aim.js'
import { setTableTransform } from './renderer.js'

const HALF_L = TABLE_LENGTH / 2
const HALF_W = TABLE_WIDTH / 2
const CUSHION_H = 12
/**
 * The cue tip's position in the stick's own space. The stick's origin sits at the
 * centre of the shaft, so the tip is well short of half the length: the tip ferrule
 * ends at 626mm forward, not at 750mm. Backing the stick off by half the length
 * instead of by this number left the tip floating a ball's width or more away from
 * the ball it was addressing.
 */
const STICK_TIP_Y = 626
/** How far the tip pulls back from the ball at rest, before any power draw-back. */
const STICK_REST_GAP = 8
/** How far the tip draws back at full power, as the player loads the shot. */
const STICK_POWER_DRAW = 190
const tableX = (x: number): number => x - HALF_L
const tableZ = (y: number): number => y - HALF_W

const BALL_COLORS: Record<number, number> = {
  0: 0xf5f3e4,
  16: 0xf4c430,
  17: 0x1b7f46,
  18: 0x8a4b23,
  19: 0x1e6fd9,
  20: 0xf0709c,
  21: 0x1a1a1e
}

const RED = 0xd62828
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

function feltTexture(): THREE.CanvasTexture {
  return cachedTexture('felt', () => {
    const w = 2048
    const h = 1024
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#0f8650'
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'
    ctx.lineWidth = 1
    for (let i = 0; i < w; i += 20) {
      ctx.beginPath()
      ctx.moveTo(i, 0)
      ctx.lineTo(i, h)
      ctx.stroke()
    }
    const shade = ctx.createRadialGradient(w * 0.5, h * 0.42, w * 0.08, w * 0.5, h * 0.5, w * 0.7)
    shade.addColorStop(0, 'rgba(40,160,95,0.28)')
    shade.addColorStop(1, 'rgba(0,0,0,0.30)')
    ctx.fillStyle = shade
    ctx.fillRect(0, 0, w, h)

    const vignette = ctx.createRadialGradient(w / 2, h / 2, w * 0.62, w / 2, h / 2, w * 0.82)
    vignette.addColorStop(0, 'rgba(0,0,0,0)')
    vignette.addColorStop(1, 'rgba(0,0,0,0.26)')
    ctx.fillStyle = vignette
    ctx.fillRect(0, 0, w, h)

    const mark = (tableXmm: number, tableYmm: number): void => {
      const u = (tableXmm / TABLE_LENGTH) * w
      const v = (tableYmm / TABLE_WIDTH) * h
      ctx.fillStyle = '#e6d9ae'
      ctx.beginPath()
      ctx.arc(u, v, 4, 0, Math.PI * 2)
      ctx.fill()
    }

    const bx = (BAULK_LINE_X / TABLE_LENGTH) * w
    const mid = h / 2
    ctx.strokeStyle = '#d8b15c'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(bx, 0)
    ctx.lineTo(bx, h)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(bx, mid, (D_RADIUS / TABLE_WIDTH) * h, Math.PI * 0.5, Math.PI * 1.5)
    ctx.stroke()

    mark(BAULK_LINE_X, TABLE_WIDTH / 2 + D_RADIUS * 0.9)
    mark(BAULK_LINE_X, TABLE_WIDTH / 2 - D_RADIUS * 0.9)
    mark(BAULK_LINE_X, TABLE_WIDTH / 2)
    mark(TABLE_LENGTH / 2, TABLE_WIDTH / 2)
    mark(TABLE_LENGTH * 0.75, TABLE_WIDTH / 2)
    mark(TABLE_LENGTH - 324, TABLE_WIDTH / 2)

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 4
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
    ctx.fillStyle = '#6b4526'
    ctx.fillRect(0, 0, size, size)
    for (let y = 0; y < size; y += 4) {
      const tone = 60 + Math.random() * 40
      ctx.fillStyle = `rgb(${Math.round(tone)}, ${Math.round(tone * 0.66)}, ${Math.round(tone * 0.4)})`
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
  material: THREE.MeshPhysicalMaterial
  blob: THREE.Mesh
  target = new THREE.Vector3()
  firstSeen = true
  sinking = false
  sinkT = 0
  sinkStart = new THREE.Vector3()
  sinkTarget = new THREE.Vector3()

  constructor(radius: number, color: number, shadowTex: THREE.CanvasTexture) {
    this.material = new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.14,
      metalness: 0.06,
      clearcoat: 0.7,
      clearcoatRoughness: 0.2,
      emissive: 0x000000
    })
    this.sphere = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 28), this.material)
    this.sphere.castShadow = true
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
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(width, height, false)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.35

    this.scene.background = new THREE.Color('#0f1317')

    this.camera = new THREE.PerspectiveCamera(50, width / height, 1, 20000)
    this.camera.position.set(0, 1400, 1750)
    this.camera.lookAt(0, 0, 0)

    this.buildLighting()
    this.buildTable()
    this.buildAim()

    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromEquirectangular(envTexture()).texture
    pmrem.dispose()
  }

  private buildLighting(): void {
    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x3a2f24, 1.15)
    this.scene.add(hemi)

    const key = new THREE.DirectionalLight(0xfff2df, 2.4)
    key.position.set(-1400, 2800, 2100)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.left = -2200
    key.shadow.camera.right = 2200
    key.shadow.camera.top = 1500
    key.shadow.camera.bottom = -1500
    key.shadow.camera.near = 200
    key.shadow.camera.far = 6500
    key.shadow.bias = -0.002
    this.scene.add(key)

    const fill = new THREE.DirectionalLight(0x9fc0e8, 0.45)
    fill.position.set(2200, 1200, -1100)
    this.scene.add(fill)
  }

  private buildTable(): void {
    const pad = 64
    const cloth = new THREE.Mesh(
      new THREE.PlaneGeometry(TABLE_LENGTH, TABLE_WIDTH),
      new THREE.MeshStandardMaterial({ map: feltTexture(), roughness: 0.92, metalness: 0 })
    )
    cloth.rotation.x = -Math.PI / 2
    cloth.receiveShadow = true
    this.scene.add(cloth)

    const apron = new THREE.Mesh(
      new THREE.BoxGeometry(TABLE_LENGTH + pad, 130, TABLE_WIDTH + pad),
      new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.55 })
    )
    apron.position.y = -66
    apron.castShadow = true
    this.scene.add(apron)

    const legGeo = new THREE.BoxGeometry(90, 470, 90)
    const legMat = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.7 })
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

    const cushionMat = new THREE.MeshStandardMaterial({ color: 0x0a5a33, roughness: 0.55, side: THREE.DoubleSide })
    const noseMat = new THREE.MeshStandardMaterial({ color: 0x1b8a55, roughness: 0.5, side: THREE.DoubleSide })
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

    const pocketMat = new THREE.MeshStandardMaterial({ color: 0x04060a, roughness: 0.4, side: THREE.DoubleSide })
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xd8b15c, roughness: 0.3, metalness: 0.8 })
    const pocketGeo = new Map<number, { disc: THREE.BufferGeometry; hole: THREE.BufferGeometry; rim: THREE.BufferGeometry }>()
    const geoFor = (radius: number) => {
      const cached = pocketGeo.get(radius)
      if (cached) return cached
      const made = {
        disc: new THREE.CircleGeometry(radius, 28),
        hole: new THREE.CylinderGeometry(radius * 0.7, radius * 0.92, 80, 24, 1, true),
        rim: new THREE.TorusGeometry(radius + 4, 3.2, 12, 32)
      }
      pocketGeo.set(radius, made)
      return made
    }
    for (const p of POCKETS) {
      const x = tableX(p.x)
      const z = tableZ(p.y)
      const geo = geoFor(p.radius)
      const disc = new THREE.Mesh(geo.disc, pocketMat)
      disc.rotation.x = -Math.PI / 2
      disc.position.set(x, CUSHION_H + 1.2, z)
      disc.renderOrder = 5
      this.scene.add(disc)
      const hole = new THREE.Mesh(geo.hole, pocketMat)
      hole.position.set(x, CUSHION_H + 1.2 - 40, z)
      hole.renderOrder = 5
      this.scene.add(hole)
      const rim = new THREE.Mesh(geo.rim, rimMat)
      rim.rotation.x = -Math.PI / 2
      rim.position.set(x, CUSHION_H + 2.2, z)
      this.scene.add(rim)
    }

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(16000, 9000),
      new THREE.MeshStandardMaterial({ color: 0x0c0e12, roughness: 1 })
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -790
    floor.receiveShadow = true
    this.scene.add(floor)

    const backWall = new THREE.Mesh(
      new THREE.PlaneGeometry(14000, 7000),
      new THREE.MeshStandardMaterial({ color: 0x11151c, roughness: 1 })
    )
    backWall.position.set(0, 500, -4600)
    this.scene.add(backWall)

    const shade = new THREE.Mesh(
      new THREE.CylinderGeometry(80, 330, 260, 28),
      new THREE.MeshStandardMaterial({ color: 0x8a6a34, roughness: 0.35, metalness: 0.6 })
    )
    shade.position.set(0, 1900, 0)
    this.scene.add(shade)
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(60, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff3cf })
    )
    bulb.position.set(0, 1790, 0)
    this.scene.add(bulb)
    const lamp = new THREE.SpotLight(0xffecc9, 4500000, 0, Math.PI / 5.5, 0.4, 2)
    lamp.position.set(0, 1800, 0)
    lamp.target.position.set(0, 0, 0)
    this.scene.add(lamp)
    this.scene.add(lamp.target)
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

    this.stick = new THREE.Group()
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(5.5, 9, 1200, 16),
      new THREE.MeshStandardMaterial({ color: 0xb07a3e, roughness: 0.5 })
    )
    const butt = new THREE.Mesh(
      new THREE.CylinderGeometry(9, 12.5, 300, 16),
      new THREE.MeshStandardMaterial({ color: 0x2a1a10, roughness: 0.35 })
    )
    butt.position.y = -750
    const tip = new THREE.Mesh(
      new THREE.CylinderGeometry(5.5, 6, 26, 12),
      new THREE.MeshStandardMaterial({ color: 0x9fd8f2, roughness: 1 })
    )
    tip.position.y = 613
    this.stick.add(shaft, butt, tip)
    this.stick.visible = false
    this.scene.add(this.stick)
  }

  update(snapshot: FrameSnapshotData | null, options: RenderOptions = {}): void {
    this.immediate = options.immediate === true
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
        rig = new BallRig(BALL_RADIUS, BALL_COLORS[ball.id] ?? RED, contactShadowTexture())
        this.balls.set(ball.id, rig)
        this.scene.add(rig.group)
      }
      rig.setVisible(!ball.potted || rig.sinking)
      if (!ball.potted) {
        const x = tableX(ball.x)
        const z = tableZ(ball.y)
        const moved = Math.hypot(rig.group.position.x - x, rig.group.position.z - z)
        rig.aim(x, z, ball.id === highlightId, rig.firstSeen || moved > 500)
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

  resize(width: number, height: number): void {
    this.cvw = width
    this.cvh = height
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
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
        if (rig.group.visible && !rig.sinking) rig.group.position.lerp(rig.target, k)
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
    setTableTransform({
      offsetX: sc.x - scale * (TABLE_LENGTH / 2),
      offsetY: sc.y - scale * (TABLE_WIDTH / 2),
      scale
    })
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
  }
}