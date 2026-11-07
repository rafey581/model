import * as THREE from 'three'
import { cameraAt, progressForViewport, type SceneMark } from './camera-path'
import { cappedDevicePixelRatio } from './motion'

const TABLE_L = 3.569
const TABLE_W = 1.778
const BALL_R = 0.02625
const HALF_L = TABLE_L / 2
const HALF_W = TABLE_W / 2
const BAULK_Z = -HALF_L + 0.737

export interface StageController {
  setReducedMotion(reduced: boolean): void
  destroy(): void
}

interface MountOptions {
  reducedMotion: boolean
}

/**
 * A real-time snooker table drawn with three.js.
 * The canvas is pointer-events: none, so it never captures scroll or taps.
 * The loop pauses when the tab is hidden or no scene window is on screen.
 */
export async function mountStage(options: MountOptions): Promise<StageController | null> {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'default',
    failIfMajorPerformanceCaveat: false
  })
  const gl = renderer.getContext()
  if (!gl) {
    renderer.dispose()
    return null
  }

  const canvas = renderer.domElement
  canvas.id = 'stage'
  canvas.setAttribute('aria-hidden', 'true')
  document.body.prepend(canvas)

  const shadows = window.innerWidth >= 900
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.08
  renderer.setClearColor(0x090b09, 1)
  renderer.shadowMap.enabled = shadows
  renderer.shadowMap.type = THREE.PCFShadowMap

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(36, 1, 0.05, 40)
  resize()
  const hemi = new THREE.HemisphereLight(0xe7eef2, 0x0c2a1c, 1.15)
  scene.add(hemi)
  const spot = new THREE.SpotLight(0xf4e6c8, 36, 9, Math.PI / 5.2, 0.65, 1)
  spot.position.set(0.05, 2.35, -0.05)
  spot.target.position.set(0, 0, 0.05)
  spot.castShadow = shadows
  spot.shadow.mapSize.set(1024, 1024)
  spot.shadow.bias = -0.00035
  spot.shadow.camera.near = 0.4
  spot.shadow.camera.far = 6
  scene.add(spot, spot.target)
  const rim = new THREE.DirectionalLight(0xd5e4ee, 1.85)
  rim.position.set(-2.4, 1.7, -1.4)
  scene.add(rim)
  const fill = new THREE.DirectionalLight(0xc9d5c8, 0.35)
  fill.position.set(1.6, 0.8, 1.8)
  scene.add(fill)

  const textures = await loadTextures()
  const table = buildTable(textures, shadows)
  scene.add(table)
  const cue = buildCue()
  scene.add(cue)
  scene.add(buildGround())

  let reduced = options.reducedMotion
  let visible = true
  let running = false
  let raf = 0
  let pointerX = 0
  let pointerY = 0
  const finePointer = window.matchMedia('(pointer: fine)').matches
  const cueBase = cue.position.clone()

  function resize(): void {
    const width = window.innerWidth
    const height = Math.max(1, window.innerHeight)
    renderer.setPixelRatio(cappedDevicePixelRatio(window.devicePixelRatio || 1, width))
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }

  function sceneMarks(): SceneMark[] {
    const marks: SceneMark[] = []
    document.querySelectorAll<HTMLElement>('[data-scene]').forEach((el) => {
      const at = Number(el.dataset.scene)
      if (!Number.isFinite(at)) return
      const rect = el.getBoundingClientRect()
      marks.push({ center: rect.top + window.scrollY + rect.height / 2, at })
    })
    return marks
  }

  function renderFrame(now: number): void {
    const progress = reduced ? 0 : progressForViewport(sceneMarks(), window.scrollY + window.innerHeight / 2)
    const shot = cameraAt(progress)
    const px = reduced || !finePointer ? 0 : pointerX
    const py = reduced || !finePointer ? 0 : pointerY
    camera.position.set(shot.position.x + px, shot.position.y + py, shot.position.z)
    camera.lookAt(shot.lookAt.x, shot.lookAt.y, shot.lookAt.z)
    if (!reduced) {
      const sway = Math.sin(now * 0.00055) * 0.018
      cue.position.set(cueBase.x, cueBase.y, cueBase.z + sway)
    }
    renderer.render(scene, camera)
  }

  function loop(now: number): void {
    if (!running) return
    renderFrame(now)
    raf = window.requestAnimationFrame(loop)
  }

  function start(): void {
    if (document.hidden || !visible) return
    if (reduced) {
      renderFrame(performance.now())
      return
    }
    if (running) return
    running = true
    raf = window.requestAnimationFrame(loop)
  }

  function stop(): void {
    running = false
    if (raf) window.cancelAnimationFrame(raf)
    raf = 0
  }

  const onScroll = (): void => {
    if (reduced) return
    if (!running) start()
  }
  const onResize = (): void => {
    resize()
    renderer.shadowMap.enabled = window.innerWidth >= 900
    renderFrame(performance.now())
  }
  const onVisibility = (): void => {
    if (document.hidden) stop()
    else start()
  }
  const onPointer = (event: PointerEvent): void => {
    if (!finePointer || reduced) return
    pointerX = (event.clientX / window.innerWidth - 0.5) * 0.05
    pointerY = (event.clientY / window.innerHeight - 0.5) * -0.03
  }
  const onContextLost = (event: Event): void => {
    event.preventDefault()
    stop()
    document.documentElement.classList.remove('has-webgl')
  }

  const observer = new IntersectionObserver(
    (entries) => {
      visible = entries.some((entry) => entry.isIntersecting)
      if (visible) start()
      else stop()
    },
    { threshold: 0.05 }
  )
  document.querySelectorAll('[data-scene]').forEach((el) => observer.observe(el))

  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onResize)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pointermove', onPointer, { passive: true })
  canvas.addEventListener('webglcontextlost', onContextLost)

  renderFrame(performance.now())
  document.documentElement.classList.add('has-webgl')
  start()

  return {
    setReducedMotion(next: boolean): void {
      reduced = next
      if (reduced) {
        stop()
        cue.position.copy(cueBase)
        renderFrame(performance.now())
      } else {
        start()
      }
    },
    destroy(): void {
      stop()
      observer.disconnect()
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pointermove', onPointer)
      canvas.removeEventListener('webglcontextlost', onContextLost)
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
        const material = mesh.material
        if (Array.isArray(material)) material.forEach((item) => item.dispose())
        else if (material) material.dispose()
      })
      renderer.dispose()
      canvas.remove()
      document.documentElement.classList.remove('has-webgl')
    }
  }
}

interface Textures {
  wood: THREE.Texture | null
  rough: THREE.Texture | null
  leather: THREE.Texture | null
}

function loadTexture(url: string, color: boolean): Promise<THREE.Texture | null> {
  return new Promise((resolve) => {
    const loader = new THREE.TextureLoader()
    loader.load(
      url,
      (texture) => {
        texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace
        texture.wrapS = THREE.RepeatWrapping
        texture.wrapT = THREE.RepeatWrapping
        texture.anisotropy = 4
        resolve(texture)
      },
      undefined,
      () => resolve(null)
    )
  })
}

async function loadTextures(): Promise<Textures> {
  const [wood, rough, leather] = await Promise.all([
    loadTexture('/textures/wood_birch_color.jpg', true),
    loadTexture('/textures/wood_birch_glossy_rough.jpg', false),
    loadTexture('/textures/leath03b.jpg', true)
  ])
  if (wood) wood.repeat.set(2.2, 1)
  if (rough) rough.repeat.set(2.2, 1)
  if (leather) leather.repeat.set(1.5, 1)
  return { wood, rough, leather }
}

function feltTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 512
  const context = canvas.getContext('2d')
  if (!context) throw new Error('felt texture failed')
  context.fillStyle = '#0e6b45'
  context.fillRect(0, 0, 512, 512)
  const image = context.getImageData(0, 0, 512, 512)
  for (let i = 0; i < image.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 16
    image.data[i] = clampByte((image.data[i] ?? 0) + n * 0.4)
    image.data[i + 1] = clampByte((image.data[i + 1] ?? 0) + n)
    image.data[i + 2] = clampByte((image.data[i + 2] ?? 0) + n * 0.45)
  }
  context.putImageData(image, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(3, 1.6)
  texture.anisotropy = 4
  return texture
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function buildTable(textures: Textures, shadows: boolean): THREE.Group {
  const group = new THREE.Group()
  const felt = new THREE.Mesh(
    new THREE.BoxGeometry(TABLE_L, 0.02, TABLE_W),
    new THREE.MeshStandardMaterial({ map: feltTexture(), roughness: 0.92, metalness: 0 })
  )
  felt.position.y = -0.01
  felt.receiveShadow = shadows
  group.add(felt)

  const railMat = new THREE.MeshStandardMaterial({
    map: textures.wood,
    roughnessMap: textures.rough,
    color: textures.wood ? '#ffffff' : '#6a4a30',
    roughness: 0.62,
    metalness: 0.08
  })
  const railH = 0.09
  const railT = 0.11
  const railY = railH / 2 - 0.01
  const rails: Array<[number, number, number, number, number]> = [
    [TABLE_L + railT * 2, railH, railT, 0, HALF_W + railT / 2],
    [TABLE_L + railT * 2, railH, railT, 0, -(HALF_W + railT / 2)],
    [railT, railH, TABLE_W, HALF_L + railT / 2, 0],
    [railT, railH, TABLE_W, -(HALF_L + railT / 2), 0]
  ]
  for (const [w, h, d, x, z] of rails) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(w ?? 1, h ?? 1, d ?? 1), railMat)
    rail.position.set(x ?? 0, railY, z ?? 0)
    rail.castShadow = shadows
    rail.receiveShadow = shadows
    group.add(rail)
  }

  const cushionMat = new THREE.MeshStandardMaterial({ color: '#0b5a38', roughness: 0.78, metalness: 0 })
  const cushionT = 0.045
  const cushionH = 0.035
  const cushions: Array<[number, number, number, number]> = [
    [TABLE_L - 0.16, cushionT, 0, HALF_W - cushionT / 2],
    [TABLE_L - 0.16, cushionT, 0, -(HALF_W - cushionT / 2)],
    [cushionT, TABLE_W - 0.16, HALF_L - cushionT / 2, 0],
    [cushionT, TABLE_W - 0.16, -(HALF_L - cushionT / 2), 0]
  ]
  for (const [w, d, x, z] of cushions) {
    const cushion = new THREE.Mesh(new THREE.BoxGeometry(w ?? 1, cushionH, d ?? 1), cushionMat)
    cushion.position.set(x ?? 0, cushionH / 2, z ?? 0)
    cushion.castShadow = shadows
    group.add(cushion)
  }

  const pocket = new THREE.MeshBasicMaterial({ color: '#070605' })
  const pocketGeo = new THREE.CircleGeometry(0.046, 20)
  const pockets: Array<[number, number]> = [
    [-HALF_L + 0.02, -HALF_W + 0.02],
    [-HALF_L + 0.02, HALF_W - 0.02],
    [HALF_L - 0.02, -HALF_W + 0.02],
    [HALF_L - 0.02, HALF_W - 0.02],
    [0, -HALF_W + 0.01],
    [0, HALF_W - 0.01]
  ]
  for (const [x, z] of pockets) {
    const mesh = new THREE.Mesh(pocketGeo, pocket)
    mesh.rotation.x = -Math.PI / 2
    mesh.position.set(x ?? 0, 0.003, z ?? 0)
    group.add(mesh)
    if (textures.leather) {
      const jaw = new THREE.Mesh(
        new THREE.TorusGeometry(0.05, 0.007, 8, 18),
        new THREE.MeshStandardMaterial({ map: textures.leather, color: '#5a3b2a', roughness: 0.62 })
      )
      jaw.rotation.x = Math.PI / 2
      jaw.position.set(x ?? 0, 0.008, z ?? 0)
      group.add(jaw)
    }
  }

  const lineMat = new THREE.MeshBasicMaterial({ color: '#f3efe4', transparent: true, opacity: 0.72 })
  const baulk = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.001, TABLE_W - 0.12), lineMat)
  baulk.position.set(BAULK_Z, 0.001, 0)
  group.add(baulk)
  const arc = new THREE.Mesh(new THREE.RingGeometry(0.286, 0.292, 48, 1, Math.PI / 2, Math.PI), lineMat)
  arc.rotation.x = -Math.PI / 2
  arc.position.set(BAULK_Z, 0.0015, 0)
  group.add(arc)

  const ballGeo = new THREE.SphereGeometry(BALL_R, 48, 32)
  const colours: Array<[number, string, number, number]> = [
    [0xf4f1e6, 'cue', 0, BAULK_Z - 0.16],
    [0xf0c93a, 'yellow', -0.292, BAULK_Z],
    [0x7a3e12, 'brown', 0, BAULK_Z],
    [0x1f8a43, 'green', 0.292, BAULK_Z],
    [0x2450b0, 'blue', 0, 0],
    [0xe7a0b4, 'pink', 0, 0.89],
    [0x141416, 'black', 0, HALF_L - 0.32]
  ]
  for (const [color, , x, z] of colours) {
    group.add(ball(ballGeo, color ?? 0xffffff, x ?? 0, z ?? 0, shadows))
  }
  const spacing = BALL_R * 2 + 0.0015
  const rows = [1, 2, 3]
  let z = 0.89 + spacing
  for (const count of rows) {
    const width = (count - 1) * spacing
    for (let i = 0; i < count; i += 1) {
      group.add(ball(ballGeo, 0xc4202a, -width / 2 + i * spacing, z, shadows))
    }
    z += spacing * 0.866
  }

  const legGeo = new THREE.CylinderGeometry(0.035, 0.048, 0.7, 12)
  const legMat = new THREE.MeshStandardMaterial({ color: '#1c1e1c', metalness: 0.82, roughness: 0.32 })
  const footGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.02, 12)
  const footMat = new THREE.MeshStandardMaterial({ color: '#d5dbe0', metalness: 1, roughness: 0.22 })
  for (const [x, z] of [
    [-HALF_L + 0.18, -HALF_W + 0.16],
    [-HALF_L + 0.18, HALF_W - 0.16],
    [HALF_L - 0.18, -HALF_W + 0.16],
    [HALF_L - 0.18, HALF_W - 0.16]
  ] as const) {
    const leg = new THREE.Mesh(legGeo, legMat)
    leg.position.set(x, -0.36, z)
    leg.castShadow = shadows
    group.add(leg)
    const foot = new THREE.Mesh(footGeo, footMat)
    foot.position.set(x, -0.7, z)
    group.add(foot)
  }

  return group
}

function ball(geo: THREE.SphereGeometry, color: number, x: number, z: number, shadows: boolean): THREE.Mesh {
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.16,
      metalness: 0.04,
      clearcoat: 1,
      clearcoatRoughness: 0.12
    })
  )
  mesh.position.set(x, BALL_R, z)
  mesh.castShadow = shadows
  mesh.receiveShadow = shadows
  return mesh
}

function buildCue(): THREE.Group {
  const group = new THREE.Group()
  const wood = new THREE.MeshStandardMaterial({ color: '#c79a62', roughness: 0.42, metalness: 0.04 })
  const chrome = new THREE.MeshStandardMaterial({ color: '#e8eef2', metalness: 1, roughness: 0.18 })
  const tip = new THREE.MeshStandardMaterial({ color: '#2c6ea5', roughness: 0.45 })
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.009, 1.28, 16), wood)
  shaft.rotation.x = Math.PI / 2
  shaft.castShadow = true
  const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(0.0052, 0.0052, 0.045, 16), chrome)
  ferrule.rotation.x = Math.PI / 2
  ferrule.position.z = 0.64
  const cueTip = new THREE.Mesh(new THREE.CylinderGeometry(0.0046, 0.005, 0.012, 12), tip)
  cueTip.rotation.x = Math.PI / 2
  cueTip.position.z = 0.668
  group.add(shaft, ferrule, cueTip)
  group.position.set(0.28, 0.028, -0.15)
  group.rotation.y = 0.55
  group.rotation.z = -0.04
  group.rotation.x = 0.04
  return group
}

function buildGround(): THREE.Mesh {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const context = canvas.getContext('2d')
  if (!context) throw new Error('ground shadow failed')
  const gradient = context.createRadialGradient(128, 128, 24, 128, 128, 122)
  gradient.addColorStop(0, 'rgba(0,0,0,0.55)')
  gradient.addColorStop(1, 'rgba(0,0,0,0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, 256, 256)
  const texture = new THREE.CanvasTexture(canvas)
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(5.2, 3.4),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false })
  )
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = -0.72
  return mesh
}
