import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {
  ARENA_CONFIG,
  resolveArenaBudget,
  type ArenaBudget,
  type ArenaConfig,
  type ArenaQuality,
  type ArenaSeatRow
} from './arenaConfig.js'

export { ARENA_CONFIG }
export type { ArenaBudget, ArenaConfig, ArenaQuality, ArenaSeatRow }

/**
 * The arena: a bowl of seating, a carpeted floor and a lighting rig built around the
 * table. Visual only — nothing in here is read by the simulation, and nothing in here
 * depends on the simulation.
 *
 * Everything is generated at build time, so the whole venue costs one function call and no
 * network. The static parts are merged into as few meshes as they can honestly be, the
 * seats are one InstancedMesh per deck, and nothing added here casts a shadow.
 */

const DEG = Math.PI / 180

function sin(deg: number): number {
  return Math.sin(deg * DEG)
}

function cos(deg: number): number {
  return Math.cos(deg * DEG)
}

function tan(deg: number): number {
  return Math.tan(deg * DEG)
}

/** A small deterministic generator, so a rebuilt arena looks identical to the last one. */
function rng(seed: number): () => number {
  let state = (seed >>> 0) || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

/**
 * Textures are built once and shared, the way the scene's own felt and wood maps are:
 * one carpet upload, not one per material that happens to want it.
 */
const arenaTextures = new Map<string, THREE.CanvasTexture>()

function cached(key: string, make: () => THREE.CanvasTexture): THREE.CanvasTexture {
  let tex = arenaTextures.get(key)
  if (!tex) {
    tex = make()
    arenaTextures.set(key, tex)
  }
  return tex
}

function canvas2d(width: number, height: number): CanvasRenderingContext2D {
  const el = document.createElement('canvas')
  el.width = width
  el.height = height
  return el.getContext('2d')!
}

function color(hex: string): THREE.Color {
  return new THREE.Color(hex)
}

/** The width of a texture's backing canvas, or 0 for anything that is not one. */
function sourceWidth(texture: THREE.Texture): number {
  const image = texture.image as { width?: unknown } | null
  return image && typeof image.width === 'number' && image.width > 1 ? image.width : 0
}

/**
 * Turns an in-plane coordinate into the seam three.js leaves in an open cylinder's UVs.
 *
 * A `CylinderGeometry` runs its seam down one meridian, where u wraps from 1 back to 0, so
 * a repeating texture samples one column of it twice and the join shows. Half a period is
 * an exact half turn, which lands the join on the seam rather than on a panel.
 */
function seamlessOffset(texture: THREE.Texture, baseRepeat: number): number {
  const period = sourceWidth(texture)
  return period > 0 ? 0.5 / (baseRepeat * period) : 0
}

/* ------------------------------------------------------------------ *
 * Procedural textures.
 * ------------------------------------------------------------------ */

/**
 * The carpet: a fine woven grain over a slow mottle, all of it a light grey.
 *
 * Kept near white on purpose. The map multiplies the carpet's own red, and a mid grey map
 * is a 0.2 multiplier in linear space, which would turn the floor black. This one sits at
 * 0.93 with the weave riding on top of it.
 */
function carpetWeaveTexture(size: number): THREE.CanvasTexture {
  const ctx = canvas2d(size, size)
  const rand = rng(0x5eed)
  const img = ctx.createImageData(size, size)
  const data = img.data
  for (let i = 0; i < size * size; i++) {
    const x = i % size
    const y = (i / size) | 0
    // Two interleaved weaves give a crosshatch, the sine pair a slow cloud over it, and the
    // random term stops the grid looking machine-made at close range. All four terms are
    // kept small on purpose: this is a floor that fills half the frame from the play pose,
    // and anything that reads as texture at 2000mm reads as crawling at 16000mm.
    const warp = ((x + y) & 7) === 0 ? 4 : 0
    const weft = ((x ^ y) & 3) === 0 ? 2 : 0
    const cloud = Math.sin((x / size) * Math.PI * 2) * Math.cos((y / size) * Math.PI * 3) * 2
    const v = 240 + warp + weft + cloud + (rand() - 0.5) * 5
    const c = v < 0 ? 0 : v > 255 ? 255 : v
    const o = i * 4
    data[o] = c
    data[o + 1] = c
    data[o + 2] = c
    data[o + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(ctx.canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.anisotropy = 8
  tex.name = 'arena-carpet-weave'
  return tex
}

/** The same grain as a height map: sampled raw, so greyscale and not colour-managed. */
function carpetBumpTexture(size: number): THREE.CanvasTexture {
  const ctx = canvas2d(size, size)
  const rand = rng(0x5eed)
  const img = ctx.createImageData(size, size)
  const data = img.data
  for (let i = 0; i < size * size; i++) {
    const x = i % size
    const y = (i / size) | 0
    const v = 128 + (((x + y) & 7) === 0 ? 26 : 0) + (((x ^ y) & 3) === 0 ? 14 : 0) + (rand() - 0.5) * 20
    const c = v < 0 ? 0 : v > 255 ? 255 : v
    const o = i * 4
    data[o] = c
    data[o + 1] = c
    data[o + 2] = c
    data[o + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(ctx.canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.anisotropy = 4
  tex.name = 'arena-carpet-bump'
  return tex
}

/**
 * The LED hoardings: a ring of lit panels carrying placeholder copy.
 *
 * The panel's aspect is derived from the ring's own geometry rather than guessed, so the
 * type stays square-on to the eye if the board height or the panel count is changed. No
 * real sponsor, venue or broadcast deal appears anywhere in it.
 */
function hoardingTexture(cfg: ArenaConfig, budget: ArenaBudget): THREE.CanvasTexture {
  const perTile = cfg.hoardings.panelsPerTile
  const tileW = budget.textureSize
  const panelW = tileW / perTile
  const panelWidthMm = (2 * Math.PI * cfg.bowl.innerRadius) / cfg.hoardings.panels
  const tileH = Math.max(48, Math.round(panelW * (cfg.bowl.boardHeight / panelWidthMm)))
  const ctx = canvas2d(tileW, tileH)

  const slogans = cfg.hoardings.slogans
  const gap = Math.max(1, Math.round(panelW * 0.012))
  for (let p = 0; p < perTile; p++) {
    const x0 = p * panelW
    const w = panelW - gap * 2
    ctx.fillStyle = p % 2 === 0 ? '#0e2f7d' : '#14213c'
    ctx.fillRect(x0 + gap, 0, w, tileH)

    // A bright accent bar down the leading edge and a rule along the foot: the two marks
    // that make a row of panels read as separate screens rather than one painted band.
    ctx.fillStyle = p % 2 === 0 ? '#f0c04a' : '#cf2432'
    ctx.fillRect(x0 + gap, tileH * 0.1, Math.max(2, w * 0.022), tileH * 0.8)
    ctx.fillStyle = 'rgba(255,255,255,0.3)'
    ctx.fillRect(x0 + gap, tileH * 0.9, w, Math.max(1, tileH * 0.012))

    const text = slogans[(p * 2 + 1) % slogans.length] ?? 'SNOOKERX'
    let fontPx = Math.round(tileH * 0.44)
    ctx.font = `700 ${fontPx}px system-ui, "Segoe UI", sans-serif`
    const widest = w * 0.8
    const measured = ctx.measureText(text).width
    if (measured > widest) {
      fontPx = Math.max(8, Math.floor((fontPx * widest) / measured))
      ctx.font = `700 ${fontPx}px system-ui, "Segoe UI", sans-serif`
    }
    ctx.fillStyle = '#f2f6ff'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, x0 + gap + w * 0.075, tileH * 0.47)
  }

  const tex = new THREE.CanvasTexture(ctx.canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.anisotropy = 8
  tex.name = 'arena-hoardings'
  return tex
}

/** The upper wall: vertical concrete ribs, with the shading the roof puts on them. */
function wallTexture(size: number): THREE.CanvasTexture {
  const h = size
  const ctx = canvas2d(size, h)
  const grad = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, '#1b2334')
  grad.addColorStop(0.45, '#2c3850')
  grad.addColorStop(1, '#3a4762')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, h)

  const ribs = 16
  for (let i = 0; i < ribs; i++) {
    const x = (i * size) / ribs
    const w = size / ribs
    ctx.fillStyle = 'rgba(255,255,255,0.055)'
    ctx.fillRect(x, 0, w * 0.42, h)
    ctx.fillStyle = 'rgba(0,0,0,0.16)'
    ctx.fillRect(x + w * 0.62, 0, w * 0.38, h)
  }
  // A balcony shadow a third of the way up, which is what stops a ten-metre wall reading
  // as a painted backdrop.
  ctx.fillStyle = 'rgba(0,0,0,0.22)'
  ctx.fillRect(0, h * 0.34, size, h * 0.03)

  const tex = new THREE.CanvasTexture(ctx.canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = 4
  tex.name = 'arena-wall'
  return tex
}

/** Catwalk grating: a dark grid with the walkway picked out, so the roof is not a void. */
function roofGratingTexture(size: number): THREE.CanvasTexture {
  const ctx = canvas2d(size, size)
  ctx.fillStyle = '#0b1120'
  ctx.fillRect(0, 0, size, size)
  ctx.fillStyle = '#20293c'
  for (let i = 0; i < 8; i++) {
    const t = (i * size) / 8
    ctx.fillRect(t, 0, size / 64, size)
    ctx.fillRect(0, t, size, size / 64)
  }
  ctx.fillStyle = '#46536e'
  ctx.fillRect(size * 0.44, 0, size * 0.05, size)
  ctx.fillRect(0, size * 0.44, size, size * 0.05)

  const tex = new THREE.CanvasTexture(ctx.canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = 4
  tex.name = 'arena-roof'
  return tex
}

/**
 * Vertical steel: dark at the top, catching more of the house light at the bottom.
 *
 * Every structural member in the arena shares this one map, so the truss, the camera
 * columns and the rig's droppers all read as the same painted steel.
 */
function steelTexture(size: number): THREE.CanvasTexture {
  const ctx = canvas2d(8, size)
  const grad = ctx.createLinearGradient(0, 0, 0, size)
  grad.addColorStop(0, '#3d4658')
  grad.addColorStop(0.6, '#232b3a')
  grad.addColorStop(1, '#4a5468')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 8, size)
  const tex = new THREE.CanvasTexture(ctx.canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = 1
  tex.name = 'arena-steel'
  return tex
}

/* ------------------------------------------------------------------ *
 * Shared materials.
 * ------------------------------------------------------------------ */

interface ArenaMaterials {
  carpet: THREE.MeshStandardMaterial
  concrete: THREE.MeshStandardMaterial
  wall: THREE.MeshStandardMaterial
  fascia: THREE.MeshStandardMaterial
  steel: THREE.MeshStandardMaterial
  darkSteel: THREE.MeshStandardMaterial
  cameraRig: THREE.MeshStandardMaterial
  hoardings: THREE.MeshStandardMaterial
  roof: THREE.MeshStandardMaterial
  roofVoid: THREE.MeshBasicMaterial
  fixtureFace: THREE.MeshStandardMaterial
  lensGlass: THREE.MeshStandardMaterial
  tally: THREE.MeshStandardMaterial
  seats: THREE.MeshStandardMaterial
}

/**
 * Every material in the venue, built once.
 *
 * Double-sided throughout, because the arena is a set of open cylinders and slabs seen
 * from the inside, and each one gets its own `side` when it is created if that ever needs
 * to change per part.
 */
function buildMaterials(cfg: ArenaConfig, budget: ArenaBudget, anisotropy: number): ArenaMaterials {
  const weave = cached('carpet', () => carpetWeaveTexture(budget.textureSize))
  weave.repeat.set(cfg.carpetTextureRepeat, cfg.carpetTextureRepeat)
  // Mipmaps are what stop the weave crawling as the camera swings between the overhead and
  // the play pose; anisotropy is what keeps it from turning to mush at the far side of the
  // hall. Both are set before the texture is ever uploaded, so neither needs a re-upload.
  weave.generateMipmaps = true
  weave.minFilter = THREE.LinearMipmapLinearFilter
  weave.anisotropy = anisotropy

  const carpet = new THREE.MeshStandardMaterial({
    color: color(cfg.carpetColor),
    map: weave,
    roughness: cfg.carpetRoughness,
    metalness: cfg.carpetMetalness,
    envMapIntensity: 0.06,
    // Front side only: this plane is never seen from below, and a floor that renders its
    // back faces has two chances per pixel to win a depth test it should always win the
    // same way. Single-sided, a floor is just a floor.
    side: THREE.FrontSide
  })
  if (budget.carpetBump) {
    const bump = cached('carpet-bump', () => carpetBumpTexture(budget.textureSize))
    bump.repeat.set(cfg.carpetTextureRepeat * 2, cfg.carpetTextureRepeat * 2)
    bump.generateMipmaps = true
    bump.minFilter = THREE.LinearMipmapLinearFilter
    bump.anisotropy = anisotropy
    carpet.bumpMap = bump
    carpet.bumpScale = cfg.carpetBumpScale
  }

  const wallMap = cached('wall', () => wallTexture(budget.textureSize))
  wallMap.repeat.set(cfg.wall.textureRepeat, cfg.wall.repeatY)

  const hoardingsMap = cached('hoardings', () => hoardingTexture(cfg, budget))
  const hoardingsRepeat = cfg.hoardings.panels / cfg.hoardings.panelsPerTile
  // The ring is an open cylinder and the boards are read from *inside* it, where the
  // surface is back-facing, so the un-mirrored canvas comes out reversed. Flipping the
  // repeat undoes that at the UV stage rather than in the drawing, which keeps the copy
  // written the right way round wherever it is looked at. The repeat is a whole number of
  // tiles, so the seam stays continuous across the wrap.
  hoardingsMap.repeat.set(-hoardingsRepeat, 1)
  hoardingsMap.offset.x = seamlessOffset(hoardingsMap, hoardingsRepeat)
  hoardingsMap.generateMipmaps = true
  hoardingsMap.minFilter = THREE.LinearMipmapLinearFilter
  hoardingsMap.anisotropy = anisotropy

  const roofMap = cached('roof', () => roofGratingTexture(budget.textureSize))
  roofMap.repeat.set(16, 16)

  const steelMap = cached('steel', () => steelTexture(budget.textureSize))
  steelMap.repeat.set(1, 1)

  return {
    carpet,
    concrete: new THREE.MeshStandardMaterial({
      color: color(cfg.palette.concrete),
      roughness: 0.94,
      metalness: 0,
      envMapIntensity: 0.2,
      side: THREE.DoubleSide
    }),
    wall: new THREE.MeshStandardMaterial({
      color: color(cfg.palette.wall),
      map: wallMap,
      roughness: 0.92,
      metalness: 0,
      envMapIntensity: 0.18,
      side: THREE.DoubleSide
    }),
    fascia: new THREE.MeshStandardMaterial({
      color: color(cfg.palette.fascia),
      roughness: 0.9,
      metalness: 0,
      envMapIntensity: 0.16,
      side: THREE.DoubleSide
    }),
    steel: new THREE.MeshStandardMaterial({
      color: color(cfg.palette.steel),
      map: steelMap,
      roughness: 0.52,
      metalness: 0.55,
      envMapIntensity: 0.5,
      side: THREE.DoubleSide
    }),
    darkSteel: new THREE.MeshStandardMaterial({
      color: color(cfg.palette.darkSteel),
      roughness: 0.62,
      metalness: 0.45,
      envMapIntensity: 0.4,
      side: THREE.DoubleSide
    }),
    cameraRig: new THREE.MeshStandardMaterial({
      color: color(cfg.palette.cameraRig),
      roughness: 0.58,
      metalness: 0.35,
      envMapIntensity: 0.45
    }),
    hoardings: new THREE.MeshStandardMaterial({
      color: '#ffffff',
      map: hoardingsMap,
      emissive: new THREE.Color('#ffffff'),
      emissiveMap: hoardingsMap,
      emissiveIntensity: cfg.hoardings.emissiveIntensity,
      roughness: 0.34,
      metalness: 0.1,
      envMapIntensity: 0.3,
      side: THREE.DoubleSide
    }),
    roof: new THREE.MeshStandardMaterial({
      color: cfg.roof.color,
      map: roofMap,
      roughness: 0.93,
      metalness: 0.05,
      envMapIntensity: 0.12,
      side: THREE.DoubleSide
    }),
    roofVoid: new THREE.MeshBasicMaterial({ color: '#070b16', side: THREE.DoubleSide }),
    fixtureFace: new THREE.MeshStandardMaterial({
      color: '#20242c',
      emissive: new THREE.Color('#fff6e2'),
      emissiveIntensity: cfg.rig.emissiveIntensity,
      roughness: 0.3,
      metalness: 0.1
    }),
    lensGlass: new THREE.MeshStandardMaterial({ color: '#0a0d14', roughness: 0.12, metalness: 0.8, envMapIntensity: 0.9 }),
    tally: new THREE.MeshStandardMaterial({
      color: '#2a0a0c',
      emissive: new THREE.Color('#ff2a1a'),
      emissiveIntensity: 2.2,
      roughness: 0.4,
      metalness: 0
    }),
    seats: new THREE.MeshStandardMaterial({
      color: '#ffffff',
      roughness: 0.58,
      metalness: 0.06,
      envMapIntensity: 0.35,
      side: THREE.DoubleSide
    })
  }
}

/* ------------------------------------------------------------------ *
 * The bowl's layout, worked out once.
 * ------------------------------------------------------------------ */

/** Every row of seats in the arena, innermost first. */
export function seatRows(cfg: ArenaConfig, budget: ArenaBudget): ArenaSeatRow[] {
  const rows: ArenaSeatRow[] = []
  const tiers = cfg.bowl.tiers.slice(0, Math.max(1, Math.min(budget.tiers, cfg.bowl.tiers.length)))
  let radius = cfg.bowl.innerRadius + cfg.bowl.firstRowInset
  let y = cfg.bowl.firstRowLift
  tiers.forEach((tier, tierIndex) => {
    if (tierIndex > 0) {
      // Each deck after the first steps back by its aisle and up by a row's rise, which is
      // what separates one bank of seating from the next.
      radius += tier.aisle
      y += tier.rowRise
    }
    for (let r = 0; r < Math.max(1, Math.min(tier.rows, budget.rows)); r++) {
      rows.push({ radius, y, tier: tierIndex, rowInTier: r, pitch: tier.rowPitch, rise: tier.rowRise })
      radius += tier.rowPitch
      y += tier.rowRise
    }
  })
  return rows
}

/* ------------------------------------------------------------------ *
 * Geometry helpers.
 * ------------------------------------------------------------------ */

/** An open cylinder ring around the table, from `centerY - h/2` to `centerY + h/2`. */
function addRing(
  parent: THREE.Object3D,
  segments: number,
  radiusTop: number,
  radiusBottom: number,
  height: number,
  centerY: number,
  material: THREE.Material
): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments, 1, true, -Math.PI, Math.PI * 2)
  const mesh = new THREE.Mesh(geo, material)
  mesh.position.y = centerY
  parent.add(mesh)
  return mesh
}

/** A flat annulus lying in the ground plane at `y`. */
function addLanding(
  parent: THREE.Object3D,
  segments: number,
  innerRadius: number,
  outerRadius: number,
  y: number,
  material: THREE.Material
): THREE.Mesh | null {
  // A `RingGeometry` with its inner edge past its outer one collapses into a sliver of
  // undefined triangles, so a landing that has run out of room is skipped instead.
  if (!(outerRadius > innerRadius + 1)) return null
  const mesh = new THREE.Mesh(new THREE.RingGeometry(innerRadius, outerRadius, segments), material)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = y
  parent.add(mesh)
  return mesh
}

/** Four corners of one face, wound so that the first three are the face's own triangle. */
type Quad = [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3]

/** Two triangles covering a quad: the front face, or the same thing wound the other way. */
type Triangles = readonly [readonly [number, number, number], readonly [number, number, number]]

/**
 * A slab with a rectangular hole in it, lying flat.
 *
 * Built as a ring of four trapezoids rather than an `ExtrudeGeometry` with a hole: this
 * stays one geometry and one draw call, and the hole's rim comes out of the same eight
 * quads.
 */
function rectangularSlab(
  outerX: number,
  outerZ: number,
  innerX: number,
  innerZ: number,
  thickness: number,
  segments: number
): THREE.BufferGeometry {
  const pos: number[] = []
  const nrm: number[] = []
  const uvs: number[] = []
  const half = thickness / 2

  const emit = (p: Quad, normal: THREE.Vector3): void => {
    // Make the winding agree with the normal, so a double-sided material still lights these
    // faces the right way round. Checking is cheaper than getting twenty faces right by hand.
    // Reversing a quad is done by giving it the two triangles wound the other way, not by
    // handing back a four-corner triangle — that used to emit the shared diagonal twice and
    // lay a second, coplanar copy of half the face over the first.
    const e1 = new THREE.Vector3().subVectors(p[1], p[0])
    const e2 = new THREE.Vector3().subVectors(p[2], p[0])
    const flipped = new THREE.Vector3().crossVectors(e1, e2).dot(normal) < 0
    const order: Triangles = flipped
      ? [
          [0, 3, 2],
          [0, 2, 1]
        ]
      : [
          [0, 1, 2],
          [0, 2, 3]
        ]
    const us = [0, 1, 1, 0]
    const vs = [0, 0, 1, 1]
    for (const triangle of order) {
      for (const i of triangle) {
        const point = p[i] as THREE.Vector3
        pos.push(point.x, point.y, point.z)
        nrm.push(normal.x, normal.y, normal.z)
        uvs.push(us[i] as number, vs[i] as number)
      }
    }
  }

  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, n: THREE.Vector3): void => {
    emit([a, b, c, d], n)
  }

  const corners = (x: number, z: number): Quad => [
    new THREE.Vector3(-x, -half, z),
    new THREE.Vector3(x, -half, z),
    new THREE.Vector3(x, half, z),
    new THREE.Vector3(-x, half, z)
  ]
  const outer = corners(outerX, outerZ)
  const inner = corners(innerX, innerZ)

  // Top, then the outer walls, then the inner rim, then the bottom.
  quad(outer[0], outer[1], outer[2], outer[3], new THREE.Vector3(0, 1, 0))
  for (let i = 0; i < 4; i++) {
    const a = outer[i] as THREE.Vector3
    const b = outer[(i + 1) % 4] as THREE.Vector3
    const c = inner[(i + 1) % 4] as THREE.Vector3
    const d = inner[i] as THREE.Vector3
    const outward = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize()
    quad(a, b, c, d, outward)
  }
  for (let i = 0; i < 4; i++) {
    const a = inner[i] as THREE.Vector3
    const b = inner[(i + 1) % 4] as THREE.Vector3
    const c = outer[(i + 1) % 4] as THREE.Vector3
    const d = outer[i] as THREE.Vector3
    const inward = new THREE.Vector3(a.x - b.x, 0, a.z - b.z).normalize()
    quad(a, b, c, d, inward)
  }
  quad(inner[0], inner[1], inner[2], inner[3], new THREE.Vector3(0, -1, 0))

  void segments
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geo.computeBoundingSphere()
  return geo
}

/* ------------------------------------------------------------------ *
 * The bowl.
 * ------------------------------------------------------------------ */

/** The carpet the whole bowl stands on. */
function buildFloor(cfg: ArenaConfig, budget: ArenaBudget, materials: ArenaMaterials): THREE.Group {
  const group = new THREE.Group()
  const carpet = new THREE.Mesh(new THREE.CircleGeometry(cfg.carpetRadius, Math.max(48, budget.curveSegments)), materials.carpet)
  carpet.rotation.x = -Math.PI / 2
  carpet.position.y = cfg.carpetY
  // The one shadow receiver the arena adds: the scene's lamp bakes its map once over the
  // static set, and this is where the table's silhouette lands.
  carpet.receiveShadow = cfg.carpetReceiveShadow
  group.add(carpet)

  return group
}

/**
 * The stands.
 *
 * The terrace itself is a single cone rather than a box per row: a 340mm step every 720mm
 * of depth is a 28-degree rake and a cone frustum describes exactly that, so the whole
 * bowl is one mesh no matter how many rows of seats stand on it. The risers then go on as
 * their own vertical rings, because those are the faces the seating pattern reads against
 * and a cone alone would read as a smooth ramp. Those rings are what carry the aisles: at
 * a deck's front edge the next row is two rises up, so the face is 680mm of step there
 * against 340mm everywhere else.
 */
function buildStands(cfg: ArenaConfig, budget: ArenaBudget, materials: ArenaMaterials, rows: ArenaSeatRow[]): THREE.Group {
  const group = new THREE.Group()
  const first = rows[0]
  const last = rows[rows.length - 1]
  if (!first || !last) return group

  // The deck's rake, front edge to back edge.
  const bottomRadius = first.radius - first.pitch / 2
  const topRadius = last.radius + last.pitch / 2
  const bottomY = first.y - first.rise
  const topY = last.y + last.rise
  addRing(group, Math.max(48, budget.curveSegments), topRadius, bottomRadius, topY - bottomY, (bottomY + topY) / 2, materials.concrete)

  // The solid face of the bowl, from the carpet up to the walkway in front of the first
  // row. It stands at the terrace's own front edge rather than at the first row, so the
  // landing covers the strip behind the hoardings and nothing of the bowl's inside is left
  // open: from a low camera you see boards, carpet, this face, then the terraces.
  const faceHeight = bottomY - cfg.carpetY
  if (faceHeight > 1) {
    addRing(group, Math.max(48, budget.curveSegments), bottomRadius, bottomRadius, faceHeight, (bottomY + cfg.carpetY) / 2, materials.concrete)
  }

  // The landing in front of the first deck, between the hoardings and the first row. Only
  // when it is above the carpet: a bowl that starts below floor level has its front landing
  // buried under the carpet, and a ring nobody can see is geometry the frame still pays for.
  if (bottomY > cfg.carpetY + 1) {
    addLanding(group, Math.max(48, budget.curveSegments), cfg.bowl.innerRadius, bottomRadius, bottomY, materials.concrete)
  }

  // One riser per row boundary: from a row's floor up to the next one's.
  rows.forEach((row, i) => {
    const next = rows[i + 1]
    const riserTop = next ? next.y : row.y + row.rise
    const height = riserTop - row.y
    if (height <= 1) return
    addRing(group, Math.max(48, budget.curveSegments), row.radius + row.pitch / 2, row.radius + row.pitch / 2, height, row.y + height / 2, materials.concrete)
  })

  // The walk at the back of the top deck, out to the wall. Only worth drawing if there is
  // a wall to walk to: without the shell it would be a concrete ring floating in the void.
  if (cfg.buildShell) {
    addLanding(group, Math.max(48, budget.curveSegments), topRadius, cfg.bowl.wallRadius, topY, materials.concrete)
  }

  return group
}

/** The LED hoardings that ring the playing area, plus their frame. */
function buildHoardings(cfg: ArenaConfig, budget: ArenaBudget, materials: ArenaMaterials): THREE.Group {
  const group = new THREE.Group()
  const kick = 140
  const boardH = cfg.bowl.boardHeight - kick
  addRing(group, cfg.hoardings.panels, cfg.bowl.innerRadius, cfg.bowl.innerRadius, boardH, cfg.carpetY + kick + boardH / 2, materials.hoardings)

  // A dark kick plate under the boards and a capping rail over them: two thin rings that
  // stop the lit panels from looking as though they float on the carpet.
  addRing(group, Math.max(24, budget.curveSegments >> 1), cfg.bowl.innerRadius, cfg.bowl.innerRadius, kick, cfg.carpetY + kick / 2, materials.darkSteel)
  addRing(
    group,
    Math.max(24, budget.curveSegments >> 1),
    cfg.bowl.innerRadius,
    cfg.bowl.innerRadius,
    80,
    cfg.carpetY + cfg.bowl.boardHeight + 40,
    materials.darkSteel
  )

  return group
}

/** The outer wall, the fascia above the top deck, and the roof with its open middle. */
function buildShell(cfg: ArenaConfig, budget: ArenaBudget, materials: ArenaMaterials, rows: ArenaSeatRow[]): THREE.Group {
  const group = new THREE.Group()
  const top = rows[rows.length - 1]
  const fasciaBase = (top?.y ?? 0) + (top?.rise ?? 0) + 200

  // From under the carpet to the roof, so no gap can ever show through to the clear colour.
  addRing(group, budget.curveSegments, cfg.bowl.wallRadius, cfg.bowl.wallRadius, cfg.bowl.wallHeight + 900, cfg.bowl.wallHeight / 2 - 900, materials.wall)
  addRing(
    group,
    budget.curveSegments,
    cfg.bowl.wallRadius - 420,
    cfg.bowl.wallRadius - 420,
    cfg.bowl.fasciaHeight,
    fasciaBase + cfg.bowl.fasciaHeight / 2,
    materials.fascia
  )

  const t = 220
  const roof = new THREE.Mesh(
    rectangularSlab(cfg.bowl.wallRadius, cfg.bowl.wallRadius, cfg.bowl.roofHoleX, cfg.bowl.roofHoleZ, t, budget.curveSegments),
    materials.roof
  )
  roof.position.y = cfg.bowl.wallHeight
  group.add(roof)

  // The rim of the mouth, hanging below the roof: what the rig's droppers land on.
  const lip = new THREE.Mesh(
    rectangularSlab(
      cfg.bowl.roofHoleX + 260,
      cfg.bowl.roofHoleZ + 260,
      cfg.bowl.roofHoleX - 120,
      cfg.bowl.roofHoleZ - 120,
      300,
      budget.curveSegments
    ),
    materials.darkSteel
  )
  lip.position.y = cfg.bowl.wallHeight - cfg.bowl.roofHoleLip / 2
  group.add(lip)

  // A cap over the mouth, so a ray that does find its way up through it sees roof void
  // rather than the scene's clear colour.
  const cap = new THREE.Mesh(new THREE.PlaneGeometry(cfg.bowl.roofHoleX * 2, cfg.bowl.roofHoleZ * 2), materials.roofVoid)
  cap.rotation.x = Math.PI / 2
  cap.position.y = cfg.bowl.wallHeight + 1400
  group.add(cap)

  // Structural bands under the roof. Their only job is to catch light: without them the
  // ceiling is a flat plane, and a flat plane is the one thing that reads as a lid.
  for (let i = 0; i < cfg.roof.bands; i++) {
    const t2 = (i + 1) / (cfg.roof.bands + 1)
    const x = -cfg.bowl.wallRadius + t2 * cfg.bowl.wallRadius * 2
    const span = cfg.bowl.wallRadius * 2 - Math.abs(x) * 2
    if (span <= 0) continue
    const band = new THREE.Mesh(new THREE.BoxGeometry(cfg.roof.bandHalfWidth * 2, 220, span), materials.roof)
    band.position.set(x, cfg.bowl.wallHeight - cfg.roof.drop, 0)
    group.add(band)
  }

  return group
}

/* ------------------------------------------------------------------ *
 * The seats.
 * ------------------------------------------------------------------ */

/**
 * One stadium chair: a pan on a pedestal with a back leaning away from the table.
 *
 * Three boxes merged into a single geometry, because the chairs are instanced — an
 * instance carries one matrix and one draw call covers a whole deck, so the chair has to be
 * one geometry rather than a group of three.
 */
function buildSeatGeometry(cfg: ArenaConfig): THREE.BufferGeometry {
  const s = cfg.seats
  const lean = s.backLean * DEG
  const backH = Math.max(1, s.backHeight - s.seatHeight)

  const pan = new THREE.BoxGeometry(s.width, s.thickness, s.depth)
  pan.translate(0, s.seatHeight, 0)

  const back = new THREE.BoxGeometry(s.width, backH, s.thickness)
  back.rotateX(-lean)
  back.translate(
    0,
    s.seatHeight + (backH / 2) * cos(s.backLean),
    -s.depth / 2 - s.thickness / 2 - (backH / 2) * sin(s.backLean)
  )

  const stemH = Math.max(1, s.seatHeight - s.thickness)
  const stem = new THREE.BoxGeometry(s.width * 0.45, stemH, s.thickness)
  stem.translate(0, s.thickness / 2 + stemH / 2, -s.depth / 2 + s.thickness / 2)

  const merged = mergeGeometries([pan, back, stem])
  pan.dispose()
  back.dispose()
  stem.dispose()
  if (!merged) throw new Error('arena: seat geometry failed to merge')
  merged.computeBoundingSphere()
  return merged
}

/** One seat's place in the bowl: where it stands, and which block of the row it is in. */
export interface ArenaSeatPlacement {
  x: number
  y: number
  z: number
  rotY: number
  deck: number
  /** Row within its deck, which the seat pattern uses so rows are not identical. */
  rowInDeck: number
  /** Block index within the row. Blocks are what leave the aisles. */
  block: number
  /** This seat is the striped one at the head of a block. */
  stripe: boolean
  /** Per-seat brightness jitter, 0..1, or -1 for the stripe. */
  shade: number
}

/**
 * Where every seat in the bowl stands.
 *
 * Exported because the crowd has to stand on the seats rather than near them: a person
 * whose position is worked out a second time from the same inputs drifts the moment one
 * of the two versions is edited, and a bowl where some spectators are a few centimetres
 * out of their chairs is worse than no crowd at all.
 */
export function arenaSeatPlacements(cfg: ArenaConfig, budget: ArenaBudget, rows: ArenaSeatRow[]): ArenaSeatPlacement[] {
  const out: ArenaSeatPlacement[] = []
  const rand = rng(0xc0ffee)
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex] as ArenaSeatRow
    const circumference = 2 * Math.PI * row.radius
    const blocks = Math.max(1, Math.round(circumference / (cfg.seats.blockSize * budget.seatPitch)))
    const blockWidth = circumference / blocks
    const perBlock = Math.max(1, Math.floor(blockWidth / budget.seatPitch))
    const total = blocks * perBlock
    for (let i = 0; i < total; i++) {
      const block = Math.floor(i / perBlock)
      const indexInBlock = i % perBlock
      // Degrees: this file's sin/cos take degrees, while `rotY` below has to stay in
      // radians because it goes straight into a Y rotation matrix. Keeping the angle in
      // degrees and converting once at the edge is what stops the two disagreeing — with
      // a radian angle fed to a degree sin, every seat in the row landed inside a six
      // degree wedge instead of around the bowl.
      const a = ((block * perBlock + indexInBlock + 0.5) / total) * 360
      // No seats where the stairway comes up through the stand.
      if (onStairway(a, row.radius)) continue
      const stripe = indexInBlock === 0 && cfg.seats.patternEvery > 0 && block % cfg.seats.patternEvery === 0
      out.push({
        x: row.radius * sin(a),
        y: row.y,
        z: row.radius * cos(a),
        rotY: a * DEG,
        deck: row.tier,
        rowInDeck: row.rowInTier,
        block: row.tier * 31 + row.rowInTier * 7 + block,
        stripe,
        shade: stripe ? -1 : 0.92 + rand() * 0.16
      })
    }
  }
  return out
}

/**
 * Every seat in the bowl, one InstancedMesh per deck.
 *
 * Seats are filtered down to whole blocks so a row never ends with half a seat at an aisle,
 * and the block boundaries are what put the aisles in. That is what stops the rows reading
 * as one continuous ring of seating.
 */
/** Where the pools of light fall round the bowl, as headings from the table's centre, in radians. */
const SEAT_POOL_HEADINGS = [0.35, 1.45, 2.5, 3.55, 4.6, 5.65]
/** How wide one pool is, in radians either side of its heading. */
const SEAT_POOL_WIDTH = 0.3
/** How bright a seat is in the dark between pools, and at the middle of one. */
const SEAT_POOL_FLOOR = 0.2
const SEAT_POOL_PEAK = 2.1

/**
 * How brightly a seat is lit, as a multiple of its own colour.
 *
 * Brightest at the heading of the nearest pool and falling off to either side, and dimmer
 * the higher up the stand it is, the way a light aimed at the front rows spills up the bank
 * behind them.
 */
function seatPoolLight(x: number, z: number, y: number): number {
  const heading = Math.atan2(z, x)
  let pool = 0
  for (const at of SEAT_POOL_HEADINGS) {
    let delta = Math.abs(heading - at) % (Math.PI * 2)
    if (delta > Math.PI) delta = Math.PI * 2 - delta
    const g = Math.exp(-(delta * delta) / (SEAT_POOL_WIDTH * SEAT_POOL_WIDTH))
    if (g > pool) pool = g
  }
  const height = Math.max(0.55, 1 - Math.max(0, y) / 9000)
  return (SEAT_POOL_FLOOR + (SEAT_POOL_PEAK - SEAT_POOL_FLOOR) * pool) * height
}

function buildSeats(cfg: ArenaConfig, budget: ArenaBudget, materials: ArenaMaterials, rows: ArenaSeatRow[]): THREE.Group {
  const group = new THREE.Group()
  const geometry = buildSeatGeometry(cfg)

  const baseColours = cfg.seats.palette.map((hex) => color(hex))
  const stripeColour = color(cfg.seats.stripeColor)
  const tint = new THREE.Color()
  const m4 = new THREE.Matrix4()

  const plan = arenaSeatPlacements(cfg, budget, rows)
  const byDeck = new Map<number, ArenaSeatPlacement[]>()
  for (const seat of plan) {
    const deck = byDeck.get(seat.deck)
    if (deck) deck.push(seat)
    else byDeck.set(seat.deck, [seat])
  }

  for (const [deck, deckSeats] of byDeck) {
    const paletteBase = baseColours[deck % baseColours.length] ?? new THREE.Color('#7f8797')

    const mesh = new THREE.InstancedMesh(geometry, materials.seats, deckSeats.length)
    mesh.name = `arena-seats-deck-${deck}`
    deckSeats.forEach((seat, i) => {
      m4.makeRotationY(seat.rotY)
      m4.setPosition(seat.x, seat.y, seat.z)
      mesh.setMatrixAt(i, m4)
      if (seat.shade < 0) tint.copy(stripeColour)
      else tint.copy(paletteBase).multiplyScalar(seat.shade)
      // A small lift per block on top of the deck's colour, so a block reads as one colour
      // rather than as a hundred different ones.
      tint.offsetHSL(((seat.block % 5) - 2) * 0.006, 0, ((seat.block % 3) - 1) * 0.018)
      // House lights, not a floodlit bowl: a handful of pools round the stands with dark
      // between them, falling away up the tiers. Written into the seat's own colour, so it
      // costs nothing to draw and is there whichever material the stands are wearing.
      tint.multiplyScalar(seatPoolLight(seat.x, seat.z, seat.y))
      mesh.setColorAt(i, tint)
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    group.add(mesh)
  }

  return group
}

/* ------------------------------------------------------------------ *
 * The lighting rig and the television cameras.
 * ------------------------------------------------------------------ */

/** A cylinder laid along an arbitrary axis: one geometry per strut, oriented by matrix. */
function strut(
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  material: THREE.Material,
  segments: number
): THREE.Mesh {
  const direction = new THREE.Vector3().subVectors(to, from)
  const length = Math.max(1, direction.length())
  const geo = new THREE.CylinderGeometry(radius, radius, length, segments, 1, true)
  const mesh = new THREE.Mesh(geo, material)
  mesh.position.copy(from).addScaledVector(direction, 0.5)
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize())
  return mesh
}

/**
 * Collapse everything under `root` into one mesh per material, baking each part's own
 * transform into its geometry on the way.
 *
 * The truss and the camera stands are modelled part by part because that is the only way to
 * describe them — every strut has its own axis — and they were being *drawn* part by part
 * too: a hundred-odd draw calls for decoration that never moves, never deforms and is never
 * picked on its own. The parts are worth keeping, the meshes are not. One steel strut and
 * one fixture housing become one steel mesh and one dark mesh, whatever the count.
 *
 * Baking happens in `root`'s own frame, so a merged mesh can go back where the parts were
 * without the group's transform being applied twice, and indexed primitives are flattened
 * first because indexed and un-indexed buffers cannot share a merge.
 *
 * If anything refuses to merge — two parts disagreeing about their attributes, which is the
 * only way `mergeGeometries` says no — every clone is thrown away and the group comes back
 * untouched: a slow truss is a frame time problem, a missing one is a wrong picture.
 */
function mergeStaticMeshes(root: THREE.Group, label: string): THREE.Group {
  root.updateMatrixWorld(true)
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert()
  type Part = { mesh: THREE.Mesh; geometry: THREE.BufferGeometry }
  const buckets = new Map<THREE.Material, Part[]>()
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh || Array.isArray(mesh.material)) return
    const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()
    geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld))
    const bucket = buckets.get(mesh.material)
    if (bucket) bucket.push({ mesh, geometry })
    else buckets.set(mesh.material, [{ mesh, geometry }])
  })

  const merged: { material: THREE.Material; geometry: THREE.BufferGeometry; parts: THREE.Mesh[] }[] = []
  let refused = false
  for (const [material, bucket] of buckets) {
    // A single part under a material has nothing to merge into, and the attempt's clone is
    // thrown away: the original stays in the tree, exactly where it already was.
    if (bucket.length < 2) {
      bucket.forEach((part) => part.geometry.dispose())
      continue
    }
    const geometry = mergeGeometries(
      bucket.map((part) => part.geometry),
      false
    )
    bucket.forEach((part) => part.geometry.dispose())
    if (!geometry) {
      refused = true
      break
    }
    merged.push({ material, geometry, parts: bucket.map((part) => part.mesh) })
  }
  if (refused) {
    merged.forEach((entry) => entry.geometry.dispose())
    return root
  }

  for (const entry of merged) {
    for (const part of entry.parts) part.removeFromParent()
    const mesh = new THREE.Mesh(entry.geometry, entry.material)
    mesh.name = `${label}:${(entry.material as THREE.Material & { name?: string }).name || 'part'}`
    root.add(mesh)
  }
  return root
}

/**
 * The truss over the table, the fixtures hung off it, and the droppers up to the roof.
 *
 * Held above the camera rig's 6000mm ceiling on purpose: the overhead view climbs to that
 * height on a narrow canvas, and anything hung over the table below it would be drawn
 * between the lens and the bed.
 */
function buildRig(cfg: ArenaConfig, budget: ArenaBudget, materials: ArenaMaterials): THREE.Group {
  const group = new THREE.Group()
  const y = cfg.rig.y
  const ex = cfg.rig.extentX
  const ez = cfg.rig.extentZ
  const v = (x: number, yv: number, z: number): THREE.Vector3 => new THREE.Vector3(x, yv, z)

  // Two chords a metre apart, tied together: a truss reads as structure, four bare pipes
  // read as a rectangle.
  for (const dy of [0, -1000]) {
    for (const z of [ez, -ez]) group.add(strut(v(-ex, y + dy, z), v(ex, y + dy, z), 130, materials.steel, budget.trussSegments))
    for (const x of [ex, -ex]) group.add(strut(v(x, y + dy, -ez), v(x, y + dy, ez), 130, materials.steel, budget.trussSegments))
  }
  for (let i = 0; i <= 10; i++) {
    const t = i / 10
    const x = -ex + t * ex * 2
    for (const z of [ez, -ez]) group.add(strut(v(x, y, z), v(x, y - 1000, z), 60, materials.darkSteel, 4))
    const z = -ez + t * ez * 2
    for (const sx of [ex, -ex]) group.add(strut(v(sx, y, z), v(sx, y - 1000, z), 60, materials.darkSteel, 4))
  }
  for (let i = 0; i <= 4; i++) {
    const x = -ex + (i / 4) * ex * 2
    group.add(strut(v(x, y, -ez), v(x, y, ez), 90, materials.steel, budget.trussSegments))
  }

  // Droppers up to the roof, standing on the solid part of it either side of the mouth.
  const roofY = cfg.bowl.wallHeight - cfg.roof.drop
  for (let i = 0; i <= cfg.rig.hangers; i++) {
    const t = i / cfg.rig.hangers
    const x = -ex + t * ex * 2
    for (const z of [ez, -ez]) group.add(strut(v(x, y, z), v(x, roofY, z), 90, materials.darkSteel, 4))
    const z = -ez + t * ez * 2
    for (const sx of [ex, -ex]) group.add(strut(v(sx, y, z), v(sx, roofY, z), 90, materials.darkSteel, 4))
  }

  // Fixtures: a housing, a lit lens face, and the dropper it hangs on.
  for (const z of [ez, -ez]) {
    for (let i = 0; i < cfg.rig.fixtures; i++) {
      const t = (i + 0.5) / cfg.rig.fixtures
      const x = -ex * 0.86 + t * ex * 1.72
      const faceY = y - cfg.rig.fixtureDrop
      group.add(strut(v(x, y, z), v(x, faceY, z), 70, materials.darkSteel, 4))
      const housing = new THREE.Mesh(new THREE.CylinderGeometry(cfg.rig.fixtureRadius, cfg.rig.fixtureRadius * 0.86, 620, 14), materials.darkSteel)
      housing.position.set(x, faceY - 310, z)
      group.add(housing)
      const face = new THREE.Mesh(new THREE.CircleGeometry(cfg.rig.fixtureRadius * 0.84, 16), materials.fixtureFace)
      face.rotation.x = Math.PI / 2
      face.position.set(x, faceY - 622, z)
      group.add(face)
    }
  }

  return mergeStaticMeshes(group, 'rig')
}

/**
 * One television camera on a tripod, built facing the table and placed by its caller.
 *
 * `baseY` is the ground it stands on: the landing in front of the first row, not the
 * carpet. The stand has to be outside the hoardings, and that landing is the only floor in
 * the venue with no seats on it.
 */
function cameraStand(cfg: ArenaConfig, materials: ArenaMaterials, baseY: number): THREE.Group {
  const group = new THREE.Group()
  const c = cfg.cameras
  const base = baseY
  const headY = base + c.height
  const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z)

  // A pedestal rather than a pillar: 55mm of radius against 2050mm of height. The old
  // 95/130 column in near-black steel is most of what made these read as obstructions.
  const column = new THREE.Mesh(new THREE.CylinderGeometry(55, 78, c.height, 10), materials.cameraRig)
  column.position.set(0, base + c.height / 2, 0)
  group.add(column)

  const hubY = base + c.height * 0.62
  for (let i = 0; i < c.legs; i++) {
    // Degrees: this file's sin/cos take degrees. Fed a radian angle, the three legs came
    // out within a few millimetres of each other and the tripod collapsed into a second
    // column, which is why the stand never read as a tripod at all.
    const a = (i / c.legs) * 360 + 30
    const lx = c.legSplay * sin(a)
    const lz = c.legSplay * cos(a)
    group.add(strut(v(lx * 0.1, hubY, lz * 0.1), v(lx, base, lz), 30, materials.cameraRig, 5))
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(58, 70, 36, 8), materials.cameraRig)
    foot.position.set(lx, base + 18, lz)
    group.add(foot)
  }

  const head = new THREE.Mesh(new THREE.BoxGeometry(180, 150, 210), materials.cameraRig)
  head.position.set(0, headY + 45, 0)
  group.add(head)

  // The body is about half a metre long, which is what a studio camera measures. The old
  // 760mm box behind a 620mm lens put a metre of black in front of the stand.
  const body = new THREE.Mesh(new THREE.BoxGeometry(c.bodyWidth, c.bodyHeight, c.bodyDepth), materials.darkSteel)
  body.position.set(0, headY + 265, 50)
  group.add(body)

  // The lens points down the stand's own -z, which the placement below aims at the table.
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(c.lensRadius, c.lensRadius * 0.92, c.lensLength, 14), materials.darkSteel)
  lens.rotation.x = Math.PI / 2
  lens.position.set(0, headY + 275, 50 - c.bodyDepth / 2 - c.lensLength / 2)
  group.add(lens)

  const glass = new THREE.Mesh(new THREE.CircleGeometry(c.lensRadius * 0.86, 16), materials.lensGlass)
  glass.rotation.y = Math.PI
  glass.position.set(0, headY + 275, 50 - c.bodyDepth / 2 - c.lensLength)
  group.add(glass)

  const tally = new THREE.Mesh(new THREE.SphereGeometry(38, 8, 6), materials.tally)
  tally.position.set(0, headY + 430, 95)
  group.add(tally)

  const viewfinder = new THREE.Mesh(new THREE.BoxGeometry(240, 90, 70), materials.darkSteel)
  viewfinder.position.set(215, headY + 345, 30)
  viewfinder.rotation.y = 0.5
  group.add(viewfinder)

  return group
}

/** How tall the wall behind the top row is, and how many times its picture repeats round the hall. */
const BACKDROP_HEIGHT_MM = 4600
const BACKDROP_REPEATS = 8

/**
 * The picture on the wall behind the stands: one bay of it, repeated round the hall.
 *
 * Drapes lit from the floor by a pair of uplights, with a banner hung between them. All of
 * the light is painted: the wall is drawn unlit, so it looks the same on every quality
 * level and costs one texture read per pixel. The top fades into the dark of the roof, so
 * the wall has no upper edge to see.
 */
function backdropTexture(size: number): THREE.CanvasTexture {
  const w = size
  const h = size / 2
  const ctx = canvas2d(w, h)
  const fall = ctx.createLinearGradient(0, h, 0, 0)
  fall.addColorStop(0, '#22408f')
  fall.addColorStop(0.45, '#152a66')
  fall.addColorStop(1, '#0a1638')
  ctx.fillStyle = fall
  ctx.fillRect(0, 0, w, h)

  // The folds of the drape: a soft dark line and a soft light one, every few centimetres.
  for (let x = 0; x < w; x += w / 64) {
    ctx.fillStyle = 'rgba(0,0,0,0.16)'
    ctx.fillRect(x, 0, w / 256, h)
    ctx.fillStyle = 'rgba(255,255,255,0.035)'
    ctx.fillRect(x + w / 128, 0, w / 256, h)
  }

  // Two uplights at the foot of the wall, warm, each throwing a tall soft cone up the drape.
  for (const at of [0.25, 0.75]) {
    const cone = ctx.createRadialGradient(w * at, h * 1.02, 0, w * at, h * 1.02, h * 0.95)
    cone.addColorStop(0, 'rgba(255,226,170,0.62)')
    cone.addColorStop(0.35, 'rgba(255,200,130,0.22)')
    cone.addColorStop(1, 'rgba(255,200,130,0)')
    ctx.save()
    ctx.translate(w * at, 0)
    ctx.scale(0.55, 1)
    ctx.translate(-w * at, 0)
    ctx.fillStyle = cone
    ctx.fillRect(-w, 0, w * 3, h)
    ctx.restore()
  }

  // The banner between them: a hanging panel with a gold edge, lit a little from below.
  const bw = w * 0.2
  const bh = h * 0.56
  const bx = w * 0.5 - bw / 2
  const by = h * 0.2
  const panel = ctx.createLinearGradient(0, by, 0, by + bh)
  panel.addColorStop(0, '#5d0f1c')
  panel.addColorStop(1, '#a41d30')
  ctx.fillStyle = 'rgba(0,0,0,0.35)'
  ctx.fillRect(bx + 6, by + 8, bw, bh)
  ctx.fillStyle = panel
  ctx.fillRect(bx, by, bw, bh)
  ctx.strokeStyle = '#e2bb55'
  ctx.lineWidth = Math.max(2, w / 340)
  ctx.strokeRect(bx + ctx.lineWidth, by + ctx.lineWidth, bw - ctx.lineWidth * 2, bh - ctx.lineWidth * 2)
  ctx.fillStyle = '#f3d98a'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `800 ${Math.round(h * 0.085)}px system-ui, sans-serif`
  ctx.fillText('WORLD', w * 0.5, by + bh * 0.3)
  ctx.font = `700 ${Math.round(h * 0.058)}px system-ui, sans-serif`
  ctx.fillText('SNOOKER', w * 0.5, by + bh * 0.5)
  ctx.font = `600 ${Math.round(h * 0.04)}px system-ui, sans-serif`
  ctx.fillStyle = '#ffffff'
  ctx.fillText('CHAMPIONSHIP', w * 0.5, by + bh * 0.7)

  const tex = new THREE.CanvasTexture(ctx.canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  // Seen from inside the ring, so the picture is turned round to read the right way.
  tex.repeat.set(-BACKDROP_REPEATS, 1)
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  return tex
}

/**
 * The wall behind the top row of seats.
 *
 * Without it the stands ended against nothing, and nothing is black: the room read as a
 * table in a cellar. One open ring, one unlit material, one draw call.
 */
function buildBackdrop(rows: ArenaSeatRow[], budget: ArenaBudget): THREE.Group {
  const group = new THREE.Group()
  const last = rows[rows.length - 1]
  if (!last) return group
  const radius = last.radius + last.pitch / 2 + 420
  const footY = last.y + last.rise - 200
  const material = new THREE.MeshBasicMaterial({
    map: cached('backdrop', () => backdropTexture(Math.max(512, budget.textureSize))),
    side: THREE.BackSide,
    fog: false
  })
  const wall = addRing(group, Math.max(48, budget.curveSegments), radius, radius, BACKDROP_HEIGHT_MM, footY + BACKDROP_HEIGHT_MM / 2, material)
  wall.name = 'arena-backdrop'
  return group
}

/** Where the stairway climbs the stand, as a heading from the table in degrees, and how wide it is. */
export const STAIRWAY_AZIMUTH_DEG = 118
export const STAIRWAY_WIDTH_MM = 1050
/** Clear floor kept between the stairway and the nearest seat on either side. */
const STAIRWAY_SEAT_GAP_MM = 300

/** Whether a seat at this heading and radius would be standing on the stairway. */
function onStairway(azimuthDeg: number, radius: number): boolean {
  let delta = Math.abs(azimuthDeg - STAIRWAY_AZIMUTH_DEG) % 360
  if (delta > 180) delta = 360 - delta
  return delta * DEG * radius < STAIRWAY_WIDTH_MM / 2 + STAIRWAY_SEAT_GAP_MM
}

/**
 * The stairway the crowd comes in by: steps up through the stand, a handrail either side,
 * and the lit doorway at the top.
 *
 * Built for a room that may be drawn unlit. With no light to shade them, a tread and the
 * riser under it are the same colour and a flight of steps is a ramp, so the two are
 * different materials: pale treads, dark risers, and a yellow strip on the edge of each
 * step the way a venue marks them. Everything is boxes, merged to one mesh per colour, so
 * the whole stairway is a handful of draw calls and a few hundred triangles.
 */
function buildStairway(rows: ArenaSeatRow[], cfg: ArenaConfig): THREE.Group {
  const group = new THREE.Group()
  const first = rows[0]
  const last = rows[rows.length - 1]
  if (!first || !last) return group
  const flat = (hex: string): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ color: color(hex), roughness: 0.9, metalness: 0, side: THREE.DoubleSide })
  const tread = flat('#b9bfcc')
  const riser = flat('#2f374c')
  const nosing = flat('#f4c531')
  const rail = flat('#d5dae2')
  const frame = flat('#1c2233')
  const sign = new THREE.MeshBasicMaterial({ color: '#46f09a' })
  const dark = new THREE.MeshBasicMaterial({ color: '#04060b' })

  const w = STAIRWAY_WIDTH_MM
  const pitch = first.pitch
  const rise = first.rise
  const depth = pitch / 2
  const stepRise = rise / 2
  const bottomRadius = first.radius - pitch / 2
  const bottomY = first.y - rise
  const steps = rows.length * 2
  const startR = bottomRadius - depth
  const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number, material: THREE.Material): void => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material)
    mesh.position.set(x, y, z)
    group.add(mesh)
  }

  // Two steps to every row of seats: one standing on the row below, one level with the row.
  for (let k = 0; k < steps; k++) {
    const r = startR + k * depth
    const top = bottomY + (k + 1) * stepRise + 6
    box(w, stepRise, depth, 0, top - stepRise / 2, r + depth / 2, riser)
    box(w, 8, depth - 60, 0, top + 4, r + 60 + (depth - 60) / 2, tread)
    box(w, 10, 60, 0, top + 5, r + 30, nosing)
  }

  // Handrails: one sloping rail a side, on posts.
  const endR = startR + steps * depth
  const topY = bottomY + steps * stepRise
  const railHeight = 760
  for (const side of [-1, 1]) {
    const x = side * (w / 2 + 40)
    group.add(
      strut(new THREE.Vector3(x, bottomY + railHeight, startR), new THREE.Vector3(x, topY + railHeight, endR), 30, rail, 6)
    )
    for (let k = 0; k <= steps; k += 2) {
      const r = startR + k * depth
      const y = bottomY + k * stepRise
      group.add(strut(new THREE.Vector3(x, y, r), new THREE.Vector3(x, y + railHeight, r), 24, rail, 5))
    }
  }

  // The doorway at the head of the stairs: two posts, a lintel, a lit sign, and the dark of
  // the concourse behind it.
  const doorHeight = 1650
  for (const side of [-1, 1]) box(140, doorHeight, 170, side * (w / 2 + 110), topY + doorHeight / 2, endR + 90, frame)
  box(w + 380, 300, 170, 0, topY + doorHeight + 150, endR + 90, frame)
  box(w * 0.62, 130, 24, 0, topY + doorHeight + 150, endR - 6, sign)
  box(w + 90, doorHeight, 20, 0, topY + doorHeight / 2, endR + 150, dark)

  // Local +z is the way out from the table, so one turn puts the foot of the stairs at the
  // boards and the doorway at the back of the stand.
  group.rotation.y = STAIRWAY_AZIMUTH_DEG * DEG
  void cfg
  return mergeStaticMeshes(group, 'stairway')
}

/**
 * Four cameras on the diagonal corners, standing on the landing in front of the first row.
 *
 * The landing's height is `first.y - rise`, the same number `buildStands` uses for its own
 * front edge, so the tripods land on the concrete instead of floating over it or sinking
 * into it. The two angles are in different units on purpose: the position wants degrees
 * because `sin` takes degrees, while `rotation.y` is a rotation and wants radians.
 */
function buildCameraStands(cfg: ArenaConfig, materials: ArenaMaterials, rows: ArenaSeatRow[]): THREE.Group {
  const group = new THREE.Group()
  const first = rows[0]
  const baseY = first ? first.y - first.rise : cfg.carpetY
  for (let i = 0; i < 4; i++) {
    const azimuth = 45 + i * 90
    const stand = cameraStand(cfg, materials, baseY)
    stand.rotation.y = (azimuth + cfg.cameras.yaw) * DEG
    stand.position.set(cfg.cameras.radius * sin(azimuth), 0, cfg.cameras.radius * cos(azimuth))
    group.add(stand)
  }
  return mergeStaticMeshes(group, 'camera-stand')
}

/* ------------------------------------------------------------------ *
 * The lights the arena adds, and the old room it steps over.
 * ------------------------------------------------------------------ */

/**
 * Grazing washes for the stands.
 *
 * Placed far out and low, so what they travel is nearly horizontal: the terrace risers and
 * the seat backs face sideways and take nearly all of it, while the bed faces up and only
 * sees `sin(elevation)` of it. That is the whole reason the seating is lit by these rather
 * than by another overhead source, which would flatten the cloth — the one surface the
 * picture is about. None of them casts a shadow.
 *
 * The azimuth stays in degrees: `sin`/`cos`/`tan` take degrees here, so converting first
 * would convert twice and park every wash within a degree of the same spot — which is what
 * happened, and is why only one side of the bowl was ever lit.
 */
function buildStandLights(cfg: ArenaConfig): THREE.Group {
  const group = new THREE.Group()
  const l = cfg.lights
  const count = Math.max(0, l.standCount)
  for (let i = 0; i < count; i++) {
    const azimuth = l.standAzimuthDeg + (360 / Math.max(1, count)) * i
    const light = new THREE.DirectionalLight(0xf2f6ff, l.standIntensity)
    light.position.set(l.standRadius * sin(azimuth), l.standRadius * tan(l.standElevationDeg), l.standRadius * cos(azimuth))
    light.target.position.set(0, 0, 0)
    group.add(light)
    group.add(light.target)
  }
  return group
}

/**
 * Hides the old room's floor and back wall.
 *
 * The wall is the one that has to go: the arena's outer wall is far outside it, so a flat
 * blue plane 4600mm behind the table stands inside the bowl and reads straight through it
 * from every camera angle. The floor is worse than redundant without this: it sits at
 * exactly `carpetY`, so the scene ends up with two ground planes at the same depth and they
 * trade wins from pixel to pixel as the camera moves. The carpet takes over its job as the
 * scene's only ground-level shadow receiver.
 *
 * Matched by size rather than by reference: this file never saw the objects that built
 * them, and asking for them would mean a wider hook into the scene than this is worth.
 * Exactly two planes in the scene have both edges past `legacyFloorSpan`, which is what the
 * count check below is for.
 *
 * **Called by the scene, after `buildTable`** — both planes are built inside that call, so
 * running this from `buildArenaEnvironment` (which runs first) would find nothing. The
 * warning below is the guard against that regression.
 */
export function hideLegacyRoom(scene: THREE.Scene, cfg: ArenaConfig = ARENA_CONFIG): void {
  if (!cfg.hideLegacyRoom) return
  let hidden = 0
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh || !mesh.visible) return
    if (!(mesh.geometry instanceof THREE.PlaneGeometry)) return
    const w = mesh.geometry.parameters.width
    const h = mesh.geometry.parameters.height
    if (Math.min(w, h) < cfg.legacyFloorSpan) return
    mesh.visible = false
    hidden++
  })
  if (hidden !== 2) {
    console.warn(`[arena] expected to step over 2 legacy room planes, hid ${hidden}`)
  }
}

/* ------------------------------------------------------------------ *
 * The hook.
 * ------------------------------------------------------------------ */

/**
 * The renderer numbers and the room fills in `ARENA_CONFIG.render`.
 *
 * The exposure is the scene's own, seeded unchanged. The shadow map size is the one that
 * needs care: `buildLighting` has already asked the lamp for a map, and a WebGL render
 * target's size is fixed when it is created, so a map that already exists is dropped and
 * the bake at the end of the scene's constructor renders the new one. Called between those
 * two points and nothing needs to know.
 *
 * The two whole-room fills are here rather than in `buildLighting` because they are venue
 * tuning, not table tuning: the lamp over the bed is what the picture is about, and the
 * numbers that decide how much of the hall you can see belong with the rest of the arena's.
 * `buildLighting` has already run by the time this is called, so both lights exist.
 */
function applyRenderSettings(scene: THREE.Scene, renderer: THREE.WebGLRenderer | null, cfg: ArenaConfig): void {
  scene.traverse((obj) => {
    const light = obj as THREE.AmbientLight
    if (light.isAmbientLight) {
      light.color.set(cfg.render.ambientColor)
      light.intensity = cfg.render.ambientIntensity
      return
    }
    const hemi = obj as THREE.HemisphereLight
    if (hemi.isHemisphereLight) {
      hemi.color.set(cfg.render.hemiSky)
      hemi.intensity = cfg.render.hemiIntensity
      return
    }
    const spot = obj as THREE.SpotLight
    if (!renderer || !spot.isSpotLight || !spot.castShadow) return
    spot.shadow.mapSize.set(cfg.render.shadowSize, cfg.render.shadowSize)
    spot.shadow.map?.dispose()
    spot.shadow.map = null
  })
  if (renderer) renderer.toneMappingExposure = cfg.render.exposure
}

/** What {@link buildArenaEnvironment} hands back: the group, and where its seats are. */
export interface ArenaEnvironment {
  group: THREE.Group
  /** Every seat in the bowl, in build order. The crowd stands on these. */
  seats: ArenaSeatPlacement[]
  /** The rows those seats were laid out along, lowest deck first. */
  rows: ArenaSeatRow[]
}

/**
 * Builds the arena into a scene and gives it back, so the caller can dispose of it.
 *
 * One call, immediately before the scene's own build: the scene freezes every matrix at
 * the end of its build, and geometry added before that freeze is baked in along with
 * everything else, which is what keeps the arena off the per-frame matrix path.
 *
 * Nothing here casts a shadow. The scene's lamp owns the only shadow map in the venue and
 * it is already baked once over the static set.
 *
 * The seat plan comes back with the group because the crowd has to stand in the seats and
 * the seat positions only exist inside this function — recomputing them outside would be a
 * second version of the same numbers, and the two would drift the first time one was
 * edited.
 */
export function buildArenaEnvironment(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer | null = null,
  config: ArenaConfig = ARENA_CONFIG
): ArenaEnvironment {
  const arena = new THREE.Group()
  arena.name = 'arena'
  const budget = resolveArenaBudget(config.quality)
  const rows = seatRows(config, budget)

  applyRenderSettings(scene, renderer, config)

  const materials = buildMaterials(config, budget, renderer ? renderer.capabilities.getMaxAnisotropy() : 8)
  arena.add(buildFloor(config, budget, materials))
  arena.add(mergeStaticMeshes(buildStands(config, budget, materials, rows), 'stands'))
  arena.add(mergeStaticMeshes(buildHoardings(config, budget, materials), 'hoardings'))
  if (config.buildShell) arena.add(buildShell(config, budget, materials, rows))
  arena.add(buildSeats(config, budget, materials, rows))
  arena.add(buildStairway(rows, config))
  if (!config.buildShell) arena.add(buildBackdrop(rows, budget))
  if (config.buildRig) arena.add(buildRig(config, budget, materials))
  if (config.buildCameraStands) arena.add(buildCameraStands(config, materials, rows))
  arena.add(buildStandLights(config))

  scene.add(arena)
  return { group: arena, seats: arenaSeatPlacements(config, budget, rows), rows }
}