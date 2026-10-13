import * as THREE from 'three'
import { qualityConfig } from './qualityConfig.js'

/**
 * The cue ball's colour: a warm cream phenolic resin, not rental-table white.
 * Kept under pure white so the lamp's warm light is what lifts it, the way a
 * real cue ball reads under tournament lighting.
 */
export const CUE_BALL_COLOR = 0xf4f0e4
/** Base lacquer roughness under the clearcoat: glossy resin, not rubber. */
export const CUE_BALL_ROUGHNESS = 0.36
/** Phenolic resin is a dielectric: no metalness anywhere on this ball. */
export const CUE_BALL_METALNESS = 0
/** Clearcoat film that carries the crisp lamp highlight. */
export const CUE_BALL_CLEARCOAT = 0.95
/** Clearcoat roughness: crisp ellipse, not a pinpoint or a plastic smear. */
export const CUE_BALL_CLEARCOAT_ROUGHNESS = 0.045
/** Dielectric specular at a strong but controlled level. */
export const CUE_BALL_SPECULAR_INTENSITY = 1
/**
 * How strongly the scene environment reflects in the cue ball. Kept below the
 * coloured balls so the brightest object on the cloth does not blow out.
 */
export const CUE_BALL_ENV_MAP_INTENSITY = 0.65

/** Fresnel index for phenolic resin. */
export const CUE_BALL_IOR = 1.5

/** Shared phenolic look for every coloured object ball. */
export const COLOURED_BALL_ROUGHNESS = 0.36
export const COLOURED_BALL_CLEARCOAT = 1
export const COLOURED_BALL_CLEARCOAT_ROUGHNESS = 0.045
export const COLOURED_BALL_ENV_MAP_INTENSITY = 1
export const COLOURED_BALL_SPECULAR_INTENSITY = 1
export const COLOURED_BALL_IOR = 1.5

/**
 * Tier-scaled gloss: low softens clearcoat/env so integrated GPUs keep budget;
 * medium/high keep the full phenolic look.
 */
export function ballGlossScale(): { clearcoat: number; env: number } {
  const tier = qualityConfig().name
  // The film is held under full strength on every tier. At full strength it takes over
  // completely at the edge of the ball, where the surface is seen at a glance, and what it
  // shows there is the dark of the room: a hard dark line round every ball.
  if (tier === 'low') return { clearcoat: 0.45, env: 0.45 }
  if (tier === 'medium') return { clearcoat: 0.7, env: 0.85 }
  return { clearcoat: 0.75, env: 1 }
}

/**
 * Cream cue-ball albedo with red spin-reference dots. DataTexture (no DOM), zero download.
 * Sphere UVs: dots land on different hemispheres so roll always shows a mark.
 */
export function cueBallAlbedoPixels(size = 256): Uint8Array {
  const data = new Uint8Array(size * size * 4)
  // Warm cream resin base (#f4f0e4).
  for (let i = 0; i < size * size; i++) {
    const o = i * 4
    data[o] = 0xf4
    data[o + 1] = 0xf0
    data[o + 2] = 0xe4
    data[o + 3] = 255
  }
  const dots: Array<{ u: number; v: number; r: number }> = [
    { u: 0.28, v: 0.38, r: 0.045 },
    { u: 0.72, v: 0.55, r: 0.04 },
    { u: 0.48, v: 0.78, r: 0.035 }
  ]
  for (const d of dots) {
    const cx = d.u * size
    const cy = d.v * size
    const rad = d.r * size
    const r0 = Math.max(1, Math.ceil(rad))
    const x0 = Math.max(0, Math.floor(cx - r0))
    const x1 = Math.min(size - 1, Math.ceil(cx + r0))
    const y0 = Math.max(0, Math.floor(cy - r0))
    const y1 = Math.min(size - 1, Math.ceil(cy + r0))
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / rad
        if (dist >= 1) continue
        const a = (1 - dist) * (1 - dist) * 0.95
        const o = (y * size + x) * 4
        data[o] = Math.round(data[o]! * (1 - a) + 190 * a)
        data[o + 1] = Math.round(data[o + 1]! * (1 - a) + 28 * a)
        data[o + 2] = Math.round(data[o + 2]! * (1 - a) + 28 * a)
      }
    }
  }
  return data
}

export function cueBallAlbedoTexture(): THREE.DataTexture {
  const size = 256
  const texture = new THREE.DataTexture(cueBallAlbedoPixels(size), size, size)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.generateMipmaps = true
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.anisotropy = qualityConfig().anisotropy
  texture.needsUpdate = true
  return texture
}

/**
 * The cue ball's own material, as a fresh instance.
 *
 * One per cue ball, never shared: the rig owns it so the "ball on" highlight can
 * drive its emissive without ever touching another ball's surface.
 */
export function createCueBallMaterial(): THREE.MeshPhysicalMaterial {
  const gloss = ballGlossScale()
  return new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: cueBallAlbedoTexture(),
    roughness: CUE_BALL_ROUGHNESS,
    metalness: CUE_BALL_METALNESS,
    clearcoat: CUE_BALL_CLEARCOAT * gloss.clearcoat,
    clearcoatRoughness: CUE_BALL_CLEARCOAT_ROUGHNESS,
    specularIntensity: CUE_BALL_SPECULAR_INTENSITY,
    envMapIntensity: CUE_BALL_ENV_MAP_INTENSITY * gloss.env,
    ior: CUE_BALL_IOR,
    emissive: 0x000000
  })
}

/**
 * Shared phenolic material for a coloured object ball. Fresh instance per rig.
 */
export function createColouredBallMaterial(color: number): THREE.MeshPhysicalMaterial {
  const gloss = ballGlossScale()
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness: COLOURED_BALL_ROUGHNESS,
    metalness: 0,
    clearcoat: COLOURED_BALL_CLEARCOAT * gloss.clearcoat,
    clearcoatRoughness: COLOURED_BALL_CLEARCOAT_ROUGHNESS,
    specularIntensity: COLOURED_BALL_SPECULAR_INTENSITY,
    envMapIntensity: COLOURED_BALL_ENV_MAP_INTENSITY * gloss.env,
    ior: COLOURED_BALL_IOR,
    emissive: 0x000000
  })
}

/**
 * The darkest the cue ball's contact shadow ever gets, right under the ball.
 * Inside the 0.55–0.75 band a real contact shadow reads under a table lamp.
 */
export const CUE_SHADOW_PEAK_ALPHA = 0.74
/**
 * The cue ball's disc size, as a multiple of its radius: 2.8 → 1.4× ball width.
 */
export const CUE_SHADOW_PLANE = 2.8
/** How far the cue ball's disc leans away from the lamp, in millimetres. */
export const CUE_SHADOW_OFFSET_MM = 2
/** How far the disc stretches along that lean: an ellipse, not a circle. */
export const CUE_SHADOW_STRETCH = 1.15
/** How high the cue ball's disc sits above the cloth, in millimetres. */
export const CUE_SHADOW_Y_MM = 0.8
/** The cue shadow texture's edge, in pixels. A soft blob needs no more. */
export const CUE_SHADOW_TEXTURE_SIZE = 128

/**
 * The cue ball's shadow opacity at a given distance from its centre, as a
 * fraction of the disc's radius: 0 at the contact, 1 at the rim.
 */
export function cueShadowAlpha(frac: number): number {
  if (frac <= 0.45) return CUE_SHADOW_PEAK_ALPHA
  if (frac >= 1) return 0
  const t = (frac - 0.45) / 0.55
  return CUE_SHADOW_PEAK_ALPHA * (1 - t * t * (3 - 2 * t))
}

/**
 * The cue ball's shadow texture as raw RGBA bytes: black, with the alpha channel
 * carrying {@link cueShadowAlpha} across the disc.
 */
export function cueShadowPixels(size: number = CUE_SHADOW_TEXTURE_SIZE): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(size * size * 4)
  const half = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - half) / half
      const dy = (y + 0.5 - half) / half
      const i = (y * size + x) * 4
      pixels[i] = 0
      pixels[i + 1] = 0
      pixels[i + 2] = 0
      pixels[i + 3] = Math.round(255 * cueShadowAlpha(Math.hypot(dx, dy)))
    }
  }
  return pixels
}

/* ------------------------------------------------------------------ *
 * Painted light.
 *
 * A ball lit the expensive way works out, for every pixel of it and every frame, how a
 * lacquered sphere answers each lamp in the room and what of the room it mirrors. But a
 * ball is a sphere under a lamp that never moves: what it looks like from the camera
 * depends only on which way each bit of its surface is facing the lens. That can be
 * worked out once, for every direction a surface can face, and kept as a picture of a
 * lit ball — and then drawing a ball is looking its pixels up in that picture.
 *
 * It is the same idea as the cloth's painted light, and it is how a game that has to run
 * on a phone gets balls that look polished. The picture below is computed, not drawn by
 * hand, from the same ingredients the lacquer had: a soft falloff from the lamp, a hard
 * bright dot where the lamp reflects, a second smaller one, and the glancing shine round
 * the rim.
 * ------------------------------------------------------------------ */

/**
 * Whether the balls take their light from the painted picture instead of working it out.
 *
 * Off. It was tried on the table and the balls read as beads: a highlight that sits in the
 * same place on every ball whichever way the camera looks is what a string of pearls looks
 * like, not fifteen balls under one lamp. The lacquer's highlight is where the lamp really
 * is, on each ball separately, and that is what makes them read as lit. The painted path
 * is kept, switched off, for a device that cannot afford the lacquer at all.
 */
export const PAINTED_BALLS = false
/** How much brighter than its texture the painted cue ball is drawn. */
export const CUE_BALL_PAINTED_LIFT = 1.22
/** The picture's edge, in pixels. A highlight a few pixels across needs this many to stay round. */
export const BALL_LIGHT_TEXTURE_SIZE = 512

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * How a lit ball looks where its surface faces a given way, as seen from the lens.
 *
 * `x` and `y` are the surface's facing across and up the picture, from -1 to 1; a point
 * off the ball is treated as its edge. Returns how brightly the ball's own colour shows
 * there, and how much white shine sits on top of it.
 */
export function ballLightAt(x: number, y: number): { shade: number; shine: number; bounce: number } {
  const r = Math.hypot(x, y)
  if (r > 0.999) {
    x = (x / r) * 0.999
    y = (y / r) * 0.999
  }
  const z = Math.sqrt(Math.max(0, 1 - x * x - y * y))
  const dot = (lx: number, ly: number, lz: number): number => {
    const l = Math.hypot(lx, ly, lz)
    return (x * lx + y * ly + z * lz) / l
  }
  // The lamp: above the table, a little towards the lens.
  const lamp = dot(0.12, 0.86, 0.5)
  // Light wraps round a ball further than a bare cosine says, because the cloth and the
  // room throw some of it back; the far side never goes to black.
  const wrap = Math.pow(clamp01(lamp * 0.5 + 0.5), 1.2)
  const rim = 1 - z
  // Darker again low down, where the ball turns under and sits in its own shade on the cloth.
  const under = clamp01((y + 1) / 0.9)
  const shade = (0.22 + 0.78 * wrap) * (1 - 0.32 * rim * rim * rim) * (0.72 + 0.28 * under * under * (3 - 2 * under))
  // What the lacquer mirrors: the lamp as a hard dot, a softer bloom round it, a second
  // small light off to one side, and the glancing shine every polished ball has at its edge.
  const half = (lx: number, ly: number, lz: number): number => {
    const l = Math.hypot(lx, ly, lz)
    return dot(lx / l, ly / l, lz / l + 1)
  }
  const key = clamp01(half(0.12, 0.86, 0.5))
  const side = clamp01(half(-0.62, 0.42, 0.66))
  // A lamp is a bright shape with an edge, not a point: its reflection is a small disc
  // that is fully bright across its middle, with a soft bloom round it.
  const disc = (v: number, from: number, to: number): number => {
    const t = clamp01((v - from) / (to - from))
    return t * t * (3 - 2 * t)
  }
  const shine =
    disc(key, 0.984, 0.9945) * 0.95 +
    Math.pow(key, 15) * 0.26 +
    disc(side, 0.9955, 0.9988) * 0.55 +
    Math.pow(rim, 4.5) * 0.18
  // The cloth throws its own colour back up into the underside of every ball on it. It is
  // the thing that makes a ball sit on the table rather than in front of a picture of one.
  const down = clamp01(-y)
  const bounce = Math.pow(down, 1.4) * (0.35 + 0.65 * rim)
  return { shade: clamp01(shade), shine: clamp01(shine), bounce: clamp01(bounce) }
}

/** The picture as raw bytes: shade in red, shine in green, the cloth's bounce in blue. */
export function ballLightPixels(size: number = BALL_LIGHT_TEXTURE_SIZE): Uint8Array {
  const data = new Uint8Array(size * size * 4)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const light = ballLightAt(((px + 0.5) / size) * 2 - 1, ((py + 0.5) / size) * 2 - 1)
      const o = (py * size + px) * 4
      data[o] = Math.round(light.shade * 255)
      data[o + 1] = Math.round(light.shine * 255)
      data[o + 2] = Math.round(light.bounce * 255)
      data[o + 3] = 255
    }
  }
  return data
}

let ballLight: THREE.DataTexture | null = null
let ballLightPlain: THREE.DataTexture | null = null

function lightTexture(pixels: Uint8Array, size: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(pixels, size, size)
  // Numbers, not colours: read exactly as written.
  texture.colorSpace = THREE.NoColorSpace
  texture.generateMipmaps = true
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return texture
}

/** The painted light, shared by every ball. Built on first use. */
export function ballLightTexture(): THREE.DataTexture {
  if (!ballLight) ballLight = lightTexture(ballLightPixels(), BALL_LIGHT_TEXTURE_SIZE)
  return ballLight
}

/**
 * The same picture with no shine in it, the same in every channel.
 *
 * What a stock material makes of the picture is "multiply the colour of the ball by it",
 * which is right for the shade and wrong for the shine. So the stock material is handed
 * this one, and only a shader that has been taught the difference gets the real one. If
 * that teaching ever fails to take, the ball is drawn softly lit and unshiny, not
 * miscoloured.
 */
function ballLightPlainTexture(): THREE.DataTexture {
  if (!ballLightPlain) {
    const size = 128
    const data = new Uint8Array(size * size * 4)
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const v = Math.round(ballLightAt(((px + 0.5) / size) * 2 - 1, ((py + 0.5) / size) * 2 - 1).shade * 255)
        const o = (py * size + px) * 4
        data[o] = v
        data[o + 1] = v
        data[o + 2] = v
        data[o + 3] = 255
      }
    }
    ballLightPlain = lightTexture(data, size)
  }
  return ballLightPlain
}

/** Drops the painted light, for when the scene that used it is torn down. */
export function disposeBallLight(): void {
  ballLight?.dispose()
  ballLightPlain?.dispose()
  ballLight = null
  ballLightPlain = null
}

const STOCK_BALL_LIGHT = 'vec3 outgoingLight = diffuseColor.rgb * matcapColor.rgb;'

/**
 * A ball whose light is painted.
 *
 * `glow` is what lights a ball that is on. It cannot be called `emissive`: the renderer
 * takes any material with a property of that name to have the stock emissive slot in its
 * shader, which this one does not, and fails the whole frame looking for it. Use
 * {@link setBallGlow}, which knows both kinds of ball.
 */
export class PaintedBallMaterial extends THREE.MeshMatcapMaterial {
  readonly glow = new THREE.Color(0x000000)

  constructor(parameters: THREE.MeshMatcapMaterialParameters = {}) {
    super({ ...parameters, matcap: ballLightPlainTexture() })
    this.onBeforeCompile = (shader) => {
      if (!shader.fragmentShader.includes(STOCK_BALL_LIGHT)) return
      // Set on the material, not on the shader: the renderer copies the material's own
      // picture into the shader every frame, and would put the plain one straight back.
      this.matcap = ballLightTexture()
      shader.uniforms.ballGlow = { value: this.glow }
      shader.fragmentShader = shader.fragmentShader
        .replace('uniform sampler2D matcap;', 'uniform sampler2D matcap;\nuniform vec3 ballGlow;')
        // The colour of the ball under the shade, the shine on top of it in white, and the
        // glow of a ball that is on.
        .replace(
          STOCK_BALL_LIGHT,
          'vec3 outgoingLight = diffuseColor.rgb * matcapColor.r + vec3( matcapColor.g ) + vec3( 0.05, 0.3, 0.07 ) * matcapColor.b + ballGlow;'
        )
    }
    this.customProgramCacheKey = () => 'painted-ball'
  }
}

export type BallMaterial = THREE.MeshPhysicalMaterial | PaintedBallMaterial

/** Lights a ball up, or puts it out with 0: the glow of the ball that is on. */
export function setBallGlow(material: BallMaterial, hex: number): void {
  if (material instanceof PaintedBallMaterial) material.glow.setHex(hex)
  else material.emissive.setHex(hex)
}

/** What a ball is glowing with, as a hex colour. */
export function ballGlow(material: BallMaterial): number {
  return material instanceof PaintedBallMaterial ? material.glow.getHex() : material.emissive.getHex()
}

/** The cue ball with painted light: the same cream and the same red dots, so its roll still reads. */
export function createPaintedCueBallMaterial(): PaintedBallMaterial {
  const material = new PaintedBallMaterial({ color: 0xffffff, map: cueBallAlbedoTexture() })
  // The one white ball on the table: lifted a little, so its shaded side reads as cream
  // in shade and not as a grey ball.
  material.color.setScalar(CUE_BALL_PAINTED_LIFT)
  return material
}

/** A coloured ball with painted light. */
export function createPaintedBallMaterial(color: number): PaintedBallMaterial {
  return new PaintedBallMaterial({ color })
}

/** The material a ball on the table wears: painted light, or the lacquer if that is switched off. */
export function createBallMaterial(color: number, cue: boolean): BallMaterial {
  if (PAINTED_BALLS) return cue ? createPaintedCueBallMaterial() : createPaintedBallMaterial(color)
  return cue ? createCueBallMaterial() : createColouredBallMaterial(color)
}
