import * as THREE from 'three'
import { qualityConfig } from './qualityConfig.js'

/**
 * The cue ball's colour: a warm cream phenolic resin, not rental-table white.
 * Kept under pure white so the lamp's warm light is what lifts it, the way a
 * real cue ball reads under tournament lighting.
 */
export const CUE_BALL_COLOR = 0xf4f0e4
/** Base lacquer roughness under the clearcoat: glossy resin, not rubber. */
export const CUE_BALL_ROUGHNESS = 0.08
/** Phenolic resin is a dielectric: no metalness anywhere on this ball. */
export const CUE_BALL_METALNESS = 0
/** Clearcoat film that carries the crisp lamp highlight. */
export const CUE_BALL_CLEARCOAT = 0.95
/** Clearcoat roughness: crisp ellipse, not a pinpoint or a plastic smear. */
export const CUE_BALL_CLEARCOAT_ROUGHNESS = 0.06
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
export const COLOURED_BALL_ROUGHNESS = 0.05
export const COLOURED_BALL_CLEARCOAT = 1
export const COLOURED_BALL_CLEARCOAT_ROUGHNESS = 0.02
export const COLOURED_BALL_ENV_MAP_INTENSITY = 1
export const COLOURED_BALL_SPECULAR_INTENSITY = 1
export const COLOURED_BALL_IOR = 1.5

/**
 * Tier-scaled gloss: low softens clearcoat/env so integrated GPUs keep budget;
 * medium/high keep the full phenolic look.
 */
export function ballGlossScale(): { clearcoat: number; env: number } {
  const tier = qualityConfig().name
  if (tier === 'low') return { clearcoat: 0.45, env: 0.45 }
  if (tier === 'medium') return { clearcoat: 0.85, env: 0.85 }
  return { clearcoat: 1, env: 1 }
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
export const CUE_SHADOW_PEAK_ALPHA = 0.68
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
