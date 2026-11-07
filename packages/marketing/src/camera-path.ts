export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface CameraShot {
  position: Vec3
  lookAt: Vec3
}

interface CameraKey {
  t: number
  shot: CameraShot
}

/**
 * Scroll poses for the table, in metres. t = 0 is the hero (cue ball, low).
 * Later keys move along the cloth toward an overhead view.
 */
export const CAMERA_KEYS: readonly CameraKey[] = [
  {
    t: 0,
    shot: {
      position: { x: -0.2, y: 1.02, z: -1.72 },
      lookAt: { x: 0.45, y: 0, z: 0.05 }
    }
  },
  {
    t: 0.38,
    shot: {
      position: { x: 1.55, y: 1.05, z: 0.15 },
      lookAt: { x: 0.05, y: 0, z: 0.2 }
    }
  },
  {
    t: 0.72,
    shot: {
      position: { x: -0.15, y: 0.78, z: 2.05 },
      lookAt: { x: 0, y: 0.02, z: 0.35 }
    }
  },
  {
    t: 1,
    shot: {
      position: { x: 0.08, y: 2.35, z: 0.42 },
      lookAt: { x: 0, y: 0, z: 0.05 }
    }
  }
]

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) }
}

function smoothstep(t: number): number {
  const x = clamp01(t)
  return x * x * (3 - 2 * x)
}

export function cameraAt(progress: number): CameraShot {
  const t = clamp01(progress)
  const first = CAMERA_KEYS[0]
  const last = CAMERA_KEYS[CAMERA_KEYS.length - 1]
  if (!first || !last) throw new Error('camera path is empty')
  if (t <= first.t) return first.shot
  if (t >= last.t) return last.shot
  for (let i = 0; i < CAMERA_KEYS.length - 1; i += 1) {
    const a = CAMERA_KEYS[i]
    const b = CAMERA_KEYS[i + 1]
    if (!a || !b) continue
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t
      const u = span === 0 ? 0 : smoothstep((t - a.t) / span)
      return {
        position: lerpVec(a.shot.position, b.shot.position, u),
        lookAt: lerpVec(a.shot.lookAt, b.shot.lookAt, u)
      }
    }
  }
  return last.shot
}

export interface SceneMark {
  /** Document Y of the scene window's center. */
  center: number
  /** Camera progress when that window is centered in the viewport. */
  at: number
}

/**
 * Map the viewport center onto the camera path using the scene windows.
 * The page itself scrolls normally; this only chooses a camera pose.
 */
export function progressForViewport(marks: readonly SceneMark[], viewportCenterY: number): number {
  if (!Number.isFinite(viewportCenterY) || marks.length === 0) return 0
  const sorted = [...marks].sort((a, b) => a.center - b.center)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (!first || !last) return 0
  if (viewportCenterY <= first.center) return clamp01(first.at)
  if (viewportCenterY >= last.center) return clamp01(last.at)
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (!a || !b) continue
    if (viewportCenterY >= a.center && viewportCenterY <= b.center) {
      const span = b.center - a.center
      const u = span === 0 ? 0 : (viewportCenterY - a.center) / span
      const s = smoothstep(u)
      return clamp01(a.at + (b.at - a.at) * s)
    }
  }
  return clamp01(last.at)
}
