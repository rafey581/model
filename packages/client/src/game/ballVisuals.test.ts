import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { BALL_RADIUS } from '@snooker/shared'
import {
  COLOURED_BALL_CLEARCOAT,
  COLOURED_BALL_CLEARCOAT_ROUGHNESS,
  COLOURED_BALL_ENV_MAP_INTENSITY,
  COLOURED_BALL_IOR,
  COLOURED_BALL_ROUGHNESS,
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
  createColouredBallMaterial,
  createCueBallMaterial,
  cueBallAlbedoPixels,
  cueShadowAlpha,
  cueShadowPixels
} from './ballVisuals.js'
import { BallRig } from './scene3d.js'

const fakeShadow = (): THREE.CanvasTexture => new THREE.Texture() as THREE.CanvasTexture

describe('cue ball material', () => {
  it('carries the specified lacquer values', () => {
    const material = createCueBallMaterial()
    // Albedo lives in the spin-dot map; material.color stays white as the map multiplier.
    expect(CUE_BALL_COLOR).toBe(0xf4f0e4)
    expect(material.color.getHex()).toBe(0xffffff)
    expect(material.map).toBeTruthy()
    expect(material.roughness).toBe(CUE_BALL_ROUGHNESS)
    expect(material.metalness).toBe(CUE_BALL_METALNESS)
    expect(material.clearcoat).toBeGreaterThan(0)
    expect(material.clearcoatRoughness).toBe(CUE_BALL_CLEARCOAT_ROUGHNESS)
    expect(material.specularIntensity).toBe(CUE_BALL_SPECULAR_INTENSITY)
    expect(material.envMapIntensity).toBeGreaterThan(0)
    expect(material.ior).toBe(CUE_BALL_IOR)
    expect(material.emissive.getHex()).toBe(0x000000)
    expect(CUE_BALL_CLEARCOAT).toBeGreaterThan(0.8)
    expect(CUE_BALL_ENV_MAP_INTENSITY).toBeGreaterThan(0.5)
  })

  it('bakes warm cream with red spin dots into the albedo map', () => {
    const data = cueBallAlbedoPixels(128)
    let redish = 0
    let cream = 0
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!
      const g = data[i + 1]!
      const b = data[i + 2]!
      // Soft radial blend keeps some green in the discs; require a clear red bias.
      if (r > g + 40 && r > b + 40 && r > 140) redish++
      if (r > 220 && g > 210 && b > 190) cream++
    }
    expect(cream).toBeGreaterThan(1000)
    expect(redish).toBeGreaterThan(50)
    expect(createCueBallMaterial().map).toBeInstanceOf(THREE.DataTexture)
  })

  it('is a fresh instance every time, so no two balls can share one', () => {
    const a = createCueBallMaterial()
    const b = createCueBallMaterial()
    expect(a).not.toBe(b)
    a.emissive.setHex(0x7a5c10)
    expect(b.emissive.getHex()).toBe(0x000000)
  })
})

describe('coloured ball material', () => {
  it('uses the shared phenolic lacquer', () => {
    const material = createColouredBallMaterial(0xd91515)
    expect(material.color.getHex()).toBe(0xd91515)
    expect(material.roughness).toBe(COLOURED_BALL_ROUGHNESS)
    expect(material.clearcoat).toBeGreaterThan(0)
    expect(material.clearcoatRoughness).toBe(COLOURED_BALL_CLEARCOAT_ROUGHNESS)
    expect(material.envMapIntensity).toBeGreaterThan(0)
    expect(material.ior).toBe(COLOURED_BALL_IOR)
    expect(COLOURED_BALL_CLEARCOAT).toBe(1)
    expect(COLOURED_BALL_ENV_MAP_INTENSITY).toBe(1)
  })
})

describe('BallRig material wiring', () => {
  it('gives the cue rig the cue ball material', () => {
    const rig = new BallRig(BALL_RADIUS, 0xffffff, fakeShadow(), { cue: true })
    expect(rig.material.map).toBeTruthy()
    expect(rig.material.roughness).toBe(CUE_BALL_ROUGHNESS)
    expect(rig.material.clearcoatRoughness).toBe(CUE_BALL_CLEARCOAT_ROUGHNESS)
    expect(rig.material.envMapIntensity).toBeGreaterThan(0)
    expect(rig.material.clearcoat).toBeGreaterThan(0)
  })

  it('leaves the coloured balls on the shared phenolic material', () => {
    const rig = new BallRig(BALL_RADIUS, 0xd91515, fakeShadow())
    expect(rig.material.roughness).toBe(COLOURED_BALL_ROUGHNESS)
    expect(rig.material.clearcoat).toBeGreaterThan(0)
    expect(rig.material.clearcoatRoughness).toBe(COLOURED_BALL_CLEARCOAT_ROUGHNESS)
    expect(rig.material.envMapIntensity).toBeGreaterThan(0)
    expect(rig.material.ior).toBe(COLOURED_BALL_IOR)
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

  it('rolls the sphere when the ball translates across the cloth', () => {
    const cue = new BallRig(BALL_RADIUS, 0xffffff, fakeShadow(), { cue: true })
    cue.aim(0, 0, false, true)
    cue.group.position.set(0, BALL_RADIUS, 0)
    cue.stepRoll()
    const before = cue.sphere.quaternion.clone()
    cue.group.position.set(BALL_RADIUS * Math.PI, BALL_RADIUS, 0)
    cue.stepRoll()
    expect(cue.sphere.quaternion.equals(before)).toBe(false)
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
    expect(at(0, 0)).toBe(0)
    expect(at(size - 1, size - 1)).toBe(0)
    expect(at(size / 2 + size / 4, size / 2)).toBeLessThan(centre)
    expect(at(size / 2 + size / 4, size / 2)).toBeGreaterThan(0)
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

  it('sits the cue disc just off the cloth, leaning and stretched', () => {
    const cue = new BallRig(BALL_RADIUS, 0xffffff, fakeShadow(), { cue: true })
    cue.aim(600, 0, false, true)
    const worldY = cue.group.position.y + cue.blob.position.y
    expect(worldY).toBeCloseTo(CUE_SHADOW_Y_MM, 9)
    expect(CUE_SHADOW_Y_MM).toBe(0.8)
    expect(Math.hypot(cue.blob.position.x, cue.blob.position.z)).toBeCloseTo(CUE_SHADOW_OFFSET_MM, 9)
    expect(cue.blob.scale.x).toBe(CUE_SHADOW_STRETCH)
    expect(cue.blob.parent).toBe(cue.group)
  })

  it('leaves the coloured balls on their retuned grounding', () => {
    const red = new BallRig(BALL_RADIUS, 0xd91515, fakeShadow())
    red.aim(600, 0, false, true)
    expect(red.group.position.y + red.blob.position.y).toBeCloseTo(0.5, 9)
    expect(Math.hypot(red.blob.position.x, red.blob.position.z)).toBeCloseTo(2.5, 9)
    expect(red.blob.scale.x).toBeCloseTo(1.15, 9)
  })
})
