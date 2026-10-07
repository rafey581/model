import * as THREE from 'three'
import { APRON_OUTER_L } from './tableGeometry.js'
import { ARENA_CONFIG } from './arenaConfig.js'

/**
 * The champion's trophy: a plinth on the carpet beside the table, inside the ring of
 * hoardings, with a gold cup on it.
 *
 * It exists because a dark, near-empty hall needs one thing in it that is not structure —
 * something for the eye to land on between frames, and the only object in the venue that
 * is deliberately not furniture. Two meshes, no lights, no movement, built once inside the
 * arena's matrix freeze like everything else that never moves.
 */

/** How far the plinth's centre sits past the table's apron edge, along the length axis. */
export const TROPHY_PAST_APRON = 1400
/** Side offset: off the table's centre line, so it never sits in a shot down the table. */
export const TROPHY_Z = 900
/** Radius of the plinth, and the clearance we measure off its inner face. */
export const TROPHY_PLINTH_RADIUS = 300
/** Height of the plinth above the carpet, so the cup sits at eye level from the play pose. */
export const TROPHY_PLINTH_HEIGHT = 1100

/** The plinth's centre in world space, worked out from the apron rather than hard-coded. */
export function trophyPosition(): { x: number; z: number } {
  return { x: APRON_OUTER_L / 2 + TROPHY_PAST_APRON, z: TROPHY_Z }
}

/**
 * Clear space between the plinth's inner face and the apron edge, measured along the
 * length axis with the side offset inside the apron's own width — which it is, because
 * 900 < APRON_OUTER_W / 2, so the nearest apron point is straight across.
 *
 * The spec asks for 1500; this lands at 1100 and the deviation is reported rather than
 * papered over by moving the trophy off its specified spot.
 */
export function trophyApronClearance(): number {
  return TROPHY_PAST_APRON - TROPHY_PLINTH_RADIUS
}

/** The cup: one lathed shell, open at the axis so the inside of the bowl is real. */
function cupGeometry(): THREE.BufferGeometry {
  const profile: [number, number][] = [
    [0, 0],
    [230, 0],
    [240, 30],
    [150, 70],
    [95, 150],
    [80, 260],
    [120, 330],
    [170, 380],
    [250, 500],
    [300, 640],
    [315, 700],
    [300, 700],
    [272, 560],
    [205, 430],
    [150, 380],
    [0, 350]
  ]
  const points = profile.map(([x, y]) => new THREE.Vector2(x, y))
  const geo = new THREE.LatheGeometry(points, 32)
  geo.computeVertexNormals()
  return geo
}

/** The plinth and the cup, as one group ready to be added to the arena. */
export function buildTrophy(): THREE.Group {
  const group = new THREE.Group()
  group.name = 'trophy'

  const stone = new THREE.MeshStandardMaterial({ color: '#12161f', roughness: 0.9, metalness: 0, envMapIntensity: 0.2 })
  const gold = new THREE.MeshStandardMaterial({
    color: '#d8b04a',
    roughness: 0.35,
    metalness: 0.8,
    envMapIntensity: 0.3,
    side: THREE.DoubleSide
  })

  const carpetY = ARENA_CONFIG.carpetY
  const plinth = new THREE.Mesh(
    new THREE.CylinderGeometry(TROPHY_PLINTH_RADIUS, TROPHY_PLINTH_RADIUS + 40, TROPHY_PLINTH_HEIGHT, 32),
    stone
  )
  plinth.position.set(0, carpetY + TROPHY_PLINTH_HEIGHT / 2, 0)

  const cup = new THREE.Mesh(cupGeometry(), gold)
  cup.position.set(0, carpetY + TROPHY_PLINTH_HEIGHT, 0)

  const at = trophyPosition()
  group.position.set(at.x, 0, at.z)
  group.add(plinth, cup)
  return group
}
