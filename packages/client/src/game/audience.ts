import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { ArenaSeatPlacement } from './arenaEnvironment.js'
import { VENUE_CONFIG, type VenueConfig } from './venueConfig.js'

/**
 * The people in the seats.
 *
 * Six `InstancedMesh`es for the whole bowl — bodies, heads, four hair silhouettes, and
 * one mesh per arm — so a stadium of twelve hundred people costs six draw calls and no
 * per-person objects at all. Nothing here is a `Group` per spectator: an instance carries
 * a matrix, a colour and a phase, and the whole crowd is stepped in one pass over one
 * flat array.
 *
 * Split into parts rather than one merged figure because the parts move independently (the
 * arms clap, the body bounces) and they carry independent colours (clothing, skin, hair).
 * The two arms are separate meshes because a clap brings them together through opposite
 * rotations, and one instance carries one matrix. The four hair silhouettes are separate
 * meshes for the same reason, each holding only the people wearing it, so the extra
 * silhouettes cost draw calls rather than instances nobody can see.
 *
 * All animation is CPU-side matrix composition. The alternative — a vertex shader with a
 * per-instance phase attribute — would move the work off the main thread entirely and is
 * the right answer for a bowl this size if the frame budget ever needs it. At this count
 * it is not: six meshes, and idle stepping at half rate, is well under a millisecond.
 */

const DEG = Math.PI / 180
/** Sine in radians. The pose maths below is all radians, and this saves two letters per line. */
const sin = Math.sin

/** The four hair silhouettes, in the order `VENUE_CONFIG.crowd.hairStyles` names them. */
const HAIR_STYLES = ['crop', 'bob', 'long', 'bun'] as const

/** Seated proportions, in millimetres, on a rig whose feet are at y = 0. */
const RIG = {
  /** Where the pan is: the hips sit on the seat, so this is the bottom of the torso. */
  hipY: 430,
  /** Where the shoulders are, and therefore where the arms hang from. */
  shoulderY: 985,
  /** Top of the torso. */
  neckY: 1010,
  headRadius: 108,
  /** Arms hang from the shoulder down to here. */
  armLength: 400,
  armThickness: 62,
  /** How far the shoulders are either side of the spine. */
  armOffset: 152,
  torsoTopRadius: 118,
  torsoBottomRadius: 138
}

/** One spectator: which seat, how tall, what they are wearing, and when they move. */
interface Spectator {
  x: number
  y: number
  z: number
  /** Facing, with the body's own jitter added. Local +Z is the way they look. */
  rotY: number
  /** Uniform scale on the one-metre rig. */
  scale: number
  /** Radians, random per person, so nobody sways in step with the person beside them. */
  phase: number
  /** A second, faster phase, so the sway and the breath are not one movement. */
  phase2: number
  /** 0.55..1, so some people clap harder than others and a row is not one motion. */
  vigour: number
  /** Which hair mesh this person is written into, and at which slot in it. */
  hairStyle: number
  hairSlot: number
}

export interface Audience {
  /** The instanced meshes, added to the arena group. */
  group: THREE.Group
  /** Advances every matrix. `dt` in seconds. */
  step(dt: number): void
  /**
   * Claps for `seconds`, harder for more balls.
   *
   * `intensity` above 1 widens the swing and the bounce, which is what a break of three or
   * four is worth over a single red. A call restarts the crowd from full rather than
   * stacking, so a pot immediately after another does not become a stampede.
   */
  applaud(seconds: number, intensity?: number): void
  /** How long the crowd still has to clap, in seconds. 0 when it is idle. */
  clapping(): number
  /** How many people are in the bowl. */
  size(): number
  dispose(): void
}

/** A torso: shoulders tapering to the hips, six sides, open at both ends. */
function torsoGeometry(): THREE.BufferGeometry {
  const height = RIG.neckY - RIG.hipY
  const geo = new THREE.CylinderGeometry(RIG.torsoTopRadius, RIG.torsoBottomRadius, height, 6, 1, true)
  geo.translate(0, RIG.hipY + height / 2, 0)
  return geo
}

/**
 * One arm, hanging from the origin.
 *
 * The origin is the shoulder on purpose: a clap is a rotation, and a rotation needs its
 * pivot where the joint is. This mesh carries the left arm; the right one is the same
 * geometry with the mirror applied by the instance matrix.
 */
function armGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(RIG.armThickness, RIG.armLength, RIG.armThickness * 0.8)
  geo.translate(0, -RIG.armLength / 2, 0)
  return geo
}

/** A head: a low-poly ball of the configured size, sat on the neck. */
function headGeometry(cfg: VenueConfig): THREE.BufferGeometry {
  const rings = Math.max(3, cfg.crowd.headSegments >> 1)
  const geo = new THREE.SphereGeometry(RIG.headRadius, cfg.crowd.headSegments, rings)
  geo.scale(0.92, 1.08, 0.92)
  geo.translate(0, RIG.neckY + RIG.headRadius * 0.82, 0)
  return geo
}

/**
 * Hair, in one of four silhouettes.
 *
 * Crown plus a back piece, because from inside the bowl every spectator is seen from the
 * front or three-quarters and the crown is all that reads; the back piece is what stops a
 * short crop from looking like a shaved head in silhouette. The long styles add a slab
 * down the back, which is the one hair cue that survives at fifteen metres.
 */
function hairGeometry(style: string, cfg: VenueConfig): THREE.BufferGeometry {
  const seg = Math.max(4, cfg.crowd.headSegments)
  const rings = Math.max(3, seg >> 1)
  const parts: THREE.BufferGeometry[] = []

  const crown = new THREE.SphereGeometry(RIG.headRadius * 1.06, seg, rings, 0, Math.PI * 2, 0, Math.PI * 0.56)
  crown.scale(0.95, 1.12, 0.95)
  crown.translate(0, RIG.neckY + RIG.headRadius * 0.82, 0)
  parts.push(crown)

  const back = new THREE.BoxGeometry(RIG.headRadius * 1.7, RIG.headRadius * 1.5, RIG.headRadius * 0.7)
  back.translate(0, RIG.neckY + RIG.headRadius * 0.95, -RIG.headRadius * 0.5)
  parts.push(back)

  if (style === 'long' || style === 'bob') {
    const len = style === 'long' ? RIG.headRadius * 3.4 : RIG.headRadius * 1.9
    const slab = new THREE.BoxGeometry(RIG.headRadius * 1.75, len, RIG.headRadius * 0.8)
    slab.translate(0, RIG.neckY + RIG.headRadius * 0.7 - len / 2, -RIG.headRadius * 0.55)
    parts.push(slab)
  }
  if (style === 'bun') {
    const bun = new THREE.SphereGeometry(RIG.headRadius * 0.55, seg, rings)
    bun.translate(0, RIG.neckY + RIG.headRadius * 2.15, -RIG.headRadius * 0.7)
    parts.push(bun)
  }

  const merged = mergeGeometries(parts)
  for (const part of parts) part.dispose()
  if (!merged) throw new Error('audience: hair geometry failed to merge')
  merged.computeBoundingSphere()
  return merged
}

/** Deterministic per-person randomness, so the same bowl fills the same way twice. */
function makeRandom(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    // xorshift32: a few lines, no dependency, and identical output on every browser.
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }
}

function pick<T>(rand: () => number, list: readonly T[]): T {
  return list[Math.min(list.length - 1, Math.floor(rand() * list.length))] as T
}

/**
 * The crowd when it is switched off: a group nothing is added to, and calls that do
 * nothing.
 *
 * Returned rather than throwing so every caller keeps one code path — the scene adds
 * `group` to the arena and steps, applauds and disposes without asking whether there is
 * anybody there.
 */
function emptyAudience(group: THREE.Group): Audience {
  return {
    group,
    step(): void {},
    applaud(): void {},
    clapping(): number {
      return 0
    },
    size(): number {
      return 0
    },
    dispose(): void {}
  }
}

/**
 * A crowd, standing on the seats it is given.
 *
 * `seats` is the arena's own seat plan, so everybody is in a chair rather than near one.
 * Empty seats are dropped rather than hidden: an instanced mesh costs nothing extra for a
 * gap in it, and a mesh sized to the whole bowl would cost those transforms forever.
 */
export function buildAudience(seats: readonly ArenaSeatPlacement[], config: VenueConfig = VENUE_CONFIG): Audience {
  const cfg = config.crowd
  const group = new THREE.Group()
  group.name = 'audience'
  if (!cfg.enabled) return emptyAudience(group)
  const rand = makeRandom(cfg.seed)

  const styleOf = Math.max(0, HAIR_STYLES.indexOf(cfg.hairStyles as (typeof HAIR_STYLES)[number]))
  const people: Spectator[] = []
  const perStyle = [0, 0, 0, 0]
  for (const seat of seats) {
    if (rand() > cfg.occupancy) continue
    const [minH, maxH] = cfg.heightRange
    // One style drawn for most people, the rest spread over the other three, which is what
    // a crowd actually looks like: a lot of the same and a few that are not.
    const style = rand() < 0.5 ? styleOf : Math.floor(rand() * HAIR_STYLES.length) % HAIR_STYLES.length
    people.push({
      x: seat.x,
      y: seat.y,
      z: seat.z,
      // Seats are laid out with +Z pointing out of the bowl, so a spectator turns a
      // half-circle to face the table, plus whatever they were doing instead.
      rotY: seat.rotY + Math.PI + (rand() - 0.5) * 0.5,
      scale: minH + rand() * (maxH - minH),
      phase: rand() * Math.PI * 2,
      phase2: rand() * Math.PI * 2,
      vigour: 0.55 + rand() * 0.45,
      hairStyle: style,
      hairSlot: perStyle[style] ?? 0
    })
    perStyle[style] = (perStyle[style] ?? 0) + 1
  }

  const count = people.length
  const bodyGeo = torsoGeometry()
  const headGeo = headGeometry(config)
  const armGeo = armGeometry()
  const hairGeos = HAIR_STYLES.map((style) => hairGeometry(style, config))

  const bodyMat = new THREE.MeshLambertMaterial({ color: '#ffffff' })
  const headMat = new THREE.MeshLambertMaterial({ color: '#ffffff' })
  const hairMat = new THREE.MeshLambertMaterial({ color: '#ffffff' })

  const bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, count)
  const heads = new THREE.InstancedMesh(headGeo, headMat, count)
  const armL = new THREE.InstancedMesh(armGeo, bodyMat, count)
  const armR = new THREE.InstancedMesh(armGeo, bodyMat, count)
  const hairMeshes = hairGeos.map((geo, i) => new THREE.InstancedMesh(geo, hairMat, perStyle[i] ?? 0))

  const all: THREE.InstancedMesh[] = [bodies, heads, armL, armR, ...hairMeshes]
  const named: Array<[string, THREE.InstancedMesh]> = [
    ['bodies', bodies],
    ['heads', heads],
    ['arm-left', armL],
    ['arm-right', armR],
    ...hairMeshes.map((mesh, i): [string, THREE.InstancedMesh] => [`hair-${HAIR_STYLES[i]}`, mesh])
  ]
  for (const [name, mesh] of named) {
    mesh.name = `audience-${name}`
    // The lamp's shadow map is baked once over the static set, so anything casting here
    // would either be missing from that bake or would cost a pass nobody asked for.
    mesh.castShadow = cfg.castShadows
    mesh.receiveShadow = cfg.receiveShadows
    // The bowl surrounds the camera, so this is drawn whenever the camera is drawn.
    // Saying so up front skips a bounding-sphere test that could never reject it.
    mesh.frustumCulled = false
    group.add(mesh)
  }

  const clothing = cfg.clothing.map((hex) => new THREE.Color(hex))
  const skins = cfg.skinTones.map((hex) => new THREE.Color(hex))
  const hairColours = cfg.hairColors.map((hex) => new THREE.Color(hex))
  const tint = new THREE.Color()

  people.forEach((p, i) => {
    tint.copy(pick(rand, clothing)).multiplyScalar(0.84 + rand() * 0.3)
    bodies.setColorAt(i, tint)
    armL.setColorAt(i, tint)
    armR.setColorAt(i, tint)
    tint.copy(pick(rand, skins))
    heads.setColorAt(i, tint)
    // Hair brightness rides the same number that picked the colour, so a pale head of
    // hair does not land on one person and a dark one on everybody else.
    tint.copy(pick(rand, hairColours)).multiplyScalar(0.78 + rand() * 0.44)
    hairMeshes[p.hairStyle]?.setColorAt(p.hairSlot, tint)
  })
  for (const mesh of all) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true

  /* --- animation ---------------------------------------------------- */

  const bodyM = new THREE.Matrix4()
  const headM = new THREE.Matrix4()
  const armM = new THREE.Matrix4()
  const tmpM = new THREE.Matrix4()
  const quat = new THREE.Quaternion()
  const euler = new THREE.Euler()
  const pos = new THREE.Vector3()
  const one = new THREE.Vector3(1, 1, 1)

  const sway = cfg.swayDeg * DEG
  const swayRate = cfg.swayRateHz * Math.PI * 2
  const clap = cfg.clap
  const raise = clap.armRaiseDeg * DEG
  const inward = raise * clap.armInward
  const clapRate = clap.rateHz * Math.PI * 2
  const idleInterval = 1 / Math.max(1, cfg.idleUpdateHz)
  const busyInterval = 1 / Math.max(1, cfg.clapUpdateHz)

  let clock = 0
  let clapLeft = 0
  let clapGain = 1
  let accumulator = 0

  /**
   * One spectator's six matrices.
   *
   * Read top to bottom this is the whole animation: a slow lean, a breath, and — while
   * the crowd is clapping — a bounce and an arm swing. Head and hair ride the body
   * matrix rather than being posed again, which is why a person costs one compose and two
   * multiplies instead of six from scratch.
   */
  const pose = (p: Spectator, i: number, t: number): void => {
    const lean0 = sin(t * swayRate + p.phase) * sway
    const breath = sin(t * 0.9 + p.phase2) * cfg.breathMm

    let bounce = 0
    let lean = 0
    let swing = 0
    if (clapLeft > 0) {
      // Everybody claps on their own phase and at their own vigour, so the bowl shimmers
      // instead of pulsing as one thing.
      const amount = (0.5 + 0.5 * sin(t * clapRate + p.phase * 3.1)) * p.vigour * clapGain
      swing = raise * amount
      bounce = clap.bounceMm * amount
      lean = clap.leanDeg * DEG * amount
    }

    pos.set(p.x, p.y + breath + bounce, p.z)
    euler.set(lean, p.rotY + lean0 * 0.6, lean0)
    quat.setFromEuler(euler)
    bodyM.compose(pos, quat, one).multiplyScalar(p.scale)

    // A nod of its own, so the head is not welded to the shoulders.
    headM.copy(bodyM).multiply(tmpM.makeTranslation(0, sin(t * 1.35 + p.phase) * 4, 0))

    bodies.setMatrixAt(i, bodyM)
    heads.setMatrixAt(i, headM)
    hairMeshes[p.hairStyle]?.setMatrixAt(p.hairSlot, headM)

    // The arm: a rotation about the shoulder, swung forward and inward. Forward is the
    // negative X turn, because the arm hangs down the -Y axis and a positive turn would
    // take it backwards. Inward is the Z turn, mirrored between the arms by the sign.
    for (let side = 0; side < 2; side++) {
      const sign = side === 0 ? 1 : -1
      armM.makeRotationX(-swing)
      if (swing > 0) armM.multiply(tmpM.makeRotationZ(-inward * sign))
      armM.premultiply(tmpM.makeTranslation(RIG.armOffset * sign * p.scale, RIG.shoulderY * p.scale, 0))
      armM.premultiply(bodyM)
      if (side === 0) armL.setMatrixAt(i, armM)
      else armR.setMatrixAt(i, armM)
    }
  }

  // Poses the crowd once up front, so the bowl is populated on the very first frame
  // rather than filling in as it is first stepped.
  for (let i = 0; i < count; i++) pose(people[i] as Spectator, i, 0)
  // And says so. The buffers are new and would be uploaded on first use anyway, but
  // leaving that to an implementation detail is how a crowd ends up standing at the
  // origin for a frame.
  for (const mesh of all) mesh.instanceMatrix.needsUpdate = true

  return {
    group,
    step(dt: number): void {
      if (count === 0) return
      clapLeft = Math.max(0, clapLeft - dt)
      clock += dt
      accumulator += dt
      if (accumulator < (clapLeft > 0 ? busyInterval : idleInterval)) return
      accumulator = 0
      for (let i = 0; i < count; i++) pose(people[i] as Spectator, i, clock)
      for (const mesh of all) mesh.instanceMatrix.needsUpdate = true
    },
    applaud(seconds: number, intensity = 1): void {
      clapLeft = Math.max(clapLeft, Math.max(0, seconds))
      // Heavier clapping is a bigger swing and a bigger bounce, not a faster one: a crowd
      // that changes tempo reads as a different crowd.
      clapGain = Math.min(1.6, Math.max(0.6, intensity))
    },
    clapping(): number {
      return clapLeft
    },
    size(): number {
      return count
    },
    dispose(): void {
      for (const mesh of all) {
        group.remove(mesh)
        mesh.dispose()
      }
      bodyGeo.dispose()
      headGeo.dispose()
      armGeo.dispose()
      for (const geo of hairGeos) geo.dispose()
      bodyMat.dispose()
      headMat.dispose()
      hairMat.dispose()
    }
  }
}