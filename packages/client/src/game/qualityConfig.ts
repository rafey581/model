/**
 * QUALITY_TIERS — the one object every renderer and venue cost is read from.
 *
 * Three tiers, one table, one detection rule. The renderer (antialias, shadow map,
 * anisotropy, render scale, FPS cap, ball segments, cloth normal map), the arena
 * (shadow size, stand washes, seat budget) and the crowd all take their numbers from
 * here; nothing outside this file is allowed to invent a quality decision.
 *
 * The tier is resolved once, in this order:
 *   1. `<html data-quality="...">` — set by `public/quality-boot.js` before any module
 *      loads from `?quality=`, then the player's saved Settings choice, then the device
 *      guess. Reading it first is what keeps the 3D scene and the CSS on the same tier.
 *   2. `?quality=low|medium|high` directly, in case the page was loaded without the boot
 *      script (a test harness, a bundled preview).
 *   3. The device guess below.
 *
 * The guess ladder and its thresholds are mirrored verbatim in `public/quality-boot.js`
 * — keep the two comment blocks identical when either changes.
 */
export type QualityTier = 'low' | 'medium' | 'high'

export interface QualityTierConfig {
  /** Which tier this is, so a caller can log or display it without a second lookup. */
  readonly name: QualityTier
  /** Upper bound on the render scale; the adaptive scaler in scene3d sits at or under it. */
  readonly renderScale: number
  /** MSAA on the WebGL context. Off below high: it costs fill rate on every pixel. */
  readonly antialias: boolean
  /** Lamp shadow map edge, in texels. Baked once, so this is a memory/quality number. */
  readonly shadowMapSize: number
  /** Cap on texture anisotropy, shared by every texture built after the renderer exists. */
  readonly anisotropy: number
  /** Cloth normal map. The bed is the biggest surface on screen; low drops the sampling. */
  readonly clothNormal: boolean
  /** Crowd: off, or built with only the nearest tier animating, or fully animated. */
  readonly crowd: 'off' | 'near' | 'full'
  /** Frame ceiling. 30 on low halves the GPU work that arrives per second. */
  readonly fpsCap: number
  /** Sphere geometry for the balls: width segments, height segments. */
  readonly ballSegments: readonly [number, number]
}

/**
 * The tier table. All other code reads its quality values from this object.
 *
 * low: 0.75 render scale, no AA, 1024 shadow, aniso 2, no cloth normal, no crowd,
 *      30fps, 24x14 balls. Ball gloss / cloth sheen are softened in scene materials.
 * medium: 0.9 scale, no AA, 1024 shadow, aniso 4, cloth normal on, crowd nearest-tier,
 *      60fps, 32x18 balls.
 * high: full scale, MSAA on, 2048 shadow, aniso 8, cloth normal on, full crowd,
 *      60fps, 32x20 balls. Full phenolic clearcoat + env intensity.
 *
 * scene3d.ts reads antialias, anisotropy, clothNormal and ballSegments from here.
 */
export const QUALITY_TIERS: Record<QualityTier, QualityTierConfig> = {
  low: {
    name: 'low',
    renderScale: 0.75,
    antialias: false,
    shadowMapSize: 1024,
    anisotropy: 2,
    clothNormal: false,
    crowd: 'off',
    fpsCap: 30,
    ballSegments: [24, 14]
  },
  medium: {
    name: 'medium',
    renderScale: 0.9,
    antialias: false,
    shadowMapSize: 1024,
    anisotropy: 4,
    clothNormal: true,
    crowd: 'near',
    fpsCap: 60,
    ballSegments: [32, 18]
  },
  high: {
    name: 'high',
    renderScale: 1,
    antialias: true,
    shadowMapSize: 2048,
    anisotropy: 8,
    clothNormal: true,
    crowd: 'full',
    fpsCap: 60,
    ballSegments: [32, 20]
  }
}

const TIERS: readonly QualityTier[] = ['low', 'medium', 'high']

export function isQualityTier(value: unknown): value is QualityTier {
  return value === 'low' || value === 'medium' || value === 'high'
}

/**
 * The device guess. Mirrored in `public/quality-boot.js` — same ladder, same
 * thresholds, so CSS and WebGL land on the same tier from one signal set:
 *
 *   - mobile user agent .................... low
 *   - phone-sized screen with dpr >= 2 ..... low   (webviews and small windows)
 *   - hardwareConcurrency <= 4 or
 *     deviceMemory <= 4 .................... medium
 *   - integrated or software GPU ........... medium  (cores say nothing about fill rate)
 *   - dpr >= 2.5 on a <= 6-core or
 *     <= 6GB device ....................... medium  (many pixels on a weak GPU)
 *   - otherwise ............................ high
 */
export function detectQualityTier(): QualityTier {
  if (typeof navigator === 'undefined') return 'medium'
  const nav = navigator as Navigator & { deviceMemory?: number }
  const mobileUA = /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(nav.userAgent)
  const cores = nav.hardwareConcurrency ?? 8
  const mem = nav.deviceMemory ?? 8
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
  const smallScreen =
    typeof window !== 'undefined' && window.screen
      ? Math.min(window.screen.width, window.screen.height) < 760
      : false

  if (mobileUA) return 'low'
  if (smallScreen && dpr >= 2) return 'low'
  if (cores <= 4 || mem <= 4) return 'medium'
  if (hasWeakGpu()) return 'medium'
  if (dpr >= 2.5 && (cores <= 6 || mem <= 6)) return 'medium'
  return 'high'
}

/**
 * GPUs that cannot afford the high tier's MSAA at full resolution, by the name WebGL gives
 * them: Intel's integrated chips (Arc is the discrete line and is left alone), AMD's
 * integrated Radeon and Vega, and the software rasterisers. Mirrored in
 * `public/quality-boot.js`.
 */
let weakGpu: boolean | null = null
const WEAK_GPU = /Intel(?!.*Arc)|Radeon\(TM\) Graphics|Radeon.*Vega|SwiftShader|llvmpipe|Basic Render/i

/**
 * Whether the GPU is one of the {@link WEAK_GPU} family.
 *
 * Eight cores and eight gigabytes describe a great many laptops whose only GPU is the one
 * built into the processor, and nothing else in the ladder can tell those from a machine
 * with a graphics card. The renderer string can. False when the browser will not say.
 */
function hasWeakGpu(): boolean {
  if (weakGpu !== null) return weakGpu
  weakGpu = false
  try {
    if (typeof document === 'undefined') return false
    const gl = document.createElement('canvas').getContext('webgl')
    if (!gl) return false
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '')
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    weakGpu = WEAK_GPU.test(name)
  } catch {
    // No WebGL to ask. The rest of the ladder decides.
  }
  return weakGpu
}

/**
 * The tier this session was asked for by name — the boot script's `data-quality` (which
 * already includes any `?quality=` override) or the URL parameter — or null when nobody
 * asked and the device guess should decide.
 */
export function requestedQualityTier(): QualityTier | null {
  try {
    const fromDom = typeof document !== 'undefined' ? document.documentElement.dataset.quality : undefined
    if (isQualityTier(fromDom)) return fromDom
    const search = typeof location !== 'undefined' ? location.search : ''
    if (search) {
      const fromUrl = new URLSearchParams(search).get('quality')
      if (isQualityTier(fromUrl)) return fromUrl
    }
  } catch {
    // No document or location (unit tests).
  }
  return null
}

/** The tier this session runs at: what was requested by name, or the device guess. */
export function resolveQualityTier(): QualityTier {
  return requestedQualityTier() ?? detectQualityTier()
}

/** What the player asked for in Settings: a tier by name, or leave it to the device. */
export type QualityPreference = 'auto' | QualityTier

/** Where the Settings choice is kept. Read by `public/quality-boot.js` before any module. */
export const QUALITY_STORAGE_KEY = 'snooker.quality'

/** The player's saved choice. `auto` when they have never chosen, or storage is refused. */
export function qualityPreference(): QualityPreference {
  try {
    const stored = globalThis.localStorage?.getItem(QUALITY_STORAGE_KEY)
    return isQualityTier(stored) ? stored : 'auto'
  } catch {
    return 'auto'
  }
}

/**
 * Saves the player's choice and puts it into effect for the next match.
 *
 * Three things have to agree, and this is the one place that moves all of them: the saved
 * choice, `<html data-quality>` (which the CSS tier rules and the arena read), and the
 * cached tier config. A match that is already on screen keeps the tier it was built with
 * — a scene's shadow map, textures and anti-aliasing are decided when it is built — so the
 * change is seen from the next match on. Returns the tier now in effect.
 */
export function setQualityPreference(preference: QualityPreference): QualityTier {
  try {
    if (preference === 'auto') globalThis.localStorage?.removeItem(QUALITY_STORAGE_KEY)
    else globalThis.localStorage?.setItem(QUALITY_STORAGE_KEY, preference)
  } catch {
    // Storage refused: the choice still holds for this page, it just is not remembered.
  }
  const tier = preference === 'auto' ? detectQualityTier() : preference
  if (typeof document !== 'undefined') document.documentElement.dataset.quality = tier
  resolved = QUALITY_TIERS[tier]
  return tier
}

/** The tier one step down, or null at the bottom. Used by the adaptive scaler once. */
export function lowerQualityTier(tier: QualityTier): QualityTier | null {
  const index = TIERS.indexOf(tier)
  return index > 0 ? TIERS[index - 1]! : null
}

let resolved: QualityTierConfig | null = null

/** The tier config for this session, resolved once and cached. */
export function qualityConfig(): QualityTierConfig {
  resolved ??= QUALITY_TIERS[resolveQualityTier()]
  return resolved
}
