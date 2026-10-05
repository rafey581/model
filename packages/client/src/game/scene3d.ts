import * as THREE from 'three'
import { BALL_IDS, TABLE_LENGTH, TABLE_WIDTH, BALL_RADIUS, BAULK_LINE_X, D_RADIUS, POCKET_RADIUS_CORNER, POCKET_RADIUS_MIDDLE, pocketPositions } from '@snooker/shared'
import type { FrameSnapshotData, AimState, RenderOptions } from './renderer.js'
import { computeAimGuide, type AimGuide, type AimGuideBall } from './aim.js'
import { setTableTransform } from './renderer.js'
import { ballColor } from './palette.js'
const SHOW_CROWN_MOULDING = false
import {
  type CameraRigState,
  type HeadingLatch,
  type PlacementTransition,
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
  followHeadingLatch,
  PLACEMENT_TRANSITION_SECONDS
} from './camera.js'
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

const HALF_L = TABLE_LENGTH / 2
const HALF_W = TABLE_WIDTH / 2
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
/** Gentle exponential fog in the room's own colour, per millimetre. Nothing at gameplay distances, a fade at the far wall. */
const ROOM_FOG_DENSITY = 0.00004
/** The blue the wall is painted at its brightest. */
const ROOM_WALL_COLOR = '#1b4bb0'
/** The navy the wall fades to at the top. */
const ROOM_WALL_TOP_COLOR = '#0b1a45'
/** The floor: dark, so the lit table is the subject of the picture. */
const ROOM_FLOOR_COLOR = '#9a3340'
/** The bed's colour: bright, saturated tournament green. */
const CLOTH_COLOR = '#1a9a2e'

/** How much of the cushions' shared normal map is left standing. */
const CUSHION_NORMAL_STRENGTH = 0.12
/** The rail wood's light figure colour (earlywood), a dark polished brown. */
const RAIL_EARLY = { r: 92, g: 45, b: 24 }
/** The rail wood's dark stripe colour (latewood). */
const RAIL_LATE = { r: 74, g: 34, b: 20 }
/** Cushion cloth: a brighter green than the bed so the raised edge reads. */
const CUSHION_COLOR = 0x1fae4a
/** The cushion nose strip: brighter still, catching the lamp. */
const NOSE_COLOR = 0x2bc75a

/*
 * STEP 3 — the balls, their contact with the cloth, and the cue stick.
 */
/** Ball resin: tight diffuse under the lacquer film. */
// Renderer/tone mapping
const TONE_MAPPING_MODE: 'neutral' | 'aces' = 'neutral'
const TONE_EXPOSURE = 1.1

// Wood / rails
const RAIL_WOOD_TINT = '#5a2520'
const APRON_SIDE_TINT = '#4a1d1a'

// Cushions
const CUSHION_FACE_COLOR = '#12782a'
const CUSHION_TOP_COLOR = '#33c44d'
const CUSHION_NOSE_COLOR = '#3fd05a'

// Cloth / baize
const CLOTH_COLOR_CENTER = '#20a63a'
const CLOTH_COLOR_MID = '#1a952f'
const CLOTH_COLOR_EDGE = '#127a28'
const CLOTH_ROUGHNESS = 0.96
const CLOTH_METALNESS = 0
const CLOTH_SHEEN = 0.1
const CLOTH_SHEEN_COLOR = '#4fd07a'
const CLOTH_SHEEN_ROUGHNESS = 0.8
const CLOTH_NORMAL_STRENGTH = 0.01
const CLOTH_NOISE_STRENGTH = 0.02 // max 2% luminance
const CLOTH_NOISE_SCALE_MM = 2 // cells < 2mm
const CLOTH_MIPMAPS = true
const CLOTH_ANISO_CAP = 16

const BALL_ROUGHNESS = 0.2
/** The clearcoat's own roughness - the one crisp highlight a ball is known by. */
const BALL_CLEARCOAT_ROUGHNESS = 0.1
/** How much brighter than the palette's white the cue ball is drawn. */
const CUE_BALL_BRIGHTEN = 1.08
/** The contact disc's size, as a multiple of the ball's radius. */
const BALL_SHADOW_PLANE = 2.6
/** The contact disc's height above the cloth, in millimetres. */
const BALL_SHADOW_Y = 0.5
/** How far the contact disc leans off the ball's centre, away from the lamp overhead. */
const BALL_SHADOW_LEAN_MM = 4.5
/** The contact disc's stretch along that lean. */
const BALL_SHADOW_STRETCH = 1.16
/** The cue's silhouette: a thin tip running out to a thicker butt. */
const STICK_TIP_R = 5.5
const STICK_SHAFT_BUTT_R = 13
const STICK_BUTT_END_R = 15.5
const CUE_LENGTH_MM = 1450
/** Chalk blue, bright enough to read as the tip at gameplay distance. */
const STICK_TIP_COLOR = 0x5f92cf
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
/** Build the detailed bowl/net/jaw on this many corner pockets. One, to review it first. */
const POCKET_DETAIL_CORNERS = 1
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
 */
/** The ribbons' height above the cloth, in millimetres. */
const AIM_RIBBON_Y = 0.6
/** LINE 1 — the shot line, from the cue ball's surface to the contact or cushion. */
const AIM_LINE1_COLOR = 0xffffff
const AIM_LINE1_WIDTH = 5.5
const AIM_LINE1_OPACITY = 0.9
/** The contact ring — hollow, the size of the ball it wraps, nothing inside. Shown only when hitting NO ball. */
const AIM_RING_COLOR = 0xffffff
const AIM_RING_OPACITY = 0.85
const AIM_RING_STROKE_MM = 1.5
const AIM_RING_Y = 1.1
/** LINE 2 — the object ball's line, away along the line of centres. */
const AIM_LINE2_COLOR = 0x3bd16f
const AIM_LINE2_WIDTH = 5.5
const AIM_LINE2_LENGTH = BALL_RADIUS * 6
const AIM_LINE2_OPACITY = 0.85
/** LINE 3 — the cue ball's tangent after the contact, when one is worked out. */
const AIM_LINE3_COLOR = 0xffffff
const AIM_LINE3_WIDTH = 5.0
const AIM_LINE3_LENGTH = BALL_RADIUS * 4
const AIM_LINE3_OPACITY = 0.6

function feltTexture(): THREE.CanvasTexture {
  return cachedTexture('felt', () => {
    // 512×512, one tile across the whole bed. The old 2048×1024 canvas cost VRAM and
    // per-frame texture bandwidth for detail the lens cannot hold at any playable
    // distance; mipmapping does the smoothing work, and the markings are baked into
    // this one texture rather than drawn as separate meshes.
    const size = 512
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    // Tournament baize, tuned bright and saturated: the broadcast look has the bed
    // as the colour anchor of the picture, holding its green under the warm lamp
    // rather than darkening down toward it.
    const g = ctx.createRadialGradient(size * 0.5, size * 0.2, size * 0.1, size * 0.5, size * 0.5, size * 0.6)
    g.addColorStop(0, CLOTH_COLOR_CENTER)
    g.addColorStop(0.5, CLOTH_COLOR_MID)
    g.addColorStop(1, CLOTH_COLOR_EDGE)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)

    let seed = 20260930
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    ctx.fillStyle = `rgba(255,255,255,${CLOTH_NOISE_STRENGTH * 0.5})`
    const noiseCount = 2200
    for (let i = 0; i < noiseCount; i++) {
      const x = rand() * size
      const y = rand() * size
      for (const dx of [-size, 0, size]) {
        for (const dy of [-size, 0, size]) {
          ctx.fillRect(x + dx, y + dy, 1.0, 1.0)
        }
      }
    }
    ctx.fillStyle = `rgba(0,0,0,${CLOTH_NOISE_STRENGTH * 0.5})`
    for (let i = 0; i < noiseCount; i++) {
      const x = rand() * size
      const y = rand() * size
      for (const dx of [-size, 0, size]) {
        for (const dy of [-size, 0, size]) {
          ctx.fillRect(x + dx, y + dy, 1.0, 1.0)
        }
      }
    }

    // Crossed nap. Cloth is milled in two directions and brushed along one, so under a
    // raking light it shows faint diagonal weave rather than isotropic speckle. Without
    // this the bed reads as flat matte paint no matter how the roughness is tuned.
    // Kept at a few percent so it survives mipmapping without ever becoming a pattern.
    ctx.save()
    ctx.translate(size / 2, size / 2)
    ctx.rotate(-Math.PI / 5)
    ctx.translate(-size / 2, -size / 2)

    ctx.restore()

    // Baulk line, the D and the spot marks, baked into the cloth: no line meshes,
    // no extra draw calls, and the markings mip down with the baize instead of
    // crawling over it.
    const mark = (tableXmm: number, tableYmm: number): void => {
      const u = (tableXmm / TABLE_LENGTH) * size
      const v = (tableYmm / TABLE_WIDTH) * size
      ctx.fillStyle = '#e6d9ae'
      ctx.beginPath()
      ctx.arc(u, v, 3, 0, Math.PI * 2)
      ctx.fill()
    }

    const bx = (BAULK_LINE_X / TABLE_LENGTH) * size
    const mid = size / 2
    ctx.strokeStyle = '#d8b15c'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(bx, 0)
    ctx.lineTo(bx, size)
    ctx.stroke()
    // The D is drawn as an ellipse, not an arc, and that distinction is the whole reason
    // it looks right on the cloth. This canvas is square but the table it is mapped over
    // is not - 3569mm by 1778mm - so texture space is stretched by about two to one
    // along the table's length. A circle drawn here therefore lands on the bed as an
    // ellipse twice as wide as it is tall, which put the D's arc out past the baulk line
    // by roughly its own radius and made the visible area considerably larger than the
    // area the rules actually allow in. `isInsideD` compares against D_RADIUS in real
    // millimetres on both axes, so each radius here is scaled by its own axis: the result
    // is a true circle of D_RADIUS once the stretch is undone, matching the gameplay
    // boundary exactly. Getting this wrong is purely visual - the rules are unaffected -
    // but a player aiming at what they can see is aiming at a place the rules forbid.
    ctx.beginPath()
    ctx.ellipse(bx, mid, (D_RADIUS / TABLE_LENGTH) * size, (D_RADIUS / TABLE_WIDTH) * size, 0, Math.PI * 0.5, Math.PI * 1.5)
    ctx.stroke()

    mark(BAULK_LINE_X, TABLE_WIDTH / 2 + D_RADIUS * 0.9)
    mark(BAULK_LINE_X, TABLE_WIDTH / 2 - D_RADIUS * 0.9)
    mark(BAULK_LINE_X, TABLE_WIDTH / 2)
    mark(TABLE_LENGTH / 2, TABLE_WIDTH / 2)
    mark(TABLE_LENGTH * 0.75, TABLE_WIDTH / 2)
    mark(TABLE_LENGTH - 324, TABLE_WIDTH / 2)

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.generateMipmaps = CLOTH_MIPMAPS
    texture.minFilter = THREE.LinearMipmapLinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.anisotropy = MAX_ANISO
    return texture
  })
}

/**
 * A woven-cloth normal map, so the bed is lit as fabric rather than matte paint.
 *
 * The colour map above carries the tone and the markings; this carries the surface. It
 * is what lets the near-white lamp highlight break up across the nap instead of sitting
 * on the bed as one dead flat sheet, and it is the difference between "green plane" and
 * "baize" at the cue camera's low angle.
 *
 * Encoded from a height field by central difference rather than authored as RGB, so the
 * weave stays coherent under mipmapping — a hand-picked set of RGB vectors moires as
 * soon as it is minified. Tiled hard (60—) and kept low-contrast for the same reason:
 * visible threads at the overhead distance would alias into a shimmer across the bed.
 */
function feltNormalTexture(): THREE.CanvasTexture {
  return cachedTexture('felt-normal', () => {
    const size = 256
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const img = ctx.createImageData(size, size)
    const d = img.data
    // Plain weave: warp and weft threads alternate over and under on a checkerboard,
    // so each cell's height is the ridge of whichever thread is on top.
    const height = (x: number, y: number): number => {
      const cx = Math.floor(x / 8)
      const cy = Math.floor(y / 8)
      const over = (cx + cy) % 2 === 0
      const u = ((x % 8) + 8) % 8
      const v = ((y % 8) + 8) % 8
      // Ridge profile across the thread: sin gives the rounded crown of a yarn.
      const warpRidge = Math.sin((u / 8) * Math.PI) * (over ? 1 : 0.55)
      const weftRidge = Math.sin((v / 8) * Math.PI) * (over ? 0.55 : 1)
      return Math.max(warpRidge, weftRidge)
    }
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Central difference on the height field. Wrap the taps so the normal map tiles
        // with the colour map instead of showing a seam line around the bed.
        const hl = height((x - 1 + size) % size, y)
        const hr = height((x + 1) % size, y)
        const hd = height(x, (y - 1 + size) % size)
        const hu = height(x, (y + 1) % size)
        // 8 is the sample spacing, so it cancels the divisor; the rest is a gain that
        // keeps the perturbation gentle — baize is nearly flat, and a strong normal here
        // would look like hammered metal.
        const nx = (hl - hr) * 0.9
        const ny = (hd - hu) * 0.9
        const nz = 1
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
        const i = (y * size + x) * 4
        // Normal maps are data, not colour: no sRGB tag here, for the same reason the
        // wood roughness map is left linear.
        d[i] = ((nx / len) * 0.5 + 0.5) * 255
        d[i + 1] = ((ny / len) * 0.5 + 0.5) * 255
        d[i + 2] = ((nz / len) * 0.5 + 0.5) * 255
        d[i + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
    const texture = new THREE.CanvasTexture(canvas)
    texture.generateMipmaps = true
    texture.minFilter = THREE.LinearMipmapLinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.anisotropy = MAX_ANISO
    return texture
  })
}

function contactShadowTexture(): THREE.CanvasTexture {
  return cachedTexture('shadow', () => {
    const size = 128
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const grad = ctx.createRadialGradient(size / 2, size / 2, 4, size / 2, size / 2, size / 2)
    grad.addColorStop(0, 'rgba(0,0,0,0.55)')
    grad.addColorStop(0.6, 'rgba(0,0,0,0.18)')
    grad.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
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
 * Open-table aim ribbon: feathered across width, solid first 70%,
 * last 30% fading to 0 toward the cushion.
 */
function aimRibbonTexture(): THREE.CanvasTexture {
  return cachedTexture('aim-ribbon', () => {
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
      const across = Math.min(1, Math.min(v, 1 - v) / 0.28)
      for (let x = 0; x < w; x++) {
        const u = x / (w - 1)
        const along = u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3
        const a = Math.round(255 * across * along * along)
        const i = (y * w + x) * 4
        d[i] = 255
        d[i + 1] = 255
        d[i + 2] = 255
        d[i + 3] = a
      }
    }
    ctx.putImageData(img, 0, 0)
    return new THREE.CanvasTexture(canvas)
  })
}

/**
 * Aim ribbon for ball contact: feathered across width, solid to the contact point.
 */
function aimRibbonSolidTexture(): THREE.CanvasTexture {
  return cachedTexture('aim-ribbon-solid', () => {
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
      const across = Math.min(1, Math.min(v, 1 - v) / 0.28)
      for (let x = 0; x < w; x++) {
        const a = Math.round(255 * across)
        const i = (y * w + x) * 4
        d[i] = 255
        d[i + 1] = 255
        d[i + 2] = 255
        d[i + 3] = a
      }
    }
    ctx.putImageData(img, 0, 0)
    return new THREE.CanvasTexture(canvas)
  })
}

/**
 * Aim ribbon trail: feathered across width, fading from 1 to 0 along its length.
 */
function aimRibbonTrailTexture(): THREE.CanvasTexture {
  return cachedTexture('aim-ribbon-trail', () => {
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
      const across = Math.min(1, Math.min(v, 1 - v) / 0.28)
      for (let x = 0; x < w; x++) {
        const u = x / (w - 1)
        const along = 1 - u
        const a = Math.round(255 * across * along)
        const i = (y * w + x) * 4
        d[i] = 255
        d[i + 1] = 255
        d[i + 2] = 255
        d[i + 3] = a
      }
    }
    ctx.putImageData(img, 0, 0)
    return new THREE.CanvasTexture(canvas)
  })
}

/**
 * Deterministic value noise on a wrapping lattice, so the field tiles.
 *
 * Hand-rolled rather than pulled from a library: the table needs exactly two kinds of
 * grain — warped growth rings and stretched pores — and both want this same field at
 * different frequencies and aspect ratios. Hash-based, so the figure is identical on
 * every load and the palette can be retuned without the wood moving underneath it.
 */
function woodHash(x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h ^= h >>> 12
  h = Math.imul(h, 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

function tileNoise(u: number, v: number, period: number): number {
  const x = u * period
  const y = v * period
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  // Smoothstep the interpolants: bilinear noise has a visible grid, and this is the
  // cheapest way to remove it without a second smoothing pass.
  const sx = xf * xf * (3 - 2 * xf)
  const sy = yf * yf * (3 - 2 * yf)
  const x0 = ((xi % period) + period) % period
  const y0 = ((yi % period) + period) % period
  const x1 = (x0 + 1) % period
  const y1 = (y0 + 1) % period
  const n00 = woodHash(x0, y0)
  const n10 = woodHash(x1, y0)
  const n01 = woodHash(x0, y1)
  const n11 = woodHash(x1, y1)
  const a = n00 + (n10 - n00) * sx
  const b = n01 + (n11 - n01) * sx
  return a + (b - a) * sy
}

function tileFbm(u: number, v: number, period: number, octaves: number): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let p = period
  for (let o = 0; o < octaves; o++) {
    sum += tileNoise(u, v, p) * amp
    norm += amp
    amp *= 0.5
    p *= 2
  }
  return sum / norm
}

let woodGrainPair: { color: HTMLCanvasElement; rough: HTMLCanvasElement } | null = null

/**
 * Flat-sawn mahogany, generated as a colour map and a matching roughness map.
 *
 * The previous texture was horizontal scanlines with a few white dashes on top, which
 * read as painted stripes rather than timber. Real flat-sawn figure is growth rings
 * whose radius wanders: the board is cut off-centre from the log, so the rings appear
 * as wide nested arches, and the narrow dark latewood band between the open earlywood
 * is what gives mahogany its contrast.
 *
 * Two decisions worth stating. The ring centre sits well below the board and the radius
 * is squashed vertically, which is what turns circles into arches — concentric circles
 * centred on the face would read as a sliced tree trunk, not a rail. And the map is
 * mapped 1:1 per face with clamped edges rather than tiled, because an arch pattern has
 * no seamless repeat; the wrap modes below would only hide the seam.
 *
 * The roughness map is the half that sells "polished". Lacquer lies over the earlywood
 * and stays glossy, while the latewood band and the open pores are too fine for a film
 * to level and stay dull. Colour alone cannot express that contrast, so a flat-colour
 * wood under a clearcoat still reads as plastic.
 */
function woodGrain(): { color: HTMLCanvasElement; rough: HTMLCanvasElement } {
  if (woodGrainPair) return woodGrainPair
  const size = 512
  const color = document.createElement('canvas')
  color.width = size
  color.height = size
  const rough = document.createElement('canvas')
  rough.width = size
  rough.height = size
  const cctx = color.getContext('2d')!
  const rctx = rough.getContext('2d')!
  const cimg = cctx.createImageData(size, size)
  const rimg = rctx.createImageData(size, size)
  const cd = cimg.data
  const rd = rimg.data

  const cx = size * 0.5
  const cy = size * 2.6
  const squash = 0.55
  const ringFreq = 13
  const EARLY_R = RAIL_EARLY.r
  const EARLY_G = RAIL_EARLY.g
  const EARLY_B = RAIL_EARLY.b
  const LATE_R = RAIL_LATE.r
  const LATE_G = RAIL_LATE.g
  const LATE_B = RAIL_LATE.b

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      // Warping the ring radius is what separates sawn timber from printed stripes.
      const warp = tileFbm(u, v, 8, 3) - 0.5
      const drift = tileFbm(u, v, 4, 2)
      const dx = x - cx
      const dy = (y - cy) * squash
      const dist = Math.sqrt(dx * dx + dy * dy) / size
      const t = dist * ringFreq + warp * 1.7 + drift * 0.3
      const frac = t - Math.floor(t)
      // A triangle raised to a high power is a narrow band — the latewood line.
      const tri = 1 - Math.abs(frac * 2 - 1)
      const late = Math.pow(tri, 10)
      // Pores: open-grain flecks, compressed in v so they stretch along the grain.
      // Sampled with a stretched u so the field is not square-checkered.
      const pore = Math.pow(tileFbm(u * 0.3, v * 2.4, 32, 1), 3)

      const mix = Math.min(1, late * 0.9 + drift * 0.28)
      const pk = pore * 0.55
      const i = (y * size + x) * 4
      cd[i] = (EARLY_R + (LATE_R - EARLY_R) * mix) * (1 - pk)
      cd[i + 1] = (EARLY_G + (LATE_G - EARLY_G) * mix) * (1 - pk * 0.92)
      cd[i + 2] = (EARLY_B + (LATE_B - EARLY_B) * mix) * (1 - pk * 0.85)
      cd[i + 3] = 255

      const rv = (0.13 + late * 0.1 + pore * 0.42 + drift * 0.05) * 255
      rd[i] = rv
      rd[i + 1] = rv
      rd[i + 2] = rv
      rd[i + 3] = 255
    }
  }
  cctx.putImageData(cimg, 0, 0)
  rctx.putImageData(rimg, 0, 0)
  woodGrainPair = { color, rough }
  return woodGrainPair
}

function woodTexture(): THREE.CanvasTexture {
  return cachedTexture('wood', () => {
    const texture = new THREE.CanvasTexture(woodGrain().color)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = MAX_ANISO
    return texture
  })
}

/**
 * The same figure as a roughness map, sharing the colour map's UVs exactly.
 *
 * Deliberately not sRGB: roughness is a linear channel, and tagging it as colour data
 * gamma-encodes it into a visibly wrong, too-glossy curve.
 */
function woodRoughnessTexture(): THREE.CanvasTexture {
  return cachedTexture('wood-rough', () => {
    const texture = new THREE.CanvasTexture(woodGrain().rough)
    texture.anisotropy = MAX_ANISO
    return texture
  })
}

/**
 * Brass, with the roughness broken up so it is not one uniform mirror.
 *
 * Hand-polished brass is never evenly rough: the polish leaves swirl marks, and the
 * recesses hold a duller tarnish. A constant roughness on a metal turns the whole part
 * into a featureless highlight, which is what made the original trim read as flat gold
 * plastic. The variation here is fine and low-contrast on purpose — enough to break the
 * specular into something with structure, not enough to look noisy or dirty.
 */
function brassRoughnessTexture(): THREE.CanvasTexture {
  return cachedTexture('brass-rough', () => {
    const size = 256
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const img = ctx.createImageData(size, size)
    const d = img.data
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size
        const v = y / size
        // Swirl: noise domain-warped around a centre, the way a rotary buff leaves it.
        const a = tileFbm(u, v, 4, 2) * Math.PI * 2
        const swirl = tileFbm(u + Math.cos(a) * 0.12, v + Math.sin(a) * 0.12, 6, 3)
        const fine = tileFbm(u * 0.2, v * 3, 48, 1)
        const rv = Math.min(1, Math.max(0, 0.17 + (swirl - 0.5) * 0.3 + (fine - 0.5) * 0.12)) * 255
        const i = (y * size + x) * 4
        d[i] = rv
        d[i + 1] = rv
        d[i + 2] = rv
        d[i + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
    const texture = new THREE.CanvasTexture(canvas)
    texture.anisotropy = MAX_ANISO
    return texture
  })
}

/**
 * A straight-grained cue timber: ash for the shaft, dark maple for the butt.
 *
 * Cue grain runs lengthwise along the taper, so the canvas is ruled with long
 * vertical figure lines and only slight tone drift between them — a cue's beauty
 * is in its even, narrow stripes rather than the wide irregular plank figure the
 * table wood uses.
 */
function cueWoodTexture(key: string, base: { r: number; g: number; b: number }, figure: number): THREE.CanvasTexture {
  return cachedTexture(key, () => {
    const size = 256
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = `rgb(${base.r}, ${base.g}, ${base.b})`
    ctx.fillRect(0, 0, size, size)
    for (let x = 0; x < size; x++) {
      const wobble = Math.sin(x * 0.35) * 6 + Math.sin(x * 0.11) * 10
      const tone = base.r + Math.sin(x * 0.8 + wobble) * figure
      ctx.fillStyle = `rgba(${Math.round(Math.max(0, tone))}, ${Math.round(base.g * (tone / base.r))}, ${Math.round(base.b * (tone / base.r))}, 0.5)`
      ctx.fillRect(x, 0, 1, size)
    }
    ctx.fillStyle = 'rgba(255,255,255,0.05)'
    for (let i = 0; i < 12; i++) {
      const y = Math.random() * size
      ctx.fillRect(0, y, size, 1)
    }
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return texture
  })
}

/**
 * The inner shading of a pocket: darkness at the bottom fading up the walls.
 *
 * Painted onto a cylinder lining the pocket's drop, it is what turns a hole into
 * a depth: a flat black disc reads as a decal, a shaded throat reads as somewhere
 * for the ball to go.
 */
function pocketDepthTexture(): THREE.CanvasTexture {
  return cachedTexture('pocket-depth', () => {
    const size = 128
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    const grad = ctx.createRadialGradient(size / 2, size / 2, 4, size / 2, size / 2, size / 2)
    grad.addColorStop(0, 'rgba(0,0,0,1)')
    grad.addColorStop(0.55, 'rgba(0,0,0,0.85)')
    grad.addColorStop(1, 'rgba(30,18,10,0.25)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
    return new THREE.CanvasTexture(canvas)
  })
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
    return new THREE.CanvasTexture(canvas)
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
    // The overhead lamp as a bright soft-edged band. This is the single most important
    // element in the map: it is what the clearcoat on the wood and the metalness of the
    // brass both reflect, and a thin hard-edged line here is what produces the long
    // specular streak running down a polished rail. Soft edges and a secondary
    // lower-intensity pass give the highlight some structure rather than one hard line.
    ctx.fillStyle = 'rgba(255,248,226,0.92)'
    ctx.fillRect(w * 0.26, h * 0.345, w * 0.48, 9)
    ctx.fillStyle = 'rgba(255,240,206,0.55)'
    ctx.fillRect(w * 0.23, h * 0.375, w * 0.54, 5)
    ctx.fillRect(w * 0.29, h * 0.40, w * 0.42, 3)
    // Two dimmer fittings further round the room, so the reflection in the brass is not
    // a single lonely streak. A polished metal part reads as expensive when it has
    // several highlights to choose between.
    ctx.fillStyle = 'rgba(255,236,198,0.3)'
    ctx.fillRect(w * 0.03, h * 0.4, w * 0.13, 4)
    ctx.fillRect(w * 0.84, h * 0.4, w * 0.13, 4)
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

class BallRig {
  group = new THREE.Group()
  sphere: THREE.Mesh
  material: THREE.MeshStandardMaterial
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

  constructor(radius: number, color: number, shadowTex: THREE.CanvasTexture) {
    // Phenolic resin: a tight diffuse under a clearcoat film. The coat is what
    // carries the ball's one crisp highlight off the lamp, and the env map's
    // bright band is what the coat reflects between that highlight and the
    // horizon. Emissive stays zero: it is only ever set on highlight, and setting
    // it costs nothing while unlit.
    this.material = new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.05,
      metalness: 0.0,
      clearcoat: 1.0,
      clearcoatRoughness: 0.02,
      emissive: 0x000000,
      envMapIntensity: 1.0,
      ior: 1.5
    })
    this.sphere = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 28), this.material)
    // Balls never cast into the scene's one static shadow map: a shadow baked at
    // frame one would sit forever where the ball first stood. Grounding is sold by
    // the soft contact blob under the ball instead, which moves with it and costs
    // no shadow renders.
    this.sphere.castShadow = false
    this.group.add(this.sphere)
    const blobMat = new THREE.MeshBasicMaterial({
      map: shadowTex,
      color: 0x000000,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -1,
      toneMapped: false,
      blending: THREE.NormalBlending
    })
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(radius * BALL_SHADOW_PLANE, radius * BALL_SHADOW_PLANE), blobMat)
    this.blob.rotation.x = -Math.PI / 2
    this.blob.position.y = 0.6
    this.blob.renderOrder = 1
    this.group.add(this.blob)
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
    }
    this.target.set(targetX, BALL_RADIUS, targetZ)
    // The contact disc leans and stretches away from the table's centre, where the
    // lamp hangs: that is the oblique part of the light, and it is the direction a
    // real shadow would take. Dead centre there is nothing to lean towards.
    const centreDist = Math.hypot(targetX, targetZ)
    if (centreDist > 40) {
      const nx = targetX / centreDist
      const nz = targetZ / centreDist
      this.blob.position.set(nx * BALL_SHADOW_LEAN_MM, BALL_SHADOW_Y - BALL_RADIUS, nz * BALL_SHADOW_LEAN_MM)
      this.blob.rotation.z = Math.atan2(-nz, nx)
      this.blob.scale.set(BALL_SHADOW_STRETCH, 1, 1)
    } else {
      this.blob.position.set(0, BALL_SHADOW_Y - BALL_RADIUS, 0)
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

export class Scene3D {
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
  private cameraMode: 'AIM' | 'TOP_DOWN' = 'AIM'
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
  /** Ring + baulk line segment marking the D during break-off placement. Built once, shown on demand. */
  private dZoneRing!: THREE.Mesh
  /**
   * The felt's texture, kept for the artifact guards in `selfCheck`: the banding
   * regression this scene once had was a texture configured without mipmaps, and
   * a one-line check at build time is cheaper than ever rediscovering it by eye.
   */
  private feltTex: THREE.CanvasTexture | null = null
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

  static create(canvas: HTMLCanvasElement, width: number, height: number): Scene3D | null {
    try {
      return new Scene3D(canvas, width, height)
    } catch {
      return null
    }
  }

  private constructor(canvas: HTMLCanvasElement, width: number, height: number) {
    this.cvw = width
    this.cvh = height
    // The canvas backing store is already sized with the device pixel ratio by the
    // caller (capped at 1.5 in main.ts), so the renderer draws at one pixel per backing
    // pixel. AA is decided once from the device rather than asked for unconditionally:
    // MSAA costs fill rate on every pass, and a weak GPU with a small backing store
    // does better spending it on pixels than on edges.
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: (window.devicePixelRatio || 1) < 1.75,
      powerPreference: 'high-performance'
    })
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(width, height, false)
    // One query, one clamp, shared by every texture built after this line.
    MAX_ANISO = Math.min(this.renderer.capabilities.getMaxAnisotropy(), CLOTH_ANISO_CAP)
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

    this.scene.background = new THREE.Color(ROOM_BG_COLOR)
    // A whisper of the room's own colour in the far distance: enough that the wall
    // and the floor fade out at their extremes instead of ending on a hard plane
    // edge, and nothing at gameplay distances.
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
    this.buildTable()
    this.buildAim()
    this.buildPlacement()

    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromEquirectangular(envTexture()).texture
    pmrem.dispose()

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
    const lamp = (this.lamp = new THREE.SpotLight(0xffd9a0, 5400000, 0, Math.PI / 4.6, 0.6, 2))
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
    const ambient = new THREE.AmbientLight(0xdfe8ff, 0.34)
    this.scene.add(ambient)

    // Hemisphere keeps the room warm from above and dark at the floor, so the underside
    // of the rails picks up bounce rather than reading as a black void.
    const hemi = new THREE.HemisphereLight(0xfff1d8, 0x2e2419, 0.5)
    this.scene.add(hemi)

    // Cool fill from one side, warm key-side fill from the other, so every visible
    // surface receives light of two different hues. This is what separates the brass
    // from the wood behind it — a single-hue scene gives metal nowhere to put its
    // warm/cool split, and brass ends up looking like tinted plastic.
    const fill = new THREE.DirectionalLight(0x9fc0e8, 0.4)
    fill.position.set(2200, 1200, -1100)
    this.scene.add(fill)

    const warm = new THREE.DirectionalLight(0xffd9a8, 0.32)
    warm.position.set(-2200, 1400, 1600)
    this.scene.add(warm)

    // A low grazing kicker from the front-right, just above rail height. It does almost
    // nothing for the bed — which faces up, so a near-horizontal light barely touches it
    // — but it rakes across the vertical faces of the apron and the cushion ends, which
    // is where a premium table is actually read. Without it the whole body of the table
    // sits in the lamp's ambient wash and the milled detail has no edge to catch.
    // No shadow: this is a shaping light, and a second shadow map is not worth it.
    const kicker = new THREE.DirectionalLight(0xfff0d4, 0.55)
    kicker.position.set(2600, 320, 1900)
    this.scene.add(kicker)

    // A tight specular source placed for the highlight it draws down the brass rail,
    // not for the light it contributes. Warm and narrow, aimed at the rail line.
    const railSpec = new THREE.DirectionalLight(0xfff4e0, 0.4)
    railSpec.position.set(900, 900, 2400)
    this.scene.add(railSpec)
  }

  private buildTable(): void {
    const pad = APRON_PAD
    const cloth = new THREE.Mesh(
      new THREE.PlaneGeometry(TABLE_LENGTH, TABLE_WIDTH),
      new THREE.MeshPhysicalMaterial({
        map: (this.feltTex = feltTexture()),
        normalMap: feltNormalTexture(),
        normalScale: new THREE.Vector2(CLOTH_NORMAL_STRENGTH, CLOTH_NORMAL_STRENGTH),
        color: 0xffffff,
        roughness: CLOTH_ROUGHNESS,
        metalness: CLOTH_METALNESS,
        sheen: CLOTH_SHEEN,
        sheenColor: new THREE.Color(CLOTH_SHEEN_COLOR),
        sheenRoughness: CLOTH_SHEEN_ROUGHNESS,
        envMapIntensity: 0.08
      })
    )
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
    const apron = new THREE.Mesh(new THREE.BoxGeometry(outerL, 122, outerW), apronMat)
    apron.position.y = -72
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
    const TRIM_COLOR = '#6b4a22'
    const SHOW_BRASS_TRIM = false
    const brassLipMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(TRIM_COLOR),
      metalness: 0.6,
      roughness: 0.55,
      roughnessMap: brassRoughnessTexture(),
      envMapIntensity: 0.15
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
        jawLong: THREE.BufferGeometry
        jawShort: THREE.BufferGeometry
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
    // The bowl: cream satin on the inside wall, shaded to black at the throat by the
    // gradient rather than by light, because no amount of lamp gets into a 46mm hole.
    // BackSide - we look at the inside of the funnel, never its outside.
    const pocketBowlMat = new THREE.MeshStandardMaterial({
      map: pocketBowlShadeTexture(),
      roughness: 0.62,
      metalness: 0,
      side: THREE.BackSide,
      envMapIntensity: 0.08
    })
    // The jaali as a picture rather than a cone. Unlit on purpose: it sits deep in a hole
    // where lit materials go black, and the reference wants the strings to stay legibly
    // cream from the normal playing camera angle.
    const pocketNetDiscMat = new THREE.MeshBasicMaterial({
      map: pocketNetTexture(),
      side: THREE.DoubleSide,
      toneMapped: false
    })
    // The jaw is cushion, so it wears cushion cloth: same green, same roughness, so the
    // nose reads as one continuous rubber from rail to pocket.
    const pocketJawMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(CUSHION_FACE_COLOR),
      roughness: 0.88,
      metalness: 0,
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
        // The two jaws. A corner pocket is met by two cushions, on the +X and +Z axes,
        // so each gets its own 50 degree arc of green nose curving down over the bowl lip.
        // LatheGeometry measures phi from +Z (x = r sin phi, z = r cos phi), so the arc
        // facing the long rail is centred on phi = 0 and the one facing the short rail on
        // phi = 90 degrees. The inner edge sits exactly on the physics radius, so the nose
        // rolls over the lip without ever narrowing the drawn mouth.
        jawLong: new THREE.LatheGeometry(
          [
            new THREE.Vector2(radius, 0),
            new THREE.Vector2(radius + 1.5, 5),
            new THREE.Vector2(radius + 5.5, 10),
            new THREE.Vector2(Math.max(POCKET_JAW_REACH_MM, radius + 12), POCKET_JAW_RISE_MM),
            new THREE.Vector2(Math.max(POCKET_JAW_REACH_MM, radius + 12) - 3, POCKET_JAW_RISE_MM - 4),
            new THREE.Vector2(radius + 6, 3),
            new THREE.Vector2(radius, 0)
          ],
          14,
          -THREE.MathUtils.degToRad(POCKET_JAW_ARC_DEG) / 2,
          THREE.MathUtils.degToRad(POCKET_JAW_ARC_DEG)
        ),
        jawShort: new THREE.LatheGeometry(
          [
            new THREE.Vector2(radius, 0),
            new THREE.Vector2(radius + 1.5, 5),
            new THREE.Vector2(radius + 5.5, 10),
            new THREE.Vector2(Math.max(POCKET_JAW_REACH_MM, radius + 12), POCKET_JAW_RISE_MM),
            new THREE.Vector2(Math.max(POCKET_JAW_REACH_MM, radius + 12) - 3, POCKET_JAW_RISE_MM - 4),
            new THREE.Vector2(radius + 6, 3),
            new THREE.Vector2(radius, 0)
          ],
          14,
          THREE.MathUtils.degToRad(90 - POCKET_JAW_ARC_DEG / 2),
          THREE.MathUtils.degToRad(POCKET_JAW_ARC_DEG)
        )
      }
      pocketGeo.set(radius, made)
      return made
    }
    // Only the first N corner pockets get the detailed treatment, so it can be reviewed
    // before it is copied to the rest. Everything else keeps the simple version.
    let detailCornersLeft = POCKET_DETAIL_CORNERS
    for (const p of POCKETS) {
      const x = tableX(p.x)
      const z = tableZ(p.y)
      const geo = geoFor(p.radius)
      const detailed = p.kind === 'corner' && detailCornersLeft > 0
      if (detailed) detailCornersLeft -= 1
      // Inner shadow ring on the bed around the mouth, softening the cloth edge.
      if (false) {
        const shadow = new THREE.Mesh(geo.shadow, mouthShadowMat)
        shadow.name = 'pocket-shadow'
        shadow.rotation.x = -Math.PI / 2
        shadow.position.set(x, CUSHION_H + 1.1, z)
        shadow.renderOrder = 4
        this.scene.add(shadow)
      }
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
      if (!detailed) {
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
        rim.position.set(x, CUSHION_H - POCKET_RIM_HEIGHT_MM, z)
        this.scene.add(rim)

        // The jaali, hanging from under the cap down into the dark. Its top radius tracks
        // the mouth so there is no gap to see the room through.
        const jaali = new THREE.Mesh(geo.net, pocketNetMat)
        jaali.name = 'pocket-net'
        jaali.position.set(x, CUSHION_H - POCKET_RIM_HEIGHT_MM - POCKET_NET_DROP_MM / 2, z)
        this.scene.add(jaali)
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
        const netDisc = new THREE.Mesh(geo.netDisc, pocketNetDiscMat)
        netDisc.name = 'pocket-net-detail'
        netDisc.rotation.x = -Math.PI / 2
        netDisc.position.set(x, -POCKET_NET_DEPTH_MM, z)
        this.scene.add(netDisc)

        // The two green jaws, one per cushion that meets this pocket. They are lathes
        // centred on the pocket itself, so they are automatically concentric with the bowl.
        for (const [name, jawGeo] of [
          ['pocket-jaw-long', geo.jawLong],
          ['pocket-jaw-short', geo.jawShort]
        ] as const) {
          const jaw = new THREE.Mesh(jawGeo, pocketJawMat)
          jaw.name = name
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

    // Dark floor, so the lit table is the subject of the picture.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(16000, 9000),
      new THREE.MeshLambertMaterial({ color: new THREE.Color(ROOM_FLOOR_COLOR) })
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -790
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
    // The aim guide is three thin ribbons and one hollow ring, in the broadcast
    // style: no dashes, no arrowheads, no dots, no glow — the lines themselves
    // carry the whole story. All of them are strips of cloth-level light sharing
    // one feathered, far-fading texture, re-pointed every frame.
    const ribbonTexSolid = aimRibbonSolidTexture()
    const ribbonTexFade = aimRibbonTexture()
    const ribbonTexTrail = aimRibbonTrailTexture()
    this.aimRibbon1 = this.buildRibbon(ribbonTexSolid, AIM_LINE1_COLOR, AIM_LINE1_OPACITY, AIM_RIBBON_Y)
    this.aimRibbon1Open = this.buildRibbon(ribbonTexFade, AIM_LINE1_COLOR, AIM_LINE1_OPACITY, AIM_RIBBON_Y)
    this.aimRibbon2 = this.buildRibbon(ribbonTexTrail, AIM_LINE2_COLOR, AIM_LINE2_OPACITY, AIM_RIBBON_Y + 0.1)
    this.aimRibbon3 = this.buildRibbon(ribbonTexTrail, AIM_LINE3_COLOR, AIM_LINE3_OPACITY, AIM_RIBBON_Y + 0.2)

    // The contact ring: a hollow circle the size of the ball it wraps, with
    // nothing inside it, at the cushion end when aiming at open table.
    this.contactRing = new THREE.Mesh(
      new THREE.RingGeometry(BALL_RADIUS - AIM_RING_STROKE_MM, BALL_RADIUS, 48),
      new THREE.MeshBasicMaterial({
        color: AIM_RING_COLOR,
        transparent: true,
        opacity: AIM_RING_OPACITY,
        side: THREE.DoubleSide,
        depthWrite: false
      })
    )
    this.contactRing.rotation.x = -Math.PI / 2
    this.contactRing.visible = false
    this.contactRing.renderOrder = 3
    this.scene.add(this.contactRing)

    // A proper cue: ash shaft with lengthwise grain, maple butt section, a brass
    // ferrule and a chalked blue tip. Geometry shares the stick's own axis (+y is
    // toward the tip), so every part is positioned along it.
    this.stick = new THREE.Group()
    const shaftMat = new THREE.MeshPhysicalMaterial({
      map: cueWoodTexture('cue-ash', { r: 214, g: 178, b: 122 }, 26),
      roughness: 0.38,
      metalness: 0.0,
      clearcoat: 0.5,
      clearcoatRoughness: 0.3
    })
    const buttMat = new THREE.MeshPhysicalMaterial({
      map: cueWoodTexture('cue-maple', { r: 74, g: 44, b: 26 }, 16),
      roughness: 0.34,
      metalness: 0.0,
      clearcoat: 0.5,
      clearcoatRoughness: 0.3
    })
    const ferruleMat = new THREE.MeshStandardMaterial({ color: 0xd8b15c, roughness: 0.25, metalness: 0.9 })
    const chalkMat = new THREE.MeshStandardMaterial({ color: STICK_TIP_COLOR, roughness: 0.95, metalness: 0.0 })
    // Shaft: a proper taper, thin at the tip running out to the joint.
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(STICK_TIP_R, STICK_SHAFT_BUTT_R, 1200, 20), shaftMat)
    shaft.position.y = 0
    // Same rule as the balls: the stick moves, the shadow map does not.
    shaft.castShadow = false
    // Butt extension past the joint to reach ~CUE_LENGTH_MM total from tip end
    const buttLen = Math.max(200, CUE_LENGTH_MM - 1200 - 30 - 14 - 10) // rough approx
    const butt = new THREE.Mesh(new THREE.CylinderGeometry(STICK_SHAFT_BUTT_R, STICK_BUTT_END_R, 250, 20), buttMat)
    butt.position.y = -598 - 125 // joint at -598, shaft ends at -600, butt extends below joint
    butt.castShadow = false
    // Brass ferrule at the tip end of the shaft.
    const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(5.4, 5.6, 30, 16), ferruleMat)
    ferrule.position.y = 612
    // Chalk-blue tip crowning the ferrule.
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(5.2, 5.4, 14, 16), chalkMat)
    tip.position.y = 634
    // A thin decorative ring where the two timbers meet.
    const joint = new THREE.Mesh(new THREE.CylinderGeometry(STICK_SHAFT_BUTT_R + 0.2, STICK_SHAFT_BUTT_R + 0.2, 10, 20), ferruleMat)
    joint.position.y = -598
    this.stick.add(shaft, butt, ferrule, tip, joint)
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
      new THREE.MeshBasicMaterial({ map, color, transparent: true, opacity, depthWrite: false })
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
    this.dZoneRing.rotation.z = 0
    // Torus arc runs 0..π counterclockwise from +x; rotated flat, that spans the
    // half-circle on the baulk side once centred on the D's middle point.
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
    // the camera is supposed to end up behind where it actually is.
    this.placementTransition = beginPlacementTransition(
      this.rig.pose,
      aimPose(landing, this.rig.yaw, aimFovDeg(this.cvw / Math.max(1, this.cvh))),
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

  update(snapshot: FrameSnapshotData | null, options: RenderOptions = {}): void {
    this.immediate = options.immediate === true
    // Kept for the camera, which moves on its own clock in `render` rather than in here:
    // the balls it follows and the heading it turns to are both read from here.
    this.lastSnapshot = snapshot
    if (options.aim) {
      this.lastAimAngle = options.aim.angle
      // While the player is free to aim, the heading follows the aim itself so the
      // lens stays directly behind the cue ball on the shot line — gated to the
      // half-plane the camera can see, so the drag-back that sets power cannot
      // spin it. While a shot is on screen the heading is latched to the line that
      // shot was played along, which is the view the tracking camera holds.
      this.latch = this.tracking
        ? stepHeadingLatch(this.latch, this.lastAimAngle, true)
        : followHeadingLatch(this.latch, this.lastAimAngle)
    }
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
        // The cue ball is lifted just off the palette's white: beside fifteen
        // saturated colours under the same warm lamp, a plain white reads grey.
        const base = ballColor(ball.id)
        let tint = base
        if (ball.id === BALL_IDS.CUE) {
          const lifted = new THREE.Color(base).multiplyScalar(CUE_BALL_BRIGHTEN)
          lifted.r = Math.min(1, lifted.r)
          lifted.g = Math.min(1, lifted.g)
          lifted.b = Math.min(1, lifted.b)
          tint = lifted.getHex()
        }
        rig = new BallRig(BALL_RADIUS, tint, this.shadowTexCache || contactShadowTexture())
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

    // LINE 1 runs from the cue ball's own surface to wherever the shot line
    // ends: the contact ring when a ball is in the way, the cushion when the
    // table is open. The cushion end is a ray against the bed's own rectangle —
    // geometry, not prediction — so no new aim data is being invented here.
    const guide = computeAimGuide({ ...cueBall, id: 0 }, aim.angle, balls)
    let length: number
    if (guide) {
      length = Math.hypot(guide.contact.x - cueBall.x, guide.contact.y - cueBall.y)
    } else {
      const dx = Math.cos(aim.angle)
      const dy = Math.sin(aim.angle)
      let far = 4000
      if (dx > 0.0001) far = Math.min(far, (TABLE_LENGTH - cueBall.x) / dx)
      if (dx < -0.0001) far = Math.min(far, -cueBall.x / dx)
      if (dy > 0.0001) far = Math.min(far, (TABLE_WIDTH - cueBall.y) / dy)
      if (dy < -0.0001) far = Math.min(far, -cueBall.y / dy)
      length = far
    }
    const lineAngle = guide ? Math.atan2(guide.contact.y - cueBall.y, guide.contact.x - cueBall.x) : aim.angle

    if (guide) {
      this.setRibbon(
        this.aimRibbon1,
        cx + Math.cos(lineAngle) * BALL_RADIUS,
        cz + Math.sin(lineAngle) * BALL_RADIUS,
        lineAngle,
        Math.max(0, length - BALL_RADIUS),
        AIM_LINE1_WIDTH
      )
      this.aimRibbon1Open.visible = false
      this.contactRing.visible = false
      this.showContactMarker(guide)
    } else {
      // Nothing in the way: Line 1 runs to cushion with last 30% fade, ring at end, Lines 2 & 3 hidden
      this.setRibbon(
        this.aimRibbon1Open,
        cx + Math.cos(lineAngle) * BALL_RADIUS,
        cz + Math.sin(lineAngle) * BALL_RADIUS,
        lineAngle,
        Math.max(0, length - BALL_RADIUS),
        AIM_LINE1_WIDTH
      )
      this.aimRibbon1.visible = false
      this.aimRibbon2.visible = false
      this.aimRibbon3.visible = false
      const endX = cx + Math.cos(lineAngle) * length
      const endZ = cz + Math.sin(lineAngle) * length
      this.contactRing.position.set(endX, AIM_RING_Y, endZ)
      this.contactRing.visible = true
    }

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

  /** Lays one of the aim ribbons down on the cloth: from a point, along a heading, so long. */
  private setRibbon(ribbon: THREE.Mesh, x: number, z: number, angle: number, length: number, widthMm: number): void {
    if (length <= 1) {
      ribbon.visible = false
      return
    }
    ribbon.scale.set(length, widthMm, 1)
    ribbon.position.set(x + Math.cos(angle) * length * 0.5, ribbon.position.y, z + Math.sin(angle) * length * 0.5)
    // With the strip lying flat, its spin maps its local +X onto the cloth.
    ribbon.rotation.z = Math.atan2(-Math.sin(angle), Math.cos(angle))
    ribbon.visible = true
  }

  /**
   * Lays the two departure lines: the object ball's own path away along the line
   * of centres, and the cue ball's deflection tangent. The contact ring is kept hidden.
   */
  private showContactMarker(guide: AimGuide): void {
    this.contactRing.visible = false

    // LINE 2: the object ball's line, starting at the object ball surface along the line of centres.
    this.setRibbon(
      this.aimRibbon2,
      tableX(guide.contact.x + guide.lineOfCentres.x * (2 * BALL_RADIUS)),
      tableZ(guide.contact.y + guide.lineOfCentres.y * (2 * BALL_RADIUS)),
      Math.atan2(guide.lineOfCentres.y, guide.lineOfCentres.x),
      AIM_LINE2_LENGTH,
      AIM_LINE2_WIDTH
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
          AIM_LINE3_LENGTH,
          AIM_LINE3_WIDTH
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
   * Asks for one of the two views the player controls: the camera behind the cue ball, or
   * the overhead one. Nothing is cut — the rig eases between them — so this can be called
   * as often as the button is pressed.
   */
  setCameraMode(mode: 'AIM' | 'TOP_DOWN'): void {
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
    this.latch = addOrbit(this.latch, delta)
  }

  /** The view the camera is being asked for, for the toggle to reflect. */
  currentCameraMode(): 'AIM' | 'TOP_DOWN' {
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
    } else {
      this.rig = stepCameraRig(
        this.rig,
        {
          mode: this.tracking ? 'TRACK' : this.placementViewHeld ? 'PLACEMENT_TOP_DOWN' : this.cameraMode,
          aspect: this.cvw / Math.max(1, this.cvh),
          cue,
          aimAngle: this.lastAimAngle,
          latch: this.latch,
          focus: count > 0 ? { x: sumX / count, y: sumY / count, spread } : null
        },
        dt
      )
    }
    const pose = this.rig.pose
    this.camera.position.set(tableX(pose.x), pose.height, tableZ(pose.y))
    this.camera.lookAt(tableX(pose.lookX), pose.lookHeight, tableZ(pose.lookY))
    if (this.camera.fov !== pose.fov) {
      this.camera.fov = pose.fov
      this.camera.updateProjectionMatrix()
    }
  }

  render(): void {
    const now = performance.now()
    const dt = Math.min(0.05, (now - this.lastTime) / 1000)
    this.lastTime = now
    if (dt > 0) {
      // A streamed shot hands over positions that are already sampled from the
      // simulation, so they are applied as-is instead of being smoothed again.
      const k = this.immediate ? 1 : 1 - Math.exp(-dt * 14)
      for (const rig of this.balls.values()) {
        if (rig.group.visible && !rig.sinking && !rig.rising) rig.group.position.lerp(rig.target, k)
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
  }
}