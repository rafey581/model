export type WebGLMode = 'skip' | 'static-frame' | 'animate'

export interface WebGLEnvironment {
  reducedMotion: boolean
  saveData: boolean
  /** `navigator.deviceMemory` in gigabytes, when the browser exposes it. */
  deviceMemoryGb?: number
  webgl: boolean
  /** `?static=1` forces the drawn fallback and skips the WebGL scene. */
  forcedStatic: boolean
}

/**
 * Decide whether to mount the 3D table.
 * Low-memory devices, data-saver, and missing WebGL keep the static drawing.
 * Reduced motion still shows one rendered frame, then does not animate it.
 */
export function webglMode(env: WebGLEnvironment): WebGLMode {
  if (env.forcedStatic || !env.webgl || env.saveData) return 'skip'
  const memory = env.deviceMemoryGb
  if (memory !== undefined && Number.isFinite(memory) && memory > 0 && memory <= 2) return 'skip'
  if (env.reducedMotion) return 'static-frame'
  return 'animate'
}

/** Cap the drawing buffer so a phone does not render at a 3x or 4x ratio. */
export function cappedDevicePixelRatio(dpr: number, viewportWidth: number): number {
  if (!Number.isFinite(dpr) || dpr <= 0) return 1
  const cap = viewportWidth < 768 ? 1.25 : 1.75
  return Math.min(dpr, cap)
}

export function shouldShowSticky(input: {
  narrow: boolean
  heroVisible: boolean
  finalVisible: boolean
  menuOpen: boolean
}): boolean {
  return input.narrow && !input.menuOpen && !input.heroVisible && !input.finalVisible
}

/** Escape closes an open menu. Any other key leaves the state alone. */
export function menuOpenAfterKey(open: boolean, key: string): boolean | null {
  if (key === 'Escape' && open) return false
  return null
}
