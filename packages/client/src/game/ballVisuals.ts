import * as THREE from 'three'

/**
 * The cue ball's colour: a warm cream phenolic resin, not rental-table white.
 * Kept under pure white so the lamp's warm light is what lifts it, the way a
 * real cue ball reads under tournament lighting.
 */
export const CUE_BALL_COLOR = 0xf4f0e4
/** Base lacquer roughness: a soft satin under the clearcoat, not a hard plastic glint. */
export const CUE_BALL_ROUGHNESS = 0.28
/** Phenolic resin is a dielectric: no metalness anywhere on this ball. */
export const CUE_BALL_METALNESS = 0
/** The clearcoat film, at full strength - it is what carries the one crisp highlight. */
export const CUE_BALL_CLEARCOAT = 0
/** The clearcoat's own roughness: crisp, but an ellipse rather than a pinpoint. */
export const CUE_BALL_CLEARCOAT_ROUGHNESS = 0.3
/** Dielectric specular at its physical maximum. */
export const CUE_BALL_SPECULAR_INTENSITY = 0.5
/**
 * How strongly the scene's environment reflects in the ball between highlight and
 * horizon. Deliberately below the coloured balls' 1.0: the cue ball is the brightest
 * object on the cloth, and a full-strength reflection of the lamp band blows its
 * silhouette out into the cloth it should stand against.
 */
export const CUE_BALL_ENV_MAP_INTENSITY = 0

/** Fresnel index for phenolic resin. */
export const CUE_BALL_IOR = 1.5

/**
 * The cue ball's own material, as a fresh instance.
 *
 * One per cue ball, never shared: the rig owns it so the "ball on" highlight can
 * drive its emissive without ever touching another ball's surface.
 */
export function createCueBallMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: CUE_BALL_COLOR,
    roughness: CUE_BALL_ROUGHNESS,
    metalness: CUE_BALL_METALNESS,
    clearcoat: CUE_BALL_CLEARCOAT,
    clearcoatRoughness: CUE_BALL_CLEARCOAT_ROUGHNESS,
    specularIntensity: CUE_BALL_SPECULAR_INTENSITY,
    envMapIntensity: CUE_BALL_ENV_MAP_INTENSITY,
    ior: CUE_BALL_IOR,
    emissive: 0x000000
  })
}

/**
 * The darkest the cue ball's contact shadow ever gets, right under the ball.
 *
 * Above the shared disc's 0.42, which was faint enough that the cue ball read as
 * floating over the cloth; inside the 0.55-0.75 band a real contact shadow reads
 * at under a table lamp, so the ball is grounded without a black coin appearing
 * under it.
 */
export const CUE_SHADOW_PEAK_ALPHA = 0.85
/**
 * The cue ball's disc size, as a multiple of its radius: 1.4 times the ball's
 * whole width, a shade wider than the coloured balls' 1.3, so the brightest ball
 * on the cloth is the one with the softest grounding.
 */
export const CUE_SHADOW_PLANE = 3
/** How far the cue ball's disc leans away from the lamp, in millimetres. */
export const CUE_SHADOW_OFFSET_MM = 1.5
/** How far the disc stretches along that lean: an ellipse, not a circle. */
export const CUE_SHADOW_STRETCH = 1.1
/** How high the cue ball's disc sits above the cloth, in millimetres. */
export const CUE_SHADOW_Y_MM = 1
/** The cue shadow texture's edge, in pixels. A soft blob needs no more. */
export const CUE_SHADOW_TEXTURE_SIZE = 128

/**
 * The cue ball's shadow opacity at a given distance from its centre, as a
 * fraction of the disc's radius: 0 at the contact, 1 at the rim.
 *
 * Pure and monotonic so it can be asserted directly: the darkest point is
 * `CUE_SHADOW_PEAK_ALPHA`, and the edge dissolves to nothing with a zero slope
 * rather than ending on a visible step.
 */
export function cueShadowAlpha(frac: number): number {
  if (frac <= 0.55) return CUE_SHADOW_PEAK_ALPHA
  if (frac >= 1) return 0
  const t = (frac - 0.55) / 0.45
  return CUE_SHADOW_PEAK_ALPHA * (1 - t * t * (3 - 2 * t))
}

/**
 * The cue ball's shadow texture as raw RGBA bytes: black, with the alpha channel
 * carrying {@link cueShadowAlpha} across the disc. Kept free of the DOM so the
 * numbers behind the shadow are testable; the caller wraps these bytes in a
 * canvas.
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
