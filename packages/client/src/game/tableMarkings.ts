import * as THREE from 'three'
import { BAULK_LINE_X, D_RADIUS, TABLE_LENGTH, TABLE_WIDTH } from '@snooker/shared'

/**
 * The baulk line, the D and the six spots, as geometry.
 *
 * They used to be painted into the cloth's texture. That texture is 512 pixels across a
 * table three and a half metres long, so one pixel of it is seven millimetres of cloth,
 * and from the low view behind the cue ball the D was a smear of magnified pixels — the
 * first thing on the screen and the first thing to look cheap. A line that is geometry has
 * no resolution to run out of: it is as sharp at the cue ball as it is at the far cushion.
 *
 * Every edge carries a narrow strip that fades to nothing, so the lines are soft-edged
 * without relying on the renderer's antialiasing, which the lower quality levels switch
 * off. The whole set is one mesh and one draw call, unlit, and covers almost no pixels.
 */

/** Width of the baulk line and the D, in millimetres. Wider than a real chalk line, which a screen cannot hold. */
export const MARKING_LINE_MM = 6
/** The fade on each side of a line. */
const MARKING_FEATHER_MM = 3.5
export const MARKING_SPOT_RADIUS_MM = 6.5
/** White, and faint enough to sit in the cloth rather than on it. */
export const MARKING_OPACITY = 0.5
/** Just clear of the cloth, so the two never fight for the same depth. */
const MARKING_HEIGHT_MM = 0.45
const D_SEGMENTS = 72
const SPOT_SEGMENTS = 20

const HALF_L = TABLE_LENGTH / 2
const HALF_W = TABLE_WIDTH / 2

/** Where each spot is, in table millimetres: yellow, green, brown, blue, pink, black. */
export function markingSpots(): Array<{ x: number; y: number }> {
  return [
    { x: BAULK_LINE_X, y: HALF_W + D_RADIUS },
    { x: BAULK_LINE_X, y: HALF_W - D_RADIUS },
    { x: BAULK_LINE_X, y: HALF_W },
    { x: HALF_L, y: HALF_W },
    { x: TABLE_LENGTH * 0.75, y: HALF_W },
    { x: TABLE_LENGTH - 324, y: HALF_W }
  ]
}

export function buildTableMarkingsGeometry(): THREE.BufferGeometry {
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  const vertex = (x: number, y: number, alpha: number): number => {
    positions.push(x - HALF_L, MARKING_HEIGHT_MM, y - HALF_W)
    colors.push(1, 1, 1, alpha)
    return positions.length / 3 - 1
  }

  /** A line along `points`, each with the unit normal to offset its edges along. */
  const ribbon = (points: Array<{ x: number; y: number; nx: number; ny: number }>): void => {
    const half = MARKING_LINE_MM / 2
    const offsets: Array<[number, number]> = [
      [-half - MARKING_FEATHER_MM, 0],
      [-half, 1],
      [half, 1],
      [half + MARKING_FEATHER_MM, 0]
    ]
    let previous: number[] | null = null
    for (const p of points) {
      const row = offsets.map(([offset, alpha]) => vertex(p.x + p.nx * offset, p.y + p.ny * offset, alpha))
      if (previous) {
        for (let i = 0; i < 3; i++) {
          indices.push(previous[i]!, row[i]!, previous[i + 1]!, previous[i + 1]!, row[i]!, row[i + 1]!)
        }
      }
      previous = row
    }
  }

  // The baulk line, cushion to cushion.
  ribbon([
    { x: BAULK_LINE_X, y: 0, nx: 1, ny: 0 },
    { x: BAULK_LINE_X, y: TABLE_WIDTH, nx: 1, ny: 0 }
  ])

  // The D: a half circle on the baulk line, bowed towards the baulk cushion.
  const arc: Array<{ x: number; y: number; nx: number; ny: number }> = []
  for (let i = 0; i <= D_SEGMENTS; i++) {
    const t = -Math.PI / 2 + (i / D_SEGMENTS) * Math.PI
    const nx = -Math.cos(t)
    const ny = Math.sin(t)
    arc.push({ x: BAULK_LINE_X + nx * D_RADIUS, y: HALF_W + ny * D_RADIUS, nx, ny })
  }
  ribbon(arc)

  // The spots: a solid disc with the same faded rim.
  for (const spot of markingSpots()) {
    const centre = vertex(spot.x, spot.y, 1)
    const inner: number[] = []
    const outer: number[] = []
    for (let i = 0; i < SPOT_SEGMENTS; i++) {
      const t = (i / SPOT_SEGMENTS) * Math.PI * 2
      const c = Math.cos(t)
      const s = Math.sin(t)
      inner.push(vertex(spot.x + c * MARKING_SPOT_RADIUS_MM, spot.y + s * MARKING_SPOT_RADIUS_MM, 1))
      const far = MARKING_SPOT_RADIUS_MM + MARKING_FEATHER_MM
      outer.push(vertex(spot.x + c * far, spot.y + s * far, 0))
    }
    for (let i = 0; i < SPOT_SEGMENTS; i++) {
      const j = (i + 1) % SPOT_SEGMENTS
      indices.push(centre, inner[i]!, inner[j]!)
      indices.push(inner[i]!, outer[i]!, inner[j]!, inner[j]!, outer[i]!, outer[j]!)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4))
  geometry.setIndex(indices)
  return geometry
}

/** The markings as one mesh, ready to be added to the scene over the bed. */
export function buildTableMarkings(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    buildTableMarkingsGeometry(),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      opacity: MARKING_OPACITY,
      depthWrite: false,
      // Seen from above or below alike; the winding of a hand-built strip is not worth a bug.
      side: THREE.DoubleSide
    })
  )
  mesh.name = 'table-markings'
  // Before the other overlays on the cloth, so a ball's contact shadow falls over a line
  // rather than under it.
  mesh.renderOrder = -1
  mesh.castShadow = false
  mesh.receiveShadow = false
  return mesh
}
