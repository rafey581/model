import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { BALL_RADIUS } from '@snooker/shared'
import {
  CUE_BALL_CLEARCOAT,
  CUE_BALL_CLEARCOAT_ROUGHNESS,
  CUE_BALL_COLOR,
  CUE_BALL_ENV_MAP_INTENSITY,
  CUE_BALL_IOR,
  CUE_BALL_METALNESS,
  CUE_BALL_ROUGHNESS,
  CUE_BALL_SPECULAR_INTENSITY,
  CUE_SHADOW_OFFSET_MM,
  CUE_SHADOW_PEAK_ALPHA,
  CUE_SHADOW_PLANE,
  CUE_SHADOW_STRETCH,
  CUE_SHADOW_TEXTURE_SIZE,
  CUE_SHADOW_Y_MM,
  createCueBallMaterial,
  cueShadowAlpha,
  cueShadowPixels
} from './ballVisuals.js'
import { BallRig } from './scene3d.js'

/** The shared phenolic look every coloured ball keeps, as built by {@link BallRig}. */
const SHARED = {
  roughness: 0.05,
  clearcoat: 1.0,
  clearcoatRoughness: 0.02,
  envMapIntensity: 1.0,
  ior: 1.5
} as const

const fakeShadow = (): THREE.CanvasTexture => new THREE.Texture() as THREE.CanvasTexture

describe('cue ball material', () => {
  it('carries the specified lacquer values', () => {
    const material = createCueBallMaterial()
    expect(material.color.getHex()).toBe(CUE_BALL_COLOR)
    expect(material.roughness).toBe(CUE_BALL_ROUGHNESS)
    expect(material.metalness).toBe(CUE_BALL_METALNESS)
    expect(material.clearcoat).toBe(CUE_BALL_CLEARCOAT)
    expect(material.clearcoatRoughness).toBe(CUE_BALL_CLEARCOAT_ROUGHNESS)
    expect(material.specularIntensity).toBe(CUE_BALL_SPECULAR_INTENSITY)
    expect(material.envMapIntensity).toBe(CUE_BALL_ENV_MAP_INTENSITY)
    expect(material.ior).toBe(CUE_BALL_IOR)
    expect(material.emissive.getHex()).toBe(0x000000)
  })

  it('is warm cream, not white', () => {
    const { r, g, b } = createCueBallMaterial().color
    expect(r).toBeLessThan(1)
    expect(b).toBeLessThan(g)
    expect(g).toBeLessThan(r)
  })

  it('is a fresh instance every time, so no two balls can share one', () => {
    const a = createCueBallMaterial()
    const b = createCueBallMaterial()
    expect(a).not.toBe(b)
    a.emissive.setHex(0x7a5c10)
    expect(b.emissive.getHex()).toBe(0x000000)
  })
})

describe('BallRig material wiring', () => {
  it('gives the cue rig the cue ball material', () => {
    const rig = new BallRig(BALL_RADIUS, 0xffffff, fakeShadow(), { cue: true })
    expect(rig.material.color.getHex()).toBe(CUE_BALL_COLOR)
    expect(rig.material.roughness).toBe(CUE_BALL_ROUGHNESS)
    expect(rig.material.clearcoatRoughness).toBe(CUE_BALL_CLEARCOAT_ROUGHNESS)
    expect(rig.material.envMapIntensity).toBe(CUE_BALL_ENV_MAP_INTENSITY)
  })

  it('leaves the coloured balls on the shared phenolic material', () => {
    const rig = new BallRig(BALL_RADIUS, 0xd91515, fakeShadow())
    expect(rig.material.roughness).toBe(SHARED.roughness)
    expect(rig.material.clearcoat).toBe(SHARED.clearcoat)
    expect(rig.material.clearcoatRoughness).toBe(SHARED.clearcoatRoughness)
    expect(rig.material.envMapIntensity).toBe(SHARED.envMapIntensity)
    expect(rig.material.ior).toBe(SHARED.ior)
    expect(rig.material.color.getHex()).toBe(0xd91515)
  })

  it('never shares a material instance between two rigs', () => {
    const cue = new BallRig(BALL_RADIUS, 0xffffff, fakeShadow(), { cue: true })
    const red = new BallRig(BALL_RADIUS, 0xd91515, fakeShadow())
    expect(cue.material).not.toBe(red.material)
    cue.material.emissive.setHex(0x7a5c10)
    expect(red.material.emissive.getHex()).toBe(0x000000)
    red.material.roughness = 0.9
    expect(cue.material.roughness).toBe(CUE_BALL_ROUGHNESS)
  })
})

describe('cue ball contact shadow', () => {
  it('peaks in the 0.55-0.75 band a grounded contact shadow reads at', () => {
    expect(CUE_SHADOW_PEAK_ALPHA).toBeGreaterThanOrEqual(0.55)
    expect(CUE_SHADOW_PEAK_ALPHA).toBeLessThanOrEqual(0.75)
    expect(cueShadowAlpha(0)).toBe(CUE_SHADOW_PEAK_ALPHA)
  })

  it('falls off monotonically to nothing at the rim', () => {
    let previous = cueShadowAlpha(0)
    for (let frac = 0.05; frac <= 1; frac += 0.05) {
      const alpha = cueShadowAlpha(frac)
      expect(alpha).toBeLessThanOrEqual(previous)
      expect(alpha).toBeGreaterThanOrEqual(0)
      previous = alpha
    }
    expect(cueShadowAlpha(1)).toBe(0)
    expect(cueShadowAlpha(1.4)).toBe(0)
  })

  it('paints a black 128x128 disc whose centre clears 50% opacity', () => {
    const size = CUE_SHADOW_TEXTURE_SIZE
    const pixels = cueShadowPixels()
    expect(size).toBe(128)
    expect(pixels.length).toBe(size * size * 4)

    const at = (x: number, y: number): number => pixels[(y * size + x) * 4 + 3] ?? -1
    const centre = at(size / 2, size / 2)
    expect(Math.abs(centre - Math.round(255 * CUE_SHADOW_PEAK_ALPHA))).toBeLessThanOrEqual(1)
    expect(centre).toBeGreaterThan(255 * 0.5)
    // Corners are outside the disc; the mid-radius is a soft half-step, not a ring edge.
    expect(at(0, 0)).toBe(0)
    expect(at(size - 1, size - 1)).toBe(0)
    expect(at(size / 2 + size / 4, size / 2)).toBeLessThan(centre)
    expect(at(size / 2 + size / 4, size / 2)).toBeGreaterThan(0)
    // Every pixel is black: the shadow is attenuation only, never a tint.
    let tinted = 0
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] !== 0 || pixels[i + 1] !== 0 || pixels[i + 2] !== 0) tinted++
    }
    expect(tinted).toBe(0)
  })

  it('gives the cue rig a disc 1.4x the ball width, its own material and texture', () => {
    const cueTex = fakeShadow()
    const cue = new BallRig(BALL_RADIUS, 0xffffff, cueTex, { cue: true, shadowTex: cueTex, shadowPlane: CUE_SHADOW_PLANE })
    const red = new BallRig(BALL_RADIUS, 0xd91515, fakeShadow())

    const cuePlane = (cue.blob.geometry as THREE.PlaneGeometry).parameters.width
    expect(cuePlane).toBeCloseTo(BALL_RADIUS * CUE_SHADOW_PLANE, 9)
    expect(cuePlane / (2 * BALL_RADIUS)).toBeCloseTo(1.4, 6)

    const cueBlob = cue.blob.material as THREE.MeshBasicMaterial
    const redBlob = red.blob.material as THREE.MeshBasicMaterial
    expect(cueBlob).not.toBe(redBlob)
    expect(cueBlob.map).toBe(cueTex)
    expect(cueBlob.color.getHex()).toBe(0x000000)
    expect(cueBlob.transparent).toBe(true)
    expect(cueBlob.depthWrite).toBe(false)
  })

  it('sits the cue disc 1mm off the cloth, leaning 5mm and stretched 1.15', () => {
    const cue = new BallRig(BALL_RADIUS, 0xffffff, fakeShadow(), { cue: true })
    cue.aim(600, 0, false, true)
    const worldY = cue.group.position.y + cue.blob.position.y
    expect(worldY).toBeCloseTo(CUE_SHADOW_Y_MM, 9)
    expect(CUE_SHADOW_Y_MM).toBe(1)
    expect(Math.hypot(cue.blob.position.x, cue.blob.position.z)).toBeCloseTo(CUE_SHADOW_OFFSET_MM, 9)
    expect(cue.blob.scale.x).toBe(CUE_SHADOW_STRETCH)
    expect(cue.blob.parent).toBe(cue.group)
  })

  it('leaves the coloured balls on their original grounding', () => {
    const red = new BallRig(BALL_RADIUS, 0xd91515, fakeShadow())
    red.aim(600, 0, false, true)
    expect(red.group.position.y + red.blob.position.y).toBeCloseTo(0.5, 9)
    expect(Math.hypot(red.blob.position.x, red.blob.position.z)).toBeCloseTo(4.5, 9)
    expect(red.blob.scale.x).toBeCloseTo(1.16, 9)
  })
})
