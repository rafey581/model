import { describe, expect, it } from 'vitest'
import { STAKE_TIERS, matchTypeForStake, stakeTierById, stakesForTable } from './constants.js'

describe('stake tables', () => {
  it('keeps the original open stakes and adds 20, 50 and 100', () => {
    expect(stakesForTable('OPEN').map((tier) => tier.usdt)).toEqual([1, 5, 10, 20, 50, 100])
  })

  it('offers Master Match at 500 through 5000', () => {
    expect(stakesForTable('MASTER').map((tier) => tier.usdt)).toEqual([500, 1000, 2000, 3000, 5000])
    for (const tier of stakesForTable('MASTER')) {
      expect(tier.id.startsWith('MASTER_')).toBe(true)
      expect(matchTypeForStake(tier.id)).toBe('MASTER')
    }
  })

  it('does not treat an open table as a master match', () => {
    expect(matchTypeForStake('TIER_1')).toBe('ONE_V_ONE')
    expect(matchTypeForStake('TIER_100')).toBe('ONE_V_ONE')
    expect(matchTypeForStake('nope')).toBe('ONE_V_ONE')
    expect(stakeTierById('MASTER_1000')?.usdt).toBe(1000)
  })

  it('lists every tier once', () => {
    const ids = STAKE_TIERS.map((tier) => tier.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(STAKE_TIERS.every((tier) => tier.label.endsWith('USDT'))).toBe(true)
  })
})
