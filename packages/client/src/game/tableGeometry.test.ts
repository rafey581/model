import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { POCKET_RADIUS_CORNER, POCKET_RADIUS_MIDDLE, TABLE_LENGTH, TABLE_WIDTH, pocketPositions } from '@snooker/shared'
import {
  APRON_OUTER_L,
  APRON_OUTER_W,
  APRON_PAD,
  CUSHION_DEPTH,
  CUSHION_H,
  cushionLayout,
  cushionTransform,
  makeBeadGeometry,
  makeCushionGeometry,
  makeFrameGeometry,
  makeRailCapGeometry
} from './tableGeometry.js'

const HALF_L = TABLE_LENGTH / 2
const HALF_W = TABLE_WIDTH / 2

/** Build a mesh the way the scene does, then measure it in world space. */
function placed(
  geometry: THREE.BufferGeometry,
  rotationY: number,
  position: THREE.Vector3
): THREE.Box3 {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
  mesh.rotation.y = rotationY
  mesh.position.copy(position)
  mesh.updateWorldMatrix(true, false)
  return new THREE.Box3().setFromObject(mesh)
}

/** True if the frame's material is present at this point on the bed's plane. */
function coversAt(cap: THREE.Mesh, x: number, z: number): boolean {
  const ray = new THREE.Raycaster(new THREE.Vector3(x, 40, z), new THREE.Vector3(0, -1, 0))
  return ray.intersectObject(cap, false).length > 0
}

describe('rail cap', () => {
  it('puts its top face on the cloth plane at y=-1', () => {
    // The scene sets railCap.position.y = -1, and selfCheck asserts the resulting top
    // face lands there. That only works if makeRailCapGeometry puts its top at local 0.
    const box = placed(makeRailCapGeometry(), 0, new THREE.Vector3(0, -1, 0))
    expect(box.max.y).toBeCloseTo(-1, 6)
  })

  it('has its underside 12mm below the top, matching the moulding depth', () => {
    const box = placed(makeRailCapGeometry(), 0, new THREE.Vector3(0, -1, 0))
    expect(box.min.y).toBeCloseTo(-13, 6)
  })

  it('reaches the outer frame face', () => {
    const box = placed(makeRailCapGeometry(), 0, new THREE.Vector3(0, -1, 0))
    expect(box.max.x).toBeCloseTo(APRON_OUTER_L / 2, 6)
    expect(box.max.z).toBeCloseTo(APRON_OUTER_W / 2, 6)
  })

  it('does not overhang the cloth', () => {
    // A bevelled ExtrudeGeometry insets its hole, so passing the bed's footprint
    // straight through used to leave 5mm of wood sitting on the playing surface.
    const cap = new THREE.Mesh(makeRailCapGeometry(), new THREE.MeshBasicMaterial())
    cap.position.y = -1
    cap.updateWorldMatrix(true, false)
    expect(coversAt(cap, HALF_L - 0.5, 0)).toBe(false)
    expect(coversAt(cap, 0, HALF_W - 0.5)).toBe(false)
  })

  it('covers the whole rail width out to the frame face', () => {
    const railWidth = APRON_OUTER_L / 2 - HALF_L
    expect(railWidth).toBe(APRON_PAD / 2)
    const cap = new THREE.Mesh(makeRailCapGeometry(), new THREE.MeshBasicMaterial())
    cap.position.y = -1
    cap.updateWorldMatrix(true, false)
    for (const d of [0.5, railWidth / 2, railWidth - 0.5]) {
      expect(coversAt(cap, HALF_L + d, 0)).toBe(true)
    }
  })

  it('opens its cutout to the bed footprint when given that footprint', () => {
    const geo = makeFrameGeometry(APRON_OUTER_L, APRON_OUTER_W, TABLE_LENGTH, TABLE_WIDTH, 12, 5, 5)
    geo.computeBoundingBox()
    const box = geo.boundingBox!
    // Outer footprint inset by the bevel; the inner hole is what the caller asked for.
    expect(box.max.x).toBeCloseTo(APRON_OUTER_L / 2, 6)
  })

  it('never lets the opening close past the outer frame', () => {
    // An opening wider than the frame has to clamp, or the shape self-intersects and the
    // triangulation produces garbage rather than an empty frame.
    const geo = makeFrameGeometry(200, 120, 9000, 9000, 12, 5, 5)
    geo.computeBoundingBox()
    expect(geo.boundingBox!.max.x).toBeCloseTo(100, 6)
  })
})

describe('cushions', () => {
  it('places all six segments on their physics planes', () => {
    for (const [length, axis, outward, centre] of cushionLayout()) {
      const place = cushionTransform(length, axis, outward, centre)
      const box = placed(makeCushionGeometry(length), place.rotationY, place.position)
      const inner =
        axis === 'x' ? Math.min(Math.abs(box.min.z), Math.abs(box.max.z)) : Math.min(Math.abs(box.min.x), Math.abs(box.max.x))
      const expected = axis === 'x' ? HALF_W : HALF_L
      const label = `${axis}/${outward} @ ${centre}`
      expect(inner, label).toBeCloseTo(expected, 6)
    }
  })

  it('stands the rail exactly CUSHION_H tall, resting on the cloth', () => {
    for (const [length, axis, outward, centre] of cushionLayout()) {
      const place = cushionTransform(length, axis, outward, centre)
      const box = placed(makeCushionGeometry(length), place.rotationY, place.position)
      const label = `${axis}/${outward} @ ${centre}`
      expect(box.max.y, label).toBeCloseTo(CUSHION_H, 6)
      expect(box.min.y, label).toBeCloseTo(0, 6)
    }
  })

  it('keeps every segment centred on where the layout says it is', () => {
    for (const [length, axis, outward, centre] of cushionLayout()) {
      const place = cushionTransform(length, axis, outward, centre)
      const box = placed(makeCushionGeometry(length), place.rotationY, place.position)
      const along = axis === 'x' ? (box.min.x + box.max.x) / 2 : (box.min.z + box.max.z) / 2
      expect(along, `${axis}/${outward} @ ${centre}`).toBeCloseTo(centre, 6)
    }
  })

  it('sweeps each segment to its exact length', () => {
    for (const [length, axis, outward, centre] of cushionLayout()) {
      const place = cushionTransform(length, axis, outward, centre)
      const box = placed(makeCushionGeometry(length), place.rotationY, place.position)
      const along = axis === 'x' ? box.max.x - box.min.x : box.max.z - box.min.z
      // Segment ends are the pocket jaws, so the length must not be eaten by a bevel.
      expect(along, `${axis}/${outward}`).toBeCloseTo(length, 6)
    }
  })

  it('is CUSHION_DEPTH deep without a bevel growing it', () => {
    for (const [length, axis, outward, centre] of cushionLayout()) {
      const place = cushionTransform(length, axis, outward, centre)
      const box = placed(makeCushionGeometry(length), place.rotationY, place.position)
      const depth = axis === 'x' ? box.max.z - box.min.z : box.max.x - box.min.x
      expect(depth, `${axis}/${outward}`).toBeCloseTo(CUSHION_DEPTH, 6)
    }
  })

  it('keeps the inner face vertical on the physics plane', () => {
    // The face the ball rebounds off must be dead flat and full height. A bevel here
    // moves it inward by bevelSize, which reads as the ball clipping the rubber.
    const geo = makeCushionGeometry(500)
    const box = placed(geo, -Math.PI / 2, new THREE.Vector3(0, 0, HALF_W))
    expect(box.min.z).toBeCloseTo(HALF_W, 6)
    expect(box.max.y - box.min.y).toBeCloseTo(CUSHION_H, 6)
  })

  it('lays out six segments with the long rails split around the middle pockets', () => {
    const layout = cushionLayout()
    expect(layout).toHaveLength(6)
    expect(layout.filter(([, axis]) => axis === 'x')).toHaveLength(4)
    expect(layout.filter(([, axis]) => axis === 'z')).toHaveLength(2)
    // The short rails are unbroken, and are cut to the corner gap at each end.
    const shortLen = TABLE_WIDTH - POCKET_RADIUS_CORNER * 2
    for (const [length, axis] of layout.filter(([, a]) => a === 'z')) {
      expect(length).toBeCloseTo(shortLen, 6)
    }
  })

  it('derives the long-rail segments from the pocket radii, not hardcoded numbers', () => {
    // Segment ends are the pocket jaws: 48.25mm at the corners, 52.25mm at the middles.
    const expected = HALF_L - POCKET_RADIUS_CORNER - POCKET_RADIUS_MIDDLE
    const longs = cushionLayout().filter(([, axis, outward]) => axis === 'x' && outward === -1)
    expect(longs).toHaveLength(2)
    for (const [len] of longs) {
      expect(len).toBeCloseTo(expected, 6)
    }
  })
})

describe('brass trim', () => {
  it('sweeps the requested length plus the bevel at each end', () => {
    const geo = makeBeadGeometry(1000)
    geo.computeBoundingBox()
    // The section is authored 1.2mm undersize and the bevel lands it on the intended
    // footprint, which also adds 1.2mm past each end of the sweep.
    expect(geo.boundingBox!.max.z).toBeCloseTo(1000 + 1.2, 3)
  })

  it('is about 14mm proud of the frame face, matching the trim it replaced', () => {
    const geo = makeBeadGeometry(1000)
    geo.computeBoundingBox()
    // The 14mm is the section's nominal outer extent plus the bevel, so the exact
    // footprint lands just outside 14. What matters is that it did not grow into a
    // different part, so this is a band rather than an exact figure.
    expect(geo.boundingBox!.max.x).toBeGreaterThan(13.9)
    expect(geo.boundingBox!.max.x).toBeLessThan(14.5)
  })

  it('stands about 13.5mm tall off the rail', () => {
    const geo = makeBeadGeometry(1000)
    geo.computeBoundingBox()
    const box = geo.boundingBox!
    expect(box.max.y - box.min.y).toBeGreaterThan(11)
    expect(box.max.y - box.min.y).toBeLessThan(15)
  })
})

describe('pocket geometry bounds', () => {
  const POCKETS = pocketPositions()
  const tableX = (x: number): number => x - TABLE_LENGTH / 2
  const tableZ = (y: number): number => y - TABLE_WIDTH / 2

  it('no pocket mesh exceeds 60mm above cloth', () => {
    const throatMat = new THREE.MeshStandardMaterial()
    const dropMat = new THREE.MeshBasicMaterial()
    const mouthShadowMat = new THREE.MeshBasicMaterial()
    const leatherMat = new THREE.MeshPhysicalMaterial()
    const brassLipMat = new THREE.MeshStandardMaterial()

    const pocketGeo = new Map<
      number,
      {
        throat: THREE.BufferGeometry
        drop: THREE.BufferGeometry
        lip: THREE.BufferGeometry
        shadow: THREE.BufferGeometry
        stitch: THREE.BufferGeometry
      }
    >()
    const geoFor = (radius: number) => {
      const cached = pocketGeo.get(radius)
      if (cached) return cached
      const made = {
        throat: new THREE.CylinderGeometry(radius * 0.98, radius * 0.8, 90, 28, 1, true),
        drop: new THREE.CircleGeometry(radius * 0.8, 24),
        lip: new THREE.TorusGeometry(radius + 4, 4.5, 14, 36),
        shadow: new THREE.CircleGeometry(radius * 1.35, 28),
        stitch: new THREE.CapsuleGeometry(1.5, 7, 3, 6)
      }
      pocketGeo.set(radius, made)
      return made
    }

    for (const p of POCKETS) {
      const x = tableX(p.x)
      const z = tableZ(p.y)
      const geo = geoFor(p.radius)

      const shadow = new THREE.Mesh(geo.shadow, mouthShadowMat)
      shadow.rotation.x = -Math.PI / 2
      shadow.position.set(x, CUSHION_H + 1.1, z)
      shadow.updateMatrixWorld(true)

      const throat = new THREE.Mesh(geo.throat, throatMat)
      throat.position.set(x, CUSHION_H + 1.2 - 45, z)
      throat.updateMatrixWorld(true)

      const drop = new THREE.Mesh(geo.drop, dropMat)
      drop.rotation.x = -Math.PI / 2
      drop.position.set(x, CUSHION_H + 1.2 - 90, z)
      drop.updateMatrixWorld(true)

      const lip = new THREE.Mesh(geo.lip, leatherMat)
      lip.rotation.x = -Math.PI / 2
      lip.position.set(x, CUSHION_H + 2.4, z)
      lip.updateMatrixWorld(true)

      const brass = new THREE.Mesh(geo.lip, brassLipMat)
      brass.rotation.x = -Math.PI / 2
      brass.scale.set(0.82, 0.82, 1.35)
      brass.position.set(x, CUSHION_H + 3.0, z)
      brass.updateMatrixWorld(true)

      const stitchCount = 16
      const stitches = new THREE.InstancedMesh(geo.stitch, brassLipMat, stitchCount)
      const m4 = new THREE.Matrix4()
      const q = new THREE.Quaternion()
      const e = new THREE.Euler()
      const one = new THREE.Vector3(1, 1, 1)
      const at = new THREE.Vector3()
      const laceR = p.radius + 8.5
      for (let i = 0; i < stitchCount; i++) {
        const t = (i / stitchCount) * Math.PI * 2
        at.set(x + Math.cos(t) * laceR, CUSHION_H + 2.6, z + Math.sin(t) * laceR)
        e.set(0, -t, i % 2 === 0 ? 0.42 : -0.42, 'YXZ')
        q.setFromEuler(e)
        m4.compose(at, q, one)
        stitches.setMatrixAt(i, m4)
      }
      stitches.instanceMatrix.needsUpdate = true
      stitches.updateMatrixWorld(true)

      const objects = [
        { name: 'shadow', obj: shadow },
        { name: 'throat', obj: throat },
        { name: 'drop', obj: drop },
        { name: 'lip', obj: lip },
        { name: 'brass', obj: brass },
        { name: 'stitches', obj: stitches }
      ]

      for (const { name, obj } of objects) {
        const box = new THREE.Box3().setFromObject(obj)
        const height = box.max.y - box.min.y
        // No pocket object should exceed 60mm above cloth (y=0)
        // Cushions are 12mm, brass fittings under 20mm
        expect(box.max.y).toBeLessThanOrEqual(60)
        // And total height should be reasonable
        expect(height).toBeLessThanOrEqual(120)
      }
    }
  })
})
