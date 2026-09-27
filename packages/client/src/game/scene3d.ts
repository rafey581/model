import * as THREE from 'three'
import { TABLE_LENGTH, TABLE_WIDTH, BALL_RADIUS, BAULK_LINE_X, D_RADIUS, BALL_DIAMETER } from '@snooker/shared'
import type { FrameSnapshotData, AimState, RenderOptions } from './renderer.js'
import { setTableTransform } from './renderer.js'

const HALF_L = TABLE_LENGTH / 2
const HALF_W = TABLE_WIDTH / 2
const POCKET_R = BALL_DIAMETER * 0.68
const CUSHION_H = 12
const STICK_LEN = 1500
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
const POCKETS = [
  { x: 0, y: 0 },
  { x: TABLE_LENGTH / 2, y: 0 },
  { x: TABLE_LENGTH, y: 0 },
  { x: 0, y: TABLE_WIDTH },
  { x: TABLE_LENGTH / 2, y: TABLE_WIDTH },
  { x: TABLE_LENGTH, y: TABLE_WIDTH }
]

function feltTexture(): THREE.CanvasTexture {
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
}

function contactShadowTexture(): THREE.CanvasTexture {
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
}

class BallRig {
  group = new THREE.Group()
  sphere: THREE.Mesh
  material: THREE.MeshStandardMaterial
  blob: THREE.Mesh
  target = new THREE.Vector3()
  firstSeen = true

  constructor(radius: number, color: number, shadowTex: THREE.CanvasTexture) {
    this.material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.16,
      metalness: 0.08,
      emissive: 0x000000
    })
    this.sphere = new THREE.Mesh(new THREE.SphereGeometry(radius, 40, 24), this.material)
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
  private shadowTex: THREE.CanvasTexture | null = null
  private cvw: number
  private cvh: number
  private aimLine!: THREE.Line
  private aimDot!: THREE.Mesh
  private spinLine!: THREE.Line
  private stick!: THREE.Group
  private lastTime = 0

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
      new THREE.MeshStandardMaterial({ color: 0x3c2415, roughness: 0.7 })
    )
    apron.position.y = -66
    apron.castShadow = true
    this.scene.add(apron)

    const legGeo = new THREE.BoxGeometry(90, 470, 90)
    const legMat = new THREE.MeshStandardMaterial({ color: 0x2a180c, roughness: 0.8 })
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(legGeo, legMat)
        leg.position.set(sx * (HALF_L + pad / 2 - 80), -308, sz * (HALF_W + pad / 2 - 80))
        this.scene.add(leg)
      }
    }

    const cushionMat = new THREE.MeshStandardMaterial({ color: 0x0a5a33, roughness: 0.55, side: THREE.DoubleSide })
    const noseMat = new THREE.MeshStandardMaterial({ color: 0x1b8a55, roughness: 0.5, side: THREE.DoubleSide })
    const gapHalf = POCKET_R
    const longSegments: Array<[number, number]> = [
      [-HALF_L + gapHalf, -gapHalf],
      [gapHalf, HALF_L - gapHalf]
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
    const discGeo = new THREE.CircleGeometry(POCKET_R, 28)
    const holeGeo = new THREE.CylinderGeometry(POCKET_R * 0.7, POCKET_R * 0.92, 80, 24, 1, true)
    for (const p of POCKETS) {
      const x = tableX(p.x)
      const z = tableZ(p.y)
      const disc = new THREE.Mesh(discGeo, pocketMat)
      disc.rotation.x = -Math.PI / 2
      disc.position.set(x, CUSHION_H + 1.2, z)
      disc.renderOrder = 5
      this.scene.add(disc)
      const hole = new THREE.Mesh(holeGeo, pocketMat)
      hole.position.set(x, CUSHION_H + 1.2 - 40, z)
      hole.renderOrder = 5
      this.scene.add(hole)
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
    if (!snapshot) {
      for (const rig of this.balls.values()) rig.setVisible(false)
      this.hideAim()
      return
    }

    if (!this.shadowTex) this.shadowTex = contactShadowTexture()
    const highlightId = this.resolveHighlight(snapshot)
    const seen = new Set<number>()
    for (const ball of snapshot.balls) {
      seen.add(ball.id)
      let rig = this.balls.get(ball.id)
      if (!rig) {
        rig = new BallRig(BALL_RADIUS, BALL_COLORS[ball.id] ?? RED, this.shadowTex)
        this.balls.set(ball.id, rig)
        this.scene.add(rig.group)
      }
      rig.setVisible(!ball.potted)
      if (!ball.potted) {
        const x = tableX(ball.x)
        const z = tableZ(ball.y)
        const moved = Math.hypot(rig.group.position.x - x, rig.group.position.z - z)
        rig.aim(x, z, ball.id === highlightId, rig.firstSeen || moved > 500)
      } else {
        rig.firstSeen = true
      }
    }
    for (const [id, rig] of this.balls) {
      if (!seen.has(id)) rig.setVisible(false)
    }

    const cueBall = snapshot.balls.find((b) => b.id === 0 && !b.potted)
    const myTurn = options.youSeat !== undefined && snapshot.turnIndex === options.youSeat
    if (cueBall && options.aim && myTurn) {
      this.showAim(cueBall, options.aim)
    } else {
      this.hideAim()
    }
  }

  private resolveHighlight(snapshot: FrameSnapshotData): number | null {
    if (snapshot.ballOn === 'RED') return null
    const match = /colour:(\d+)/.exec(snapshot.ballOn)
    return match ? Number(match[1]) : null
  }

  private showAim(cueBall: { x: number; y: number }, aim: AimState): void {
    const cx = tableX(cueBall.x)
    const cz = tableZ(cueBall.y)
    const dir = { x: Math.cos(aim.angle), z: Math.sin(aim.angle) }
    const length = 160 + aim.power * 340
    const ex = cx + dir.x * length
    const ez = cz + dir.z * length

    this.aimLine.geometry.dispose()
    this.aimLine.geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(cx, 1.6, cz),
      new THREE.Vector3(ex, 1.6, ez)
    ])
    this.aimLine.computeLineDistances()
    this.aimLine.visible = true

    this.aimDot.position.set(ex, 2.4, ez)
    this.aimDot.visible = true

    const spinX = aim.spinX ?? 0
    const spinY = aim.spinY ?? 0
    if (Math.hypot(spinX, spinY) > 0.01) {
      const px = -Math.sin(aim.angle)
      const py = Math.cos(aim.angle)
      const off = spinX * 40 + spinY * 16
      this.spinLine.geometry.dispose()
      this.spinLine.geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(ex, 2.4, ez),
        new THREE.Vector3(ex + px * off, 2.4, ez + py * off)
      ])
      this.spinLine.visible = true
    } else {
      this.spinLine.visible = false
    }

    const tipGap = BALL_RADIUS + 10 + aim.power * 240
    this.stick.visible = true
    this.stick.position.set(cx - dir.x * (tipGap + STICK_LEN / 2), 21, cz - dir.z * (tipGap + STICK_LEN / 2))
    const up = new THREE.Vector3(0, 1, 0)
    const target = new THREE.Vector3(dir.x, 0, dir.z).normalize()
    this.stick.quaternion.setFromUnitVectors(up, target)
  }

  private hideAim(): void {
    this.aimLine.visible = false
    this.aimDot.visible = false
    this.spinLine.visible = false
    if (this.stick) this.stick.visible = false
  }

  render(): void {
    const now = performance.now()
    const dt = Math.min(0.05, (now - this.lastTime) / 1000)
    this.lastTime = now
    if (dt > 0) {
      const k = 1 - Math.exp(-dt * 14)
      for (const rig of this.balls.values()) {
        if (rig.group.visible) rig.group.position.lerp(rig.target, k)
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
    if (this.shadowTex) this.shadowTex.dispose()
  }
}