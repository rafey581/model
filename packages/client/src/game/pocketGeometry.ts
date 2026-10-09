import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { CUSHION_H } from './tableGeometry.js'

/**
 * Premium pocket parts, millimetres, cloth at y=0, y up.
 *
 * Fixes over the old pocket build in scene3d.ts:
 *
 * 1. Jaws are now FULL cushion height (CUSHION_H = 36). The old jaw rose only 16mm, so a
 *    36mm cushion ended in a 16mm stub and the pocket looked broken.
 * 2. Jaws are SOLID with end caps, not a thin one-sided flap.
 * 3. Jaws sit on the OUTSIDE of the cushion line only, so they never intrude onto the
 *    playing surface, and they point the right way on every corner. The old code used
 *    +X/+Z jaws on all four corners, which is correct for one corner and wrong for three.
 * 4. The jaali is a real see-through cone (alpha-tested cord texture) hanging in the cup,
 *    not a flat painted disc.
 *
 * LatheGeometry convention: x = r*sin(phi), z = r*cos(phi), so phi 0 = +Z, 90 = +X,
 * 180 = -Z, 270 = -X.
 */

export const JAW_REACH_MM = 46
export const JAW_ARC_DEG = 70

/** Solid jaw section in (radius, height): vertical inner face, rounded knuckle, back slope. */
export function jawSolidProfile(radius: number): THREE.Vector2[] {
  const h = CUSHION_H
  const reach = radius + JAW_REACH_MM
  return [
    new THREE.Vector2(radius, 0),
    new THREE.Vector2(radius, h - 8),
    new THREE.Vector2(radius + 1.2, h - 4),
    new THREE.Vector2(radius + 4, h - 1.4),
    new THREE.Vector2(radius + 9, h),
    new THREE.Vector2(reach - 16, h - 2.5),
    new THREE.Vector2(reach - 4, 6),
    new THREE.Vector2(reach, 0)
  ]
}

/** A flat cap closing one end of the jaw, so the solid is not hollow when seen from the side. */
function capGeometry(profile: THREE.Vector2[], phi: number): THREE.BufferGeometry {
  const faces = THREE.ShapeUtils.triangulateShape(profile, [])
  const sin = Math.sin(phi)
  const cos = Math.cos(phi)
  const pos: number[] = []
  const uv: number[] = []
  for (const p of profile) {
    pos.push(p.x * sin, p.y, p.x * cos)
    uv.push(0.5, 0.5)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geo.setIndex(faces.flat())
  geo.computeVertexNormals()
  return geo
}

/**
 * One solid jaw wrapping the pocket circle from `startDeg` for `arcDeg`.
 * Use a DoubleSide material: lathe winding depends on direction and the caps are shared.
 */
export function makeJawGeometry(radius: number, startDeg: number, arcDeg: number = JAW_ARC_DEG): THREE.BufferGeometry {
  const profile = jawSolidProfile(radius)
  const phiStart = THREE.MathUtils.degToRad(startDeg)
  const phiLen = THREE.MathUtils.degToRad(arcDeg)
  const lathe = new THREE.LatheGeometry(profile, 12, phiStart, phiLen)
  const merged = mergeGeometries([lathe, capGeometry(profile, phiStart), capGeometry(profile, phiStart + phiLen)], false)
  return merged ?? lathe
}

/**
 * Which arcs a pocket needs. `x`/`z` are the pocket centre in WORLD space (table centre
 * at the origin), `kind` is 'corner' or anything else for a middle pocket.
 *
 * A jaw starts on the line of the rail it continues and sweeps toward the outside of the
 * table, which is how it stays off the playing surface.
 */
export function jawSpecs(x: number, z: number, kind: string, arcDeg: number = JAW_ARC_DEG): Array<{ startDeg: number; arcDeg: number }> {
  const outsideZ = z < 0 ? 180 : 0
  const outsideX = x < 0 ? 270 : 90
  const span = (alongDeg: number, outsideDeg: number): { startDeg: number; arcDeg: number } => {
    const diff = ((outsideDeg - alongDeg + 540) % 360) - 180
    return { startDeg: diff > 0 ? alongDeg : alongDeg - arcDeg, arcDeg }
  }
  if (kind === 'corner') {
    const alongX = x < 0 ? 90 : 270
    const alongZ = z < 0 ? 0 : 180
    return [span(alongX, outsideZ), span(alongZ, outsideX)]
  }
  return [span(90, outsideZ), span(270, outsideZ)]
}

/** The jaali as a see-through cone hanging just inside the bowl. */
export function makePocketNetGeometry(radius: number): THREE.LatheGeometry {
  const pts: THREE.Vector2[] = []
  const steps = 8
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    pts.push(new THREE.Vector2(radius * (0.96 - 0.46 * Math.pow(t, 1.25)), -5 - 62 * t))
  }
  return new THREE.LatheGeometry(pts, 32)
}

/**
 * Cream cords on a TRANSPARENT background, so the dark bowl shows through the gaps.
 * Use with alphaTest (not transparent: true) to avoid sorting problems:
 *   new THREE.MeshBasicMaterial({ map: pocketNetAlphaTexture(), alphaTest: 0.35, side: THREE.DoubleSide })
 */
let netTex: THREE.CanvasTexture | null = null
export function pocketNetAlphaTexture(): THREE.CanvasTexture {
  if (netTex) return netTex
  const size = 96
  const pitch = size / 3
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, size, size)
  ctx.lineCap = 'round'
  ctx.lineWidth = 7
  for (let dir = 0; dir < 2; dir++) {
    ctx.strokeStyle = dir === 0 ? '#f6efdc' : '#e4dac0'
    for (let i = -size; i <= size * 2; i += pitch) {
      ctx.beginPath()
      if (dir === 0) {
        ctx.moveTo(i, 0)
        ctx.lineTo(i + size, size)
      } else {
        ctx.moveTo(i, 0)
        ctx.lineTo(i - size, size)
      }
      ctx.stroke()
    }
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(8, 3)
  tex.anisotropy = 4
  netTex = tex
  return tex
}
