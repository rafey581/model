import * as THREE from 'three'
import { qualityConfig } from './qualityConfig.js'

/**
 * The cue. One build, used for the player's own stick and for the opponent's, so the two
 * are the same object at the same quality and nobody is playing with the better cue.
 *
 * A traditional hand-spliced snooker cue: a straight-grained ash shaft with its dark
 * growth-line chevrons, tapering from a 9.5mm tip out to the joint; an ebony butt let into
 * the ash in four long points, each outlined by a thin coloured veneer; a brass ferrule
 * under a domed leather tip, chalked blue; a brass ring at the joint and another above a
 * rubber bumper at the butt end.
 *
 * Built along the group's own +Y with the tip uppermost. The striking face of the tip sits
 * at `CUE_TIP_Y` and the bumper ends at `CUE_BUTT_Y`, the same two heights the stick this
 * replaces was built to, so whatever placed that one places this one.
 */

/** Height of the tip's striking face above the group's origin, in millimetres. */
export const CUE_TIP_Y = 641
/** Height of the end of the butt. Negative: the origin is partway down the shaft. */
export const CUE_BUTT_Y = -848
/** The cue's whole length, tip to bumper. */
export const CUE_LENGTH = CUE_TIP_Y - CUE_BUTT_Y

const TIP_LENGTH = 9
const FERRULE_LENGTH = 24
/** Where the ash ends and the spliced butt begins. */
const SPLICE_Y = -400
const BUMPER_LENGTH = 12
const TIP_RADIUS = 4.9
const FERRULE_RADIUS = 5.3
const SPLICE_RADIUS = 11.4
const BUTT_RADIUS = 14.6

const ASH: [number, number, number] = [226, 192, 138]
const ASH_GRAIN: [number, number, number] = [150, 108, 62]
const EBONY: [number, number, number] = [26, 17, 13]
const VENEER = ['#c9a23a', '#7a1f1c']

export interface CueStick {
  /** The cue, along +Y, tip up. Hidden parts and placement are the caller's business. */
  group: THREE.Group
  dispose(): void
}

const textures = new Map<string, THREE.CanvasTexture>()

function cached(key: string, make: () => HTMLCanvasElement): THREE.CanvasTexture {
  let texture = textures.get(key)
  if (!texture) {
    texture = new THREE.CanvasTexture(make())
    texture.colorSpace = THREE.SRGBColorSpace
    texture.wrapS = THREE.RepeatWrapping
    texture.anisotropy = qualityConfig().anisotropy
    textures.set(key, texture)
  }
  return texture
}

/** A fixed pseudo-random stream, so the grain is the same cue on every load. */
function stream(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
}

const rgb = (c: [number, number, number], a = 1): string => `rgba(${c[0]},${c[1]},${c[2]},${a})`

/**
 * Lays straight ash grain into a canvas region: fine fibres running the length of the cue,
 * and the open dark growth lines that make ash look like ash.
 *
 * The canvas wraps round the cue (x is the way round, y is along it), so every mark is
 * drawn at x and again one width over: the seam at the back of the cue has no join in it.
 */
function paintAsh(ctx: CanvasRenderingContext2D, w: number, top: number, bottom: number, seed: number): void {
  const rand = stream(seed)
  const h = bottom - top
  ctx.fillStyle = rgb(ASH)
  ctx.fillRect(0, top, w, h)
  // Broad tone drift round the shaft: no board is one colour all the way round.
  for (let i = 0; i < 5; i++) {
    const x = rand() * w
    const band = ctx.createLinearGradient(x - 30, 0, x + 30, 0)
    const dark = rand() > 0.5
    band.addColorStop(0, 'rgba(0,0,0,0)')
    band.addColorStop(0.5, dark ? 'rgba(96,60,24,0.16)' : 'rgba(255,240,205,0.16)')
    band.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = band
    for (const dx of [-w, 0, w]) {
      ctx.save()
      ctx.translate(dx, 0)
      ctx.fillRect(x - 30, top, 60, h)
      ctx.restore()
    }
  }
  // Fibres: many faint hairlines the length of the shaft.
  for (let i = 0; i < 260; i++) {
    const x = rand() * w
    const y = top + rand() * h
    const len = 30 + rand() * 180
    ctx.strokeStyle = rand() > 0.45 ? rgb(ASH_GRAIN, 0.1 + rand() * 0.16) : `rgba(255,244,214,${0.08 + rand() * 0.1})`
    ctx.lineWidth = 0.6 + rand() * 0.7
    for (const dx of [-w, 0, w]) {
      ctx.beginPath()
      ctx.moveTo(x + dx, y)
      ctx.lineTo(x + dx + (rand() - 0.5) * 1.5, Math.min(bottom, y + len))
      ctx.stroke()
    }
  }
  // Growth lines: the dark, open-pored chevrons. A stack of shallow arrowheads down one
  // face of the shaft, which is how a flat-sawn ash board shows its rings.
  const face = w * 0.5
  const spacing = 34
  for (let y = top - 20; y < bottom + 20; y += spacing * (0.7 + rand() * 0.7)) {
    const reach = 60 + rand() * 46
    const depth = 46 + rand() * 40
    ctx.strokeStyle = rgb(ASH_GRAIN, 0.42 + rand() * 0.25)
    ctx.lineWidth = 1 + rand() * 1.1
    for (const dx of [-w, 0, w]) {
      ctx.beginPath()
      ctx.moveTo(face + dx - reach, y + depth)
      ctx.quadraticCurveTo(face + dx - reach * 0.25, y + depth * 0.2, face + dx, y)
      ctx.quadraticCurveTo(face + dx + reach * 0.25, y + depth * 0.2, face + dx + reach, y + depth)
      ctx.stroke()
    }
  }
}

function shaftCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 1024
  const ctx = canvas.getContext('2d')!
  paintAsh(ctx, canvas.width, 0, canvas.height, 9041)
  return canvas
}

/**
 * The butt: ash at the top carrying on from the shaft, ebony below, and four ebony points
 * running up into the ash, each edged with two thin veneers.
 */
function buttCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  const w = (canvas.width = 256)
  const h = (canvas.height = 512)
  const ctx = canvas.getContext('2d')!
  paintAsh(ctx, w, 0, h, 5113)

  const points = 4
  const pitch = w / points
  /** Where the points start, and where the ebony is solid all the way round. */
  const apexY = h * 0.06
  const solidY = h * 0.62
  const drawPoints = (inset: number, fill: string): void => {
    ctx.fillStyle = fill
    for (let i = -1; i <= points; i++) {
      const cx = i * pitch + pitch / 2
      ctx.beginPath()
      ctx.moveTo(cx, apexY + inset * 5)
      ctx.lineTo(cx + pitch / 2 - inset * 0.2, solidY)
      ctx.lineTo(cx - pitch / 2 + inset * 0.2, solidY)
      ctx.closePath()
      ctx.fill()
    }
  }
  // Outside in: two veneers, then the ebony itself.
  drawPoints(0, VENEER[0]!)
  drawPoints(2.2, VENEER[1]!)
  drawPoints(4.4, rgb(EBONY))
  ctx.fillStyle = rgb(EBONY)
  ctx.fillRect(0, solidY - 1, w, h - solidY + 1)

  // Ebony is not flat black: a faint lengthwise figure, so the lacquer has something to show.
  const rand = stream(771)
  for (let i = 0; i < 90; i++) {
    const x = rand() * w
    const y = solidY * 0.5 + rand() * (h - solidY * 0.5)
    ctx.strokeStyle = `rgba(120,84,60,${0.05 + rand() * 0.09})`
    ctx.lineWidth = 0.7
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + (rand() - 0.5), y + 20 + rand() * 90)
    ctx.stroke()
  }
  return canvas
}

/** A cylinder along +Y from `fromY` up to `toY`, `bottom` radius at the lower end. */
function section(
  fromY: number,
  toY: number,
  bottom: number,
  top: number,
  material: THREE.Material,
  radial: number
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(top, bottom, toY - fromY, radial, 1), material)
  mesh.position.y = (fromY + toY) / 2
  // The cue moves and the lamp's shadow map is baked once, so it never casts into it.
  mesh.castShadow = false
  return mesh
}

export function buildCueStick(): CueStick {
  const low = qualityConfig().name === 'low'
  const radial = low ? 12 : 22
  const lacquer = low ? 0 : 0.75

  const shaftMat = new THREE.MeshPhysicalMaterial({
    map: cached('cue-shaft', shaftCanvas),
    roughness: 0.36,
    metalness: 0,
    clearcoat: lacquer,
    clearcoatRoughness: 0.18,
    envMapIntensity: 0.7
  })
  const buttMat = new THREE.MeshPhysicalMaterial({
    map: cached('cue-butt', buttCanvas),
    roughness: 0.3,
    metalness: 0,
    clearcoat: lacquer,
    clearcoatRoughness: 0.1,
    envMapIntensity: 0.9
  })
  const brassMat = new THREE.MeshStandardMaterial({ color: 0xd9b25a, roughness: 0.24, metalness: 0.95, envMapIntensity: 1.3 })
  const tipMat = new THREE.MeshStandardMaterial({ color: 0x4f86c6, roughness: 0.96, metalness: 0 })
  const rubberMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.85, metalness: 0 })

  const ferruleTop = CUE_TIP_Y - TIP_LENGTH
  const shaftTop = ferruleTop - FERRULE_LENGTH
  const buttBottom = CUE_BUTT_Y + BUMPER_LENGTH

  const tip = section(ferruleTop, CUE_TIP_Y - 2.4, FERRULE_RADIUS - 0.1, TIP_RADIUS, tipMat, radial)
  // The crown of the tip: a shallow dome, the shape a tip is filed to.
  const crown = new THREE.Mesh(new THREE.SphereGeometry(TIP_RADIUS, radial, 6, 0, Math.PI * 2, 0, Math.PI / 2), tipMat)
  crown.scale.y = 2.4 / TIP_RADIUS
  crown.position.y = CUE_TIP_Y - 2.4
  crown.castShadow = false
  const ferrule = section(shaftTop, ferruleTop, FERRULE_RADIUS + 0.2, FERRULE_RADIUS, brassMat, radial)
  const shaft = section(SPLICE_Y, shaftTop, SPLICE_RADIUS, FERRULE_RADIUS + 0.2, shaftMat, radial)
  const joint = section(SPLICE_Y - 5, SPLICE_Y + 5, SPLICE_RADIUS + 0.5, SPLICE_RADIUS + 0.4, brassMat, radial)
  const butt = section(buttBottom + 8, SPLICE_Y - 5, BUTT_RADIUS, SPLICE_RADIUS + 0.1, buttMat, radial)
  const endRing = section(buttBottom, buttBottom + 8, BUTT_RADIUS + 0.4, BUTT_RADIUS + 0.4, brassMat, radial)
  const bumper = section(CUE_BUTT_Y, buttBottom, BUTT_RADIUS - 2.2, BUTT_RADIUS - 0.4, rubberMat, radial)

  const group = new THREE.Group()
  group.name = 'cue-stick'
  const parts = [tip, crown, ferrule, shaft, joint, butt, endRing, bumper]
  group.add(...parts)

  return {
    group,
    dispose(): void {
      for (const part of parts) {
        part.geometry.dispose()
        part.parent?.remove(part)
      }
      for (const material of [shaftMat, buttMat, brassMat, tipMat, rubberMat]) material.dispose()
    }
  }
}
