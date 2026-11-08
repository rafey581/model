import { describe, expect, it } from 'vitest'
import { QUALITY_TIERS, isSharpTier, lowerQualityTier, qualityTierForSignals } from './qualityConfig.js'

const desktop = { mobileUA: false, cores: 8, memGb: 8, dpr: 2, smallScreen: false, weakGpu: false }

describe('the quality ladder', () => {
  it('keeps a phone off Ultra', () => {
    expect(qualityTierForSignals({ ...desktop, mobileUA: true, cores: 8, memGb: 8 })).toBe('medium')
    expect(qualityTierForSignals({ ...desktop, mobileUA: true, cores: 4, memGb: 2 })).toBe('low')
  })

  it('keeps a software or integrated GPU on Medium', () => {
    expect(qualityTierForSignals({ ...desktop, weakGpu: true })).toBe('medium')
  })

  it('gives a strong discrete desktop Ultra and a smaller one High', () => {
    expect(qualityTierForSignals(desktop)).toBe('ultra')
    expect(qualityTierForSignals({ ...desktop, cores: 6, memGb: 16 })).toBe('high')
  })
})

describe('Ultra', () => {
  it('draws rounder balls without raising the pixel budget above High', () => {
    const high = QUALITY_TIERS.high
    const ultra = QUALITY_TIERS.ultra
    expect(ultra.ballSegments[0]).toBeGreaterThan(high.ballSegments[0])
    expect(ultra.ballSegments[1]).toBeGreaterThan(high.ballSegments[1])
    expect(ultra.renderScale).toBe(high.renderScale)
    expect(ultra.shadowMapSize).toBe(high.shadowMapSize)
    expect(ultra.shadowMapSize).toBeLessThanOrEqual(2048)
    expect(ultra.anisotropy).toBeLessThanOrEqual(16)
    expect(ultra.fpsCap).toBe(60)
    expect(ultra.antialias).toBe(true)
    expect(isSharpTier('ultra')).toBe(true)
    expect(isSharpTier('medium')).toBe(false)
  })

  it('steps down to High, not off the table', () => {
    expect(lowerQualityTier('ultra')).toBe('high')
    expect(lowerQualityTier('low')).toBeNull()
  })
})
