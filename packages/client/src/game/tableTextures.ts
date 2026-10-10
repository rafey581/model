import * as THREE from 'three'
import { BAULK_LINE_X, D_RADIUS, TABLE_LENGTH, TABLE_WIDTH } from '@snooker/shared'
import { qualityConfig } from './qualityConfig.js'

/**
 * Every procedural texture the snooker table wears, in one place.
 *
 * Moved out of scene3d.ts so the material spec reads as materials and the pixels
 * live together. Nothing here queries the renderer per call: anisotropy is pushed
 * in once by `setTableAnisotropy()` when the renderer exists, and every generator
 * is cached by key. `disposeTableTextures()` releases the lot, and Scene3D calls
 * it from its own dispose so a match's upgraded textures do not outlive the match.
 *
 * Colour management rule for the whole file: albedo maps are tagged
 * sRGBColorSpace, every data map (roughness, normal) is left linear.
 */

const tableCache = new Map<string, THREE.CanvasTexture>()

let tableAniso = 4

/** Push the renderer's anisotropy cap in. Called once, from the Scene3D constructor. */
export function setTableAnisotropy(value: number): void {
  tableAniso = value
}

function canvasTexture(
  key: string,
  make: () => { canvas: HTMLCanvasElement; colorSpace?: string; repeat?: number }
): THREE.CanvasTexture {
  let tex = tableCache.get(key)
  if (!tex) {
    const { canvas, colorSpace, repeat } = make()
    tex = new THREE.CanvasTexture(canvas)
    if (colorSpace === 'srgb') tex.colorSpace = THREE.SRGBColorSpace
    tex.generateMipmaps = true
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
    if (repeat && repeat !== 1) tex.repeat.set(repeat, repeat)
    tex.anisotropy = tableAniso
    tableCache.set(key, tex)
  }
  return tex
}

/** Drop every cached table texture. Scene3D.dispose() calls this. */
export function disposeTableTextures(): void {
  for (const tex of tableCache.values()) tex.dispose()
  tableCache.clear()
  woodPair = null
}

function newScratchCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  return { canvas, ctx: canvas.getContext('2d')! }
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/*
 * Deterministic value noise on a wrapping lattice, so every field tiles.
 *
 * Hand-rolled rather than pulled from a library: the table needs exactly two kinds
 * of grain — warped growth rings and stretched pores — and both want this same
 * field at different frequencies and aspect ratios. Hash-based, so the figure is
 * identical on every load and the palette can be retuned without the wood moving
 * underneath it.
 */
function woodHash(x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h ^= h >>> 12
  h = Math.imul(h, 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

function tileNoise(u: number, v: number, period: number): number {
  const x = u * period
  const y = v * period
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  // Smoothstep the interpolants: bilinear noise has a visible grid, and this is the
  // cheapest way to remove it without a second smoothing pass.
  const sx = xf * xf * (3 - 2 * xf)
  const sy = yf * yf * (3 - 2 * yf)
  const x0 = ((xi % period) + period) % period
  const y0 = ((yi % period) + period) % period
  const x1 = (x0 + 1) % period
  const y1 = (y0 + 1) % period
  const n00 = woodHash(x0, y0)
  const n10 = woodHash(x1, y0)
  const n01 = woodHash(x0, y1)
  const n11 = woodHash(x1, y1)
  const a = n00 + (n10 - n00) * sx
  const b = n01 + (n11 - n01) * sx
  return a + (b - a) * sy
}

function tileFbm(u: number, v: number, period: number, octaves: number): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let p = period
  for (let o = 0; o < octaves; o++) {
    sum += tileNoise(u, v, p) * amp
    norm += amp
    amp *= 0.5
    p *= 2
  }
  return sum / norm
}

/* ------------------------------------------------------------------ wood ---- */

/**
 * The rail wood: very dark rosewood/mahogany with long, slightly wavy grain.
 *
 * Snooker Stars rails are almost black until the lamp finds them, so the base
 * gradient runs #2a0f08 -> #4a1d12 with rare lighter streaks; the grain is 70-odd
 * lines along the texture U axis, waved by low-frequency tile noise so the field
 * repeats seamlessly in both directions. A separate roughness map carries the
 * lacquer-vs-grain difference that stops a flat-colour rail reading as plastic.
 */
// Lifted from the near-black rosewood (#2a0f08 -> #4a1d12) to a warm mid mahogany: under
// the wider, more even lamp the old tones read as a black frame round the cloth, where a
// broadcast table shows the timber's colour.
const WOOD_DARK: [number, number, number] = [0x4a, 0x21, 0x10]
const WOOD_MID: [number, number, number] = [0x7c, 0x3f, 0x1f]
const WOOD_LIGHT: [number, number, number] = [0x9a, 0x58, 0x2e]
/** Growth rings across one tile of the board. Whole, so the tile repeats without a seam. */
const WOOD_RINGS = 24

function woodSize(): number {
  return qualityConfig().name === 'low' ? 512 : 1024
}

interface WoodPair {
  size: number
  color: HTMLCanvasElement
  rough: HTMLCanvasElement
  normal: HTMLCanvasElement | null
}
let woodPair: WoodPair | null = null

function woodGrain(): WoodPair {
  const size = woodSize()
  if (woodPair && woodPair.size === size) return woodPair
  // The roughness map is generated at every tier: the code-built fallback table always
  // consumes it, and a missing canvas would crash that path on the low tier. The normal
  // map stays high-tier only, since only the model's wood material requests it.
  const wantNormal = qualityConfig().name !== 'low'

  const color = newScratchCanvas(size)
  const rough = newScratchCanvas(size)
  const cimg = color.ctx.createImageData(size, size)
  const cd = cimg.data
  const rimg = rough.ctx.createImageData(size, size)
  const rd = rimg.data
  const height = wantNormal ? new Float32Array(size * size) : null

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      // Flat-sawn timber, built up the way the board is: growth rings cut at a shallow
      // angle, which show as long wandering bands that swell into cathedral arches; a
      // sharp dark line where each year's latewood ends; fine fibres running the length
      // of the board; and open pores scattered along them. The old texture was 72 evenly
      // spaced ruled lines, which is a pinstripe, not a plank.
      const tone = tileFbm(u, v, 3, 3)
      // The rings wander a long way across the board (the 2.6) and slowly along it (the
      // low frequency), which is what turns parallel lines into figure.
      const wander = (tileFbm(u, v, 2, 3) - 0.5) * 3.4 + (tileFbm(u, v * 2, 4, 2) - 0.5) * 0.5
      const ringCoord = v * WOOD_RINGS + wander
      const ring = ringCoord - Math.floor(ringCoord)
      // Earlywood pales out across the ring, then the latewood line closes it, dark and
      // narrow, with a soft shoulder on one side only.
      const latewood = Math.pow(ring, 3.2)
      const early = 1 - ring
      // Fibres: fine streaks stretched hard along the board.
      const fibre = tileFbm(u, v * 40, 4, 3) - 0.5
      // Pores: short dark dashes, denser inside the latewood.
      const poreField = tileFbm(u * 6, v * 60, 5, 2)
      const pore = poreField > 0.68 - latewood * 0.12 ? Math.min(1, (poreField - (0.68 - latewood * 0.12)) * 6) : 0
      // The long pale flashes of ribbon figure where the grain turns to the light.
      const flash = tileFbm(u, v * 4, 2, 3)
      const streak = flash > 0.62 ? (flash - 0.62) * 2 : 0
      const line = clamp01(latewood + pore * 0.55)

      const body = clamp01(0.32 + early * 0.42 + (tone - 0.5) * 0.5 + fibre * 0.5)
      let r = lerp(WOOD_DARK[0], WOOD_MID[0], body)
      let g = lerp(WOOD_DARK[1], WOOD_MID[1], body)
      let b = lerp(WOOD_DARK[2], WOOD_MID[2], body)
      r = lerp(r, WOOD_LIGHT[0], streak * 0.55)
      g = lerp(g, WOOD_LIGHT[1], streak * 0.55)
      b = lerp(b, WOOD_LIGHT[2], streak * 0.55)
      r = lerp(r, WOOD_DARK[0] * 0.7, line * 0.55)
      g = lerp(g, WOOD_DARK[1] * 0.7, line * 0.55)
      b = lerp(b, WOOD_DARK[2] * 0.7, line * 0.55)
      const figure = fibre

      const i = (y * size + x) * 4
      cd[i] = clamp01(r / 255) * 255
      cd[i + 1] = clamp01(g / 255) * 255
      cd[i + 2] = clamp01(b / 255) * 255
      cd[i + 3] = 255

      // Relief for the normal map: the latewood line and the pores are cut into the
      // surface, the fibres ripple it, and the lacquer over the top keeps it shallow.
      if (height) height[y * size + x] = -line * 0.45 + fibre * 0.5 + tone * 0.1

      // Lacquered earlywood sits near 0.85; the latewood line reads a touch rougher.
      // The material's own roughness scalar (0.42) multiplies this.
      const rv = clamp01(0.82 + line * 0.16 + figure * 0.04) * 255
      rd[i] = rv
      rd[i + 1] = rv
      rd[i + 2] = rv
      rd[i + 3] = 255
    }
  }
  color.ctx.putImageData(cimg, 0, 0)
  rough.ctx.putImageData(rimg, 0, 0)

  let normalCanvas: HTMLCanvasElement | null = null
  if (height) {
    const normal = newScratchCanvas(size)
    const nimg = normal.ctx.createImageData(size, size)
    const nd = nimg.data
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const l = height[y * size + (((x - 1) + size) % size)]!
        const r = height[y * size + ((x + 1) % size)]!
        const d = height[(((y - 1) + size) % size) * size + x]!
        const uu = height[((y + 1) % size) * size + x]!
        const nx = (l - r) * 1.0
        const ny = (d - uu) * 1.0
        const nz = 1
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
        const i = (y * size + x) * 4
        nd[i] = ((nx / len) * 0.5 + 0.5) * 255
        nd[i + 1] = ((ny / len) * 0.5 + 0.5) * 255
        nd[i + 2] = ((nz / len) * 0.5 + 0.5) * 255
        nd[i + 3] = 255
      }
    }
    normal.ctx.putImageData(nimg, 0, 0)
    normalCanvas = normal.canvas
  }

  woodPair = { size, color: color.canvas, rough: rough.canvas, normal: normalCanvas }
  return woodPair
}

export function woodTexture(): THREE.CanvasTexture {
  return canvasTexture(`wood-${woodSize()}`, () => ({ canvas: woodGrain().color, colorSpace: 'srgb' }))
}

export function woodRoughnessTexture(): THREE.CanvasTexture {
  const pair = woodGrain()
  return canvasTexture(`wood-rough-${pair.size}`, () => ({ canvas: pair.rough }))
}

export function woodNormalTexture(): THREE.CanvasTexture {
  return canvasTexture(`wood-normal-${woodSize()}`, () => ({ canvas: woodGrain().normal! }))
}

/* ------------------------------------------------------------------ felt ---- */

// A bright match-table green, and only a gentle falloff to the edge. The old ramp ran
// from #147a3c down to #083d1e at the cushions — half the centre's brightness, painted
// into the cloth itself — which is what made the ends of the table look unlit whatever
// the lamp was doing.
export const CLOTH_COLOR_CENTER = '#22a82e'
export const CLOTH_COLOR_MID = '#1a8f25'
export const CLOTH_COLOR_EDGE = '#116a19'
/** How far out from each cushion its shade reaches across the bed, and how dark it starts. */
const CUSHION_SHADE_MM = 95
const CUSHION_SHADE_STRENGTH = 0.42
const CLOTH_MIPMAPS = true

/**
 * The bed: one tile across the whole playing surface.
 *
 * This texture carries only what is large and soft: the lamp's pool of light, brighter
 * over the middle of the table and falling away to the cushions, and the cushions' own
 * shade. It is the table's lighting, painted once instead of worked out for every pixel
 * of every frame. Nothing fine is in it, because at seven millimetres of cloth to the
 * pixel anything fine is a blur from the playing view: the fibre of the cloth is a small
 * repeating texture laid over this one (`clothDetailTexture`), and the baulk line, the D
 * and the spots are geometry (`tableMarkings.ts`).
 */
export function feltTexture(): THREE.CanvasTexture {
  let tex = tableCache.get('felt')
  if (tex) return tex
  const size = 512
  const { canvas, ctx } = newScratchCanvas(size)
  const g = ctx.createRadialGradient(size * 0.5, size * 0.5, size * 0.06, size * 0.5, size * 0.5, size * 0.78)
  g.addColorStop(0, CLOTH_COLOR_CENTER)
  g.addColorStop(0.45, CLOTH_COLOR_MID)
  g.addColorStop(0.75, '#167f20')
  g.addColorStop(1, CLOTH_COLOR_EDGE)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)

  // The lamp hangs over the middle, so the two ends of a twelve-foot table are further
  // from it and catch its light at a slant. That falloff is painted here, because below
  // the high quality level the bed is drawn unlit and this texture is all the light it has.
  const ends = ctx.createLinearGradient(0, 0, size, 0)
  ends.addColorStop(0, 'rgba(0,0,0,0.2)')
  ends.addColorStop(0.3, 'rgba(0,0,0,0)')
  ends.addColorStop(0.7, 'rgba(0,0,0,0)')
  ends.addColorStop(1, 'rgba(0,0,0,0.2)')
  ctx.fillStyle = ends
  ctx.fillRect(0, 0, size, size)

  // The cushions' own shade on the bed. A cushion overhangs the cloth, so the strip of
  // baize under its nose is always darker than the open table; the bed itself takes no
  // real-time shadow, so that strip is painted here. It is what makes the cushion read
  // as standing over the cloth instead of being a green stripe printed at its edge.
  const shade = (x0: number, y0: number, x1: number, y1: number, w: number, h: number, x: number, y: number): void => {
    const edge = ctx.createLinearGradient(x0, y0, x1, y1)
    edge.addColorStop(0, `rgba(0,0,0,${CUSHION_SHADE_STRENGTH})`)
    edge.addColorStop(0.35, `rgba(0,0,0,${CUSHION_SHADE_STRENGTH * 0.45})`)
    edge.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = edge
    ctx.fillRect(x, y, w, h)
  }
  const alongLength = (CUSHION_SHADE_MM / TABLE_LENGTH) * size
  const alongWidth = (CUSHION_SHADE_MM / TABLE_WIDTH) * size
  shade(0, 0, alongLength, 0, alongLength, size, 0, 0)
  shade(size, 0, size - alongLength, 0, alongLength, size, size - alongLength, 0)
  shade(0, 0, 0, alongWidth, size, alongWidth, 0, 0)
  shade(0, size, 0, size - alongWidth, size, alongWidth, 0, size - alongWidth)

  tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.generateMipmaps = CLOTH_MIPMAPS
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  // Clamp, not repeat: the model's Cloth runs a few mm past the playing area, and a
  // repeat there would tile the baulk line into the pocket mouth.
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.anisotropy = tableAniso
  tableCache.set('felt', tex)
  return tex
}

/** How many times the fibre tile repeats along the table and across it: one tile is about 130mm of cloth. */
export const CLOTH_DETAIL_REPEAT_U = 27
export const CLOTH_DETAIL_REPEAT_V = 14

/**
 * The fibre of the cloth: a small grey tile, repeated, that the bed's colour is multiplied by.
 *
 * Mid grey leaves the colour alone; lighter and darker specks and short strokes are the
 * nap. Because it repeats every 130mm, a pixel of it is half a millimetre of cloth, so the
 * bed has real texture under the cue ball where the stretched base texture has none. Far
 * down the table it mips to plain grey and disappears, so it cannot shimmer.
 */
export function clothDetailTexture(): THREE.CanvasTexture {
  const tex = canvasTexture('felt-detail', () => {
    const size = 256
    const { canvas, ctx } = newScratchCanvas(size)
    ctx.fillStyle = 'rgb(128,128,128)'
    ctx.fillRect(0, 0, size, size)
    let seed = 20260930
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    // Every mark is drawn nine times, once in each neighbouring tile, so it wraps.
    const wrapped = (draw: (dx: number, dy: number) => void): void => {
      for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) draw(dx, dy)
    }
    // Soft mottling first: wool is not one even shade.
    for (let i = 0; i < 90; i++) {
      const x = rand() * size
      const y = rand() * size
      const r = 10 + rand() * 22
      const light = rand() > 0.5
      wrapped((dx, dy) => {
        const blot = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r)
        blot.addColorStop(0, light ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)')
        blot.addColorStop(1, light ? 'rgba(255,255,255,0)' : 'rgba(0,0,0,0)')
        ctx.fillStyle = blot
        ctx.fillRect(x + dx - r, y + dy - r, r * 2, r * 2)
      })
    }
    // The nap: short fibres, mostly lying one way, as a brushed cloth's do.
    ctx.lineWidth = 1
    for (let i = 0; i < 5200; i++) {
      const x = rand() * size
      const y = rand() * size
      const angle = -Math.PI / 5 + (rand() - 0.5) * 1.1
      const length = 1.5 + rand() * 4
      const alpha = 0.05 + rand() * 0.09
      ctx.strokeStyle = rand() > 0.5 ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha})`
      const ex = Math.cos(angle) * length
      const ey = Math.sin(angle) * length
      wrapped((dx, dy) => {
        ctx.beginPath()
        ctx.moveTo(x + dx, y + dy)
        ctx.lineTo(x + dx + ex, y + dy + ey)
        ctx.stroke()
      })
    }
    return { canvas }
  })
  return tex
}

/**
 * A woven-cloth normal map, so the bed is lit as fabric rather than matte paint.
 *
 * Encoded from a height field by central difference rather than authored as RGB, so
 * the weave stays coherent under mipmapping. Low-contrast on purpose: visible
 * threads at the overhead distance would alias into a shimmer across the bed.
 */
export function feltNormalTexture(): THREE.CanvasTexture {
  return canvasTexture('felt-normal', () => {
    const size = 256
    const { canvas, ctx } = newScratchCanvas(size)
    const img = ctx.createImageData(size, size)
    const d = img.data
    const height = (x: number, y: number): number => {
      const cx = Math.floor(x / 8)
      const cy = Math.floor(y / 8)
      const over = (cx + cy) % 2 === 0
      const u = ((x % 8) + 8) % 8
      const v = ((y % 8) + 8) % 8
      const warpRidge = Math.sin((u / 8) * Math.PI) * (over ? 1 : 0.55)
      const weftRidge = Math.sin((v / 8) * Math.PI) * (over ? 0.55 : 1)
      return Math.max(warpRidge, weftRidge)
    }
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const hl = height((x - 1 + size) % size, y)
        const hr = height((x + 1) % size, y)
        const hd = height(x, (y - 1 + size) % size)
        const hu = height(x, (y + 1) % size)
        const nx = (hl - hr) * 0.9
        const ny = (hd - hu) * 0.9
        const nz = 1
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
        const i = (y * size + x) * 4
        d[i] = ((nx / len) * 0.5 + 0.5) * 255
        d[i + 1] = ((ny / len) * 0.5 + 0.5) * 255
        d[i + 2] = ((nz / len) * 0.5 + 0.5) * 255
        d[i + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
    return { canvas }
  })
}

/**
 * The cushions' cloth: the bed's nap recipe without the markings, drawn near-white
 * so the material's own tint (`CLOTH_COLOR_MID`) is what sets the green. Keeping it
 * neutral is what guarantees the cushion and the bed share one hue exactly.
 */
export function cushionFeltTexture(): THREE.CanvasTexture {
  const sizeByName: Record<string, number> = { low: 256, medium: 512, high: 1024 }
  const size = sizeByName[qualityConfig().name] ?? 512
  return canvasTexture(`cushion-felt-${size}`, () => {
    const { canvas, ctx } = newScratchCanvas(size)
    ctx.fillStyle = '#f4f4f4'
    ctx.fillRect(0, 0, size, size)
    let seed = 0x51f3a2
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const count = Math.round(size * size * 0.004)
    for (let i = 0; i < count; i++) {
      const x = rand() * size
      const y = rand() * size
      const tone = rand() > 0.5 ? 255 : 0
      const a = 0.05 + rand() * 0.05
      ctx.fillStyle = tone ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`
      for (const dx of [-size, 0, size]) {
        for (const dy of [-size, 0, size]) ctx.fillRect(x + dx, y + dy, 1.2, 1.2)
      }
    }
    // Faint crossed nap, same spacing as the bed so the scale matches.
    ctx.strokeStyle = 'rgba(0,0,0,0.03)'
    ctx.lineWidth = 1
    for (let y = 0; y < size; y += 5) {
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(size, y + 4)
      ctx.stroke()
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.03)'
    for (let y = 0; y < size; y += 8) {
      ctx.beginPath()
      ctx.moveTo(0, y + 2)
      ctx.lineTo(size, y + 6)
      ctx.stroke()
    }
    return { canvas, colorSpace: 'srgb', repeat: 8 }
  })
}

/* ---------------------------------------------------------------- brass ---- */

/**
 * Brass roughness: a fine brushed swirl so the trim is not one uniform mirror.
 * Linear data map. Reused from the code-built table.
 */
export function brassRoughnessTexture(): THREE.CanvasTexture {
  return canvasTexture('brass-rough', () => {
    const size = 256
    const { canvas, ctx } = newScratchCanvas(size)
    const img = ctx.createImageData(size, size)
    const d = img.data
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size
        const v = y / size
        const a = tileFbm(u, v, 4, 2) * Math.PI * 2
        const swirl = tileFbm(u + Math.cos(a) * 0.12, v + Math.sin(a) * 0.12, 6, 3)
        const fine = tileFbm(u * 0.2, v * 3, 48, 1)
        const rv = clamp01(0.17 + (swirl - 0.5) * 0.3 + (fine - 0.5) * 0.12) * 255
        const i = (y * size + x) * 4
        d[i] = rv
        d[i + 1] = rv
        d[i + 2] = rv
        d[i + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
    return { canvas, repeat: 2 }
  })
}

/* --------------------------------------------------------------- leather ---- */

/** The cream leather of the pocket covers. Warm off-white, satin, never plastic. */
export function leatherAlbedoTexture(): THREE.CanvasTexture {
  return canvasTexture('leather-albedo', () => {
    const size = 256
    const { canvas, ctx } = newScratchCanvas(size)
    const img = ctx.createImageData(size, size)
    const d = img.data
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size
        const v = y / size
        const mottle = (tileFbm(u, v, 4, 3) - 0.5) * 0.08
        const i = (y * size + x) * 4
        d[i] = clamp01(0.902 + mottle) * 255
        d[i + 1] = clamp01(0.839 + mottle) * 255
        d[i + 2] = clamp01(0.706 + mottle) * 255
        d[i + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
    return { canvas, colorSpace: 'srgb', repeat: 4 }
  })
}

/** A worley F1/F2 distance pair on a wrapping lattice, for the leather grain. */
function worley(pu: number, pv: number, cells: number, seed: number): { f1: number; f2: number } {
  const xi = Math.floor(pu)
  const yi = Math.floor(pv)
  let f1 = 1e9
  let f2 = 1e9
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx
      const cy = yi + dy
      const wx = ((cx % cells) + cells) % cells
      const wy = ((cy % cells) + cells) % cells
      const ox = woodHash(wx * 2 + seed, wy * 3 + 11)
      const oy = woodHash(wx * 3 + 7, wy * 2 + seed)
      const px = cx + ox
      const py = cy + oy
      const d = Math.hypot(pu - px, pv - py)
      if (d < f1) {
        f2 = f1
        f1 = d
      } else if (d < f2) {
        f2 = d
      }
    }
  }
  return { f1, f2 }
}

export function leatherNormalTexture(): THREE.CanvasTexture {
  const sizeByName: Record<string, number> = { low: 0, medium: 256, high: 512 }
  const size = sizeByName[qualityConfig().name] ?? 256
  return canvasTexture('leather-normal', () => {
    if (!size) return { canvas: newScratchCanvas(4).canvas }
    const { canvas, ctx } = newScratchCanvas(size)
    const cells = Math.max(24, Math.round(size * 0.35))
    const height = new Float32Array(size * size)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const { f1 } = worley((x / size) * cells, (y / size) * cells, cells, 3)
        // Rounded cells: high at the centre, dipping into the creases between.
        height[y * size + x] = clamp01(1 - f1) + (woodHash(x, y) - 0.5) * 0.05
      }
    }
    const img = ctx.createImageData(size, size)
    const d = img.data
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const l = height[y * size + (((x - 1) + size) % size)]!
        const r = height[y * size + ((x + 1) % size)]!
        const dd = height[(((y - 1) + size) % size) * size + x]!
        const uu = height[((y + 1) % size) * size + x]!
        const nx = (l - r) * 1.4
        const ny = (dd - uu) * 1.4
        const nz = 1
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
        const i = (y * size + x) * 4
        d[i] = ((nx / len) * 0.5 + 0.5) * 255
        d[i + 1] = ((ny / len) * 0.5 + 0.5) * 255
        d[i + 2] = ((nz / len) * 0.5 + 0.5) * 255
        d[i + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
    return { canvas }
  })
}

export function leatherRoughnessTexture(): THREE.CanvasTexture {
  const sizeByName: Record<string, number> = { low: 0, medium: 256, high: 256 }
  const size = sizeByName[qualityConfig().name] ?? 256
  return canvasTexture('leather-rough', () => {
    if (!size) return { canvas: newScratchCanvas(4).canvas }
    const { canvas, ctx } = newScratchCanvas(size)
    const cells = Math.max(20, Math.round(size * 0.3))
    const img = ctx.createImageData(size, size)
    const d = img.data
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const { f1, f2 } = worley((x / size) * cells, (y / size) * cells, cells, 5)
        // Pits (small F1) read a little rougher than the flat hide.
        const pit = clamp01(1 - f1 * 3)
        const edge = clamp01((f2 - f1) * 2)
        const rv = clamp01(0.5 + pit * 0.15 - edge * 0.04) * 255
        const i = (y * size + x) * 4
        d[i] = rv
        d[i + 1] = rv
        d[i + 2] = rv
        d[i + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
    return { canvas, repeat: 6 }
  })
}

/* --------------------------------------------------------------- pocket ---- */

/**
 * The inner shading of a pocket: darkness at the bottom fading up the walls.
 * Painted onto the liner, it turns a hole into a depth rather than a decal.
 */
export function pocketDepthTexture(): THREE.CanvasTexture {
  return canvasTexture('pocket-depth', () => {
    const size = 128
    const { canvas, ctx } = newScratchCanvas(size)
    const grad = ctx.createRadialGradient(size / 2, size / 2, 4, size / 2, size / 2, size / 2)
    grad.addColorStop(0, 'rgba(0,0,0,1)')
    grad.addColorStop(0.55, 'rgba(0,0,0,0.85)')
    grad.addColorStop(1, 'rgba(30,18,10,0.25)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
    return { canvas }
  })
}
