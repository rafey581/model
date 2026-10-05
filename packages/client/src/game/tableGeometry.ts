import * as THREE from 'three'
import {
  POCKET_RADIUS_CORNER,
  POCKET_RADIUS_MIDDLE,
  TABLE_LENGTH,
  TABLE_WIDTH
} from '@snooker/shared'

/**
 * Geometry for the snooker table's moulded parts: the rail cap, the cushion bodies and
 * the brass trim.
 *
 * This lives apart from `scene3d.ts` for one reason: none of it needs a canvas, a GL
 * context or a DOM, so it can be built and measured in a test. Every part here is placed
 * against a dimension that the physics engine also uses — the rail cap's top face sits on
 * the cloth's y=-1 plane and each cushion's inner face sits on its collision plane — and
 * both of those are invisible to a typecheck. ExtrudeGeometry's bevel in particular
 * expands the profile *outward*, which silently pushes a cushion's inner face onto the
 * playing surface and a frame's edge over the cloth. `tableGeometry.test.ts` asserts the
 * real world-space bounding boxes so that cannot regress unnoticed.
 *
 * Shared build-space conventions:
 *
 * - Millimetres throughout, matching `@snooker/shared`.
 * - `u` runs outward from the bed, `v` runs up from the cloth. Sections are authored in
 *   (u, v) and swept along local +Z, so the caller rotates the result onto its rail.
 * - Frame geometry is built in XZ extruding along -Y; swept sections are built in the
 *   local plane extruding along +Z.
 */

/** The cushion's inner face is a vertical plane at u=0; the ball radius is 26.25mm. */
export const CUSHION_H = 12
export const CUSHION_DEPTH = 44

/** How far the apron extends past the bed on every side. */
export const APRON_PAD = 2 * (CUSHION_DEPTH + 80)

/** The apron body's outer footprint. */
export const APRON_OUTER_L = TABLE_LENGTH + APRON_PAD
export const APRON_OUTER_W = TABLE_WIDTH + APRON_PAD

/**
 * A rectangular frame — outer rectangle with an inner rectangle cut out — extruded
 * downward with a bevel on both faces.
 *
 * Extruding a 2D section rather than assembling boxes is what makes a moulded profile
 * possible: a bevel on a BoxGeometry can only chamfer one edge, whereas here the shape
 * carries the whole section, so the chamfer runs the full length of all four rails in a
 * single mesh and a single draw call.
 *
 * `innerL`/`innerW` are the opening's full extent measured from the centreline, so the
 * rail's width is `outer/2 - inner/2` on each side. The caller keeps explicit control of
 * how wide the rail reads.
 *
 * Y: the top face ends up at local y=0, measured off the built geometry rather than
 * derived from `depth`, so the caller positions by top face — which is how the rail cap's
 * top lands on the cloth's y=-1 plane.
 */
export function makeFrameGeometry(
  outerL: number,
  outerW: number,
  innerL: number,
  innerW: number,
  depth: number,
  bevel: number,
  cornerRadius: number
): THREE.ExtrudeGeometry {
  const outer = new THREE.Shape()
  const hl = outerL / 2 - bevel
  const hw = outerW / 2 - bevel
  const r = Math.min(cornerRadius, hl, hw)
  // Manual corner arcs rather than absarc: the shape is built in the XZ plane and then
  // rotated, so the winding has to stay consistent or ExtrudeGeometry's triangulation
  // produces inverted faces on one side.
  outer.moveTo(-hl + r, -hw)
  outer.lineTo(hl - r, -hw)
  outer.quadraticCurveTo(hl, -hw, hl, -hw + r)
  outer.lineTo(hl, hw - r)
  outer.quadraticCurveTo(hl, hw, hl - r, hw)
  outer.lineTo(-hl + r, hw)
  outer.quadraticCurveTo(-hl, hw, -hl, hw - r)
  outer.lineTo(-hl, -hw + r)
  outer.quadraticCurveTo(-hl, -hw, -hl + r, -hw)

  // Inner hole, wound the opposite way so ExtrudeGeometry reads it as a cutout.
  const hole = new THREE.Path()
  // Compensate for the bevel here rather than in the caller's numbers. The bevel insets
  // the hole on the top and bottom faces and only reaches the requested half-extent at
  // mid-depth, so passing the bed's footprint straight through left the cap's top face
  // overhanging the cloth by a full bevelSize — 5mm of wood sitting on the playing
  // surface. Widening the hole by exactly one bevel cancels that, putting the visible
  // top-face edge back on the cloth edge where it belongs.
  const inL = Math.min(innerL / 2 + bevel, hl - bevel)
  const inW = Math.min(innerW / 2 + bevel, hw - bevel)
  hole.moveTo(-inL, -inW)
  hole.lineTo(-inL, inW)
  hole.lineTo(inL, inW)
  hole.lineTo(inL, -inW)
  hole.lineTo(-inL, -inW)
  outer.holes.push(hole)

  const geometry = new THREE.ExtrudeGeometry(outer, {
    depth: depth - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 6
  })
  // Extrude builds in XY extruding along +Z; the table is built in XZ extruding along -Y.
  geometry.rotateX(-Math.PI / 2)
  // Move the top face to local y=0 so callers can position by top face rather than
  // re-deriving an extent. Measured off the built geometry rather than computed from
  // `depth`: the bevel's contribution to the total thickness does not follow simple
  // arithmetic, and guessing wrong put the cap's top at y=-23 instead of y=-1.
  geometry.computeBoundingBox()
  const top = geometry.boundingBox?.max.y ?? 0
  geometry.translate(0, -top, 0)
  geometry.computeVertexNormals()
  return geometry
}

/**
 * The rail cap: the moulded top of the frame, from y=-1 down to y=-13.
 *
 * Its inner opening is the bed's own footprint, so the cap's visible inner edge lands on
 * the cloth edge and the 32mm between that and the outer face is the rail's width.
 */
export function makeRailCapGeometry(): THREE.ExtrudeGeometry {
  return makeFrameGeometry(APRON_OUTER_L, APRON_OUTER_W, TABLE_LENGTH, TABLE_WIDTH, 12, 5, 5)
}

/**
 * The cushion's cross-section, authored in (u, v): u runs outward from the playing
 * surface, v runs up from the cloth.
 *
 * The inner face at u=0 is dead vertical for the full height. That is the physics plane
 * the ball rebounds off, so it is not rounded, chamfered or displaced.
 */
export function cushionProfile(): THREE.Shape {
  const shape = new THREE.Shape()
  shape.moveTo(0, 0)
  // Inner face: the physics plane. Exactly where the box it replaced had it.
  shape.lineTo(0, CUSHION_H)
  // Top land, then the rounded nose shoulder rolling over into the back.
  shape.lineTo(4, CUSHION_H)
  shape.quadraticCurveTo(9, CUSHION_H, 12, CUSHION_H - 2.5)
  // Back slope down to the rail, which is where the cloth-covered rubber is screwed to
  // the frame on a real table.
  shape.lineTo(26, 5)
  shape.quadraticCurveTo(CUSHION_DEPTH - 4, 3, CUSHION_DEPTH, 0)
  shape.closePath()
  return shape
}

/**
 * A cushion body: `cushionProfile` swept `length` along local +Z, in build space. The
 * caller places it with `cushionTransform`.
 *
 * `bevelEnabled` is false, and that is load-bearing rather than lazy. ExtrudeGeometry's
 * bevel expands the profile *outward* by bevelSize: with a 1.2mm bevel this cushion's
 * inner face moved from u=0 to u=-1.2, i.e. 1.2mm onto the playing surface, and its top
 * rose to y=13.2. Both are physics-visible — the rail would read as 1.2mm proud of the
 * plane the ball bounces off. The rounded nose comes from the profile's own curves
 * instead, which are authored inside the exact 0..44 by 0..12 envelope. The rail's ends
 * stay square, which is correct anyway: they are cut off at the pocket jaws.
 */
export function makeCushionGeometry(length: number): THREE.ExtrudeGeometry {
  const geometry = new THREE.ExtrudeGeometry(cushionProfile(), {
    depth: length,
    bevelEnabled: false,
    curveSegments: 6
  })
  geometry.computeVertexNormals()
  return geometry
}

/**
 * Where a cushion of `length` goes, given which rail it belongs to.
 *
 * `axis` is the rail's run ('x' for the long rails, 'z' for the short), `outward` the sign
 * of the direction its depth points away from the bed. Both are needed because the four
 * rails face four different ways.
 *
 * The rotation and position are not independent — flipping one mirrors the other, so they
 * have to move together:
 *
 * - Sweeping runs along local +Z and the profile's u along local +X.
 * - `rotateY(-90°)` sends local +Z to world +X but local +X to world -Z, so u points
 *   inward. That is correct for the +Z rail. `rotateY(+90°)` sends local +Z to -X and
 *   local +X to +Z, which is what the -Z rail needs. Getting this pair the wrong way
 *   round puts a cushion inside the playing surface.
 * - On the short rails the sweep already lies along +Z, so only u has to turn onto X: no
 *   rotation for the +X rail, 180° for the -X rail. The 180° also flips the sweep, so the
 *   z origin goes at the opposite end.
 */
export function cushionTransform(
  length: number,
  axis: 'x' | 'z',
  outward: 1 | -1,
  centreAlong: number
): { rotationY: number; position: THREE.Vector3 } {
  const halfL = TABLE_LENGTH / 2
  const halfW = TABLE_WIDTH / 2
  if (axis === 'x') {
    return {
      rotationY: outward > 0 ? -Math.PI / 2 : Math.PI / 2,
      position: new THREE.Vector3(
        outward > 0 ? centreAlong + length / 2 : centreAlong - length / 2,
        0,
        outward * halfW
      )
    }
  }
  return {
    rotationY: outward > 0 ? 0 : Math.PI,
    position: new THREE.Vector3(
      outward * halfL,
      0,
      outward > 0 ? centreAlong - length / 2 : centreAlong + length / 2
    )
  }
}

/**
 * A stepped bead-and-reel section, swept the length of a rail. Same (u, v) convention as
 * `cushionProfile`.
 *
 * The step matters more than the detail: three flats at three angles give the lamp three
 * highlight lines down the rail, where a single flat gives it one and the whole trim reads
 * as a painted line. Costs about 90 triangles per rail.
 */
export function makeBeadGeometry(length: number): THREE.ExtrudeGeometry {
  const b = 1.2
  const shape = new THREE.Shape()
  // u: 0 at the frame face, out to 14. v: 0 at the rail's base, up to 14.
  shape.moveTo(0, 1)
  shape.lineTo(3 - b, 1)
  // Roll out to the widest point.
  shape.quadraticCurveTo(7 - b, 2.5, 11 - b, 6)
  // Flat top land.
  shape.lineTo(14 - b, 10)
  // Bead back down to the underside.
  shape.quadraticCurveTo(11 - b, 13.5, 6 - b, 13.5)
  shape.lineTo(0, 12)
  shape.closePath()
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: length,
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 1,
    curveSegments: 4
  })
  geometry.computeVertexNormals()
  return geometry
}

/** Where a length of trim goes: `axis` is its run, `side` the offset direction. */
export function trimTransform(
  length: number,
  axis: 'x' | 'z',
  side: 1 | -1,
  y: number,
  halfInner: number
): { rotationY: number; position: THREE.Vector3 } {
  const halfL = TABLE_LENGTH / 2
  const halfW = TABLE_WIDTH / 2
  if (axis === 'x') {
    return {
      rotationY: side > 0 ? -Math.PI / 2 : Math.PI / 2,
      position: new THREE.Vector3(side > 0 ? length / 2 : -length / 2, y, side * (halfW + halfInner))
    }
  }
  return {
    rotationY: side > 0 ? 0 : Math.PI,
    position: new THREE.Vector3(side * (halfL + halfInner), y, side > 0 ? -length / 2 : length / 2)
  }
}

/**
 * The six cushion placements: [length, axis, outward, centreAlong].
 *
 * The long rails are split in two around the middle pockets, so each is two segments of
 * equal length; the short rails are unbroken. Segment ends are the pocket jaws, which is
 * why the lengths are derived from the pocket radii rather than hardcoded.
 */
export function cushionLayout(): Array<[number, 'x' | 'z', 1 | -1, number]> {
  const halfL = TABLE_LENGTH / 2
  const halfW = TABLE_WIDTH / 2
  const gapHalf = POCKET_RADIUS_CORNER
  const midGapHalf = POCKET_RADIUS_MIDDLE
  const longSegments: Array<[number, number]> = [
    [-halfL + gapHalf, -midGapHalf],
    [midGapHalf, halfL - gapHalf]
  ]
  const out: Array<[number, 'x' | 'z', 1 | -1, number]> = []
  for (const [from, to] of longSegments) {
    const mid = (from + to) / 2
    out.push([to - from, 'x', -1, mid])
    out.push([to - from, 'x', 1, mid])
  }
  const shortLen = TABLE_WIDTH - gapHalf * 2
  out.push([shortLen, 'z', -1, 0])
  out.push([shortLen, 'z', 1, 0])
  return out
}
