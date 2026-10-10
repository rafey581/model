import * as THREE from 'three'
import { BALL_IDS, TABLE_LENGTH, TABLE_WIDTH, BALL_RADIUS, BAULK_LINE_X, D_RADIUS, POCKET_RADIUS_CORNER, POCKET_RADIUS_MIDDLE, pocketPositions } from '@snooker/shared'
import type { FrameSnapshotData, AimState, RenderOptions } from './renderer.js'
import {
  aimLineWorldWidth,
  computeAimGuide,
  shotLineLayout,
  shotLineLayoutTarget,
  type AimGuide,
  type AimGuideBall,
  type ShotLineLayout
} from './aim.js'
import { setTableTransform } from './renderer.js'
import { buildArenaEnvironment, hideLegacyRoom } from './arenaEnvironment.js'
import type { ArenaSeatPlacement } from './arenaEnvironment.js'
import { ARENA_CONFIG, applyArenaQuality } from './arenaConfig.js'
import { buildCueStick } from './cueStick.js'
import { readOpponentShot, buildVenueEvents, type VenueEvents, type VenueHost } from './venueEvents.js'
import type { OpponentShot } from './opponentCue.js'
import type { ShotPlayback } from '@snooker/shared'
import { ballColor } from './palette.js'
import {
  createColouredBallMaterial,
  createCueBallMaterial,
  cueShadowPixels,
  CUE_SHADOW_OFFSET_MM,
  CUE_SHADOW_PLANE,
  CUE_SHADOW_STRETCH,
  CUE_SHADOW_TEXTURE_SIZE,
  CUE_SHADOW_Y_MM
} from './ballVisuals.js'
import { qualityConfig } from './qualityConfig.js'
import {
  brassRoughnessTexture,
  CLOTH_COLOR_MID,
  cushionFeltTexture,
  disposeTableTextures,
  feltNormalTexture,
  feltTexture,
  leatherAlbedoTexture,
  leatherNormalTexture,
  leatherRoughnessTexture,
  pocketDepthTexture,
  setTableAnisotropy,
  woodNormalTexture,
  woodRoughnessTexture,
  woodTexture
} from './tableTextures.js'
const SHOW_CROWN_MOULDING = false
// The crowd went with the old arena: the dark bowl stands empty, and an empty seat plan is
// how the venue says so (venueEvents builds no people when it gets none).
const SHOW_OLD_AUDIENCE = false
/**
 * How close to the aim view's own height the lens has to be before it counts as having
 * arrived there, in millimetres. Every other view sits far higher, so height alone tells
 * a camera that is panning round the cue ball from one that is still flying in.
 */
const AIM_SETTLED_HEIGHT_MM = 40
/** How bright the arena's materials are drawn once they are unlit, against their own colour. */
const ENVIRONMENT_UNLIT_LEVEL = 0.5
/** How much the ambient light is raised when the stand washes are switched off. */
const ENVIRONMENT_LOW_AMBIENT_LIFT = 1.35
import {
  type CameraRigState,
  type HeadingLatch,
  type PlacementTransition,
  type PlayerCameraMode,
  initialRigState,
  initialHeadingLatch,
  stepCameraRig,
  stepHeadingLatch,
  addOrbit,
  noPlacementTransition,
  beginPlacementTransition,
  stepPlacementTransition,
  placementTransitionEndPose,
  topDownPose,
  aimPose,
  aimFovDeg,
  resolveCameraTarget,
  followHeadingLatch,
  latchedCameraYaw,
  PLACEMENT_TRANSITION_SECONDS,
  type CameraPose
} from './camera.js'
import {
  SPECTATOR_CAM,
  addressHeading,
  beginSpectatorTransition,
  fitSpectatorCamera,
  nextSpectating,
  stepSpectatorTransition
} from './spectatorCamera.js'
import {
  ballRadiusPx,
  ndcToPixel,
  pickCameraAt,
  pickCameraFromWorldMatrix,
  pixelToNdc,
  projectToNdc,
  screenToTable,
  type PickCamera
} from './cameraPick.js'
import { placementStatus } from './placement.js'
import {
  APRON_OUTER_L,
  APRON_OUTER_W,
  APRON_PAD,
  CUSHION_H as CUSHION_H_MM,
  cushionLayout,
  cushionTransform,
  makeBeadGeometry,
  makeCushionGeometry,
  makeRailCapGeometry,
  trimTransform,
  CUSHION_DEPTH
} from './tableGeometry.js'
import { makeJawGeometry, jawSpecs, makePocketNetGeometry, pocketNetAlphaTexture } from './pocketGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {
  TABLE_LEGS_SUFFIX, instantiateTableModel, tableModelIfReady, type TableMaterials } from './tableModel.js'

const HALF_L = TABLE_LENGTH / 2
const HALF_W = TABLE_WIDTH / 2

/** Optional hooks for Scene3D.create — omit for identical legacy behaviour. */
export interface Scene3DCreateOptions {
  onBuildProgress?: (fraction: number) => void
  /**
   * The parsed Blender table to build the scene from, or null to force the
   * code-built table. Omit it and Scene3D uses whatever `preloadTableModel()`
   * has finished loading (`tableModelIfReady()`), which is the online path:
   * there is no async window there, so the download is kicked off at boot
   * instead.
   */
  tableModel?: THREE.Group | null
}

/** Progress phases reported by Scene3D.warmUp. */
export type WarmUpPhase = 'textures' | 'shaders' | 'bakes' | 'warmup'

function yieldMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 16)
  })
}
/** Kept as an alias so the scene's own reads stay terse; the value lives with the geometry. */
const CUSHION_H = CUSHION_H_MM
/**
 * The perspective camera's near plane, in millimetres.
 *
 * Perspective depth precision scales as z²/near, so this number governs whether the
 * bed's own coplanar surfaces can be told apart. The bed's tightest pair is the cloth
 * plane at y=0 and the apron box's top face at y=-1 — the apron is 64mm wider and
 * longer than the cloth, so that face underlies the whole playing surface — which is a
 * 1mm gap. It has to stay resolvable at the overhead camera's ~4.5m, the farthest the
 * rig ever gets and where z² is at its worst.
 *
 * This was 0.1, which is far closer than anything ever needs to be seen: the nearest
 * geometry is a cue butt on its way out of frame, or a cushion nose at
 * MIN_CAMERA_HEIGHT_MM=140. A 0.1mm near spent effectively the whole depth buffer on
 * the first few millimetres in front of the lens — about 12mm of granularity at 4.5m,
 * so the 1mm gap was 12x finer than a single depth step and the depth test became a
 * coin flip. The mahogany apron punched through the green cloth in dark bands that
 * flickered as the camera moved: unreadable at the 90-degree overhead view, and
 * invisible from the cue camera, where the same buffer resolved 0.073mm and left a
 * comfortable 13x margin. 20mm still holds every such surface inside the frustum and
 * resolves ~0.06mm at the overhead distance, a 16x margin that no pose in the rig can
 * spend. Kept as a named constant because `selfCheck` asserts against it.
 */
const CAMERA_NEAR_MM = 20
/**
 * The cue tip's position in the stick's own space. The stick's origin sits at the
 * centre of the shaft, so the tip is well short of half the length: with the
 * ferrule (to 627) and the chalk tip (to 641) crowning the shaft, the striking
 * end is at 641mm forward. Backing the stick off by half the length instead of by
 * this number left the tip floating a ball's width or more away from the ball it
 * was addressing.
 */
const STICK_TIP_Y = 641
/** How far the tip pulls back from the ball at rest, before any power draw-back. */
const STICK_REST_GAP = 8
/** How far the tip draws back at full power, as the player loads the shot. */
const STICK_POWER_DRAW = 190
const tableX = (x: number): number => x - HALF_L
const tableZ = (y: number): number => y - HALF_W
/** Stands in for an undrawn table, so the camera's per-frame walk allocates nothing. */
const NO_BALLS: readonly FrameSnapshotData['balls'][number][] = []
/**
 * How far below its resting height a ball starts its rise back onto the cloth.
 *
 * The same depth the sink drops through, and both are driven at the same rate, so a ball
 * that goes down and comes back spends equal time doing each.
 */
const RISE_DEPTH = 34
/** The scale a ball starts its rise at, growing to full size as it reaches the cloth. */
const RISE_START_SCALE = 0.6

const textureCache = new Map<string, THREE.CanvasTexture>()

function cachedTexture(key: string, make: () => THREE.CanvasTexture): THREE.CanvasTexture {
  let tex = textureCache.get(key)
  if (!tex) {
    tex = make()
    textureCache.set(key, tex)
  }
  return tex
}
function pocketKey(p: ReturnType<typeof pocketPositions>[number]): string {
  return `${Math.round(p.x)}_${Math.round(p.y)}_${p.radius}`
}

const POCKETS = pocketPositions()

/**
 * A single shared anisotropy cap, set once when the renderer exists.
 *
 * Conservative on purpose — 4096 is where a grazing cue-view angle stops shimmering
 * and a weak GPU stops paying for the wider sampling footprint. Captured rather
 * than queried per texture, because the answer never changes.
 */
let MAX_ANISO = 4

/*
 * The room and its palette. Every colour the light lands on, in one place.
 *
 * The look is the bright broadcast one: a saturated green bed under one strong warm
 * lamp, dark polished rails around it, and behind all that a blue room that falls
 * away to navy. The table is the subject of the picture; the room is its backdrop.
 */
/** The scene's clear colour: dark navy, the top of the room's gradient. */
const ROOM_BG_COLOR = '#10235a'
/** What the camera sees past the edge of the carpet: the darkened hall itself. */
const ROOM_DARK_COLOR = '#04060d'
/** Gentle exponential fog in the room's own colour, per millimetre. Nothing at gameplay distances, a fade at the far wall. */
const ROOM_FOG_DENSITY = 0.00004
/** The blue the wall is painted at its brightest. */
const ROOM_WALL_COLOR = '#1b4bb0'
/** The navy the wall fades to at the top. */
const ROOM_WALL_TOP_COLOR = '#0b1a45'
/** The floor: dark, so the lit table is the subject of the picture. */
const ROOM_FLOOR_COLOR = '#9a3340'
/** The bed's colour: deep tournament snooker green. */
const CLOTH_COLOR = '#1a8f25'

/** How much of the cushions' shared normal map is left standing. */
const CUSHION_NORMAL_STRENGTH = 0.12
/** Cushion cloth: a brighter green than the bed so the raised edge reads. */
const CUSHION_COLOR = 0x189a42
/** The cushion nose strip: brighter still, catching the lamp. */
const NOSE_COLOR = 0x24b852

/*
 * STEP 3 — the balls, their contact with the cloth, and the cue stick.
 */
/** Ball resin: tight diffuse under the lacquer film. */
// Renderer/tone mapping — ACES for rich filmic contrast; Neutral remains an A/B flag.
const TONE_MAPPING_MODE: 'neutral' | 'aces' = 'aces'
const TONE_EXPOSURE = 1.06

/** The table lamp: warm white, a cone wide enough to hold the corners, no distance falloff. */
const LAMP_COLOR = 0xfff0dc
const LAMP_INTENSITY = 1.5
const LAMP_ANGLE = Math.PI / 3.2
const LAMP_PENUMBRA = 0.4

// Wood / rails
const RAIL_WOOD_TINT = '#5a2520'
const APRON_SIDE_TINT = '#4a1d1a'

// Cushions — one step darker so they sit against the deeper bed without glowing.
const CUSHION_FACE_COLOR = '#0e5e2e'
const CUSHION_TOP_COLOR = '#1fae4a'
const CUSHION_NOSE_COLOR = '#2bc75a'

// Cloth / baize — Tournament Snooker Green with darker corner falloff.
const CLOTH_ROUGHNESS = 0.9
const CLOTH_METALNESS = 0
const CLOTH_SHEEN = 0.14
const CLOTH_SHEEN_COLOR = '#35b045'
const CLOTH_SHEEN_ROUGHNESS = 0.62
const CLOTH_NORMAL_STRENGTH = 0.13

/** The contact disc's size, as a multiple of the ball's radius. */
const BALL_SHADOW_PLANE = 2.4
/** The contact disc's height above the cloth, in millimetres. */
const BALL_SHADOW_Y = 0.5
/** How far the contact disc leans off the ball's centre, away from the lamp overhead. */
const BALL_SHADOW_LEAN_MM = 2.5
/** The contact disc's stretch along that lean. */
const BALL_SHADOW_STRETCH = 1.15
/** The stick's shadow strip on the cloth, in millimetres across. Thinner than cue butt (13mm vs 26mm). */
const STICK_SHADOW_WIDTH = 13
/** The stick's shadow color on the cloth (pure black). */
const STICK_SHADOW_COLOR = 0x000000
/** Opacity of the stick's shadow strip. */
const STICK_SHADOW_OPACITY = 0.25
/** How fast the stick's shadow fades in and out, per second. */
const STICK_SHADOW_FADE_RATE = 14

const SHADOW_STRETCH = 1.25
const SHADOW_OFFSET_MM = 3
const SHADOW_ALPHA = 0.65
const SHADOW_CORE_ALPHA = 0.85

const POCKET_HOLE_SCALE = 0.95
const POCKET_HOLE_Y_MM = 0.9
const POCKET_PLATE_COLOR = '#d9cfb4'
const POCKET_PLATE_Y_MM = 2
const POCKET_PLATE_EXTRA_MM = 60
const POCKET_NET_COLOR = '#c9bf9f'
const POCKET_CUT_EXTRA_MM = 40
const RAIL_TOP_HEIGHT_MM = 55
const POCKET_FLOOR_Y_MM = -0.5
const POCKET_LIP_COLOR = '#d9cfb4'
/** The cream cap ringing every pocket mouth: warm off-white, satin. */
const POCKET_RIM_COLOR = '#e9dfc6'
/** How far the cream cap reaches out from the physics pocket radius, in mm. */
const POCKET_RIM_WIDTH_MM = 26
/** How tall the cream cap stands above its own base, in mm. */
const POCKET_RIM_HEIGHT_MM = 10
/** Thin brass outer ring: major radius offset from the cream rim's outer edge, in mm. */
const POCKET_BRASS_RING_INSET_MM = 3
/** Brass torus tube radius, in mm. */
const POCKET_BRASS_TUBE_MM = 2.2
/** The dark jaali hanging inside the pocket cavity. */
const POCKET_NET_DARK_COLOR = '#14100c'
/** How far the jaali hangs below the cloth, in mm. */
const POCKET_NET_DROP_MM = 66
/**
 * How deep the modelled pocket bowl goes below the cloth, in mm. Deep enough that the
 * gradient has somewhere to fall off to, shallow enough that the net inside it is still
 * lit by the table lamps at the normal playing camera angle.
 */
const POCKET_BOWL_DEPTH_MM = 46
/** The bowl narrows from the physics radius down to this at its bottom. */
const POCKET_BOWL_THROAT_MM = 30
/** How far down the bowl the jaali sits, and how wide it is there. */
const POCKET_NET_DEPTH_MM = 34
const POCKET_NET_RADIUS_MM = 34
/**
 * The arc, in degrees, that the green jaw covers where a cushion meets the pocket. A
 * cushion meets a corner pocket on two axes, so each corner gets two of these.
 */
const POCKET_JAW_ARC_DEG = 50
/** How high the jaw stands proud of the cloth where it meets the cushion. */
const POCKET_JAW_RISE_MM = 16
/** The radius the jaw reaches as it rises, i.e. how far it leans out over the bowl. */
const POCKET_JAW_REACH_MM = 60
/** Build the detailed bowl/net/jaw on every pocket. */
const POCKET_DETAIL_ALL = true
/**
 * How finely the bed's outline is sampled while the pocket notches are cut into it, in mm.
 * Finer than this buys nothing visible on a 48mm radius and costs outline points.
 */
const BED_NOTCH_STEP_MM = 2
/**
 * The jaw's cross-section in (radius, height), walked out from the bowl lip and back down
 * to it so the arc is a closed shell with an underside rather than a single-sided flap.
 * The inner edge is the physics radius itself - the nose rolls over the lip but the drawn
 * mouth never narrows below where the ball actually drops.
 */
function jawProfile(radius: number): THREE.Vector2[] {
  const reach = Math.max(POCKET_JAW_REACH_MM, radius + 12)
  return [
    new THREE.Vector2(radius, 0),
    new THREE.Vector2(radius + 1.5, 5),
    new THREE.Vector2(radius + 5.5, 10),
    new THREE.Vector2(reach, POCKET_JAW_RISE_MM),
    new THREE.Vector2(reach - 3, POCKET_JAW_RISE_MM - 4),
    new THREE.Vector2(radius + 6, 3),
    new THREE.Vector2(radius, 0)
  ]
}
/** A jaw arc centred on `deg` degrees, where 0 is +Z and 90 is +X. */
const jawPhi = (deg: number): number =>
  THREE.MathUtils.degToRad(deg - POCKET_JAW_ARC_DEG / 2)
/** The arc's width, shared by all twelve jaw arcs so they are identical. */
const jawArc = (): number => THREE.MathUtils.degToRad(POCKET_JAW_ARC_DEG)
const POCKET_LIP_WIDTH_MM = 14
const POCKET_LIP_HEIGHT_MM = 3
const SHOW_OLD_POCKET_PLATES = false
/** The old brown leather torus ring around each pocket mouth. Off: replaced by the cream rim. */
const SHOW_POCKET_LIP_RING = false
/** The old flat cream ShapeGeometry plate lying across the table at each pocket. Off: replaced by the bed opening. */
const SHOW_POCKET_FLAT_PLATE = false
const RAIL_WOOD_UV_TILE_MM = 500

/*
 * STEP 4 — the aim guide: thin soft ribbons on the cloth and one hollow ring.
 *
 * Every line holds the same screen thickness, worked out per frame from the
 * lens (see `aimLineWorldWidth`), so a broadcast-style two-pixel line stays two
 * pixels from the cue camera and from the overhead one alike. Widths are not
 * named in millimetres for that reason: the millimetres are computed.
 */
/** The ribbons' height above the cloth, in millimetres. */
const AIM_RIBBON_Y = 0.5
/** LINE 1 — cue path: solid white rectangular strip to ghost ball or cushion. */
const AIM_LINE1_COLOR = 0xffffff
const AIM_LINE1_OPACITY = 0.62
/** The contact ring — hollow, the size of the ball it wraps, nothing inside. */
const AIM_RING_COLOR = 0xffffff
const AIM_RING_OPACITY = 0.6
const AIM_RING_STROKE_MM = 1.8
const AIM_RING_Y = 1.1
/** LINE 2 — object ball path along the line of centres: neon green. */
const AIM_LINE2_COLOR = 0x46e868
const AIM_LINE2_LENGTH = BALL_RADIUS * 22
const AIM_LINE2_OPACITY = 0.85
/** LINE 3 — cue ball deflection after contact: solid white. */
const AIM_LINE3_COLOR = 0xffffff
const AIM_LINE3_LENGTH = BALL_RADIUS * 14
const AIM_LINE3_OPACITY = 0.5
/** The shortest either departure line is drawn, as a share of its full length. */
const AIM_LINE_MIN_SHARE = 0.14
/** How much of the way to its new length a line moves each frame. */
const AIM_LINE_EASE = 0.16


function contactShadowTexture(): THREE.CanvasTexture {
  return cachedTexture('shadow', () => {
    const size = 128
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    grad.addColorStop(0, 'rgba(0,0,0,0.85)')
    grad.addColorStop(0.55, 'rgba(0,0,0,0.85)')
    grad.addColorStop(0.67, 'rgba(0,0,0,0.7)')
    grad.addColorStop(0.8, 'rgba(0,0,0,0.3)')
    grad.addColorStop(0.9, 'rgba(0,0,0,0.08)')
    grad.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
    return new THREE.CanvasTexture(canvas)
  })
}

/**
 * The cue ball's own contact shadow: a softer, wider falloff than the shared ball
 * shadow, so the ball is grounded without ever reading as a black disc under it.
 * The darkest point stays small and right at the contact, and the edge dissolves to
 * nothing well inside the disc's rim.
 */
function cueContactShadowTexture(): THREE.CanvasTexture {
  return cachedTexture('cue-shadow', () => {
    const size = CUE_SHADOW_TEXTURE_SIZE
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const img = ctx.createImageData(size, size)
    img.data.set(cueShadowPixels(size))
    ctx.putImageData(img, 0, 0)
    return new THREE.CanvasTexture(canvas)
  })
}

/**
 * The stick's shadow strip: soft edges across width, fading along the length.
 * Fades to nothing at the butt end (u=0) and dissolves before touching the cue ball (u=1).
 * Black pixels with alpha channel doing all attenuation.
 */
function stickShadowTexture(): THREE.CanvasTexture {
  return cachedTexture('stick-shadow', () => {
    const w = 256
    const h = 64
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    const img = ctx.createImageData(w, h)
    const d = img.data
    for (let y = 0; y < h; y++) {
      const v = y / (h - 1)
      const across = Math.sin(v * Math.PI)
      for (let x = 0; x < w; x++) {
        const u = x / (w - 1)
        let along = 0
        if (u < 0.8) {
          const t = u / 0.8
          along = t * t * (3 - 2 * t)
        } else {
          const t = (1 - u) / 0.2
          along = t * t * (3 - 2 * t)
        }
        const a = Math.round(255 * across * along)
        const i = (y * w + x) * 4
        d[i] = 0
        d[i + 1] = 0
        d[i + 2] = 0
        d[i + 3] = a
      }
    }
    ctx.putImageData(img, 0, 0)
    return new THREE.CanvasTexture(canvas)
  })
}

/**
 * Solid rectangular aim strip: full opaque white, no edge feather or length fade.
 * Tint comes from MeshBasicMaterial.color (white cue path / neon object path).
 */
function aimRibbonSolidTexture(): THREE.CanvasTexture {
  return cachedTexture('aim-ribbon-solid', () => {
    // White with a feathered edge across the strip's width: solid through the middle,
    // fading out over the outer quarter on each side. A hard-edged strip stair-steps along
    // its length at a shallow angle and reads as a painted bar; the soft edge is what
    // makes it a line of light lying on the cloth.
    const w = 4
    const h = 32
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    const across = ctx.createLinearGradient(0, 0, 0, h)
    across.addColorStop(0, 'rgba(255,255,255,0)')
    across.addColorStop(0.3, 'rgba(255,255,255,1)')
    across.addColorStop(0.7, 'rgba(255,255,255,1)')
    across.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = across
    ctx.fillRect(0, 0, w, h)
    const texture = new THREE.CanvasTexture(canvas)
    texture.magFilter = THREE.LinearFilter
    texture.minFilter = THREE.LinearFilter
    texture.generateMipmaps = false
    return texture
  })
}


/**
 * The nine materials the Blender table asks for, finished as one premium table.
 *
 * The model tags each merged mesh with a material name rather than a role, so this is
 * the one place that decides what "Wood" or "JawCloth" means. The bed (`clothMat`) is
 * passed in so the model wears the same felt instance the code bed would have used —
 * its canvas carries the baulk line, the D and the spots.
 *
 * Three fixes live here rather than in the model, because the model must not be edited
 * (and because they are finish, not geometry):
 *  - the wood's envMapIntensity is pulled well down from the old mirror-like 0.5, which
 *    is what made the rail top read as a chrome streak (P3);
 *  - the cushions get the *bed's* felt and the bed's green, so the two cloths match (P4);
 *  - the pockets' leather is cream and the interior is a true black well (P1's base).
 *
 * Quality knobs read from `qualityConfig()`: the lower tiers drop the roughness and
 * normal maps that cost the most sampling.
 */
function tableMaterials(clothMat: THREE.MeshPhysicalMaterial): TableMaterials {
  const tier = qualityConfig()
  const isLow = tier.name === 'low'

  const wood = new THREE.MeshPhysicalMaterial({
    map: woodTexture(),
    color: 0xffffff,
    roughness: 0.42,
    metalness: 0,
    clearcoat: isLow ? 0 : 0.7,
    clearcoatRoughness: 0.14,
    specularIntensity: 0.5,
    // The single biggest P3 lever: high envMap on dark wood turns the rail top silver.
    envMapIntensity: 0.45
  })
  if (!isLow) wood.roughnessMap = woodRoughnessTexture()
  // The grain's relief is what stops a lacquered rail reading as brown plastic, and the
  // rails are what the player looks straight at, so every tier but the lowest has it.
  if (!isLow) {
    wood.normalMap = woodNormalTexture()
    wood.normalScale = new THREE.Vector2(0.4, 0.4)
  }

  const brass = new THREE.MeshStandardMaterial({
    color: 0xd4a64a,
    metalness: 1,
    roughness: 0.28,
    envMapIntensity: 1.3
  })
  if (!isLow) brass.roughnessMap = brassRoughnessTexture()

  const jawCloth = new THREE.MeshPhysicalMaterial({
    map: cushionFeltTexture(),
    color: new THREE.Color(CLOTH_COLOR_MID),
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
    sheen: CLOTH_SHEEN,
    sheenColor: new THREE.Color(CLOTH_SHEEN_COLOR),
    sheenRoughness: CLOTH_SHEEN_ROUGHNESS,
    side: THREE.DoubleSide,
    envMapIntensity: 0.12
  })
  if (tier.clothNormal) {
    jawCloth.normalMap = feltNormalTexture()
    jawCloth.normalScale = new THREE.Vector2(CUSHION_NORMAL_STRENGTH, CUSHION_NORMAL_STRENGTH)
  }

  const leather = new THREE.MeshPhysicalMaterial({
    map: leatherAlbedoTexture(),
    color: 0xffffff,
    roughness: 0.55,
    metalness: 0,
    sheen: 0.35,
    sheenColor: new THREE.Color('#fff3d9'),
    sheenRoughness: 0.55,
    clearcoat: 0.12,
    clearcoatRoughness: 0.4,
    envMapIntensity: 0.5
  })
  if (!isLow) {
    leather.roughnessMap = leatherRoughnessTexture()
    leather.normalMap = leatherNormalTexture()
    leather.normalScale = new THREE.Vector2(0.25, 0.25)
  }

  return {
    Wood: wood,
    Brass: brass,
    JawCloth: jawCloth,
    Leather: leather,
    NetCord: new THREE.MeshStandardMaterial({
      color: 0xf4f4f0,
      roughness: 0.85,
      metalness: 0,
      side: THREE.DoubleSide
    }),
    DarkInterior: new THREE.MeshStandardMaterial({ color: 0x060606, roughness: 1, metalness: 0, envMapIntensity: 0 }),
    Nameplate: new THREE.MeshPhysicalMaterial({
      color: 0xf3f2ee,
      roughness: 0.25,
      metalness: 0,
      clearcoat: 0.6,
      clearcoatRoughness: 0.1,
      envMapIntensity: 0.6
    }),
    Iron: new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.45, metalness: 0.8, envMapIntensity: 0.8 }),
    Cloth: clothMat
  }
}

/**
 * The jaali, painted rather than modelled: cream strings in a diamond lattice over near
 * black, so the gaps read as the dark of the drop behind them.
 *
 * Two passes per diagonal. The first is a wide, dim stroke that stands in for the string's
 * own shadow falling into the mesh; the second is the thin bright core on top. Without the
 * underlay a single stroke reads as flat white paint, and the whole point of a net is that
 * you see through it.
 */
function pocketNetTexture(): THREE.CanvasTexture {
  return cachedTexture('pocket-net', () => {
    const size = 256
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#070605'
    ctx.fillRect(0, 0, size, size)
    const pitch = size / 6
    ctx.lineCap = 'round'
    // Underlay: the soft dark edge where the cord sinks into the weave.
    ctx.strokeStyle = 'rgba(120,108,86,0.30)'
    ctx.lineWidth = 6
    for (let dir = 0; dir < 2; dir++) {
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
    // Core: the cord itself. Two slightly different creams so the lattice has some life in
    // it rather than reading as one flat printed colour.
    ctx.lineWidth = 2.4
    for (let dir = 0; dir < 2; dir++) {
      ctx.strokeStyle = dir === 0 ? '#f6efdc' : '#e8dfc6'
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
    // The knots where the cords cross, so the diamonds have something at their corners.
    ctx.fillStyle = '#fbf6e6'
    for (let dir = 0; dir < 2; dir++) {
      for (let i = 0; i <= size * 2; i += pitch) {
        const cx = dir === 0 ? (i + size) % size : (size - (i % size))
        ctx.beginPath()
        ctx.arc(cx, (i + size) % size, 1.7, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    return new THREE.CanvasTexture(canvas)
  })
}

/**
 * The bowl's inner wall shading: cream where it meets the cloth, falling to near black at
 * the throat. A lathe runs v from the first profile point to the last, so a vertical
 * gradient is all that is needed - no lighting on the inside of a hole is ever going to be
 * even, and faking it in the texture is cheaper and steadier than trying to light it.
 */
function pocketBowlShadeTexture(): THREE.CanvasTexture {
  return cachedTexture('pocket-bowl-shade', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 4
    canvas.height = 128
    const ctx = canvas.getContext('2d')!
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height)
    grad.addColorStop(0, '#efe6d0')
    grad.addColorStop(0.3, '#d8caa9')
    grad.addColorStop(0.62, '#6c5c44')
    grad.addColorStop(0.85, '#241d15')
    grad.addColorStop(1, '#0b0906')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const tex = new THREE.CanvasTexture(canvas)
    // flipY off, and this is load-bearing rather than a style preference. The lathe's v=0
    // is the profile's first point, which is the cloth edge, and canvas row 0 is the cream
    // stop. three uploads canvas textures upside down by default, so v=0 would land on row
    // 127 instead - putting the black end of the gradient at the lip, which left every
    // pocket reading as a dark hole with its cream wall hidden underneath the jaali.
    tex.flipY = false
    return tex
  })
}

function envTexture(): THREE.CanvasTexture {
  return cachedTexture('env', () => {
    const w = 1024
    const h = 512
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    const grad = ctx.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, ROOM_BG_COLOR)
    grad.addColorStop(0.42, ROOM_WALL_COLOR)
    grad.addColorStop(0.5, '#b8a57f')
    grad.addColorStop(0.58, '#3f2f20')
    grad.addColorStop(1, ROOM_FLOOR_COLOR)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)
    // Soft studio softboxes: the clearcoat on wood/balls and brass metalness both reflect
    // these. Soft elliptical lamps read as phenolic highlights; hard rectangles read as CGI.
    const softbox = (cx: number, cy: number, rw: number, rh: number, a: number): void => {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rw, rh))
      g.addColorStop(0, `rgba(255,248,226,${a})`)
      g.addColorStop(0.45, `rgba(255,240,206,${a * 0.55})`)
      g.addColorStop(1, 'rgba(255,240,206,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2)
      ctx.fill()
    }
    softbox(w * 0.5, h * 0.36, w * 0.28, 14, 0.95)
    softbox(w * 0.5, h * 0.4, w * 0.22, 8, 0.45)
    softbox(w * 0.12, h * 0.42, w * 0.08, 5, 0.35)
    softbox(w * 0.88, h * 0.42, w * 0.08, 5, 0.35)
    // The warm band where wall meets floor — the room's bounce, and what keeps the
    // underside of the rails from reflecting pure black.
    ctx.fillStyle = 'rgba(150,112,72,0.92)'
    ctx.fillRect(0, h * 0.6, w, 26)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.mapping = THREE.EquirectangularReflectionMapping
    return texture
  })
}

/**
 * The back wall: blue paint, brightest at the height the lamp reaches, falling to
 * navy at the top, with the pool of light the table throws behind it.
 *
 * One small canvas rather than geometry: the gradient and the pool are the whole
 * look of the room, and a texture costs one draw call and no extra meshes.
 */
function wallTexture(): THREE.CanvasTexture {
  return cachedTexture('wall', () => {
    const w = 512
    const h = 256
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    // Vertical: navy at the ceiling fading into the blue below, so the room reads
    // as lit from the table rather than from the sky.
    const grad = ctx.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, ROOM_WALL_TOP_COLOR)
    grad.addColorStop(0.55, ROOM_WALL_COLOR)
    grad.addColorStop(1, ROOM_WALL_COLOR)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)
    // The pool of light the table's lamp throws on the wall: one soft ellipse
    // behind the table, brighter than the paint but never a blown highlight.
    const pool = ctx.createRadialGradient(w / 2, h * 0.62, 10, w / 2, h * 0.62, w * 0.34)
    pool.addColorStop(0, 'rgba(190,215,255,0.5)')
    pool.addColorStop(0.5, 'rgba(120,160,240,0.22)')
    pool.addColorStop(1, 'rgba(120,160,240,0)')
    ctx.fillStyle = pool
    ctx.fillRect(0, 0, w, h)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return texture
  })
}

/**
 * Per-ball visual overrides for {@link BallRig}. Every field defaults to the shared
 * ball look, so the fifteen colours keep their exact current material; the cue ball
 * is the only rig that opts into its own polish and shadow.
 */
export interface BallRigOptions {
  /**
   * Takes the cue ball's own material from {@link createCueBallMaterial}: the warm
   * cream resin under its own clearcoat. When set, the constructor's `color` is not
   * applied - the factory carries the cue ball's colour with its lacquer.
   */
  cue?: boolean
  /** A bespoke contact-shadow texture (the cue ball's soft grounded blob). */
  shadowTex?: THREE.CanvasTexture
  /** The contact disc's edge length, as a multiple of the ball's radius. */
  shadowPlane?: number
}

export class BallRig {
  group = new THREE.Group()
  sphere: THREE.Mesh
  material: THREE.MeshPhysicalMaterial
  blob: THREE.Mesh
  target = new THREE.Vector3()
  firstSeen = true
  sinking = false
  sinkT = 0
  sinkStart = new THREE.Vector3()
  sinkTarget = new THREE.Vector3()
  rising = false
  riseT = 0
  riseFrom = new THREE.Vector3()
  /**
   * Whether this rig is the cue ball's, and so carries the cue's own grounding:
   * its shadow sits a shade higher and leans a shade further off the lamp than
   * the coloured balls', which is all the difference the brightest ball on the
   * cloth needs to stay planted.
   */
  private readonly cueShadow: boolean
  private readonly radius: number
  private readonly prevVisual = new THREE.Vector3()
  private hasPrevVisual = false
  private readonly rollAxis = new THREE.Vector3()

  constructor(radius: number, color: number, shadowTex: THREE.CanvasTexture, opts: BallRigOptions = {}) {
    this.cueShadow = opts.cue === true
    this.radius = radius
    // Phenolic resin: tight diffuse under a clearcoat film. The coat carries the
    // crisp lamp highlight; the env map supplies the curved studio reflection.
    // Cue ball uses its own cream albedo with red spin dots so roll is readable.
    this.material = opts.cue ? createCueBallMaterial() : createColouredBallMaterial(color)
    const [segW, segH] = qualityConfig().ballSegments
    this.sphere = new THREE.Mesh(new THREE.SphereGeometry(radius, segW, segH), this.material)
    // Balls never cast into the scene's one static shadow map: a shadow baked at
    // frame one would sit forever where the ball first stood. Grounding is sold by
    // the soft contact blob under the ball instead, which moves with it and costs
    // no shadow renders.
    this.sphere.castShadow = false
    this.group.add(this.sphere)
    const blobMat = new THREE.MeshBasicMaterial({
      map: opts.shadowTex ?? shadowTex,
      color: 0x000000,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -1,
      toneMapped: false,
      blending: THREE.NormalBlending
    })
    const plane = radius * (opts.shadowPlane ?? BALL_SHADOW_PLANE)
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(plane, plane), blobMat)
    this.blob.rotation.x = -Math.PI / 2
    this.blob.position.y = 0.6
    this.blob.renderOrder = 1
    this.group.add(this.blob)
  }

  /**
   * Visual-only roll: rotates the sphere from cloth-space translation so spin
   * dots (and phenolic highlights) track motion. Does not touch physics state.
   */
  stepRoll(): void {
    const p = this.group.position
    if (!this.hasPrevVisual) {
      this.prevVisual.copy(p)
      this.hasPrevVisual = true
      return
    }
    const dx = p.x - this.prevVisual.x
    const dz = p.z - this.prevVisual.z
    const dist = Math.hypot(dx, dz)
    if (dist > 1e-4) {
      // Axis = up × displacement, so the ball rolls in the direction of travel.
      this.rollAxis.set(dz, 0, -dx).normalize()
      this.sphere.rotateOnWorldAxis(this.rollAxis, dist / this.radius)
    }
    this.prevVisual.copy(p)
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible
  }

  startSink(targetX: number, targetZ: number): void {
    this.sinking = true
    this.sinkT = 0
    this.sinkStart.copy(this.group.position)
    this.sinkTarget.set(targetX, this.group.position.y - 8, targetZ)
  }

  /**
   * Puts a ball back into play, the counterpart to the sink.
   *
   * A ball that comes back — the cue ball into hand after an in-off, a colour the rules
   * re-spot — used to be teleported onto its spot, which reads as a glitch rather than
   * as the table being re-racked. It comes up off the cloth instead, over the same
   * fraction of a second the sink takes going down, so the two ends of a ball's journey
   * off and back onto the table look like one motion.
   */
  startRise(targetX: number, targetZ: number): void {
    // A sink still in flight is abandoned rather than raced. The ball is back on the
    // table, so letting the drop finish would take it away again a moment later.
    this.sinking = false
    this.rising = true
    this.riseT = 0
    this.riseFrom.set(targetX, BALL_RADIUS - RISE_DEPTH, targetZ)
    this.group.position.copy(this.riseFrom)
    this.group.scale.set(RISE_START_SCALE, RISE_START_SCALE, RISE_START_SCALE)
  }

  aim(targetX: number, targetZ: number, highlight: boolean, reset: boolean): void {
    if (reset) {
      this.group.position.set(targetX, BALL_RADIUS, targetZ)
      this.firstSeen = false
      this.hasPrevVisual = false
    }
    this.target.set(targetX, BALL_RADIUS, targetZ)
    // The contact disc leans and stretches away from the table's centre, where the
    // lamp hangs: that is the oblique part of the light, and it is the direction a
    // real shadow would take. Dead centre there is nothing to lean towards. The cue
    // ball takes its own lean, height and stretch from the cue's shadow tuning.
    const lean = this.cueShadow ? CUE_SHADOW_OFFSET_MM : BALL_SHADOW_LEAN_MM
    const stretch = this.cueShadow ? CUE_SHADOW_STRETCH : BALL_SHADOW_STRETCH
    const shadowY = this.cueShadow ? CUE_SHADOW_Y_MM : BALL_SHADOW_Y
    const centreDist = Math.hypot(targetX, targetZ)
    if (centreDist > 40) {
      const nx = targetX / centreDist
      const nz = targetZ / centreDist
      this.blob.position.set(nx * lean, shadowY - BALL_RADIUS, nz * lean)
      this.blob.rotation.z = Math.atan2(-nz, nx)
      this.blob.scale.set(stretch, 1, 1)
    } else {
      this.blob.position.set(0, shadowY - BALL_RADIUS, 0)
      this.blob.scale.set(1, 1, 1)
    }
    this.material.emissive.setHex(highlight ? 0x7a5c10 : 0x000000)
  }

  dispose(): void {
    this.sphere.geometry.dispose()
    this.material.dispose()
    ;(this.blob.material as THREE.MeshBasicMaterial).dispose()
    this.blob.geometry.dispose()
  }
}

export class Scene3D implements VenueHost {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private balls = new Map<number, BallRig>()
  /**
   * Whether each ball was potted in the previous update, so a ball coming back onto the
   * table can be told from one that is merely being aimed at a new position. Kept here
   * rather than passed in because the renderer is the only thing that sees every frame.
   */
  private wasPotted = new Map<number, boolean>()
  private shadowTexCache: THREE.CanvasTexture | null = null
  private cvw: number
  private cvh: number
  private aimRibbon1!: THREE.Mesh
  private aimRibbon1Open!: THREE.Mesh
  private aimRibbon2!: THREE.Mesh
  private aimRibbon3!: THREE.Mesh
  private contactRing!: THREE.Mesh
  /**
   * The shot line's layout for this frame, filled in place by `shotLineLayout`
   * so drawing the guide costs no allocation.
   */
  private readonly aimLayout: ShotLineLayout = shotLineLayoutTarget()
  /** Scratch point for measuring a ribbon's distance to the lens, also reused per frame. */
  private readonly aimMeasure = new THREE.Vector3()
  /** The object-ball and cue-ball lines' drawn lengths, eased towards what the cut asks for. */
  private aimLength2 = AIM_LINE2_LENGTH
  private aimLength3 = AIM_LINE3_LENGTH * 0.2
  private readonly aimDir = new THREE.Vector3()
  private stick!: THREE.Group
  /** The stick's soft shadow strip on the cloth, following its angle and pull-back. */
  private stickShadow!: THREE.Mesh
  /** The strip's current and target opacity, so it fades rather than cuts. */
  private stickShadowAlpha = 0
  private stickShadowTarget = 0
  private lastTime = 0
  private immediate = false
  /**
   * The camera's own memory: where it is, and the heading it has turned to so far.
   *
   * Held here rather than recomputed from the pose, because the heading is the one thing
   * with two ways round it: easing it from the pose would swing the table the long way
   * when the aim crosses 180 degrees.
   */
  private rig: CameraRigState
  /**
   * The one shadow-casting lamp, kept for `render()`: the shadow pass pins its
   * shadow camera's basis before the map is baked, so the bake cannot inherit a
   * view-dependent orientation from whichever camera happens to be drawing.
   */
  private lamp!: THREE.SpotLight
  /** Which view the player has asked for. The rig follows it unless a shot or a
   * placement overrides it. */
  private cameraMode: PlayerCameraMode = 'AIM'
  /** True while a shot is being watched, which is when the camera follows the balls. */
  private tracking = false
  /** The snapshot last handed to `update`, which is what the camera reads its cue ball from. */
  private lastSnapshot: FrameSnapshotData | null = null
  /**
   * The aim the player is setting right now. It turns the cue, and through the
   * latch below it turns the camera with it while the player is free to aim.
   */
  private lastAimAngle = 0
  /**
   * Where the camera is pointed: the heading following the live aim while the
   * player is free to aim, latched to the played shot while one is on screen,
   * plus the player's own look-around on top of either.
   */
  private latch: HeadingLatch = initialHeadingLatch()
  /**
   * Whether the lens is down in the aim view, as opposed to on its way there.
   *
   * A pointer is cast through the live camera, so while the camera is still flying in from
   * overhead or from a shot the same pixel sweeps across the whole table. Nothing should
   * re-read the pointer as an aim until this is true.
   */
  private aimViewSettled = false
  /** True once the surroundings have been put on their cheaper finish for this scene. */
  private environmentLow = false
  /** What each swapped mesh was wearing, so teardown can free the originals too. */
  private readonly environmentOriginals: Array<[THREE.Mesh, THREE.Material]> = []
  /**
   * Whether the spectator view is up: the whole-table camera for somebody else's visit.
   * Decided once a frame by `nextSpectating` from turn state this class is only shown.
   */
  private spectating = false
  /** Seconds the table has been at rest, for the settle before the spectator view goes up. */
  private restSeconds = 0
  /** The timed move into or out of the spectator view. Never blocks input. */
  private spectatorTransition: PlacementTransition = noPlacementTransition()
  /** The fitted spectator pose and the canvas shape it was fitted for, so a resize refits. */
  private spectatorFit: { aspect: number; pose: CameraPose } | null = null
  /** Whose turn and whether a shot is replaying, as the game has it right now. */
  private liveSeatKnown = false
  private liveOpponentTurn = false
  private liveReplay = false
  /** Whether the shot being replayed was the opponent's. Latched when the replay starts. */
  private replayByOpponent = false
  /** The same two, as the table is currently showing them after any presentation delay. */
  private shownMyTurn = false
  /** The opponent's shot being wound up, as read off its recording, and its line on the cloth. */
  private opponentShot: OpponentShot | null = null
  private opponentLineReady = false
  private readonly opponentLayout: ShotLineLayout = shotLineLayoutTarget()
  private opponentRibbon!: THREE.Mesh
  private opponentRing!: THREE.Mesh
  /**
   * The venue's moving parts: the crowd, the applause, the banner and the opponent's cue.
   *
   * The only object in this file that owns anything outside the 3D scene, and the only one
   * that talks to the network — see `venueEvents.ts` for why that is not in `main.ts`.
   */
  private venue: VenueEvents | null = null
  /** The arena group, and where its seats are. The crowd is parented to the group. */
  readonly venueGroup!: THREE.Group
  readonly venueSeats: readonly ArenaSeatPlacement[] = []
  /**
   * Snapshots waiting out their presentation delay, oldest first.
   *
   * This is a *queue*, not a hold. A hold would show the table frozen at a turn change and
   * then jump to wherever it had got to; a queue replays every snapshot late instead, so
   * the motion is the same motion, shifted. The only thing a viewer can tell is that the
   * room took its beat before anything moved.
   */
  private presentationQueue: Array<{ at: number; snapshot: FrameSnapshotData | null; options: RenderOptions }> = []
  /** Seconds left on the presentation hold, and the clock that spends it. */
  private presentationLeft = 0
  private presentationClock = 0
  /** How late a snapshot is shown while the hold is open. Set by `beginPresentation`. */
  private presentationDelay = 0
  /** When the current hold opened, on the presentation clock. */
  private holdStartedAt = -Infinity
  /** Ring + baulk line segment marking the D during break-off placement. Built once, shown on demand. */
  private dZoneRing!: THREE.Mesh
  /**
   * The felt's texture, kept for the artifact guards in `selfCheck`: the banding
   * regression this scene once had was a texture configured without mipmaps, and
   * a one-line check at build time is cheaper than ever rediscovering it by eye.
   */
  private feltTex: THREE.CanvasTexture | null = null
  /**
   * The Blender table the scene is built from, if the model was available when
   * this scene was created. Null means the code-built table was used, which is
   * also the signal for `selfCheck` to run its code-geometry guards.
   */
  private tableSource: THREE.Group | null = null
  /** True when the model replaced the code-built cloth, cushions, frame and pockets. */
  private usingTableModel = false
  /** Translucent disc shading the legal D area during break-off placement. */
  private dZoneFill!: THREE.Mesh
  /** Ghost cue ball the player moves while placing; hidden when not placing. */
  private ghostBall!: THREE.Mesh
  /** Current ghost position in table millimetres, so the follow easing has memory. */
  private ghostPos = new THREE.Vector2(BAULK_LINE_X, TABLE_WIDTH / 2)
  /** Whether the ghost is being shown at all this frame. */
  private placementActive = false
  /** Called once the placement camera move back to gameplay has landed. */
  private placementArrival: (() => void) | null = null

  /**
   * Where the cue-ball placement camera move is: not happening, or in flight.
   *
   * Held here rather than in the frame loop so the scene is the single authority on it.
   * The loop asks every frame whether input is being refused, and the rig's mode is
   * resolved from this before anything else, which is what stops a stale
   * `setCameraMode` from the player-facing toggle fighting a transition in progress.
   */
  private placementTransition: PlacementTransition = noPlacementTransition()
  /**
   * Whether the overhead placement view is being held, as opposed to merely flying
   * towards it. Set when the move into the view begins, cleared when the move back out
   * begins, so the overlays and the camera agree on which of the two is happening.
   */
  private placementViewHeld = false
  /**
   * The confirmed cue-ball position, held while the camera flies home after a placement.
   *
   * The snapshot that carries the placed cue ball arrives after the camera has already
   * started its flight back, and until it does the snapshot still describes the ball as
   * potted or absent. Driving the cue ball from the snapshot alone through that window
   * shows the player the ball they just placed disappear, then reappear somewhere the
   * transition is already aimed at. While this is set the cue ball is drawn from the
   * confirmed position instead, and it is cleared the moment the server's own snapshot
   * says the ball is down - which is also when the snapshot takes over with the same
   * number, so the handover is invisible.
   */
  private placementCueLock: { x: number; y: number } | null = null

  /**
   * GPU warm-up used only by the match loading screen. Uploads textures, compiles
   * shaders (forcing normally-hidden objects visible for the compile pass), warms both
   * start camera poses, and draws a handful of real frames including one shadow bake.
   * Restores every visibility flip. Does not change materials, lights, or look.
   */
  async warmUp(
    onProgress?: (phase: WarmUpPhase, fraction: number) => void,
    opts?: { perf?: boolean }
  ): Promise<void> {
    const t0 = performance.now()
    const phaseAt: Partial<Record<WarmUpPhase, number>> = {}
    const mark = (phase: WarmUpPhase): void => {
      phaseAt[phase] = performance.now() - t0
    }

    const report = (phase: WarmUpPhase, fraction: number): void => {
      try {
        onProgress?.(phase, fraction)
      } catch (err) {
        console.warn('[scene3d.warmUp] progress callback failed', phase, err)
      }
    }

    // --- textures ---
    try {
      const textures = this.collectGpuTextures()
      const batch = 4
      for (let i = 0; i < textures.length; i++) {
        try {
          this.renderer.initTexture(textures[i]!)
        } catch {
          /* skip a bad texture; never stall the loader */
        }
        if ((i + 1) % batch === 0 || i === textures.length - 1) {
          report('textures', textures.length ? (i + 1) / textures.length : 1)
          await yieldMain()
        }
      }
      if (textures.length === 0) report('textures', 1)
    } catch (err) {
      console.warn('[scene3d.warmUp] textures phase failed', err)
      report('textures', 1)
    }
    mark('textures')

    // --- shaders (temporarily reveal hidden meshes so compile sees them) ---
    try {
      await this.withForcedVisibility(async () => {
        const aspect = this.cvw / Math.max(1, this.cvh)
        const overhead = topDownPose(aspect)
        this.applyWarmPose(overhead)
        const compiler = this.renderer as THREE.WebGLRenderer & {
          compileAsync?: (scene: THREE.Scene, camera: THREE.Camera) => Promise<void>
        }
        report('shaders', 0.2)
        if (typeof compiler.compileAsync === 'function') {
          await compiler.compileAsync(this.scene, this.camera)
        } else {
          this.renderer.compile(this.scene, this.camera)
        }
        report('shaders', 0.7)
        await yieldMain()
        // Second compile from the aim pose so the cue-view programs are warm too.
        const cue = { x: TABLE_LENGTH * 0.25, y: TABLE_WIDTH * 0.5 }
        this.applyWarmPose(aimPose(cue, 0, aimFovDeg(aspect)))
        if (typeof compiler.compileAsync === 'function') {
          await compiler.compileAsync(this.scene, this.camera)
        } else {
          this.renderer.compile(this.scene, this.camera)
        }
        report('shaders', 1)
      })
    } catch (err) {
      console.warn('[scene3d.warmUp] shaders phase failed', err)
      report('shaders', 1)
    }
    mark('shaders')

    // --- static bakes: shadow map + one draw ---
    try {
      report('bakes', 0.2)
      this.renderer.shadowMap.needsUpdate = true
      this.warmDraw()
      report('bakes', 1)
      await yieldMain()
    } catch (err) {
      console.warn('[scene3d.warmUp] bakes phase failed', err)
      report('bakes', 1)
    }
    mark('bakes')

    // --- warm-up frames across both start poses ---
    try {
      const aspect = this.cvw / Math.max(1, this.cvh)
      const poses: CameraPose[] = [
        topDownPose(aspect),
        aimPose({ x: TABLE_LENGTH * 0.25, y: TABLE_WIDTH * 0.5 }, 0, aimFovDeg(aspect))
      ]
      const frames = 8
      for (let i = 0; i < frames; i++) {
        this.applyWarmPose(poses[i % poses.length]!)
        if (i === 0) this.renderer.shadowMap.needsUpdate = true
        this.warmDraw()
        report('warmup', (i + 1) / frames)
        await nextAnimationFrame()
      }
      // Leave the camera on the default aim-ish pose the constructor started with.
      this.applyWarmPose(aimPose({ x: TABLE_LENGTH * 0.25, y: TABLE_WIDTH * 0.5 }, 0, aimFovDeg(aspect)))
      this.warmDraw()
      report('warmup', 1)
    } catch (err) {
      console.warn('[scene3d.warmUp] warmup frames failed', err)
      report('warmup', 1)
    }
    mark('warmup')

    if (opts?.perf) {
      const info = this.renderer.info
      console.info('[perf] warmUp phases (ms)', phaseAt, {
        programs: info.programs?.length ?? 0,
        textures: info.memory.textures,
        totalMs: performance.now() - t0
      })
    }
  }

  /** Programs / texture counts for loading-screen handover checks. */
  rendererInfo(): { programs: number; textures: number } {
    const info = this.renderer.info
    return {
      programs: info.programs?.length ?? 0,
      textures: info.memory.textures
    }
  }

  private collectGpuTextures(): THREE.Texture[] {
    const found = new Set<THREE.Texture>()
    const add = (tex: THREE.Texture | null | undefined): void => {
      if (tex) found.add(tex)
    }
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const mat of mats) {
        if (!mat) continue
        const m = mat as THREE.MeshStandardMaterial & Record<string, unknown>
        add(m.map)
        add(m.normalMap)
        add(m.roughnessMap)
        add(m.metalnessMap)
        add(m.aoMap)
        add(m.emissiveMap)
        add(m.envMap)
        add(m.alphaMap)
        add(m.lightMap)
        add(m.bumpMap as THREE.Texture | null | undefined)
        add(m.displacementMap)
      }
    })
    if (this.scene.environment) add(this.scene.environment)
    const bg = this.scene.background
    if (bg && (bg as THREE.Texture).isTexture) add(bg as THREE.Texture)
    return [...found]
  }

  private applyWarmPose(pose: CameraPose): void {
    this.camera.position.set(tableX(pose.x), pose.height, tableZ(pose.y))
    this.camera.lookAt(tableX(pose.lookX), pose.lookHeight, tableZ(pose.lookY))
    if (this.camera.fov !== pose.fov) {
      this.camera.fov = pose.fov
      this.camera.updateProjectionMatrix()
    }
    this.camera.updateMatrixWorld(true)
  }

  private warmDraw(): void {
    if (this.renderer.shadowMap.needsUpdate) {
      const shadowCam = this.lamp.shadow.camera
      shadowCam.position.set(0, 1750, 0)
      shadowCam.up.set(0, 0, -1)
      shadowCam.lookAt(0, 0, 0)
      shadowCam.updateMatrixWorld(true)
    }
    this.renderer.render(this.scene, this.camera)
  }

  private async withForcedVisibility(run: () => Promise<void>): Promise<void> {
    const saved: Array<{ obj: THREE.Object3D; visible: boolean }> = []
    this.scene.traverse((obj) => {
      saved.push({ obj, visible: obj.visible })
      obj.visible = true
    })
    try {
      await run()
    } finally {
      for (const entry of saved) entry.obj.visible = entry.visible
    }
  }

  /**
   * Optional build/warm-up hooks. Unused callers keep the previous create(canvas, w, h)
   * behaviour unchanged.
   */
  static create(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    opts?: Scene3DCreateOptions
  ): Scene3D | null {
    try {
      return new Scene3D(canvas, width, height, opts)
    } catch {
      return null
    }
  }

  private constructor(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    opts?: Scene3DCreateOptions
  ) {
    this.cvw = width
    this.cvh = height
    const onBuild = opts?.onBuildProgress
    // The Blender table, if one is ready. An explicit `tableModel` (even null) wins
    // over the boot preload, so a caller can force the code-built table; otherwise
    // this is a synchronous read of the preload's result.
    const explicitModel = opts?.tableModel
    const readyModel = tableModelIfReady()
    this.tableSource = explicitModel !== undefined ? explicitModel : readyModel
    this.usingTableModel = this.tableSource !== null
    console.info('[scene3d] table source decision', {
      usingTableModel: this.usingTableModel,
      explicitProvided: explicitModel !== undefined,
      explicitWasNull: explicitModel === null,
      preloadReady: readyModel !== null
    })
    // The canvas backing store is already sized with the device pixel ratio by the
    // caller (capped at 1.5 in main.ts), so the renderer draws at one pixel per backing
    // pixel. AA is decided once from the device rather than asked for unconditionally:
    // MSAA costs fill rate on every pass, and a weak GPU with a small backing store
    // does better spending it on pixels than on edges.
    const tier = qualityConfig()
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: tier.antialias,
      powerPreference: 'high-performance'
    })
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(width, height, false)
    // One query, one clamp, shared by every texture built after this line.
    MAX_ANISO = Math.min(this.renderer.capabilities.getMaxAnisotropy(), tier.anisotropy)
    // The table's procedural textures live in tableTextures.ts and are built on first
    // use, so they read the cap from there; the local MAX_ANISO still drives the
    // scene's own textures.
    setTableAnisotropy(MAX_ANISO)
    this.renderer.shadowMap.enabled = true
    // PCFSoftShadowMap was deprecated in r186; PCFShadowMap with a radius is the
    // supported soft look, and the map is baked once so the filter costs per frame
    // nothing anyway.
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    // Everything this light can see is static, so the map is rendered exactly once —
    // the flag is raised after the scene is fully built and never touched again.
    this.renderer.shadowMap.autoUpdate = false
    if (TONE_MAPPING_MODE === 'neutral' && (THREE as any).NeutralToneMapping) {
      this.renderer.toneMapping = (THREE as any).NeutralToneMapping
    } else {
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    }
    this.renderer.toneMappingExposure = TONE_EXPOSURE
    // sRGB output, by its current name (outputEncoding was retired in r152).
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    this.scene.background = new THREE.Color(ROOM_DARK_COLOR)
    // A whisper of the room's own colour in the far distance: enough that the wall
    // and the floor fade out at their extremes instead of ending on a hard plane
    // edge, and nothing at gameplay distances. Still on ROOM_BG_COLOR — the fog's
    // job is to soften what is in the scene, and the scene is the lit table and the
    // bowl, both of which have to read exactly as bright as they did before.
    this.scene.fog = new THREE.FogExp2(ROOM_BG_COLOR, ROOM_FOG_DENSITY)

    // Near plane at CAMERA_NEAR_MM (20), not 0.1 — that constant's comment carries the
    // depth-precision argument. A camera pulled close to a cushion nose or over a pocket
    // jaw still has those surfaces well inside the frustum; what 0.1 bought was nothing
    // but a depth buffer too coarse to separate the cloth from the apron under it.
    this.camera = new THREE.PerspectiveCamera(50, width / height, CAMERA_NEAR_MM, 20000)
    this.rig = initialRigState(width / height)
    this.camera.position.set(0, 1400, 1750)
    this.camera.lookAt(0, 0, 0)

    this.buildLighting()
    onBuild?.(0.12)
    // How much of that arena this device gets to have: the seat and texture budget, the
    // lamp's shadow map and the number of stand washes are all read during the build
    // below, so this is the one moment the choice can still be made.
    const quality = applyArenaQuality()
    // The World Championship arena: carpet, bowl, hoardings, roof, lighting rig and camera
    // stands. Built here, before buildTable, so it is inside the matrix freeze at the end of
    // that build and inside the one shadow bake. Visual only, and tuned entirely from
    // ARENA_CONFIG in arenaConfig.ts.
    const arena = buildArenaEnvironment(this.scene, this.renderer)
    if (quality !== 'high') {
      console.info(`[arena] built at "${quality}" quality (try ?quality=high to see the full venue)`)
    }
    this.venueGroup = arena.group
    this.venueSeats = SHOW_OLD_AUDIENCE ? arena.seats : []
    onBuild?.(0.32)
    this.buildTable()
    // The old room's floor and back wall are built inside buildTable, so they can only be
    // stepped over once that has run. It has to happen: the old floor sits at exactly
    // `carpetY`, so leaving it in the scene puts two ground planes at the same depth and
    // they trade wins from pixel to pixel as the camera moves — the carpet reads as a
    // flickering plane rather than as cloth.
    hideLegacyRoom(this.scene)
    onBuild?.(0.58)
    this.buildAim()
    this.buildPlacement()
    onBuild?.(0.72)

    // The crowd, the applause and the turn presentation. Added after the freeze on
    // purpose: these are the only venue objects that move, and a frozen matrix is the whole
    // point of the freeze.
    this.venue = buildVenueEvents(this)
    onBuild?.(0.86)

    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromEquirectangular(envTexture()).texture
    pmrem.dispose()
    onBuild?.(1)

    // The one and only shadow bake, over the finished static set: cushions, pockets,
    // floor, lamp shade. Every later frame reuses this map at zero shadow cost.
    this.renderer.shadowMap.needsUpdate = true

    this.selfCheck()
  }

  /**
   * Build-time guards on the mechanisms behind cloth banding artifacts.
   *
   * Three separate mechanisms, all of which have produced visible banding on the bed at
   * some point: the bed must never sample the depth map, so no shadow-map artifact of
   * any bias, frustum depth or camera angle can land on it; the depth buffer must stay
   * fine enough to separate the bed's own coplanar surfaces; and the felt's own
   * sampling must stay calm (moire without mipmaps, shimmer without aniso). A violation
   * means somebody reintroduced a bug that took real diagnosis to find, so it is
   * announced rather than suffered silently.
   */
  private selfCheck(): void {
    const problems: string[] = []
    // The invariant that matters most is structural: find the cloth by its texture
    // and assert it never became a shadow receiver again.
    let clothReceives = false
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.isMesh && (mesh.material as THREE.MeshStandardMaterial)?.map === this.feltTex && mesh.receiveShadow) {
        clothReceives = true
      }
    })
    if (clothReceives) problems.push('cloth is receiving depth-map shadows (shadow acne will return)')

    // The guards below are all assertions about the *code-built* geometry — the 1mm
    // cloth/apron gap, the rail cap's underside at y=-1 and each cushion's inner face
    // on its physics plane. The model has its own geometry, so none of them apply;
    // running them would only report the model as broken.
    if (!this.usingTableModel) {
    // Depth-precision guard. The bed's tightest coplanar pair is the cloth plane at
    // y=0 and the apron box's top face at y=-1, a 1mm gap that spans the whole playing
    // surface. Assert the depth buffer can actually resolve it at the farthest the
    // camera rig ever gets, which is the overhead view. Approximate perspective
    // granularity is z^2 * (far-near) / (near * far * 2^depthBits); the ask is a 10x
    // margin, so a drop below a tenth of the gap is a warning rather than a hard fail
    // (depth buffer size is not observable from here, so 24-bit is the common case).
    const clothGapMm = 1
    const overheadMm = 4500
    const cam = this.camera
    const bits = 24
    const granularity =
      (overheadMm * overheadMm * (cam.far - cam.near)) / (cam.near * cam.far * 2 ** bits)
    if (granularity * 10 > clothGapMm) {
      problems.push(
        `camera near plane ${cam.near}mm resolves only ${granularity.toFixed(3)}mm at ` +
          `${overheadMm}mm — the cloth and the apron ${clothGapMm}mm apart will z-fight`
      )
    }

    // Geometry guards. The bevel on an ExtrudeGeometry expands the profile *outward*,
    // which for a cushion means its inner face ends up inside the playing surface, and
    // for the rail cap means the frame overhangs the cloth. Both are invisible to a
    // typecheck and both change where the ball appears to hit, so they are asserted here
    // off real world-space bounding boxes rather than left to review.
    const tagged = new Map<string, THREE.Mesh>()
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh
      const tag = (mesh.userData as { physicsSurface?: string } | undefined)?.physicsSurface
      if (mesh.isMesh && tag) tagged.set(tag, mesh)
    })

    // The cloth and the nearest apron surface must stay 1mm apart, and the rail cap's top
    // face must be the surface that gap is measured to.
    const cap = tagged.get('railCapTop')
    if (cap) {
      cap.updateWorldMatrix(true, false)
      const capTop = new THREE.Box3().setFromObject(cap).max.y
      if (Math.abs(capTop - -1) > 0.01) {
        problems.push(`rail cap top face is at y=${capTop.toFixed(2)}mm, expected -1mm`)
      }
    } else {
      problems.push('rail cap is not tagged, so its top face is unguarded')
    }

    // Every cushion's inner face must sit exactly on its physics plane. These are the
    // planes the ball bounces off, so a cushion that has drifted inward reads as the ball
    // clipping into the rubber.
    const HALF_L_MM = TABLE_LENGTH / 2
    const HALF_W_MM = TABLE_WIDTH / 2
    for (const [tag, mesh] of tagged) {
      if (!tag.startsWith('cushion:')) continue
      const [, axis, side] = tag.split(':')
      mesh.updateWorldMatrix(true, false)
      const box = new THREE.Box3().setFromObject(mesh)
      const inner = axis === 'x' ? Math.min(Math.abs(box.min.z), Math.abs(box.max.z)) : Math.min(Math.abs(box.min.x), Math.abs(box.max.x))
      const expected = axis === 'x' ? HALF_W_MM : HALF_L_MM
      if (Math.abs(inner - expected) > 0.5) {
        problems.push(`${tag} inner face at ${inner.toFixed(2)}mm, physics plane is ${expected}mm`)
      }
      if (Math.abs(box.max.y - CUSHION_H) > 0.5) {
        problems.push(`${tag} top at ${box.max.y.toFixed(2)}mm, expected ${CUSHION_H}mm`)
      }
      if (Math.abs(box.min.y) > 0.5) {
        problems.push(`${tag} base at ${box.min.y.toFixed(2)}mm, expected 0mm`)
      }
      if (side !== '1' && side !== '-1') problems.push(`${tag} has no valid side`)
    }
    }

    const tex = this.feltTex
    if (tex) {
      if (!tex.generateMipmaps) problems.push('felt texture is missing mipmaps')
      if (tex.minFilter !== THREE.LinearMipmapLinearFilter) problems.push('felt texture is not trilinearly filtered')
      if (tex.anisotropy <= 0) problems.push('felt texture has no anisotropic filtering')
    }
    if (problems.length) {
      // Console, not a throw: a cosmetic guard must never take the table down.
      console.warn('[scene3d] rendering artifact guards failed:', problems.join('; '))
    }
  }

  private buildLighting(): void {
    // One lamp over the table, like a real snooker room: a warm cone strictly over the
    // bed, the only shadow caster in the scene. It used to be three shadow-casting
    // spotlights with 1024² maps — three shadow renders every frame for pools of light
    // that baked textures and contact blobs already supply — which is exactly the
    // overhead a low-end GPU does not have to spend.
    //
    // The cone and the falloff are those of a snooker canopy rather than of a bulb. A
    // real table light is a long diffuser the size of the bed, and the standard it is
    // built to asks for even light across the whole cloth. The old lamp was a 37.5 degree
    // cone with inverse-square falloff: the ends of the table sit 45 degrees off its
    // axis, so they were outside the cone altogether, and what did reach the corners
    // was under a third of the centre. The cone now takes in the corners with room to
    // spare, and the light does not thin with distance, so the only falloff left is the
    // cloth turning away from the lamp. The colour is a warm white where it was amber,
    // which is what lets the green read as green.
    const lamp = (this.lamp = new THREE.SpotLight(LAMP_COLOR, LAMP_INTENSITY, 0, LAMP_ANGLE, LAMP_PENUMBRA, 0))
    lamp.position.set(0, 1750, 0)
    lamp.target.position.set(0, 0, 0)
    lamp.castShadow = true
    // 2048² costs nothing per frame — the map is baked once over the static set —
    // and the finer texels are what let the acne fixes stay gentle.
    lamp.shadow.mapSize.set(2048, 2048)
    // The frustum is squeezed onto the table. Stripe artifacts on the baize are a
    // depth-precision problem: with near 400 and far 4000 the map spread 3600mm of
    // depth over 2048² texels and the cloth's minified sampling landed several
    // texels deep inside the cushions' shadows, drawing banded stripes across the
    // bed. Everything that casts or receives sits between ~1730mm (cushion tops)
    // and ~2600mm (the arena floor) below the lamp, so a tight band holds them all
    // and each texel now resolves a fraction of the depth it used to.
    lamp.shadow.camera.near = 1600
    lamp.shadow.camera.far = 2800
    lamp.shadow.camera.updateProjectionMatrix()
    // Stripe artifacts come from self-shadowing surfaces the depth map cannot
    // resolve: the bias pulls the sample back along the light ray, the normalBias
    // pushes the sampled surface out along its own normal. Together they clear the
    // banding without visibly detaching shadows from their casters.
    lamp.shadow.bias = -0.0001
    lamp.shadow.normalBias = 0.02
    lamp.shadow.radius = 3
    this.scene.add(lamp)
    this.scene.add(lamp.target)

    // The arena has to read as a lit venue, not a void: an ambient base over the
    // whole scene, the warm hemisphere for the room, and two balanced directionals
    // so walls, floor and hoardings all carry colour from more than one side.
    // Balanced for "evenly lit, no pitch-black corners, no blown-out patches":
    // the ambient lifts the shadows off pure black, the hemisphere keeps the room
    // warm from above and dark at the floor, and the two directionals put colour
    // on every wall from more than one side. Intensities sit well under the lamp's
    // contribution so the cloth keeps a soft gradient rather than a hot centre.
    // Ambient is low and slightly cool. It exists to keep the shadowed side of the rails
    // from crushing to black, not to light anything — at the old 0.5 it was flattening
    // the wood's figure by flooding the same value into both the lit and unlit sides,
    // which is exactly the "evenly lit, nothing has form" failure. A directional
    // contrast is what makes a bevel read as a bevel.
    const ambient = new THREE.AmbientLight(0xdfe8ff, 0.36) 
    this.scene.add(ambient)

    // Hemisphere keeps the room warm from above and dark at the floor, so the underside
    // of the rails picks up bounce rather than reading as a black void.
    const hemi = new THREE.HemisphereLight(0xfff1d8, 0x2e2419, 0.75)
    this.scene.add(hemi)

    // Cool fill from one side, warm key-side fill from the other, so every visible
    // surface receives light of two different hues. This is what separates the brass
    // from the wood behind it — a single-hue scene gives metal nowhere to put its
    // warm/cool split, and brass ends up looking like tinted plastic.
    const fill = new THREE.DirectionalLight(0x9fc0e8, 0.12) 
    fill.position.set(2200, 1200, -1100)
    this.scene.add(fill)

    const warm = new THREE.DirectionalLight(0xffd9a8, 0.1)
    warm.position.set(-2200, 1400, 1600)
    this.scene.add(warm)

    // A low grazing kicker from the front-right, just above rail height. It does almost
    // nothing for the bed — which faces up, so a near-horizontal light barely touches it
    // — but it rakes across the vertical faces of the apron and the cushion ends, which
    // is where a premium table is actually read. Without it the whole body of the table
    // sits in the lamp's ambient wash and the milled detail has no edge to catch.

    
    // No shadow: this is a shaping light, and a second shadow map is not worth it.
    const kicker = new THREE.DirectionalLight(0xfff0d4, 0.15)
    kicker.position.set(2600, 320, 1900)
    this.scene.add(kicker)

    // A tight specular source placed for the highlight it draws down the brass rail,
    // not for the light it contributes. Warm and narrow, aimed at the rail line.
    const railSpec = new THREE.DirectionalLight(0xfff4e0, 0.08)
    railSpec.position.set(900, 900, 2400)
    this.scene.add(railSpec)
  }

  /**
   * The felt material, shared by the code-built bed and the model's Cloth mesh.
   *
   * Building it here rather than at the point of use is what lets both tables use
   * the same texture instance: `selfCheck` finds the cloth by its map, and the
   * model path in `buildTable` needs the material even though it builds no bed.
   */
  private makeClothMaterial(): THREE.MeshPhysicalMaterial {
    const clothMat = new THREE.MeshPhysicalMaterial({
      map: (this.feltTex = feltTexture()),
      color: 0xffffff,
      roughness: CLOTH_ROUGHNESS,
      metalness: CLOTH_METALNESS,
      sheen: CLOTH_SHEEN,
      sheenColor: new THREE.Color(CLOTH_SHEEN_COLOR),
      sheenRoughness: CLOTH_SHEEN_ROUGHNESS,
      envMapIntensity: 0.12
    })
    // Cloth normal is the biggest sampling cost on the bed; low tier drops it.
    if (qualityConfig().clothNormal) {
      clothMat.normalMap = feltNormalTexture()
      clothMat.normalScale = new THREE.Vector2(CLOTH_NORMAL_STRENGTH, CLOTH_NORMAL_STRENGTH)
    }
    return clothMat
  }

  /**
   * A dark liner inside each modelled pocket, traced from the net's own outline.
   *
   * The Blender pockets are a visible jaali with nothing behind it, so from the playing
   * camera the cloth floor shows through the weave and the "hole" reads as a hole in the
   * table rather than a hole in the cloth. The model cannot be edited, so the fix is a
   * second surface: for each pocket we read the NetCord vertices within 120mm of the
   * pocket centre, bin them by height, and take the innermost radius per bin — that is the
   * net's mouth profile. A lathe of that profile, 3mm inside the net, closes the pocket
   * behind the weave while leaving the net itself visible over it. The six liners merge
   * into a single draw call, and being MeshBasicMaterial with no lighting they cost
   * nothing to shade and are guaranteed black whatever the lamps do.
   */
  private buildPocketLiners(group: THREE.Group): void {
    const net = group.getObjectByName('table:NetCord') as THREE.Mesh | undefined
    const pos = net?.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
    if (!pos) return
    const BIN_MM = 6
    const REACH_MM = 120
    const INSET_MM = 3
    const segments = qualityConfig().name === 'low' ? 20 : 32
    const geoms: THREE.BufferGeometry[] = []
    for (const p of POCKETS) {
      const cx = p.x - HALF_L
      const cz = -(p.y - HALF_W)
      const bins = new Map<number, number>()
      for (let i = 0; i < pos.count; i++) {
        const dx = pos.getX(i) - cx
        const dz = pos.getZ(i) - cz
        const r = Math.hypot(dx, dz)
        if (r > REACH_MM) continue
        const bin = Math.round(pos.getY(i) / BIN_MM)
        const prev = bins.get(bin)
        if (prev === undefined || r < prev) bins.set(bin, r)
      }
      if (bins.size < 2) continue
      const ys = [...bins.keys()].sort((a, b) => b - a) // top first (larger y)
      const top = ys[0]!
      const bottom = ys[ys.length - 1]!
      const points: THREE.Vector2[] = []
      // Start at the cloth plane (y=0) if the net hangs below it, so the liner meets the
      // bed's cut edge with no gap.
      const topY = Math.max(0, top * BIN_MM)
      points.push(new THREE.Vector2(Math.max(0.5, bins.get(top)! - INSET_MM), topY))
      for (const bin of ys) {
        points.push(new THREE.Vector2(Math.max(0.5, bins.get(bin)! - INSET_MM), bin * BIN_MM))
      }
      // Cap the bottom so the liner is a closed cup.
      points.push(new THREE.Vector2(0.01, bottom * BIN_MM - 2))
      const lathe = new THREE.LatheGeometry(points, segments)
      lathe.translate(cx, 0, cz)
      geoms.push(lathe)
    }
    if (!geoms.length) return
    const merged = mergeGeometries(geoms, false)
    geoms.forEach((g) => g.dispose())
    if (!merged) return
    const liner = new THREE.Mesh(
      merged,
      new THREE.MeshBasicMaterial({ color: 0x050505, side: THREE.DoubleSide })
    )
    liner.name = 'pocket-liner'
    liner.castShadow = false
    liner.receiveShadow = false
    liner.userData.physicsSurface = 'pocketLiner'
    group.add(liner)
  }

  private buildTable(): void {
    const clothMat = this.makeClothMaterial()
    if (this.tableSource) {
      console.info('[scene3d] buildTable: Blender model branch (9 draw calls)')
      // The Blender table brings its own bed, apron, rails, legs, cushions and
      // pockets as nine merged meshes. Only the felt material is the game's, so
      // the markings and cloth shading stay pixel-identical to the code bed.
      const model = instantiateTableModel(this.tableSource, tableMaterials(clothMat), {
        cloth: 'model',
        cushionShading: true,
        rotateShortRailWoodUV: true
      })
      this.scene.add(model)
      // Pockets: the model's nets are see-through, so the floor shows behind them. A
      // dark liner built from the net's own outline closes that off (see buildPocketLiners).
      this.buildPocketLiners(model)
    } else {
    console.info('[scene3d] buildTable: code-built branch (no model ready)')
    const pad = APRON_PAD
    // The bed is a rectangle with a rounded notch bitten out of it at each pocket rather than
    // a plain plane. This is what lets the modelled bowl actually be seen: a solid plane has
    // nothing behind it, so a funnel below the cloth is invisible and the only way to fake a
    // hole is to lay an opaque black disc on top - which is exactly the flat black cup this
    // replaces.
    //
    // The notches have to be part of the outline rather than holes. Every pocket centre sits
    // exactly on the bed's own corner or edge, so a circular hole would straddle the boundary
    // and triangulate to nothing - the cloth would render solid straight over the pocket.
    //
    // So the rectangle is walked edge by edge and any sample that falls inside a pocket is
    // slid along that edge's inward normal until it lands on the pocket's circle. That traces
    // the arc as part of the outline, keeps each pocket's own radius and centre, and needs no
    // special-casing for corners against middles.
    const bedShape = new THREE.Shape()
    {
      const halfL = TABLE_LENGTH / 2
      const halfW = TABLE_WIDTH / 2
      const edges: Array<[number, number, number, number, number, number]> = [
        [-halfL, -halfW, halfL, -halfW, 0, 1],
        [halfL, -halfW, halfL, halfW, -1, 0],
        [halfL, halfW, -halfL, halfW, 0, -1],
        [-halfL, halfW, -halfL, -halfW, 1, 0]
      ]
      const centres = POCKETS.map((p) => ({
        cx: tableX(p.x),
        cy: -tableZ(p.y),
        r: p.radius
      }))
      const pts: THREE.Vector2[] = []
      for (const [ax, ay, bx, by, nx, ny] of edges) {
        const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / BED_NOTCH_STEP_MM))
        for (let s = 0; s < steps; s++) {
          const t = s / steps
          let px = ax + (bx - ax) * t
          let py = ay + (by - ay) * t
          for (const c of centres) {
            const dx = px - c.cx
            const dy = py - c.cy
            if (dx * dx + dy * dy >= c.r * c.r) continue
            // Slide inward along the edge normal until we are out on the circle. Solving it
            // this way rather than pushing radially matters: a radial push would smear the
            // notch sideways along the rail instead of curving it into the bed.
            const along = dx * nx + dy * ny
            const off = Math.sqrt(Math.max(0, along * along - (dx * dx + dy * dy) + c.r * c.r))
            px += nx * (off - along)
            py += ny * (off - along)
            break
          }
          pts.push(new THREE.Vector2(px, py))
        }
      }
      bedShape.setFromPoints(pts)
    }
    const bedGeo = new THREE.ShapeGeometry(bedShape)
    // ShapeGeometry derives its UVs from raw shape coordinates, which would stretch the felt
    // across the whole plane. Rewrite them onto PlaneGeometry's convention so the cloth is
    // pixel-identical to the plane it replaces.
    {
      const pos = bedGeo.attributes.position!
      const uv = new Float32Array(pos.count * 2)
      for (let i = 0; i < pos.count; i++) {
        uv[i * 2] = (pos.getX(i) + TABLE_LENGTH / 2) / TABLE_LENGTH
        uv[i * 2 + 1] = (pos.getY(i) + TABLE_WIDTH / 2) / TABLE_WIDTH
      }
      bedGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    }
    const cloth = new THREE.Mesh(bedGeo, clothMat)
    cloth.rotation.x = -Math.PI / 2
    // The bed never samples the depth map. A coplanar-ish plane lit from above is
    // the textbook generator of shadow acne: every texel of a 2048² map stretched
    // across the bed self-shadows in bands, and the artifacts move with the camera
    // angle. The lamp washes the cloth directly, the baked AO lives in the texture,
    // and grounding is sold by the ball contact blobs — no depth reception needed.
    cloth.receiveShadow = false
    this.scene.add(cloth)

    // The apron becomes three stacked pieces rather than one 130mm box: a rail cap with a
    // moulded outer face, a recessed inner rebate, and the main body below it. All three
    // share the original outer footprint (TABLE_LENGTH + pad by TABLE_WIDTH + pad) and
    // the original top face height, because the depth-precision guard in `selfCheck`
    // asserts on the cloth-to-apron gap — that assertion is why the cap's underside sits
    // at y=-1 and must stay there.
const outerL = APRON_OUTER_L
    const outerW = APRON_OUTER_W
    // Satin-lacquered mahogany. Clearcoat carries the lacquer film, and that is the
    // whole point: clearcoat sits on top of the base layer with its own roughness, so
    // the grain can stay matte-ish and the film over it stays glossy. Faking this by
    // dropping the base roughness to 0.3 gave the *grain* a specular highlight, which
    // is backwards — real polished wood shows a sharp reflection of the lamp floating
    // over a soft diffuse figure, and only the two-layer model produces that.
    // clearcoatRoughness 0.12 keeps the highlight crisp rather than hazy; the old flat
    // 0.3 produced a broad sheen that looked like worn plastic.
    const apronMat = new THREE.MeshPhysicalMaterial({
      map: woodTexture(),
      roughnessMap: woodRoughnessTexture(),
      color: new THREE.Color('#4a2214'),
      roughness: 0.42,
      metalness: 0,
      clearcoat: 0.32,
      clearcoatRoughness: 0.28,
      envMapIntensity: 0.5
    })
    // The main body: same outer footprint and same top face as the original box, so the
    // depth guard's 1mm cloth-to-apron gap is untouched. Only the faces *between* this
    // and the cap change.
    //
    // It was one solid box, which is fine for a closed cabinet and wrong for a bed with six
    // pockets in it: the box's top face runs across the whole footprint at y=-11, so it roofs
    // every pocket and the bowls and their jaali hang buried inside solid mahogany where no
    // camera can reach them. Cutting the six pocket circles out of it is the smallest change
    // that gives the bowls somewhere to be. The outer silhouette and the top face height are
    // untouched, so nothing about the table's outside or the 1mm cloth gap moves.
    //
    // The holes are 1mm proud of the bowl lip so the bowl's own wall is not embedded in wood.
    // No bevel: it would grow the profile outward, which is exactly how the cushion and the
    // rail cap picked up their hidden physics-visible offsets.
    const apronShape = new THREE.Shape()
    apronShape.moveTo(-outerL / 2, -outerW / 2)
    apronShape.lineTo(outerL / 2, -outerW / 2)
    apronShape.lineTo(outerL / 2, outerW / 2)
    apronShape.lineTo(-outerL / 2, outerW / 2)
    apronShape.closePath()
    for (const p of POCKETS) {
      const hole = new THREE.Path()
      // Pocket centres arrive in table space (0..L, 0..W) and the apron is centred on the
      // origin. The extrusion is built in XY and laid down by rotateX(-90) below, which sends
      // shape +Y to world -Z, hence the negated second term.
      hole.absarc(p.x - TABLE_LENGTH / 2, -(p.y - TABLE_WIDTH / 2), p.radius + 1, 0, Math.PI * 2, true)
      apronShape.holes.push(hole)
    }
    const apronGeo = new THREE.ExtrudeGeometry(apronShape, { depth: 122, bevelEnabled: false })
    apronGeo.rotateX(-Math.PI / 2)
    const apron = new THREE.Mesh(apronGeo, apronMat)
    apron.position.y = -133
    apron.castShadow = true
    this.scene.add(apron)

    // Recessed panel construction on all four apron faces — the hallmark of premium
    // cabinetmaking. Each face has a raised field panel framed by a mitred moulding.
    // This breaks up the flat box and catches light like real joinery.
    const panelInset = 18
    const panelDepth = 4
    const mouldingWidth = 22
    const fieldSizeL = outerL - panelInset * 2 - mouldingWidth * 2
    const fieldSizeW = outerW - panelInset * 2 - mouldingWidth * 2
    const panelMat = new THREE.MeshPhysicalMaterial({
      map: woodTexture(),
      roughnessMap: woodRoughnessTexture(),
      color: new THREE.Color(RAIL_WOOD_TINT),
      roughness: 0.38,
      metalness: 0,
      clearcoat: 0.4,
      clearcoatRoughness: 0.3,
      envMapIntensity: 0.35
    })
    const mouldingMat = new THREE.MeshPhysicalMaterial({
      map: woodTexture(),
      roughnessMap: woodRoughnessTexture(),
      color: new THREE.Color(RAIL_WOOD_TINT),
      roughness: 0.38,
      metalness: 0,
      clearcoat: 0.4,
      clearcoatRoughness: 0.3,
      envMapIntensity: 0.35
    })

    // Long faces (x-axis) - two panels each side, split at centre
    for (const side of [-1, 1]) {
      const z = side * (outerW / 2 - panelInset - mouldingWidth / 2)
      // Centre divider
      const divider = new THREE.Mesh(
        new THREE.BoxGeometry(outerL - panelInset * 2, 4, 6),
        mouldingMat
      )
      divider.position.set(0, -72, z)
      divider.castShadow = true
      this.scene.add(divider)

      // Panels on each side of divider
      for (const panelSide of [-1, 1]) {
        const x = panelSide * (fieldSizeL / 4 + mouldingWidth / 4)
        const panel = new THREE.Mesh(
        new THREE.BoxGeometry(fieldSizeL / 2 - mouldingWidth / 2, 4, mouldingWidth),
          panelMat
        )
        panel.position.set(x, -72, z)
        panel.castShadow = true
        this.scene.add(panel)
      }

      // Top and bottom moulding rails
      for (const railY of [-12, -132]) {
        const rail = new THREE.Mesh(
          new THREE.BoxGeometry(outerL - panelInset * 2, 4, mouldingWidth),
          mouldingMat
        )
        rail.position.set(0, railY, z)
        rail.castShadow = true
        this.scene.add(rail)
      }
    }

    // Short faces (z-axis) - one panel each
    for (const side of [-1, 1]) {
      const x = side * (outerL / 2 - panelInset - mouldingWidth / 2)
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(mouldingWidth, 4, outerW - panelInset * 2 - mouldingWidth * 2),
        panelMat
      )
      panel.position.set(x, -72, 0)
      panel.castShadow = true
      this.scene.add(panel)

      // Vertical mouldings
      for (const railY of [-12, -132]) {
        const rail = new THREE.Mesh(
          new THREE.BoxGeometry(mouldingWidth, 4, outerW - panelInset * 2 - mouldingWidth * 2),
          mouldingMat
        )
        rail.position.set(x, railY, 0)
        rail.castShadow = true
        this.scene.add(rail)
      }
    }

    // Rail cap: the moulded top of the frame, from -1 down to -13. This is the piece that
    // replaces the box's single hard edge with a bevelled one, which is what lets the lamp
    // draw a highlight along it instead of terminating abruptly.
    //
    // All four rails are one mesh with one draw call. Its inner opening is the bed's own
    // footprint, so the visible inner edge lands on the cloth edge and the 32mm between
    // that and the outer face is the rail's width. The 5mm bevel is the chamfer: enough
    // to catch a specular line, invisible as a shape change at gameplay distance.
    const railCap = new THREE.Mesh(makeRailCapGeometry(), apronMat)
    railCap.position.y = -1
    railCap.castShadow = true
    // Tagged so selfCheck can assert the cap's top face stays on the cloth's y=-1 plane.
    railCap.userData.physicsSurface = 'railCapTop'
    this.scene.add(railCap)

    // Crown moulding on top of rail cap — a stepped ogee profile that catches three
    // distinct highlight lines. This is what makes a rail read as hand-moulded millwork
    // rather than a bevelled box. Sits at y=-1 so it doesn't change the physics surface.
    const crownProfile = new THREE.Shape()
    // Profile in (x, y): x runs across rail width (inner to outer), y runs up from cloth
    crownProfile.moveTo(0, 0)           // Inner edge on cloth plane
    crownProfile.lineTo(0, 1.5)         // Small vertical rise
    crownProfile.quadraticCurveTo(4, 3, 8, 3)   // Cove up to first fillet
    crownProfile.lineTo(12, 2)          // Fillet
    crownProfile.quadraticCurveTo(16, 0.5, 20, 0.5)  // Ogee down
    crownProfile.lineTo(26, 1)          // Small step
    crownProfile.quadraticCurveTo(30, 2.5, 32, 2.5)  // Outer ogee up
    crownProfile.lineTo(32, 0)          // Down to outer face
    crownProfile.closePath()

    const crownGeo = new THREE.ExtrudeGeometry(crownProfile, {
      depth: APRON_OUTER_L,
      bevelEnabled: false,
      curveSegments: 8
    })
    crownGeo.rotateX(-Math.PI / 2)
    crownGeo.translate(0, 1, 0) // Position so bottom lands at y=-1

    const crownMat = new THREE.MeshPhysicalMaterial({
      map: woodTexture(),
      roughnessMap: woodRoughnessTexture(),
      color: 0xffffff,
      roughness: 0.35,
      metalness: 0,
      clearcoat: 0.95,
      clearcoatRoughness: 0.08,
      envMapIntensity: 1.3
    })

    // Long rails
    for (const side of [-1, 1]) {
      const crown = new THREE.Mesh(crownGeo, crownMat)
      crown.rotation.y = -Math.PI / 2
      crown.position.set(0, -1, side * (APRON_OUTER_W / 2))
      crown.castShadow = true
      if (SHOW_CROWN_MOULDING) this.scene.add(crown)
    }
    // Short rails
    const crownShortGeo = new THREE.ExtrudeGeometry(crownProfile, {
      depth: APRON_OUTER_W,
      bevelEnabled: false,
      curveSegments: 8
    })
    crownShortGeo.rotateX(-Math.PI / 2)
    crownShortGeo.translate(0, 1, 0)
    for (const side of [-1, 1]) {
      const crown = new THREE.Mesh(crownShortGeo, crownMat)
      crown.position.set(side * (APRON_OUTER_L / 2), -1, 0)
      crown.castShadow = true
      if (SHOW_CROWN_MOULDING) this.scene.add(crown)
    }

    // A recessed rebate under the cap — the reveal between the top rail and the body.
    // Enhanced with a stepped profile: upper fillet, deep shadow gap, lower fillet.
    // This three-part moulding is what makes furniture read as premium millwork.
    const rebateUpper = new THREE.Mesh(
      new THREE.BoxGeometry(outerL - 14, 2, outerW - 14),
      new THREE.MeshStandardMaterial({ color: 0x1a0d07, roughness: 0.9, metalness: 0 })
    )
    rebateUpper.position.y = -14.5
    this.scene.add(rebateUpper)

    const rebateGap = new THREE.Mesh(
      new THREE.BoxGeometry(outerL - 8, 5, outerW - 8),
      new THREE.MeshStandardMaterial({ color: 0x0a0503, roughness: 1, metalness: 0 })
    )
    rebateGap.position.y = -17.5
    this.scene.add(rebateGap)

    const rebateLower = new THREE.Mesh(
      new THREE.BoxGeometry(outerL - 14, 2, outerW - 14),
      new THREE.MeshStandardMaterial({ color: 0x1a0d07, roughness: 0.9, metalness: 0 })
    )
    rebateLower.position.y = -20.5
    this.scene.add(rebateLower)

    // Legs take the same satin film as the apron but a touch less of it: they are further
    // from the lamp's hot centre, and a matching gloss would pull the eye down off the
    // bed. Same maps, so the grain runs continuous in colour from rail to leg.
    const legMat = new THREE.MeshPhysicalMaterial({
      map: woodTexture(),
      roughnessMap: woodRoughnessTexture(),
      color: 0xf2e8e0,
      roughness: 0.5,
      metalness: 0,
      clearcoat: 0.6,
      clearcoatRoughness: 0.18,
      envMapIntensity: 0.9
    })

    // Legs: a turned column, not a post.
    //
    // A 90mm square box is the single loudest "this is a placeholder" signal on the table,
    // and it is the part of a snooker table that is *supposed* to be turned — the profile
    // below is the standard tournament leg: a moulded plinth, a torus, a long tapered
    // shaft, a cove, then a capital block that meets the apron. LatheGeometry sweeps this
    // profile around Y, which is exactly how the real one was made (on a lathe), and
    // costs about 700 triangles per leg — a rounding error next to the bump the
    // silhouette gives.
    //
    // The profile is deliberately not smooth. Every vertical tangent in it is a highlight
    // line under the lamp, and those lines are the whole visual argument that the leg was
    // turned rather than extruded; a smooth taper would just read as a cone.
    // Polished brass. metalness is 1, not the previous 0.85: brass is a pure conductor with
    // no dielectric component, and anything under 1 leaves a diffuse term that greys the
    // metal down toward the colour of the plastic underneath. The colour is a touch
    // warmer and less yellow than the old 0xc9a227, which read as toy gold under the
    // 0xffd9a0 lamp; real polished brass picks up more of the lamp's own warmth and
    // less saturated pigment. The roughness map does the rest.
    const brassMat = new THREE.MeshStandardMaterial({
      color: 0xd8b878,
      metalness: 1,
      roughness: 0.22,
      roughnessMap: brassRoughnessTexture(),
      envMapIntensity: 1.4
    })

    // Leg positions at the frame corners (outer apron footprint).
    // Frame outer half-extents: HALF_L + pad/2, HALF_W + pad/2.
    // This places legs under the frame corners, not under the pocket mouths.
    const legX = HALF_L + pad / 2
    const legZ = HALF_W + pad / 2

    // Leg profile extended to reach from floor (y=-790) to apron bottom (y≈-131).
    // Total height 664mm. Ferrule sits on floor at y=-790 (LEG_FLOOR_Y = -797, ferrule bottom at -790).
    const LEG_FLOOR_Y = -797
    const legProfile: Array<[number, number]> = [
      [0, 0],
      // Plinth: splayed foot, then the fillet under it.
      [46, 0],
      [46, 10],
      [40, 14],
      [38, 26],
      // Torus above the plinth.
      [44, 36],
      [46, 44],
      [44, 52],
      [36, 60],
      // Shaft: long, slightly concave taper — extended to span floor-to-apron.
      [33, 307],
      [30.5, 357],
      [28.5, 417],
      [27, 477],
      [26, 527],
      // Cove into the capital.
      [27, 557],
      [30, 575],
      [38, 587],
      [38, 599],
      // Capital: the block the apron sits on. 664 tall overall, so the top lands at
      // -133 — up inside the apron's bottom edge at -133, with no visible joint and no
      // gap opening at the corner.
      [44, 607],
      [44, 623],
      [46, 627],
      [46, 664],
      [0, 664]
    ]
    const legGeo = new THREE.LatheGeometry(
      legProfile.map(([r, y]) => new THREE.Vector2(r, y)),
      20
    )
    legGeo.computeVertexNormals()

    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(legGeo, legMat)
        leg.position.set(sx * legX, LEG_FLOOR_Y, sz * legZ)
        leg.castShadow = true
        this.scene.add(leg)

        // Brass foot ferrule. A turned leg almost always has a metal or cast shoe, and
        // it does two jobs: it hides the plinth's contact with the floor, and it puts a
        // bright accent at the bottom of the frame so the eye stops sliding off the
        // table. 24 segments — the same silhouette scale as the column it caps.
        const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(47, 49, 14, 24), brassMat)
        ferrule.position.set(sx * legX, LEG_FLOOR_Y + 7, sz * legZ)
        this.scene.add(ferrule)

        // Decorative brass collars at key transitions up the leg — these are the
        // "rings" that separate turned sections on a premium table leg.
        const collarMat = new THREE.MeshStandardMaterial({
          color: 0xd8b878,
          metalness: 1,
          roughness: 0.18,
          roughnessMap: brassRoughnessTexture(),
          envMapIntensity: 1.4
        })
        // Collar at torus top (profile y=60)
        const collar1 = new THREE.Mesh(new THREE.TorusGeometry(46, 3, 10, 24), collarMat)
        collar1.rotation.x = -Math.PI / 2
        collar1.position.set(sx * legX, LEG_FLOOR_Y + 60, sz * legZ)
        this.scene.add(collar1)

        // Collar at shaft/cove transition (profile y=527)
        const collar2 = new THREE.Mesh(new THREE.TorusGeometry(36, 2.5, 10, 24), collarMat)
        collar2.rotation.x = -Math.PI / 2
        collar2.position.set(sx * legX, LEG_FLOOR_Y + 527, sz * legZ)
        this.scene.add(collar2)

        // Collar at capital base (profile y=607)
        const collar3 = new THREE.Mesh(new THREE.TorusGeometry(44, 3, 10, 24), collarMat)
        collar3.rotation.x = -Math.PI / 2
        collar3.position.set(sx * legX, LEG_FLOOR_Y + 607, sz * legZ)
        this.scene.add(collar3)
      }
    }
    const halfInner = pad / 2 - 10
    // A scaled unit cube has square corners and one hard specular edge, which is why the
    // trim read as a flat gold sticker. Each rail instead gets a proper moulding: a small
    // stepped section swept the length of the rail, so the lamp catches three separate
    // highlight lines along it rather than one.
    //
    // Placement is unchanged from the boxes this replaces  14mm proud of the frame face
    // and sitting at —halfInner  so the trim occupies exactly the same volume it did.
    const trimRails: Array<[number, 'x' | 'z', 1 | -1]> = [
      [TABLE_LENGTH + pad - 14, 'x', -1],
      [TABLE_LENGTH + pad - 14, 'x', 1],
      [TABLE_WIDTH + pad - 14, 'z', -1],
      [TABLE_WIDTH + pad - 14, 'z', 1]
    ]
    const trimCache = new Map<number, THREE.ExtrudeGeometry>()
    for (const [length, axis, side] of trimRails) {
      const key = Math.round(length)
      let geo = trimCache.get(key)
      if (!geo) {
        geo = makeBeadGeometry(key)
        trimCache.set(key, geo)
      }
      const trim = new THREE.Mesh(geo, brassMat)
      const place = trimTransform(key, axis, side, 2.5, halfInner)
      trim.rotation.y = place.rotationY
      trim.position.copy(place.position)
      this.scene.add(trim)
    }

    // Corner castings. Enhanced with beveled base plate, stepped boss, domed cap, and
    // subtle fastener heads — the hallmark of premium tournament tables where the rails
    // are bolted through brass corner plates.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const cx = sx * (HALF_L + halfInner)
        const cz = sz * (HALF_W + halfInner)

        // Base plate: beveled washer that sits on the rail cap, slightly recessed
        const basePlate = new THREE.Mesh(
          new THREE.CylinderGeometry(28, 28, 3, 32),
          brassMat
        )
        basePlate.position.set(cx, 3.5, cz)
        this.scene.add(basePlate)

        // Beveled outer ring on base plate
        const baseBevel = new THREE.Mesh(
          new THREE.TorusGeometry(28, 2.5, 12, 32),
          brassMat
        )
        baseBevel.rotation.x = -Math.PI / 2
        baseBevel.position.set(cx, 5, cz)
        this.scene.add(baseBevel)

        // Main corner boss - stepped profile
        const boss = new THREE.Mesh(new THREE.CylinderGeometry(19, 23, 7, 20), brassMat)
        boss.position.set(cx, 9.5, cz)
        this.scene.add(boss)

        // Decorative collar at boss midpoint
        const collar = new THREE.Mesh(
          new THREE.TorusGeometry(21, 1.8, 10, 20),
          brassMat
        )
        collar.rotation.x = -Math.PI / 2
        collar.position.set(cx, 9.5, cz)
        this.scene.add(collar)

        // Domed cap
        const dome = new THREE.Mesh(
          new THREE.SphereGeometry(11, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2),
          brassMat
        )
        dome.position.set(cx, 14.4, cz)
        this.scene.add(dome)

        // Four subtle fastener heads at the corners of the base plate
        const fastenerMat = new THREE.MeshStandardMaterial({
          color: 0xc8a068,
          metalness: 1,
          roughness: 0.15,
          envMapIntensity: 1.5
        })
        const fastenerGeo = new THREE.CylinderGeometry(2.5, 2.5, 1.5, 12)
        for (const fx of [-1, 1]) {
          for (const fz of [-1, 1]) {
            const fastener = new THREE.Mesh(fastenerGeo, fastenerMat)
            fastener.position.set(cx + fx * 14, 4.2, cz + fz * 14)
            this.scene.add(fastener)
          }
        }
      }
    }

    // Cushion cloth: the same woven treatment as the bed, a step darker so the raised edge
    // does not melt into the playing surface. Shares the bed's normal map, which is the
    // right call — cushions are cut from the same bolt of cloth, so their nap must match
    // or the join between bed and cushion becomes visible at the seam.
    // side: DoubleSide is not a shortcut — an ExtrudeGeometry profile is a closed loop
    // only if the caller closes it, and this one's ends are swept open at the pocket
    // jaws where the segment is cut to length.
    const cushionMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#1c9a34'),
      normalMap: feltNormalTexture(),
      normalScale: new THREE.Vector2(CUSHION_NORMAL_STRENGTH, CUSHION_NORMAL_STRENGTH),
      roughness: 0.55,
      metalness: 0,
      side: THREE.DoubleSide,
      vertexColors: true,
      envMapIntensity: 0.25
    })
    // The nose strip stays a separate material rather than being merged into the cushion:
// real cushion rubber is compressed smooth along the strike line, so it takes a tighter
// highlight than the body, and that highlight running along the nose is what tells the
// eye where the cushion is. With the profile below carrying the shape, this is now a
// thin capping strip on the nose shoulder instead of a separate box beside it.
    const noseMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#22b23f'),
      normalMap: feltNormalTexture(),
      normalScale: new THREE.Vector2(CUSHION_NORMAL_STRENGTH, CUSHION_NORMAL_STRENGTH),
      roughness: 0.32,
      metalness: 0,
      side: THREE.DoubleSide,
      envMapIntensity: 0.3
    })
    // Six segments, two per long rail and one per short rail. The long pair on each rail
    // is the same length, so this caches two distinct geometries rather than six.
    const cushionGeo = new Map<number, THREE.ExtrudeGeometry>()

    // `axis` is the rail's run ('x' for the long rails, 'z' for the short), `outward` the
    // sign of the direction the cushion's depth points away from the bed. The rotation and
    // position that follow are coupled, and the coupling is why they live in
    // `cushionTransform` rather than here  see the note there on why the signs are written
    // out instead of folded into a lookup.
    const addCushion = (length: number, axis: 'x' | 'z', outward: 1 | -1, centreAlong: number): void => {
      const key = Math.round(length)
      let geo = cushionGeo.get(key)
      if (!geo) {
        geo = makeCushionGeometry(key)
        cushionGeo.set(key, geo)
      }
      const mesh = new THREE.Mesh(geo, cushionMat)
      const place = cushionTransform(length, axis, outward, centreAlong)
      mesh.rotation.y = place.rotationY
      mesh.position.copy(place.position)
      mesh.castShadow = true
      mesh.receiveShadow = true
      // Two-tone cushion: darker face toward table, lighter glossy top
      const pos = (geo.attributes.position as THREE.BufferAttribute)
      const normal = (geo.attributes.normal as THREE.BufferAttribute)
      const colors = new Float32Array(pos.count * 3)
      const faceColor = new THREE.Color(CUSHION_FACE_COLOR)
      const topColor = new THREE.Color(CUSHION_TOP_COLOR)
      const nY = new THREE.Vector3()
      for (let i = 0; i < pos.count; i++) {
        nY.x = normal.getX(i)
        nY.y = normal.getY(i)
        nY.z = normal.getZ(i)
        const t = THREE.MathUtils.smoothstep(nY.y, 0.25, 0.85)
        const c = faceColor.clone().lerp(topColor, t)
        colors[i * 3 + 0] = c.r
        colors[i * 3 + 1] = c.g
        colors[i * 3 + 2] = c.b
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      mesh.userData.physicsSurface = `cushion:${axis}:${outward}`
      this.scene.add(mesh)

      // Cushion attachment brackets — small brass brackets that screw the cushion rubber
      // to the rail frame. On a real table these are spaced every ~200mm along the rail.
      // They catch highlights and sell the "physically attached" look.
      const bracketMat = new THREE.MeshStandardMaterial({
        color: 0xc8a068,
        metalness: 1,
        roughness: 0.2,
        roughnessMap: brassRoughnessTexture(),
        envMapIntensity: 1.5
      })
      const bracketGeo = new THREE.BoxGeometry(8, 6, 4)
      const screwGeo = new THREE.CylinderGeometry(1.2, 1.2, 3, 8)
      const screwMat = new THREE.MeshStandardMaterial({
        color: 0x9a7a4a,
        metalness: 1,
        roughness: 0.25,
        envMapIntensity: 1.3
      })
      const spacing = 200
      const start = -length / 2 + spacing / 2
      const count = Math.floor(length / spacing)
      for (let i = 0; i < count; i++) {
        const along = start + i * spacing
        if (axis === 'x') {
          // Bracket on the back of the cushion, screwed into the rail
          const bracket = new THREE.Mesh(bracketGeo, bracketMat)
          bracket.position.set(
            centreAlong + along,
            4,
            outward * (HALF_W + CUSHION_DEPTH - 2)
          )
          this.scene.add(bracket)
          const screw = new THREE.Mesh(screwGeo, screwMat)
          screw.rotation.x = Math.PI / 2
          screw.position.set(
            centreAlong + along,
            4,
            outward * (HALF_W + CUSHION_DEPTH + 1)
          )
          this.scene.add(screw)
        } else {
          const bracket = new THREE.Mesh(bracketGeo, bracketMat)
          bracket.rotation.y = Math.PI / 2
          bracket.position.set(
            outward * (HALF_L + CUSHION_DEPTH - 2),
            4,
            centreAlong + along
          )
          this.scene.add(bracket)
          const screw = new THREE.Mesh(screwGeo, screwMat)
          screw.rotation.x = Math.PI / 2
          screw.position.set(
            outward * (HALF_L + CUSHION_DEPTH + 1),
            4,
            centreAlong + along
          )
          this.scene.add(screw)
        }
      }

      // The nose cap: a thin strip riding the shoulder, in the glossier material. It sits
      // just proud of the profile so it reads as a separate strip of compressed rubber
      // rather than a coplanar decal, and it starts at u=1 so the physics face at u=0 is
      // left completely untouched.
      const noseGeo = new THREE.BoxGeometry(
        axis === 'x' ? length : 6,
        3,
        axis === 'x' ? 6 : length
      )
      const nose = new THREE.Mesh(noseGeo, noseMat)
      if (axis === 'x') {
        nose.position.set(centreAlong, CUSHION_H - 1.2, outward * (HALF_W + 5))
      } else {
        nose.position.set(outward * (HALF_L + 5), CUSHION_H - 1.2, centreAlong)
      }
      this.scene.add(nose)
    }

    for (const [length, axis, outward, centre] of cushionLayout()) {
      addCushion(length, axis, outward, centre)
    }

    // Leather drop pockets: a shaded throat cylinder recessed below the bed, a
    // dark inner drop, and a leather-look rim ring. The depth texture on the
    // throat's inside face is what makes the hole read as a cavity rather than a
    // flat decal — darkness pooling at the bottom, leather tone up the walls.
    const throatMat = new THREE.MeshStandardMaterial({
      map: pocketDepthTexture(),
      color: 0x2a1a10,
      roughness: 0.9,
      metalness: 0,
      side: THREE.BackSide
    })
    const dropMat = new THREE.MeshBasicMaterial({ color: 0x000000 })
    const mouthShadowMat = new THREE.MeshBasicMaterial({
      map: contactShadowTexture(),
      transparent: true,
      depthWrite: false
    })
    // Pocket leather: a coated hide with pebble grain. The clearcoat gives the
    // finished leather its tight specular, while the base roughness carries the
    // pebble texture. We'll add a leather normal map for the grain.
    const leatherMat = new THREE.MeshPhysicalMaterial({
      color: 0x6b4426,
      roughness: 0.62,
      metalness: 0,
      clearcoat: 0.5,
      clearcoatRoughness: 0.3,
      sheen: 0.3,
      sheenColor: new THREE.Color(0xa8794a),
      envMapIntensity: 0.8
    })
    const brassLipMat = new THREE.MeshStandardMaterial({
      color: 0xd8b878,
      metalness: 1,
      roughness: 0.2,
      roughnessMap: brassRoughnessTexture(),
      envMapIntensity: 1.35
    })
    const pocketGeo = new Map<
      number,
      {
        throat: THREE.BufferGeometry
        drop: THREE.BufferGeometry
        lip: THREE.BufferGeometry
        shadow: THREE.BufferGeometry
        stitch: THREE.BufferGeometry
        mouth: THREE.BufferGeometry
        rim: THREE.BufferGeometry
        net: THREE.BufferGeometry
        bowl: THREE.BufferGeometry
        netDisc: THREE.BufferGeometry
        jawZ: THREE.BufferGeometry
        jawX: THREE.BufferGeometry
        jawXFar: THREE.BufferGeometry
        brassRing: THREE.BufferGeometry
      }
    >()
    const pocketHoleMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -1
    })
    const pocketPlateMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(POCKET_PLATE_COLOR),
      roughness: 0.55,
      metalness: 0,
      envMapIntensity: 0.35
    })
    // The cream/ivory cap that rings every pocket mouth: warm off-white, semi-gloss,
    // satin rather than plastic. It is a dielectric like the rails, so metalness stays 0
    // and the clearcoat is a whisper - any more and the lamp turns it into a chrome ring.
    const pocketRimMat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(POCKET_RIM_COLOR),
      roughness: 0.55,
      metalness: 0,
      clearcoat: 0.15,
      clearcoatRoughness: 0.35,
      envMapIntensity: 0.25
    })
    // The jaali hanging inside the pocket: a dark, matte, unlit-looking weave. Seen from
    // inside, so BackSide - the camera looks down into a cone, not at the outside of one.
    const pocketNetMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(POCKET_NET_DARK_COLOR),
      roughness: 0.9,
      metalness: 0,
      side: THREE.BackSide,
      envMapIntensity: 0.05
    })
    // The bowl's inner wall. Unlit on purpose, and that is the whole trick: a lit material
    // inside a 46mm hole receives essentially no light and renders black no matter how pale
    // its albedo is, which is why this used to come out as a dark void. Carrying the shading
    // in a painted gradient instead means the cream-at-the-lip to black-at-the-throat fall
    // is exactly what reaches the screen, with no dependence on what the lamps are doing.
    // DoubleSide, because a lathe's winding decides which way the inside wall faces and a
    // one-sided guess that lands wrong leaves you looking through the funnel at the room.
    const pocketBowlMat = new THREE.MeshBasicMaterial({
      map: pocketBowlShadeTexture(),
      side: THREE.DoubleSide
    })
    // The jaali as a picture rather than a cone. Unlit on purpose: it sits deep in a hole
    // where lit materials go black, and the reference wants the strings to stay legibly
    // cream from the normal playing camera angle.
    const pocketNetConeMat = new THREE.MeshBasicMaterial({
     map: pocketNetAlphaTexture(),
     alphaTest: 0.35,
    side: THREE.DoubleSide
     })
    // The jaw is cushion, so it wears cushion cloth: same green, same roughness, so the
    // nose reads as one continuous rubber from rail to pocket.
    const pocketJawMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#1c9a34'),
    roughness: 0.88,
    metalness: 0,
    side: THREE.DoubleSide,
    envMapIntensity: 0.12
   })
    const geoFor = (radius: number) => {
      const cached = pocketGeo.get(radius)
      if (cached) return cached
      const made = {
        throat: new THREE.CylinderGeometry(radius * 0.98, radius * 0.8, 90, 28, 1, true),
        drop: new THREE.CircleGeometry(radius * 0.8, 24),
        lip: new THREE.TorusGeometry(radius + 4, 4.5, 14, 36),
        shadow: new THREE.CircleGeometry(radius * 1.35, 28),
        // Stitches. A pocket with a laced rim is the single strongest "real object"
        // signal available here, and a ring of tiny capsules costs about 400 triangles.
        // 16 is the point where they stop reading as a beaded edge, which is what a real
        // lace looks like.
        stitch: new THREE.CapsuleGeometry(1.5, 7, 3, 6),
        // The bed opening: a clean disc of cloth-coloured-over-by-black that reads as the
        // mouth. Its radius is the physics radius exactly, so it meets the cream cap's
        // inner edge with no sliver of green showing between them.
        mouth: new THREE.CircleGeometry(radius, 32),
        // The cream cap, lathed. The profile is authored in (radius, height) and spun
        // around Y, which is the one primitive that gives a rounded outer edge without
        // hand-authoring a torus section. Inner edge sits ON the physics radius: never
        // narrower, or the drawn mouth would disagree with where the ball actually drops.
        rim: new THREE.LatheGeometry(
          [
            new THREE.Vector2(radius, 0),
            new THREE.Vector2(radius, POCKET_RIM_HEIGHT_MM * 0.55),
            new THREE.Vector2(radius + 2, POCKET_RIM_HEIGHT_MM * 0.85),
            new THREE.Vector2(radius + 6, POCKET_RIM_HEIGHT_MM),
            new THREE.Vector2(radius + POCKET_RIM_WIDTH_MM - 6, POCKET_RIM_HEIGHT_MM),
            new THREE.Vector2(radius + POCKET_RIM_WIDTH_MM - 2, POCKET_RIM_HEIGHT_MM * 0.8),
            new THREE.Vector2(radius + POCKET_RIM_WIDTH_MM, POCKET_RIM_HEIGHT_MM * 0.4),
            new THREE.Vector2(radius + POCKET_RIM_WIDTH_MM, 0)
          ],
          32
        ),
        // The jaali: a truncated cone hanging from just under the rim down into the
        // cavity. Open-ended, so it is a wall and not a lid - the drop below stays black.
        net: new THREE.CylinderGeometry(
          radius * 0.95,
          radius * 0.5,
          POCKET_NET_DROP_MM,
          20,
          1,
          true
        ),
        // The bowl: a funnel whose lip is the physics radius at the cloth and which draws
        // in to the throat depth below it. The profile is authored top-down so the lathe's
        // v runs 0 at the cloth edge to 1 at the throat, which is the direction the shading
        // gradient runs.
        bowl: new THREE.LatheGeometry(
          [
            new THREE.Vector2(radius, 0),
            new THREE.Vector2(radius * 0.98, -7),
            new THREE.Vector2(radius * 0.9, -18),
            new THREE.Vector2(radius * 0.78, -30),
            new THREE.Vector2(POCKET_BOWL_THROAT_MM + 4, -40),
            new THREE.Vector2(POCKET_BOWL_THROAT_MM, -POCKET_BOWL_DEPTH_MM)
          ],
          40
        ),
        // The jaali as a picture across the throat of the bowl.
        netDisc: new THREE.CircleGeometry(POCKET_NET_RADIUS_MM, 32),
        // The jaws. Every pocket here is met by exactly two cushion ends, and which axes
        // those are differs by pocket: a corner is entered from +X (long rail) and +Z
        // (short rail), while a middle pocket sits between the two halves of one long rail
        // and is entered from +X and -X.
        //
        // LatheGeometry measures phi from +Z (x = r sin phi, z = r cos phi), so +Z is phi 0,
        // +X is phi 90 and -X is phi 270. The inner edge of each arc sits exactly on the
        // physics radius, so the nose rolls over the lip without narrowing the drawn mouth.
        jawZ: new THREE.LatheGeometry(jawProfile(radius), 14, jawPhi(0), jawArc()),
        jawX: new THREE.LatheGeometry(jawProfile(radius), 14, jawPhi(90), jawArc()),
        jawXFar: new THREE.LatheGeometry(jawProfile(radius), 14, jawPhi(270), jawArc()),
        // Thin polished brass ring sitting on the cream rim's outer edge.
        brassRing: new THREE.TorusGeometry(
          radius + POCKET_RIM_WIDTH_MM - POCKET_BRASS_RING_INSET_MM,
          POCKET_BRASS_TUBE_MM,
          10,
          36
        )
      }
      pocketGeo.set(radius, made)
      return made
    }
    // Every pocket gets the modelled bowl, the painted jaali and its pair of green jaws.
    // The older flat pieces - black disc, cream cap, dark cone, leather ring - are kept in
    // the tree but gated off, so nothing lies flat above the cloth or floats on the rail.
    for (const p of POCKETS) {
      const x = tableX(p.x)
      const z = tableZ(p.y)
      const geo = geoFor(p.radius)
      const detailed = POCKET_DETAIL_ALL
      // Inner shadow ring on the bed around the mouth, softening the cloth edge.
      if (false) {
        const shadow = new THREE.Mesh(geo.shadow, mouthShadowMat)
        shadow.name = 'pocket-shadow'
        shadow.rotation.x = -Math.PI / 2
        shadow.position.set(x, CUSHION_H + 1.1, z)
        shadow.renderOrder = 4
        this.scene.add(shadow)
      }
      if (!detailed) {
        // The throat: open-ended cylinder seen from inside, recessed below the bed.
        const throat = new THREE.Mesh(geo.throat, throatMat)
        throat.name = 'pocket-throat'
        throat.position.set(x, CUSHION_H + 1.2 - 45, z)
        throat.renderOrder = 5
        this.scene.add(throat)
        // The bottom of the drop.
        const drop = new THREE.Mesh(geo.drop, dropMat)
        drop.name = 'pocket-drop'
        drop.rotation.x = -Math.PI / 2
        drop.position.set(x, CUSHION_H + 1.2 - 90, z)
        this.scene.add(drop)
        // The bed opening. A clean black disc sitting a fraction of a millimetre over the
        // cloth, sized to the physics radius so it lines up with where the ball actually
        // falls. This is what stops the cloth reading as an unbroken sheet at the pocket.
        const mouth = new THREE.Mesh(geo.mouth, pocketHoleMat)
        mouth.name = 'pocket-mouth'
        mouth.rotation.x = -Math.PI / 2
        mouth.position.set(x, POCKET_HOLE_Y_MM, z)
        mouth.renderOrder = 2
        this.scene.add(mouth)

        // The cream cap, sitting on top of the cushion's own height so the rubber and the
        // cap meet at one level rather than the cap perching on the rail below them.
        const rim = new THREE.Mesh(geo.rim, pocketRimMat)
        rim.name = 'pocket-rim'
         rim.position.set(x, CUSHION_H - POCKET_RIM_HEIGHT_MM - 2, z)
        this.scene.add(rim)

        // The jaali, hanging from under the cap down into the dark. Its top radius tracks
        // the mouth so there is no gap to see the room through.
        const netCone = new THREE.Mesh(makePocketNetGeometry(p.radius), pocketNetConeMat)
        netCone.name = 'pocket-net-detail'
        netCone.position.set(x, 0, z)
        this.scene.add(netCone)
      }

      if (detailed) {
        // The bowl. Its lip is the physics radius sitting on the cloth, so the cream wall
        // starts exactly at the cloth edge and shares the pocket's centre - it is placed at
        // the pocket's own x/z, never at the origin. The lathe is BackSide, so what the
        // camera sees is the inside of the funnel.
        const bowl = new THREE.Mesh(geo.bowl, pocketBowlMat)
        bowl.name = 'pocket-bowl-detail'
        bowl.position.set(x, 0, z)
        this.scene.add(bowl)

        // The jaali, stretched across the throat of the bowl. Kept shallow enough that it
        // is still lit and still legible looking down from the normal playing camera.
        const netCone = new THREE.Mesh(makePocketNetGeometry(p.radius), pocketNetConeMat)
        netCone.name = 'pocket-net-detail'
        netCone.position.set(x, 0, z)
        this.scene.add(netCone)

        // Cream rim + thin brass outer ring: premium arena pocket trim without replacing
        // the ivory cap. Rim sits on cushion height; brass hugs the outer edge.
        const rim = new THREE.Mesh(geo.rim, pocketRimMat)
        rim.name = 'pocket-rim'
        rim.position.set(x, CUSHION_H - POCKET_RIM_HEIGHT_MM - 2, z)
        this.scene.add(rim)
        const brassRing = new THREE.Mesh(geo.brassRing, brassLipMat)
        brassRing.name = 'pocket-brass-ring'
        brassRing.rotation.x = -Math.PI / 2
        brassRing.position.set(x, CUSHION_H - 1.5, z)
        this.scene.add(brassRing)

        // The green jaws, one per cushion that meets this pocket. They are lathes centred on
        // the pocket itself, so they are automatically concentric with the bowl, and which
        // axes they cover depends on the pocket: a corner is entered from +X and +Z, a
        // middle from +X and -X.
          for (const s of jawSpecs(x, z, p.kind)) {
          const jaw = new THREE.Mesh(makeJawGeometry(p.radius, s.startDeg, s.arcDeg), pocketJawMat)
          jaw.name = 'pocket-jaw-detail'
          jaw.position.set(x, 0, z)
          this.scene.add(jaw)
        }
      }

      // Jaw plate: flat cream plate with hole, clipped to apron footprint
      const holeR = p.radius * POCKET_HOLE_SCALE
      const isCorner = p.kind === 'corner'
      const shape = new THREE.Shape()
      const extra = POCKET_PLATE_EXTRA_MM
      const apronHalfL = APRON_OUTER_L / 2
      const apronHalfW = APRON_OUTER_W / 2
      if (isCorner) {
        // wedge along the two rails toward corner; but easier: build polygon around pocket extending along rails, then hole
        shape.moveTo(x - holeR, z)
        shape.lineTo(x - extra, z)
        shape.lineTo(x, z - extra)
        shape.lineTo(x + holeR, z)
        shape.arc(0, 0, holeR, 0, Math.PI * 2, true)
        shape.closePath()
      } else {
        shape.moveTo(x - extra, z - holeR)
        shape.lineTo(x + extra, z - holeR)
        shape.lineTo(x + extra, z + holeR)
        shape.lineTo(x - extra, z + holeR)
        shape.lineTo(x - extra, z - holeR)
      }
      const plateGeo = new THREE.ShapeGeometry(shape)
      const plate = new THREE.Mesh(plateGeo, pocketPlateMat)
      plate.rotation.x = -Math.PI / 2
      plate.position.set(0, POCKET_PLATE_Y_MM, 0)
      plate.renderOrder = 1
      if (SHOW_POCKET_FLAT_PLATE) {
        this.scene.add(plate)
      }

      if (SHOW_POCKET_LIP_RING) {
        const lip = new THREE.Mesh(geo.lip, leatherMat)
        lip.name = 'pocket-lip'
        lip.rotation.x = -Math.PI / 2
        lip.position.set(x, CUSHION_H + 2.4, z)
        this.scene.add(lip)
      }
      if (false) {
        const brass = new THREE.Mesh(geo.lip, brassLipMat)
        brass.name = 'pocket-brass'
        brass.rotation.x = -Math.PI / 2
        brass.scale.set(0.82, 0.82, 1.35)
        brass.position.set(x, CUSHION_H + 3.0, z)
        this.scene.add(brass)
      }

      // Lacing around the pocket mouth. Each stitch is a capsule laid flat and rotated to
      // follow the circle, alternating lean so the ring reads as laced rather than as a
      // printed dotted line. The InstancedMesh matters here: 16 stitches x 6 pockets is
      // 96 meshes otherwise, all sharing one geometry.
      const stitchCount = 16
      const stitches = new THREE.InstancedMesh(geo.stitch, brassLipMat, stitchCount)
      stitches.name = 'pocket-stitches'
      const m4 = new THREE.Matrix4()
      const q = new THREE.Quaternion()
      const e = new THREE.Euler()
      const one = new THREE.Vector3(1, 1, 1)
      const at = new THREE.Vector3()
      const laceR = p.radius + 8.5
      for (let i = 0; i < stitchCount; i++) {
        const t = (i / stitchCount) * Math.PI * 2
        at.set(x + Math.cos(t) * laceR, CUSHION_H + 2.6, z + Math.sin(t) * laceR)
        // Lie the capsule along the circumference, alternating lean so the ring looks
        // stitched. Yaw to face outward, then pitch to the tangent.
       e.set(Math.PI / 2, -t, i % 2 === 0 ? 0.42 : -0.42, 'YXZ')
        q.setFromEuler(e)
        m4.compose(at, q, one)
        stitches.setMatrixAt(i, m4)
      }
      stitches.instanceMatrix.needsUpdate = true
      if (false) {
        this.scene.add(stitches)
      }
    }
    } // end code-built table

    // Dark floor, so the lit table is the subject of the picture.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(16000, 9000),
      new THREE.MeshLambertMaterial({ color: new THREE.Color(ROOM_FLOOR_COLOR) })
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -797
    floor.receiveShadow = true
    this.scene.add(floor)

    // Blue wall, gradient to navy at the top, with the lamp's pool of light on it.
    const backWall = new THREE.Mesh(
      new THREE.PlaneGeometry(14000, 7000),
      new THREE.MeshStandardMaterial({ map: wallTexture(), roughness: 0.9 })
    )
    backWall.position.set(0, 500, -4600)
    this.scene.add(backWall)

    // The fixture meshes stay in the scene graph but are not rendered: the shade
    // sits exactly on the line between the overhead camera and the table centre, so
    // in the top-down view it filled the frame with a brown cone. The light itself
    // lives in buildLighting and is untouched — only the geometry is hidden.
    const shade = new THREE.Mesh(
      new THREE.CylinderGeometry(80, 330, 260, 28),
      new THREE.MeshStandardMaterial({ color: 0x8a6a34, roughness: 0.35, metalness: 0.6 })
    )
    shade.position.set(0, 1900, 0)
    shade.visible = false
    this.scene.add(shade)
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(60, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff3cf })
    )
    bulb.position.set(0, 1790, 0)
    bulb.visible = false
    this.scene.add(bulb)

    // The whole set built above — cloth, cushions, pockets, floor, lamp shade — is
    // static. Freezing every matrix here means the one static shadow frame and every
    // later render skip their matrix recalculations, and the fixture part of the
    // shadow map is settled before the first frame is ever drawn.
    this.scene.traverse((obj) => {
      obj.matrixAutoUpdate = false
      obj.updateMatrix()
    })
    if ((globalThis as any).__DEBUG_POLES__) {
      this.__debugPoles()
    }
    this.__installDebugHandles()
  }

  /**
   * TEMP DEBUG (Step E) — the pole census. Flag-gated and inert by default.
   *
   * Set `window.__DEBUG_POLES__ = true` before the scene is built (or just call
   * `window.__debugPoles()` afterwards) and this prints every mesh whose world-space
   * bounding box reaches `yMin` above the cloth, grouped by its nearest pocket. The point
   * is to answer one question with numbers instead of guesses: *what is standing up on
   * this table, and where.*
   *
   * Four things the first version of this got wrong, all of which changed its answer:
   *
   * - It ignored `visible`. `Box3.setFromObject` walks invisible objects happily, so the
   *   two fixture meshes that are deliberately `visible = false` — the lamp shade at
   *   y≈1900 and the bulb at y≈1790, both parked on the table's centre line — were
   *   reported as the two tallest "poles" in the scene. They cannot be seen; they were
   *   the top two rows of the table.
   * - It excluded the cue with `m === this.stick`, which is a `Group`. `traverse` visits
   *   the Group *and* its five cylinder children, and the shaft alone is 1200mm long, so
   *   excluding the Group excluded none of the geometry. Membership is now decided by
   *   walking ancestors, so a cue is a cue whichever of its parts is being measured.
   * - It read `m.position` for the pocket-distance test, which is local. Anything parented
   *   — every ball rig, the whole cue — was measured from the wrong place and attributed
   *   to whichever pocket happened to be nearest the origin. World centres now.
   * - It `break`ed out of the instanced loop on the first tall instance, so an
   *   `InstancedMesh` could report at most one hit however many of its instances were
   *   standing up. All instances are enumerated now.
   *
   * Everything it walks is a real world-space box, and every instance of an instanced mesh
   * is measured rather than sampled, so a count from this can be trusted to be a count.
   */
  private __debugPoles(yMin = 100): void {
    const box = new THREE.Box3()
    const centre = new THREE.Vector3()
    const m4 = new THREE.Matrix4()
    const rows: Array<Record<string, unknown>> = []
    const byPocket = new Map<string, number>()
    for (const p of POCKETS) byPocket.set(pocketKey(p), 0)

    /** True when `obj` or any ancestor is the cue, or is not visible at all. */
    const skip = (obj: THREE.Object3D): boolean => {
      for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
        if (o === (this as unknown as { stick: THREE.Group }).stick) return true
        if (o.visible === false) return true
      }
      return false
    }

    const nearestPocket = (x: number, z: number): { key: string; dist: number } => {
      let key = 'other'
      let dist = Infinity
      for (const p of POCKETS) {
        const d = Math.hypot(tableX(p.x) - x, tableZ(p.y) - z)
        if (d < dist) {
          dist = d
          key = pocketKey(p)
        }
      }
      return { key, dist }
    }

    const record = (label: string, kind: string, b: THREE.Box3, instance: number | null): void => {
      centre.addVectors(b.min, b.max).multiplyScalar(0.5)
      const near = nearestPocket(centre.x, centre.z)
      byPocket.set(near.key, (byPocket.get(near.key) ?? 0) + 1)
      rows.push({
        label,
        kind,
        instance,
        yMin: Number(b.min.y.toFixed(1)),
        yMax: Number(b.max.y.toFixed(1)),
        x: Number(centre.x.toFixed(1)),
        z: Number(centre.z.toFixed(1)),
        nearestPocket: near.key,
        distToPocket: Number(near.dist.toFixed(1))
      })
    }

    this.scene.traverse((obj) => {
      if (skip(obj)) return
      const mesh = obj as THREE.Mesh & { isInstancedMesh?: boolean; isMesh?: boolean }
      if (mesh.isInstancedMesh) {
        const im = mesh as unknown as THREE.InstancedMesh
        if (!im.geometry.boundingBox) im.geometry.computeBoundingBox()
        const geoBox = im.geometry.boundingBox
        if (!geoBox) return
        const tmp = new THREE.Box3()
        for (let i = 0; i < im.count; i++) {
          im.getMatrixAt(i, m4)
          tmp.copy(geoBox).applyMatrix4(m4)
          tmp.applyMatrix4(im.matrixWorld)
          if (tmp.max.y > yMin) record(im.name || 'instanced', (im.geometry as any).type, tmp, i)
        }
        return
      }
      if (!mesh.isMesh) return
      box.setFromObject(mesh, true)
      if (box.max.y > yMin) record(mesh.name || mesh.geometry.type, mesh.geometry.type, box, null)
    })

    console.log(`POLES: ${rows.length} meshes reaching above y=${yMin}mm (invisible and cue excluded)`)
    console.log('POLES by nearest pocket:', Object.fromEntries(byPocket))
    console.table(rows)
  }

  /**
   * TEMP DEBUG (Step E) — console handles for bisecting the scene by hand.
   *
   * `__debugScene` is the live scene graph, so anything can be inspected from the console.
   * `__hide` takes a substring and hides every mesh whose name or geometry type contains
   * it, which is how a suspect is isolated without a rebuild: hide the cue, look; hide the
   * fixtures, look. `__showAll` puts everything back.
   *
   * Gated on the same flag as the census so a normal match never pays for the traversal.
   */
  private __installDebugHandles(): void {
    const g = globalThis as any
    if (!g.__DEBUG_POLES__) return
    g.__debugScene = this.scene
    g.__debugPoles = (yMin?: number) => this.__debugPoles(yMin)
    g.__hide = (needle: string): number => {
      let n = 0
      this.scene.traverse((o) => {
        const m = o as THREE.Mesh & { isMesh?: boolean; isInstancedMesh?: boolean }
        const hay = `${m.name ?? ''} ${m.geometry?.type ?? ''}`
        if ((m.isMesh || m.isInstancedMesh) && hay.includes(needle)) {
          o.visible = false
          n++
        }
      })
      console.log(`__hide(${needle}): hid ${n}`)
      return n
    }
    g.__showAll = (): void => {
      this.scene.traverse((o) => {
        o.visible = true
      })
      console.log('__showAll: every object visible again (note: this also un-hides the lamp shade)')
    }
    console.log('debug handles: __debugScene, __debugPoles(yMin?), __hide(needle), __showAll()')
  }

  private buildAim(): void {
    // The aim guide is three solid rectangular strips and one hollow ring:
    // white cue path + deflection, neon object path — no feathers or length fades.
    const ribbonTex = aimRibbonSolidTexture()
    this.aimRibbon1 = this.buildRibbon(ribbonTex, AIM_LINE1_COLOR, AIM_LINE1_OPACITY, AIM_RIBBON_Y)
    this.aimRibbon1Open = this.buildRibbon(ribbonTex, AIM_LINE1_COLOR, AIM_LINE1_OPACITY, AIM_RIBBON_Y)
    this.aimRibbon2 = this.buildRibbon(ribbonTex, AIM_LINE2_COLOR, AIM_LINE2_OPACITY, AIM_RIBBON_Y + 0.1)
    this.aimRibbon3 = this.buildRibbon(ribbonTex, AIM_LINE3_COLOR, AIM_LINE3_OPACITY, AIM_RIBBON_Y + 0.2)

    // The contact ring: a hollow circle the size of the ball it wraps, with
    // nothing inside it, at the cushion end when aiming at open table.
    this.contactRing = new THREE.Mesh(
      new THREE.RingGeometry(BALL_RADIUS - AIM_RING_STROKE_MM, BALL_RADIUS, 48),
      new THREE.MeshBasicMaterial({
        color: AIM_RING_COLOR,
        transparent: true,
        opacity: AIM_RING_OPACITY,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -1
      })
    )
    this.contactRing.rotation.x = -Math.PI / 2
    this.contactRing.visible = false
    this.contactRing.renderOrder = 3
    this.scene.add(this.contactRing)

    // The opponent's line, for the spectator view: the same strip and the same ring as the
    // player's own, on the same texture and the same ring geometry, dimmer and warm so it
    // is never taken for a line the player is aiming.
    this.opponentRibbon = this.buildRibbon(
      ribbonTex,
      SPECTATOR_CAM.aimLineColor,
      SPECTATOR_CAM.aimLineOpacity,
      AIM_RIBBON_Y + 0.3
    )
    const ringMat = (this.contactRing.material as THREE.MeshBasicMaterial).clone()
    ringMat.color.setHex(SPECTATOR_CAM.aimLineColor)
    ringMat.opacity = SPECTATOR_CAM.aimLineOpacity
    this.opponentRing = new THREE.Mesh(this.contactRing.geometry, ringMat)
    this.opponentRing.rotation.x = -Math.PI / 2
    this.opponentRing.visible = false
    this.opponentRing.renderOrder = 3
    this.scene.add(this.opponentRing)

    // The cue: the one build the opponent's stick uses too (see cueStick.ts). It is made
    // along its own +y with the tip at the height this stick has always had it, so the
    // placement in `showAim` is unchanged.
    this.stick = buildCueStick().group
    this.stick.visible = false
    this.scene.add(this.stick)

    // The stick's shadow on the cloth: a soft strip under the line the cue takes,
    // feathered at the edges and fading toward the butt. It is a texture rather
    // than a shadow map — the map is baked over static geometry only — and it
    // follows the stick's angle and pull-back the same way the stick itself does.
    this.stickShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: stickShadowTexture(),
        color: STICK_SHADOW_COLOR,
        transparent: true,
        depthWrite: false
      })
    )
    this.stickShadow.rotation.x = -Math.PI / 2
    this.stickShadow.renderOrder = 1
    this.stickShadow.frustumCulled = false
    this.stickShadow.visible = false
    this.scene.add(this.stickShadow)
  }

  /** One thin strip of light on the cloth: shared geometry, built once, hidden until aimed. */
  private buildRibbon(map: THREE.CanvasTexture, color: number, opacity: number, y: number): THREE.Mesh {
    const ribbon = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map,
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        // The lines are drawn, not lit: tone mapping would take the pure white
        // down to the lamp's own colour and turn a crisp line into a smudge.
        toneMapped: false,
        // Held a hair above the cloth so the strip never fights the cloth's own
        // depth for the pixels it lies on.
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -1
      })
    )
    ribbon.rotation.x = -Math.PI / 2
    ribbon.position.y = y
    ribbon.renderOrder = 2
    ribbon.frustumCulled = false
    ribbon.visible = false
    this.scene.add(ribbon)
    return ribbon
  }

  /**
   * The placement overlay: a D indicator for break-off and a ghost cue ball for
   * every in-hand. Built once like the rest of the scene; the meshes only cost
   * anything while they are visible, which is only while a placement is live.
   */
  private buildPlacement(): void {
    // The legal D area, shaded. Flat-lit and transparent so it reads as an overlay,
    // not as a patch of different cloth; depthWrite off so it never fights the bed.
    this.dZoneFill = new THREE.Mesh(
      new THREE.CircleGeometry(D_RADIUS, 48, Math.PI * 0.5, Math.PI),
      new THREE.MeshBasicMaterial({
        color: 0x9fe8b0,
        transparent: true,
        opacity: 0.14,
        depthWrite: false
      })
    )
    this.dZoneFill.rotation.x = -Math.PI / 2
    this.dZoneFill.position.set(tableX(BAULK_LINE_X), 0.8, tableZ(TABLE_WIDTH / 2))
    this.dZoneFill.renderOrder = 6
    this.dZoneFill.visible = false
    this.scene.add(this.dZoneFill)

    // The D's own edge: the half-circle arc plus the baulk-line chord, one ring
    // segment. LineDashed would fight the bed's markings; a thin tube reads at
    // every angle without aliasing.
    this.dZoneRing = new THREE.Mesh(
      new THREE.TorusGeometry(D_RADIUS, 3.5, 8, 64, Math.PI),
      new THREE.MeshBasicMaterial({ color: 0xd9f5df, transparent: true, opacity: 0.8, depthWrite: false })
    )
    this.dZoneRing.rotation.x = -Math.PI / 2
    // The torus arc runs 0..π counterclockwise from +x. Laid flat as it stands, that is a
    // half-circle across the baulk line — half of it inside the D and half sticking out
    // into the table. A quarter turn first puts both ends on the baulk line and the bow on
    // the baulk side, which is the D.
    this.dZoneRing.rotation.z = Math.PI / 2
    this.dZoneRing.position.set(tableX(BAULK_LINE_X), 1.2, tableZ(TABLE_WIDTH / 2))
    this.dZoneRing.renderOrder = 7
    this.dZoneRing.visible = false
    this.scene.add(this.dZoneRing)

    // The ghost cue ball: same size as the real one, half transparent, sitting at
    // cloth height. It is the thing the player is actually pointing at.
    this.ghostBall = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_RADIUS, 32, 20),
      new THREE.MeshStandardMaterial({
        color: 0xf4f9ff,
        roughness: 0.35,
        metalness: 0,
        transparent: true,
        opacity: 0.55,
        depthWrite: false
      })
    )
    this.ghostBall.visible = false
    this.scene.add(this.ghostBall)
  }

  /**
   * Shows or hides ball-in-hand placement overlays.
   *
   * `inD` is the snapshot's `cueInHandInD`: true only at break-off, where the D
   * indicator is shown. A mid-frame in-hand shows no D — the whole table is legal
   * and a stale D highlight would claim otherwise.
   */
  setPlacementMode(active: boolean, inD: boolean): void {
    this.placementActive = active
    this.dZoneRing.visible = active && inD
    this.dZoneFill.visible = active && inD
    this.ghostBall.visible = active
    if (!active) return
    // Park the ghost on the D centre (break-off) or the table centre (mid-frame)
    // so it is somewhere sensible the first frame before the pointer moves it.
    const start = inD ? { x: BAULK_LINE_X, y: TABLE_WIDTH / 2 } : { x: TABLE_LENGTH / 2, y: TABLE_WIDTH / 2 }
    this.ghostPos.set(start.x, start.y)
    this.ghostBall.position.set(tableX(start.x), BALL_RADIUS, tableZ(start.y))
  }

  /**
   * Moves the ghost to the table point the pointer is over and tints it by legality.
   *
   * The validity test mirrors the server's own rules, but is only a preview: the
   * server still rejects an illegal placement authoritatively. Red ghost means the
   * spot will not be accepted, with the reason readable from `status`.
   */
  updatePlacementGhost(
    target: { x: number; y: number } | null,
    inD: boolean,
    balls: Array<{ id: number; x: number; y: number; potted: boolean }>
  ): { ok: boolean; reason: string | null } {
    if (!this.placementActive || !target) {
      this.ghostBall.visible = false
      return { ok: false, reason: null }
    }
    this.ghostBall.visible = true
    this.ghostPos.set(target.x, target.y)
    this.ghostBall.position.set(tableX(target.x), BALL_RADIUS, tableZ(target.y))
    const status = placementStatus(target, inD, balls)
    const mat = this.ghostBall.material as THREE.MeshStandardMaterial
    mat.color.setHex(status.ok ? 0xf4f9ff : 0xff6b6b)
    return status
  }

  /** Hides the ghost for the frame where the pointer is off the cloth. */
  hidePlacementGhost(): void {
    this.ghostBall.visible = false
  }

  /**
   * Flies the camera into the overhead placement view, and holds it there.
   *
   * This is the half of the flow a player sees when the cue ball comes to hand: rather
   * than placing from whatever perspective they happened to be in, the table lifts to
   * the plan view that is the only place the whole legal area can be read at once. The
   * move is a timed interpolation between the pose the rig is in now and the overhead
   * pose, so it cannot cut, and its endpoint is the same pose the rig would have reached
   * by easing there on its own.
   *
   * Input is refused for the whole of the move, from the frame it starts. The caller
   * finds that out from {@link isPlacementTransitionBlocking} rather than by tracking
   * the state itself, so there is exactly one answer to "may the player act right now".
   */
  beginPlacementCamera(seconds: number = PLACEMENT_TRANSITION_SECONDS): void {
    // Already overhead and not moving: nothing to do. Anything else starts a move from
    // wherever the camera is now.
    //
    // This does start a move while one may be in flight, and that is deliberate: when the
    // server refuses a placement the camera is halfway back down to the gameplay view, and
    // it has to turn around and come back up. Restarting a flight *in* is prevented one
    // level up instead - the caller only asks on the frame the flow's phase changes into
    // entering, so a flow sitting in that phase never asks again.
    if (this.placementViewHeld && !this.placementTransition.active) return
    this.placementViewHeld = true
    // A fresh placement starts with nothing held: a lock left by a previous one would
    // draw the cue ball at the old spot for as long as this flight took.
    this.placementCueLock = null
    this.placementArrival = null
    this.placementTransition = beginPlacementTransition(
      this.rig.pose,
      topDownPose(this.cvw / Math.max(1, this.cvh)),
      seconds
    )
  }

  /**
   * Flies the camera back to the normal gameplay view and releases input when it lands.
   *
   * Called the moment a placement is confirmed, and `cuePos` is the position that was
   * confirmed - which is the whole point of passing it in. The authoritative snapshot
   * carrying the placed cue ball has not arrived yet at this point, so resolving the
   * endpoint from {@link cueBallPosition} would aim the camera at wherever the ball was
   * before it was placed, or at the table centre if it had been potted: the flight would
   * be smooth and would still arrive at the wrong place.
   *
   * The cue ball is also locked at `cuePos` for the flight, so the player watches the ball
   * they just placed sit still where they put it rather than watching the ghost vanish and
   * the real ball fade in somewhere else. The lock is dropped as soon as the server's own
   * snapshot puts the cue ball down, at which point the ball is being driven by the
   * snapshot again and nothing about its position changes.
   */
  endPlacementCamera(
    cuePos: { x: number; y: number } | null,
    onArrived?: () => void,
    seconds: number = PLACEMENT_TRANSITION_SECONDS
  ): void {
    if (!this.placementViewHeld && !this.placementTransition.active) return
    this.placementViewHeld = false
    this.placementArrival = onArrived ?? null
    // A placement that was withdrawn rather than confirmed has no spot to hold the ball
    // at, and nothing was sent to the server, so the ball is simply wherever the snapshot
    // says it is. That case falls back to the live snapshot's cue ball.
    const landing = cuePos ?? this.cueBallPosition()
    this.placementCueLock = cuePos ? { x: cuePos.x, y: cuePos.y } : null
    // The pose to come back to is resolved from the position being flown back to, not
    // from a pose captured when the flight in started: the cue ball has moved since, and
    // the camera is supposed to end up behind where it actually is. It is resolved for the
    // view the player is actually in as well, so the aim camera comes back to the aim pose
    // exactly as it always did while a broadcast view comes back to where that view stands
    // — a placement does not fly home through a view nobody asked for.
    this.placementTransition = beginPlacementTransition(
      this.rig.pose,
      resolveCameraTarget({
        mode: this.cameraMode,
        aspect: this.cvw / Math.max(1, this.cvh),
        cue: landing,
        aimAngle: this.rig.yaw,
        latch: this.latch,
        focus: null
      }),
      seconds
    )
  }

  /**
   * Whether a placement camera move is in flight and gameplay input must stay refused.
   *
   * The single question the frame loop asks before it will let the player aim, fire,
   * move the ghost or drag the camera round. True from the frame a move begins until
   * the frame it completes.
   */
  isPlacementTransitionBlocking(): boolean {
    return this.placementTransition.blocking
  }

  /**
   * Whether the camera has finished a placement move: not flying into the overhead view
   * and not flying back out of it. True when no placement has ever been asked for, which
   * is what lets the flow treat "nothing in flight" and "arrived" the same way.
   *
   * Deliberately not "and not holding the overhead view either". Holding the view is the
   * *destination* of the flight in and the state the player places the ball in, so folding
   * it in here meant this stayed false for exactly as long as a placement was live - and a
   * flow waiting to hear it had arrived would wait forever. Whether the view is being held
   * is its own question, answered by {@link isPlacementViewHeld}.
   */
  isPlacementCameraSettled(): boolean {
    return !this.placementTransition.active
  }

  /**
   * Whether the camera is holding the overhead placement view, as opposed to flying
   * into it or back out of it. False while either move is in flight.
   */
  isPlacementViewHeld(): boolean {
    return this.placementViewHeld && !this.placementTransition.active
  }

  /** Where the cue ball is on the table, or the table centre before it has ever existed. */
  private cueBallPosition(): { x: number; y: number } {
    const cue = this.lastSnapshot?.balls.find((b) => b.id === BALL_IDS.CUE && !b.potted)
    return cue ? { x: cue.x, y: cue.y } : { x: TABLE_LENGTH / 2, y: TABLE_WIDTH / 2 }
  }

  /**
   * Records where the player is aiming, so the camera's heading follows the aim.
   *
   * Separate from {@link applySnapshot} because it is the one part of an update that is
   * never held: while a presentation delay is running, the snapshot is late and the aim is
   * not. While a shot is on screen the heading is latched to the line that shot was played
   * along, which is the view the tracking camera holds. Between shots the heading follows
   * the aim instead, but that is eased over time and so belongs to {@link stepCamera},
   * which has the frame's `dt`.
   */
  private captureAim(options: RenderOptions): void {
    if (!options.aim) return
    this.lastAimAngle = options.aim.angle
    if (this.tracking) this.latch = stepHeadingLatch(this.latch, this.lastAimAngle, true)
  }

  update(snapshot: FrameSnapshotData | null, options: RenderOptions = {}): void {
    // Read, never written: whose visit it is and whether a shot is on screen, as the game
    // has them this frame. The spectator view goes up on these.
    const replaying = options.immediate === true
    // A replay is starting on this frame. Whose visit it was on the frame before is who
    // played it; the snapshot arriving with it may already name the other player.
    if (replaying && !this.liveReplay) this.replayByOpponent = this.liveOpponentTurn
    this.liveSeatKnown = snapshot !== null && options.youSeat !== undefined
    this.liveOpponentTurn = this.liveSeatKnown && snapshot!.turnIndex !== options.youSeat
    this.liveReplay = replaying
    if (SPECTATOR_CAM.enabled && snapshot && options.youSeat !== undefined) {
      // The venue cannot show an opponent's cue without knowing which seat is the
      // opponent's, and it does not always hear that for itself. Does nothing once it knows.
      this.venue?.setSeat(options.youSeat, snapshot.turnIndex)
    }
    // While the room is taking its presentation beat, a snapshot is not dropped and not
    // applied: it joins the back of the queue and is shown when its turn comes. The
    // snapshot the game actually has is never altered, so what the player is looking at is
    // the real game, later.
    //
    // The gate stays shut while the queue still has work, not just while the hold runs:
    // otherwise a snapshot arriving the instant the hold expires would leapfrog the one
    // still waiting, and the table would draw its own history out of order.
    if (
      SPECTATOR_CAM.enabled &&
      this.presentationLeft <= 0 &&
      this.presentationQueue.length > 0 &&
      options.immediate !== true &&
      !this.presentationQueue.some((item) => item.options.immediate === true)
    ) {
      // The hold is over and everything still waiting is a table at rest, so there is
      // nothing left to show late: the queue is dropped and the table is live again.
      // Without this the gate below never reopens — each frame queues one snapshot and
      // releases one — and the whole match is drawn a turn-delay behind from the first
      // banner onwards, the player's own aim line included. A replay still in the queue
      // is left to play out, so no moving ball is ever skipped.
      this.presentationQueue.length = 0
    }
    if (this.presentationLeft > 0 || this.presentationQueue.length > 0) {
      // The aim heading is taken straight through rather than queued. The table is late on
      // purpose; the player's own drag across the cue ball is not, and on the frame a turn
      // changes the snapshot the guide is drawn against is still the settled one it was
      // already drawn against. Holding this too would be a frozen screen rather than a
      // held beat.
      this.captureAim(options)
      this.presentationQueue.push({
        at: this.presentationClock + this.presentationDelay,
        snapshot,
        options
      })
      return
    }
    this.applySnapshot(snapshot, options)
  }

  /** The real update. Split out so the queue can replay it without re-checking the hold. */
  private applySnapshot(snapshot: FrameSnapshotData | null, options: RenderOptions = {}): void {
    this.immediate = options.immediate === true
    // Kept for the camera, which moves on its own clock in `render` rather than in here:
    // the balls it follows and the heading it turns to are both read from here.
    this.lastSnapshot = snapshot
    // The same question as above, asked of the table that is actually being shown, which
    // is the late one while a turn presentation runs. The spectator view comes down on it.
    this.shownMyTurn = snapshot !== null && options.youSeat !== undefined && snapshot.turnIndex === options.youSeat
    this.captureAim(options)
    if (!snapshot) {
      for (const rig of this.balls.values()) rig.setVisible(false)
      this.hideAim()
      return
    }

    if (!this.shadowTexCache) this.shadowTexCache = contactShadowTexture()
    const highlightId = this.resolveHighlight(snapshot)
    const seen = new Set<number>()

    // The server has taken the placement once its snapshot stops saying the cue ball is
    // in hand. Until then the confirmed position is drawn rather than the snapshot's, so
    // the cue ball sits still at the spot the player chose instead of vanishing for the
    // length of the camera's flight home. The ball is at that same spot by the time this
    // clears, so nothing moves across the handover.
    if (this.placementCueLock && snapshot.cueInHand !== true) this.placementCueLock = null

    for (const ball of snapshot.balls) {
      seen.add(ball.id)
      let rig = this.balls.get(ball.id)
      if (!rig) {
        // The cue ball gets its own look: warm cream phenolic under its own
        // clearcoat, and a softer grounded contact shadow. Every other ball keeps
        // the shared phenolic material and shadow.
        const tint = ballColor(ball.id)
        let cueTuning: BallRigOptions | undefined
        if (ball.id === BALL_IDS.CUE) {
          cueTuning = {
            cue: true,
            shadowTex: cueContactShadowTexture(),
            shadowPlane: CUE_SHADOW_PLANE
          }
        }
        rig = new BallRig(BALL_RADIUS, tint, this.shadowTexCache || contactShadowTexture(), cueTuning)
        this.balls.set(ball.id, rig)
        this.scene.add(rig.group)
      }
      rig.setVisible(!ball.potted || rig.sinking)
      // The cue ball under a placement lock is drawn from the confirmed position and
      // stays visible even while the snapshot still has it potted: this is the ball the
      // player just placed, and it is what the camera is flying back to. Every other ball
      // is driven by the snapshot exactly as before.
      if (this.placementCueLock && ball.id === BALL_IDS.CUE) {
        const lx = tableX(this.placementCueLock.x)
        const lz = tableZ(this.placementCueLock.y)
        const lockMoved = Math.hypot(rig.group.position.x - lx, rig.group.position.z - lz)
        rig.setVisible(true)
        // Not a rise: it was never potted as far as the player is concerned, it was
        // placed. Snapping rather than rising is the difference between a ball staying
        // where it was put and a ball popping up from a pocket it never went in.
        rig.aim(lx, lz, ball.id === highlightId, rig.firstSeen || lockMoved > 500)
      } else if (!ball.potted) {
        const x = tableX(ball.x)
        const z = tableZ(ball.y)
        const moved = Math.hypot(rig.group.position.x - x, rig.group.position.z - z)
        rig.aim(x, z, ball.id === highlightId, rig.firstSeen || moved > 500)
        // A ball that was potted and is now on the table has been re-racked rather than
        // moved, so it rises onto its spot instead of being snapped there. The cue ball
        // into hand after an in-off is the case this exists for; a colour the rules
        // re-spot comes back the same way.
        if (this.wasPotted.get(ball.id) === true) rig.startRise(x, z)
      } else if (rig.group.visible && !rig.sinking) {
        const px = tableX(ball.x)
        const pz = tableZ(ball.y)
        let best = Infinity
        let targetX = px
        let targetZ = pz
        for (const p of POCKETS) {
          const dx = tableX(p.x) - px
          const dz = tableZ(p.y) - pz
          const d2 = dx * dx + dz * dz
          if (d2 < best) {
            best = d2
            targetX = tableX(p.x)
            targetZ = tableZ(p.y)
          }
        }
        rig.startSink(targetX, targetZ)
      } else {
        rig.firstSeen = true
      }
      // Remembered after the ball has been placed, so the next update can tell a
      // re-rack (potted, then not) apart from a ball that has only ever been on the
      // table, which must not rise.
      this.wasPotted.set(ball.id, ball.potted)
    }
    for (const [id, rig] of this.balls) {
      if (!seen.has(id) && !(this.placementCueLock && id === BALL_IDS.CUE)) {
        rig.setVisible(false)
      }
    }

    // A snapshot that omits the cue ball entirely - rather than reporting it potted, which
    // is what the loop above handles - would otherwise leave the placed ball hidden for
    // the whole flight home, since there is no ball in the list to draw it from.
    if (this.placementCueLock) {
      const locked = this.balls.get(BALL_IDS.CUE)
      if (locked) {
        locked.setVisible(true)
        locked.aim(tableX(this.placementCueLock.x), tableZ(this.placementCueLock.y), false, locked.firstSeen)
      }
    }

    const cueBall = snapshot.balls.find((b) => b.id === 0 && !b.potted)
    const myTurn = options.youSeat !== undefined && snapshot.turnIndex === options.youSeat
    // The cue stick and the aim guide are only drawn on a settled table during the
    // player's own visit. Without the canAim test they would be re-anchored to a
    // cue ball that is still travelling, which dragged the stick diagonally across
    // the cloth behind a shot the player had already played.
    if (cueBall && options.aim && myTurn && options.canAim !== false) {
      this.showAim(cueBall, options.aim, snapshot.balls)
    } else {
      this.hideAim()
    }
  }

  private resolveHighlight(snapshot: FrameSnapshotData): number | null {
    if (snapshot.ballOn === 'RED') return null
    const match = /colour:(\d+)/.exec(snapshot.ballOn)
    return match ? Number(match[1]) : null
  }

  private showAim(cueBall: { x: number; y: number }, aim: AimState, balls: AimGuideBall[]): void {
    const cx = tableX(cueBall.x)
    const cz = tableZ(cueBall.y)
    const dir = { x: Math.cos(aim.angle), z: Math.sin(aim.angle) }

    // LINE 1 runs along the aim angle from the cue ball's own surface to
    // wherever the shot line ends: the ghost ball when a ball is in the way,
    // the cushion when the table is open. The heading is the aim's own, never
    // the direction to the contact point — the two differ on a cut, and the cue
    // ball goes where it was aimed. The cushion end is a ray against the bed's
    // own rectangle, so no new aim data is being invented here either.
    const guide = computeAimGuide({ ...cueBall, id: 0 }, aim.angle, balls)
    const layout = shotLineLayout(cueBall, aim.angle, guide, this.aimLayout)
    const drawn = layout.length > 1
    const startX = tableX(layout.from.x)
    const startZ = tableZ(layout.from.y)

    if (drawn) {
      this.setRibbon(guide ? this.aimRibbon1 : this.aimRibbon1Open, startX, startZ, layout.angle, layout.length)
      ;(guide ? this.aimRibbon1Open : this.aimRibbon1).visible = false
      // The ring sits where the line stops: the ghost ball on contact, the
      // cushion face on an open table.
      this.contactRing.position.set(tableX(layout.to.x), AIM_RING_Y, tableZ(layout.to.y))
      this.contactRing.visible = true
    } else {
      this.aimRibbon1.visible = false
      this.aimRibbon1Open.visible = false
      this.contactRing.visible = false
    }
    this.aimRibbon2.visible = false
    this.aimRibbon3.visible = false
    if (guide) this.showContactMarker(guide)

    // The tip sits `tipGap` behind the ball's centre, and the stick extends a
    // further STICK_TIP_Y forward of its own origin, so the origin goes back by
    // the sum of the two.
    const tipGap = BALL_RADIUS + STICK_REST_GAP + aim.power * STICK_POWER_DRAW
    const backOff = tipGap + STICK_TIP_Y
    this.stick.visible = true
    this.stick.position.set(cx - dir.x * backOff, 21, cz - dir.z * backOff)
    const up = new THREE.Vector3(0, 1, 0)
    const target = new THREE.Vector3(dir.x, 0, dir.z).normalize()
    this.stick.quaternion.setFromUnitVectors(up, target)

    // The shadow strip under the line the stick takes: from the ball out past the
    // butt, flat on the cloth, spun to the shot's heading. The length follows the
    // pull-back, so loading the shot drags the shadow back with the stick.
    const shadowLen = tipGap + 250
    this.stickShadow.scale.set(shadowLen, STICK_SHADOW_WIDTH, 1)
    this.stickShadow.position.set(cx - dir.x * shadowLen * 0.5, 0.55, cz - dir.z * shadowLen * 0.5)
    // With the strip lying flat, its spin maps its local +X onto the cloth; the
    // dark end of the texture is the one that has to land by the ball.
    this.stickShadow.rotation.z = Math.atan2(-dir.z, dir.x)
    this.stickShadowTarget = 1
  }

  /**
   * Lays one of the aim ribbons down on the cloth: from a point, along a
   * heading, so long, and thick enough to read as `AIM_LINE_TARGET_PX` from
   * wherever the lens is standing.
   *
   * Width is measured rather than passed: it is a property of the frame, not of
   * the line, and every ribbon takes the same one so the three lines of a
   * contact read as one guide rather than as three different pens.
   */
    private setRibbon(ribbon: THREE.Mesh, x: number, z: number, angle: number, length: number, widthScale = 1): void {
    if (length <= 1) {
      ribbon.visible = false
      return
    }
    const midX = x + Math.cos(angle) * length * 0.5
    const midZ = z + Math.sin(angle) * length * 0.5
    const nearX = x + Math.cos(angle) * length * 0.2
    const nearZ = z + Math.sin(angle) * length * 0.2
    const distance = this.camera.position.distanceTo(this.aimMeasure.set(nearX, ribbon.position.y, nearZ))
    const width = aimLineWorldWidth(distance, this.camera.fov, this.cvh)

    // A flat strip looks thinner the more it runs across the view at a low camera angle.
    const cam = this.camera.getWorldDirection(this.aimDir)
    const fl = Math.hypot(cam.x, cam.z) || 1
    const fx = cam.x / fl
    const fz = cam.z / fl
    const px = -Math.sin(angle)
    const pz = Math.cos(angle)
    const sinEl = Math.min(1, Math.abs(this.camera.position.y - ribbon.position.y) / distance)
    const visible = Math.abs(px * -fz + pz * fx) + Math.abs(px * fx + pz * fz) * sinEl
    const compensate = 1 / Math.max(0.35, visible)

    ribbon.scale.set(length, width * widthScale * compensate, 1)
    ribbon.position.set(midX, ribbon.position.y, midZ)
    ribbon.rotation.z = Math.atan2(-Math.sin(angle), Math.cos(angle))
    ribbon.visible = true
  }

  /**
   * Lays the two departure lines: the object ball's own path away along the line
   * of centres, and the cue ball's deflection tangent. The contact ring is left
   * wherever the shot line put it.
   */
  private showContactMarker(guide: AimGuide): void {
    // How full the contact is. Dead straight, the object ball takes all the pace and the
    // cue ball stops; the thinner the cut, the less the object ball gets and the further
    // the cue ball runs on. The two lines are drawn to those shares, eased so they grow
    // and shrink as the aim sweeps across the ball instead of snapping.
    const fullness = Math.max(0, Math.min(1, Math.cos(this.lastAimAngle) * guide.lineOfCentres.x + Math.sin(this.lastAimAngle) * guide.lineOfCentres.y))
    const want2 = AIM_LINE2_LENGTH * (AIM_LINE_MIN_SHARE + (1 - AIM_LINE_MIN_SHARE) * fullness)
    const want3 = AIM_LINE3_LENGTH * (AIM_LINE_MIN_SHARE + (1 - AIM_LINE_MIN_SHARE) * Math.sqrt(1 - fullness * fullness))
    this.aimLength2 += (want2 - this.aimLength2) * AIM_LINE_EASE
    this.aimLength3 += (want3 - this.aimLength3) * AIM_LINE_EASE
    // LINE 2: the object ball's line, starting at the object ball surface along the line of centres.
    this.setRibbon(
      this.aimRibbon2,
      tableX(guide.contact.x + guide.lineOfCentres.x * (2 * BALL_RADIUS)),
      tableZ(guide.contact.y + guide.lineOfCentres.y * (2 * BALL_RADIUS)),
       Math.atan2(guide.lineOfCentres.y, guide.lineOfCentres.x),
      this.aimLength2,
      1
    )

    // LINE 3: the cue ball's departure after the contact, from the ghost's
    // surface along the tangent the guide already worked out.
    const first = guide.cuePath[0]
    if (first) {
      let tx = first.to.x - first.from.x
      let ty = first.to.y - first.from.y
      const tlen = Math.hypot(tx, ty)
      if (tlen > 0.001) {
        tx /= tlen
        ty /= tlen
        this.setRibbon(
          this.aimRibbon3,
          tableX(first.from.x + tx * BALL_RADIUS),
          tableZ(first.from.y + ty * BALL_RADIUS),
          Math.atan2(ty, tx),
          this.aimLength3,
          1
        )
        return
      }
    }
    this.aimRibbon3.visible = false
  }

  private hideAim(): void {
    this.aimRibbon1.visible = false
    this.aimRibbon1Open.visible = false
    this.aimRibbon2.visible = false
    this.aimRibbon3.visible = false
    this.contactRing.visible = false
    if (this.stick) this.stick.visible = false
    if (this.stickShadow) this.stickShadowTarget = 0
  }

  /**
   * Asks for one of the views the player controls: the camera behind the cue ball, the
   * overhead one, and the venue's own three broadcast cameras. Nothing is cut — the rig
   * eases between them — so this can be called as often as the button is pressed.
   */
  setCameraMode(mode: PlayerCameraMode): void {
    this.cameraMode = mode
  }

  /**
   * Tells the camera whether a shot is on screen.
   *
   * While one is, the camera stops being a view the player chose and becomes a view of the
   * balls: it follows where they are going. When it ends, the rig eases back to whichever
   * view the player had asked for, which is why this is a flag rather than a mode — the
   * choice underneath is remembered across every shot.
   */
  setTracking(tracking: boolean): void {
    this.tracking = tracking
  }

  /**
   * Adds one drag step to the player's look-around, in radians.
   *
   * This is the only way the aim-mode camera turns between shots: a deliberate
   * right- or middle-button drag, never a hovering pointer.
   */
  orbitBy(delta: number): void {
    // The spectator view is a fixed television shot: a drag while it is up turns nothing,
    // and is not saved up to swing the aim view when it comes back.
    if (this.spectating) return
    this.latch = addOrbit(this.latch, delta)
  }

  /**
   * Whether the camera has arrived in the aim view and is only panning, not flying.
   *
   * The cue controller asks this before it re-reads a resting pointer as an aim: the
   * answer to "what is under this pixel" is only steady once the lens is down.
   */
  isAimViewSettled(): boolean {
    return this.aimViewSettled
  }

  /** The view the camera is being asked for, for the toggle to reflect. */
  currentCameraMode(): PlayerCameraMode {
    return this.cameraMode
  }

  /**
   * Where the camera is looking at the moment, in the form the picking maths needs.
   *
   * Read off the live camera rather than worked out again from the pose, so the two can
   * never disagree: whatever the lens is actually pointing at is what a pointer is cast
   * through. The renderer's world axes are turned into table millimetres on the way out,
   * which is the one conversion the pure module knows nothing about.
   */
  private pickCamera(): PickCamera {
    return pickCameraFromWorldMatrix(
      this.camera.position,
      this.camera.matrixWorld.elements,
      this.camera.fov,
      this.camera.aspect
    )
  }

  /**
   * The point on the cloth under a canvas pixel, cast through the live camera.
   *
   * This is what makes the pointer mean the same thing from behind the cue ball and from
   * overhead: the ray starts at the lens, goes through the pixel, and meets the cloth where
   * the table is. Null when the pixel is above the horizon, so a caller can leave the aim
   * alone rather than guessing.
   */
  screenToTable(px: number, py: number): { x: number; y: number } | null {
    if (this.cvw <= 0 || this.cvh <= 0) return null
    const ndc = pixelToNdc(px, py, this.cvw, this.cvh)
    return screenToTable(ndc.x, ndc.y, this.pickCamera())
  }

  /**
   * Where a point on the cloth is drawn, in canvas pixels.
   *
   * The other half of the same question, and what the press-and-release test uses to ask
   * "was that on the cue ball". Null when the point is behind the lens.
   */
  tableToScreen(x: number, y: number): { x: number; y: number } | null {
    if (this.cvw <= 0 || this.cvh <= 0) return null
    const ndc = projectToNdc({ x, y }, 0, this.pickCamera())
    if (!ndc) return null
    return ndcToPixel(ndc.x, ndc.y, this.cvw, this.cvh)
  }

  /** How wide a ball is drawn at a point on the cloth, in canvas pixels. */
  ballRadiusPx(x: number, y: number, radiusMm: number): number {
    if (this.cvw <= 0 || this.cvh <= 0) return 0
    return ballRadiusPx({ x, y }, radiusMm, this.cvw, this.cvh, this.pickCamera())
  }

  /** The heading the camera is easing towards, which is the last aim it was given. */
  cameraYaw(): number {
    return this.rig.yaw
  }

  resize(width: number, height: number): void {
    this.cvw = width
    this.cvh = height
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  /**
   * Moves the camera one frame towards whatever it has been asked to be doing.
   *
   * Called before the scene is drawn and after the balls have been moved, so the frame that
   * gets drawn is the one the rig has just eased to. Everything it needs is already here:
   * the cue ball and the balls worth following come out of the snapshot it is drawing, and
   * the heading is the last aim the player gave, which during a shot is the line the shot
   * was played along.
   */
  private stepCamera(dt: number): void {
    let cue: { x: number; y: number } | null = null
    let sumX = 0
    let sumY = 0
    let count = 0
    // Runs before the table has ever been drawn as well as after, so the empty case wants a
    // real empty array rather than a fresh one every frame.
    const balls = this.lastSnapshot?.balls ?? NO_BALLS
    for (const ball of balls) {
      if (ball.potted) continue
      sumX += ball.x
      sumY += ball.y
      count++
      if (ball.id === BALL_IDS.CUE) cue = { x: ball.x, y: ball.y }
    }
    // The spread is the radius of the smallest circle round the centre that holds them all,
    // which is what tells the tracking camera how far back it has to stand.
    let spread = 0
    if (count > 0) {
      const midX = sumX / count
      const midY = sumY / count
      for (const ball of balls) {
        if (ball.potted) continue
        spread = Math.max(spread, Math.hypot(ball.x - midX, ball.y - midY))
      }
    }
    this.stepSpectator(cue, dt)
    // A placement camera move, if one is in flight, owns the pose outright: it is a
    // timed interpolation between two known endpoints, so the rig is stepped with the
    // interpolated pose rather than being asked for a mode. Running both would have two
    // things writing the camera at once, and the loser's contribution shows up as a
    // wobble on the way through.
    if (this.placementTransition.active) {
      const stepped = stepPlacementTransition(this.placementTransition, dt)
      this.placementTransition = stepped.transition
      // The rig is seeded with the interpolated pose rather than damped towards it, so
      // the transition's timing is the timing of the move: when it finishes the camera
      // is exactly on the end pose, and when it is not running the rig carries on from
      // exactly where the last frame left it.
      this.rig = { pose: stepped.pose, yaw: this.rig.yaw }
      if (!this.placementTransition.active) {
        // Arrived. The pose is written back so the rig continues from the end of the
        // move rather than snapping to it again on the next frame's damp.
        this.rig = { pose: placementTransitionEndPose(this.placementTransition), yaw: this.rig.yaw }
        const arrived = this.placementArrival
        this.placementArrival = null
        if (arrived) arrived()
      }
      this.aimViewSettled = false
    } else if (this.spectatorTransition.active) {
      // Flying into the spectator view or back out of it: the same timed move a placement
      // uses, in its own slot so it never raises the flag that refuses input.
      const stepped = stepSpectatorTransition(this.spectatorTransition, dt)
      this.spectatorTransition = stepped.transition
      this.rig = { pose: stepped.pose, yaw: this.rig.yaw }
      this.aimViewSettled = false
    } else if (this.spectating) {
      // Held. Read through the fit each frame so a resize or a turned phone refits it.
      this.rig = { pose: this.spectatorPose(), yaw: this.rig.yaw }
      this.aimViewSettled = false
    } else {
      const mode = this.tracking ? 'TRACK' : this.placementViewHeld ? 'PLACEMENT_TOP_DOWN' : this.cameraMode
      // While the player is free to aim, the heading pans after an aim that has swung
      // out of the band in front of the lens — gated to the half-plane the camera can
      // see, so the drag-back that sets power cannot spin it.
      if (!this.tracking) this.latch = followHeadingLatch(this.latch, this.lastAimAngle, dt)
      this.rig = stepCameraRig(
        this.rig,
        {
          mode,
          aspect: this.cvw / Math.max(1, this.cvh),
          cue,
          aimAngle: this.lastAimAngle,
          latch: this.latch,
          focus: count > 0 ? { x: sumX / count, y: sumY / count, spread } : null
        },
        dt
      )
      this.aimViewSettled =
        mode === 'AIM' &&
        cue !== null &&
        Math.abs(this.rig.pose.height - aimPose(cue, this.rig.yaw).height) < AIM_SETTLED_HEIGHT_MM
    }
    const pose = this.rig.pose
    this.camera.position.set(tableX(pose.x), pose.height, tableZ(pose.y))
    this.camera.lookAt(tableX(pose.lookX), pose.lookHeight, tableZ(pose.lookY))
    if (this.camera.fov !== pose.fov) {
      this.camera.fov = pose.fov
      this.camera.updateProjectionMatrix()
    }
  }

  /**
   * Gives the surroundings a cheaper finish, and says whether it just did.
   *
   * What a frame costs here is very nearly the number of pixels shaded times what each
   * one costs, and the arena behind the table covers a great many pixels with a full
   * physically-based material under nine lights. Swapping those materials for unlit ones
   * takes a third or more off the frame while the picture barely changes, because the
   * room is a dim backdrop to begin with. The table's legs get a simple lit finish for
   * the same reason. The balls, the cloth, the cushions, the rails and the pockets — the
   * things a player is looking at — are not touched: this is the first thing to give when
   * frames are short, so that their resolution does not have to.
   *
   * Returns true when it lowered the detail, false when it was already low, so a caller
   * knows whether there was anything here to give.
   */
  lowerEnvironmentDetail(): boolean {
    if (this.environmentLow) return false
    this.environmentLow = true
    const cheap = new Map<THREE.Material, THREE.Material>()
    const swap = (
      root: THREE.Object3D,
      make: (from: THREE.MeshStandardMaterial, mesh: THREE.Mesh) => THREE.Material
    ): void => {
      // The opponent's cue hangs off the arena group too. It is part of the play, not of
      // the room, so the walk steps over it.
      if (root.name === 'opponent-cue') return
      for (const child of root.children) swap(child, make)
      const mesh = root as THREE.Mesh
      if (!mesh.isMesh || Array.isArray(mesh.material)) return
      const from = mesh.material as THREE.MeshStandardMaterial
      if (!from.isMeshStandardMaterial) return
      let to = cheap.get(from)
      if (!to) {
        to = make(from, mesh)
        cheap.set(from, to)
      }
      this.environmentOriginals.push([mesh, from])
      mesh.material = to
    }
    if (this.venueGroup) {
      swap(this.venueGroup, (from, mesh) => {
        // The carpet is the one part of the room that has to stay lit: it is where the
        // lamp's pool falls and where the table's shadow lands, and a table over a flat
        // floor floats. A plain diffuse finish keeps both for a fraction of the cost.
        const carpet =
          mesh.geometry.type === 'CircleGeometry' && Math.abs(mesh.position.y - ARENA_CONFIG.carpetY) < 1
        if (carpet) return new THREE.MeshLambertMaterial({ color: from.color.clone(), map: from.map, side: from.side })
        // Everything else is unlit, at about the brightness the room's dim lighting left it.
        return new THREE.MeshBasicMaterial({
          color: from.color.clone().multiplyScalar(ENVIRONMENT_UNLIT_LEVEL),
          map: from.map,
          side: from.side,
          transparent: from.transparent,
          opacity: from.opacity
        })
      })
    }
    // The washes that light the stands have nothing left to light once the stands are
    // unlit, but every lit pixel on the table and the balls still pays for each of them.
    // Switching them off is the other half of what this mode saves.
    if (this.venueGroup) {
      this.venueGroup.traverse((obj) => {
        if ((obj as THREE.DirectionalLight).isDirectionalLight) obj.visible = false
      })
    }
    // Those washes also spilled a little onto the table. The ambient light is lifted by
    // about what they gave it, so the table is as bright in this mode as it was.
    this.scene.traverse((obj) => {
      const ambient = obj as THREE.AmbientLight
      if (ambient.isAmbientLight) ambient.intensity *= ENVIRONMENT_LOW_AMBIENT_LIFT
    })

    this.scene.traverse((obj) => {
      if (!obj.name.endsWith(TABLE_LEGS_SUFFIX)) return
      swap(obj, (from) => new THREE.MeshLambertMaterial({ color: from.color.clone(), map: from.map, side: from.side }))
    })
    return true
  }

  /** Whether the surroundings are on their cheaper finish. */
  isEnvironmentDetailLow(): boolean {
    return this.environmentLow
  }

  /** The spectator pose for the canvas as it is now, refitted only when its shape changes. */
  private spectatorPose(): CameraPose {
    const aspect = this.cvw / Math.max(1, this.cvh)
    if (!this.spectatorFit || this.spectatorFit.aspect !== aspect) {
      this.spectatorFit = { aspect, pose: fitSpectatorCamera(aspect).pose }
    }
    return this.spectatorFit.pose
  }

  /**
   * Decides whether the spectator view is up this frame, and starts the move when that
   * changes.
   *
   * Runs after the venue has been stepped, so a turn presentation that opened this frame
   * is already holding the table by the time the question is asked. A move always starts
   * from wherever the lens is at that moment, including partway through the opposite move,
   * which is what makes a turn that changes mid-flight a change of direction and not a cut.
   */
  private stepSpectator(cue: { x: number; y: number } | null, dt: number): void {
    // How long the table has been standing still, on both clocks: the live game and the
    // picture being shown. The view only goes up once that has lasted long enough for the
    // player to have seen where their shot finished.
    this.restSeconds = this.liveReplay || this.immediate ? 0 : this.restSeconds + dt
    const placementActive = this.placementViewHeld || this.placementTransition.active
    const next = nextSpectating(this.spectating, {
      enabled: SPECTATOR_CAM.enabled,
      seatKnown: this.liveSeatKnown,
      liveOpponentTurn: this.liveOpponentTurn,
      liveReplay: this.liveReplay,
      replayByOpponent: this.replayByOpponent,
      settled: this.restSeconds >= SPECTATOR_CAM.settleSeconds,
      shownMyTurn: this.shownMyTurn,
      presentationHeld: this.presentationLeft > 0 || this.presentationQueue.length > 0,
      placementActive
    })
    if (next === this.spectating) return
    this.spectating = next
    this.venue?.setSpectator(next, SPECTATOR_CAM.cueThicknessScale, SPECTATOR_CAM.cueAimSeconds)
    if (next) {
      this.spectatorTransition = beginSpectatorTransition(this.rig.pose, this.spectatorPose(), SPECTATOR_CAM.enterSeconds)
      return
    }
    if (placementActive) {
      // The player's own ball-in-hand view is taking the camera. It flies from wherever
      // the lens is, so this one simply lets go.
      this.spectatorTransition = noPlacementTransition()
      return
    }
    // Back to the view the player had picked, square on its own heading. The rig's eased
    // heading is put there too, so it does not swing round after the move has landed.
    const yaw = latchedCameraYaw(this.latch)
    this.rig = { pose: this.rig.pose, yaw }
    this.spectatorTransition = beginSpectatorTransition(
      this.rig.pose,
      resolveCameraTarget({
        mode: this.cameraMode,
        aspect: this.cvw / Math.max(1, this.cvh),
        cue,
        aimAngle: yaw,
        latch: this.latch,
        focus: null
      }),
      SPECTATOR_CAM.exitSeconds
    )
  }

  /**
   * Keeps the opponent's cue at the table for the whole of their visit, in the spectator
   * view: from the moment the turn is theirs and the balls are at rest, the cue stands
   * behind the cue ball, so the visit has somebody playing it before the shot arrives.
   * Taken away the moment the table is no longer theirs to address.
   */
  private stepOpponentAddress(): void {
    if (!SPECTATOR_CAM.enabled || !this.venue) return
    const snapshot = this.lastSnapshot
    let cue: { x: number; y: number } | null = null
    if (snapshot && this.spectating && this.liveOpponentTurn && !this.liveReplay && !this.immediate) {
      if (snapshot.cueInHand !== true) {
        for (const ball of snapshot.balls) {
          if (ball.id === BALL_IDS.CUE && !ball.potted) cue = ball
        }
      }
    }
    if (!snapshot || !cue) {
      this.venue.stopAddressingCue()
      return
    }
    this.venue.addressCue(cue.x, cue.y, addressHeading(cue, snapshot.balls, snapshot.ballOn))
  }

  /**
   * Draws the opponent's line while their cue is coming up and drawing back, in the
   * spectator view only.
   *
   * From the cue ball along the heading read off the recording of their shot, to the ghost
   * ball or the cushion — the same layout the player's own line uses, worked out once per
   * shot against the table as it is being shown and then only re-laid for the lens.
   */
  private stepOpponentLine(): void {
    const shot = this.opponentShot
    const balls = this.lastSnapshot?.balls
    if (!shot || !balls || !this.spectating || !(this.venue?.cueWinding() ?? false)) {
      this.opponentRibbon.visible = false
      this.opponentRing.visible = false
      return
    }
    const layout = this.opponentLayout
    if (!this.opponentLineReady) {
      const guide = computeAimGuide({ x: shot.x, y: shot.y, id: 0 }, shot.angle, balls)
      shotLineLayout(shot, shot.angle, guide, layout)
      this.opponentLineReady = true
    }
    if (layout.length <= 1) {
      this.opponentRibbon.visible = false
      this.opponentRing.visible = false
      return
    }
    this.setRibbon(this.opponentRibbon, tableX(layout.from.x), tableZ(layout.from.y), layout.angle, layout.length)
    this.opponentRing.position.set(tableX(layout.to.x), AIM_RING_Y, tableZ(layout.to.y))
    this.opponentRing.visible = true
  }

  /**
   * Releases the snapshots whose presentation delay has run out.
   *
   * Applied in order, oldest first, so the replay is the same replay — there is no moment
   * where a frame is skipped and the table appears to teleport. The hold ends when its
   * seconds are spent, not when the queue empties; anything still waiting keeps its own
   * longer timestamp and comes out on the frame it was due.
   */
  private drainPresentation(): void {
    if (this.presentationQueue.length === 0) return
    const due = this.presentationQueue.filter((item) => item.at <= this.presentationClock)
    if (due.length === 0) return
    this.presentationQueue = this.presentationQueue.filter((item) => item.at > this.presentationClock)
    for (const item of due) this.applySnapshot(item.snapshot, item.options)
  }

  /**
   * The `VenueHost` half of this class: the three things the venue needs from the scene.
   *
   * Deliberately three methods and two getters. Everything the crowd, the applause and the
   * banner want from the 3D world is here, and nothing here can move a ball.
   */
  beginPresentation(seconds: number): void {
    this.presentationDelay = Math.max(0, seconds)
    this.presentationLeft = this.presentationDelay
    this.holdStartedAt = this.presentationClock
  }

  /**
   * Brings the opponent's cue up, with its strike lined up against the first frame of the
   * replay.
   *
   * The cue is a picture of an action; the replay is the action. When they are not lined
   * up the room looks like it is doing two things: the stick finishes its strike while the
   * ball is still sitting there, and then the ball goes anyway. So the delay already held
   * for the turn banner is stretched by however much of the wind-up has not happened yet,
   * and everything already waiting is pushed back by the same amount — which is only ever
   * a rescheduling of pictures that were going to be late anyway.
   *
   * If nothing is waiting, the hold has already passed and the shot is on screen; there is
   * nothing left to line up with, so the cue simply plays in front of it.
   */
  showOpponentCue(shot: OpponentShot): void {
    const preRoll = this.venue?.cuePreRoll() ?? 0
    if (SPECTATOR_CAM.enabled) {
      // The replay this cue belongs to is started late by the game itself, by exactly
      // `opponentShotPreRoll`, so the picture, the sounds and the score all wait for the
      // strike together. Nothing is held back here.
      //
      // The recording's first sample is the cue ball a tick after it was struck, already
      // a few centimetres down the line, so a cue placed against it would stand with its
      // tip inside the ball that is actually on the table. The ball as it is being drawn
      // is where the cue goes.
      let at: { x: number; y: number } = shot
      for (const ball of this.lastSnapshot?.balls ?? NO_BALLS) {
        if (ball.id === BALL_IDS.CUE && !ball.potted) at = ball
      }
      const placed = { x: at.x, y: at.y, angle: shot.angle, power: shot.power }
      this.opponentShot = placed
      this.opponentLineReady = false
      this.venue?.showCue(placed)
      return
    }
    const elapsed = this.presentationClock - this.holdStartedAt
    const extra = preRoll - elapsed
    if (extra > 0 && this.presentationQueue.length > 0) {
      for (const item of this.presentationQueue) item.at += extra
      this.presentationDelay += extra
      this.presentationLeft = Math.max(this.presentationLeft, extra)
    }
    this.opponentShot = { x: shot.x, y: shot.y, angle: shot.angle, power: shot.power }
    this.opponentLineReady = false
    this.venue?.showCue(shot)
  }

  /**
   * How long the game should wait before it starts replaying an opponent's shot, in
   * seconds: the length of the cue's wind-up, so the cue comes up, lines up, draws back
   * and strikes, and the balls move as it does.
   *
   * Zero when there is no wind-up to wait for — the feature is off, or the recording does
   * not say where the shot was played from — so a shot is never held up for a cue that is
   * not going to appear.
   */
  opponentShotPreRoll(playback: ShotPlayback | undefined): number {
    if (!SPECTATOR_CAM.enabled || !this.venue) return 0
    if (!readOpponentShot(playback)) return 0
    // A quick opponent can play before the view has gone up. It goes up on the next frame
    // for their shot, so the cue is dressed for it now: the wind-up being timed here has
    // to be the one that is about to be shown.
    if (!this.spectating) {
      this.venue.setSpectator(true, SPECTATOR_CAM.cueThicknessScale, SPECTATOR_CAM.cueAimSeconds)
    }
    return this.venue.cuePreRoll()
  }

  /**
   * Ends a presentation hold now, throwing away anything still waiting.
   *
   * This is teardown, not the end of a hold: the normal end of a hold is the clock in
   * `drainPresentation`, which releases the queue instead of dropping it. Anything calling
   * this during a replay is choosing to skip it.
   */
  endPresentation(): void {
    this.presentationLeft = 0
    this.presentationDelay = 0
    this.presentationQueue.length = 0
    this.opponentShot = null
    this.venue?.hideCue()
  }

  render(): void {
    const now = performance.now()
    const dt = Math.min(0.05, (now - this.lastTime) / 1000)
    this.lastTime = now
    // The venue is stepped first and on the same clock as everything else: the crowd keeps
    // time, the banner counts down, and the opponent's cue advances, all on this frame's
    // `dt` rather than on their own.
    this.presentationClock += dt
    if (this.presentationLeft > 0) this.presentationLeft = Math.max(0, this.presentationLeft - dt)
    // `immediate` is true while a shot replay is on screen, which is the beat the venue
    // uses to flush a turn announcement it held behind the player's own shot.
    this.venue?.step(dt, this.immediate)
    this.drainPresentation()
    if (dt > 0) {
      // A streamed shot hands over positions that are already sampled from the
      // simulation, so they are applied as-is instead of being smoothed again.
      const k = this.immediate ? 1 : 1 - Math.exp(-dt * 14)
      for (const rig of this.balls.values()) {
        if (rig.group.visible && !rig.sinking && !rig.rising) {
          rig.group.position.lerp(rig.target, k)
          // Visual roll from cloth translation (spin dots / phenolic highlights track motion).
          rig.stepRoll()
        }
      }
      for (const rig of this.balls.values()) {
        if (rig.rising) {
          // Eased out, so the ball leaves the cloth briskly and settles onto it, which is
          // the reverse of the sink's ease-in.
          rig.riseT += dt * 3.4
          const t = Math.min(1, rig.riseT)
          const eased = 1 - (1 - t) * (1 - t)
          rig.group.position.set(
            rig.riseFrom.x,
            rig.riseFrom.y + (BALL_RADIUS - rig.riseFrom.y) * eased,
            rig.riseFrom.z
          )
          const s = RISE_START_SCALE + (1 - RISE_START_SCALE) * eased
          rig.group.scale.set(s, s, s)
          if (t >= 1) {
            rig.rising = false
            rig.group.scale.set(1, 1, 1)
            // Handed back to the ordinary target, so the ball keeps tracking a spot that
            // moves for any reason other than the re-rack itself.
            rig.group.position.set(rig.target.x, BALL_RADIUS, rig.target.z)
          }
        }
      }
      for (const rig of this.balls.values()) {
        if (!rig.sinking) continue
        rig.sinkT += dt * 3.4
        const t = Math.min(1, rig.sinkT)
        const eased = t * t
        rig.group.position.set(
          rig.sinkStart.x + (rig.sinkTarget.x - rig.sinkStart.x) * eased,
          rig.sinkStart.y - eased * 34,
          rig.sinkStart.z + (rig.sinkTarget.z - rig.sinkStart.z) * eased
        )
        const s = 1 - eased * 0.55
        rig.group.scale.set(s, s, s)
        if (t >= 1) {
          rig.sinking = false
          rig.setVisible(false)
          rig.group.scale.set(1, 1, 1)
          rig.firstSeen = true
        }
      }
    }
    // The camera eases after the balls have been moved, so the frame that goes to the
    // screen is the one the rig has just settled towards rather than the one before.
    this.stepCamera(dt)
    this.stepOpponentAddress()
    // After the camera, because the line's width is measured from where the lens now is.
    this.stepOpponentLine()
    // The stick's shadow fades with the stick rather than cutting out with it.
    if (this.stickShadow) {
      this.stickShadowAlpha +=
        (this.stickShadowTarget - this.stickShadowAlpha) * (1 - Math.exp(-STICK_SHADOW_FADE_RATE * dt))
      const shadowMat = this.stickShadow.material as THREE.MeshBasicMaterial
      shadowMat.opacity = this.stickShadowAlpha * STICK_SHADOW_OPACITY
      this.stickShadow.visible = this.stickShadowAlpha > 0.02
    }
    this.camera.updateMatrixWorld(true)
    const center = new THREE.Vector3(0, 0, 0).project(this.camera)
    const ax = new THREE.Vector3(600, 0, 0).project(this.camera)
    const az = new THREE.Vector3(0, 0, 600).project(this.camera)
    const toScreen = (v: THREE.Vector3): { x: number; y: number } => ({
      x: (v.x * 0.5 + 0.5) * this.cvw,
      y: (1 - (v.y * 0.5 + 0.5)) * this.cvh
    })
    const sc = toScreen(center)
    const sx = (toScreen(ax).x - sc.x) / 600
    const sz = (toScreen(az).y - sc.y) / 600
    const scale = (sx + sz) / 2
    // Handed back every frame: the 2D HUD's power rail picks table points, and the
    // cue controller's fallback projection reads the same transform. Cutting this
    // from the render pass desynced those from the live camera.
    setTableTransform({
      offsetX: sc.x - scale * (TABLE_LENGTH / 2),
      offsetY: sc.y - scale * (TABLE_WIDTH / 2),
      scale
    })
    // No per-frame shadow work happens here: the map was baked once, and moving balls
    // are shaded by the lamp itself, so they read as lit rather than floating — their
    // contact with the cloth is sold by the textured blobs under them, which move
    // with the balls and cost no shadow renders.
    //
    // Before any render that might be the one shadow pass, the shadow camera's basis
    // is pinned: three.js derives that basis from the render camera's orientation at
    // the moment it renders the shadow map, and the bake frame would otherwise be
    // whichever view happened to be on screen first. A map baked under one view and
    // sampled under the other is the mechanism behind the diagonal stripe artifacts
    // that appeared when toggling between the two views — the depth matrix disagreed
    // with itself by a rotation. Pinning it to the world axes makes the map, and every
    // sample of it, view-independent by construction.
    if (this.renderer.shadowMap.needsUpdate) {
      const shadowCam = this.lamp.shadow.camera
      shadowCam.position.set(0, 1750, 0)
      shadowCam.up.set(0, 0, -1)
      shadowCam.lookAt(0, 0, 0)
      shadowCam.updateMatrixWorld(true)
    }
    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.venue?.dispose()
    this.venue = null
    // The materials the cheap finish replaced are no longer on any mesh, so the sweep
    // below would miss them.
    for (const [, material] of this.environmentOriginals) material.dispose()
    this.environmentOriginals.length = 0
    this.renderer.dispose()
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) for (const m of mat) m.dispose()
      else mat?.dispose()
    })
    for (const rig of this.balls.values()) rig.dispose()
    this.balls.clear()
    this.wasPotted.clear()
    // The table's procedural maps are cached across matches; a scene teardown is the
    // one point where they must go, or a rebuild re-tags textures the GPU has dropped.
    disposeTableTextures()
  }
}
