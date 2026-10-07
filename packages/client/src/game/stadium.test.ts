import { describe, expect, it } from 'vitest'
import { APRON_OUTER_L, APRON_OUTER_W } from './tableGeometry.js'
import { ARENA_CONFIG, resolveArenaBudget, type ArenaQuality } from './arenaConfig.js'
import { arenaSeatPlacements, seatRows } from './arenaEnvironment.js'

const QUALITIES: ArenaQuality[] = ['low', 'medium', 'high']

/** Half the diagonal of the table's apron: the smallest circle that contains it. */
const APRON_HYPOT = Math.hypot(APRON_OUTER_L / 2, APRON_OUTER_W / 2)

/** The bank the config lays out, whatever the budget ends up allowing of it. */
const BANK = ARENA_CONFIG.bowl.tiers[0]!

describe('the bowl plan', () => {
  it('lays the bank out from the boards, stepping back and up by the same amount each row', () => {
    const rows = seatRows(ARENA_CONFIG, resolveArenaBudget('high'))
    expect(rows.length).toBe(BANK.rows)

    const firstRadius = ARENA_CONFIG.bowl.innerRadius + ARENA_CONFIG.bowl.firstRowInset
    rows.forEach((row, i) => {
      expect(row.radius).toBeCloseTo(firstRadius + i * BANK.rowPitch, 6)
      expect(row.y).toBeCloseTo(ARENA_CONFIG.bowl.firstRowLift + i * BANK.rowRise, 6)
      if (i > 0) {
        expect(row.radius).toBeGreaterThan(rows[i - 1]!.radius)
        expect(row.y).toBeGreaterThan(rows[i - 1]!.y)
      }
    })
  })

  it('takes fewer rows as the quality falls, and never more than the bank holds', () => {
    const counts = QUALITIES.map((quality) => {
      const budget = resolveArenaBudget(quality)
      return seatRows(ARENA_CONFIG, budget).length
    })

    expect(counts[0]).toBe(Math.min(BANK.rows, resolveArenaBudget('low').rows))
    expect(counts[1]).toBe(Math.min(BANK.rows, resolveArenaBudget('medium').rows))
    expect(counts[2]).toBe(Math.min(BANK.rows, resolveArenaBudget('high').rows))
    expect(counts[0]!).toBeLessThan(counts[1]!)
    expect(counts[1]!).toBeLessThan(counts[2]!)
  })

  it('keeps the front of the bowl outside the table apron', () => {
    for (const quality of QUALITIES) {
      const rows = seatRows(ARENA_CONFIG, resolveArenaBudget(quality))
      const first = rows[0]!
      expect(first.radius - first.pitch / 2).toBeGreaterThan(APRON_HYPOT)
    }
  })

  it('leaves a walk between the boards and the front row', () => {
    const rows = seatRows(ARENA_CONFIG, resolveArenaBudget('high'))
    const first = rows[0]!
    const walk = first.radius - first.pitch / 2 - ARENA_CONFIG.bowl.innerRadius
    expect(walk).toBeGreaterThanOrEqual(500)
  })

  it('keeps every seat pitch wider than a seat', () => {
    for (const quality of QUALITIES) {
      const budget = resolveArenaBudget(quality)
      expect(budget.seatPitch).toBeGreaterThan(ARENA_CONFIG.seats.width)
    }
  })
})

describe('the seat plan', () => {
  it('stands every seat clear of the apron and inside the bank', () => {
    const budget = resolveArenaBudget('high')
    const rows = seatRows(ARENA_CONFIG, budget)
    const plan = arenaSeatPlacements(ARENA_CONFIG, budget, rows)

    expect(plan.length).toBeGreaterThan(0)
    const outer = rows[rows.length - 1]!
    for (const seat of plan) {
      const radius = Math.hypot(seat.x, seat.z)
      expect(radius).toBeGreaterThan(APRON_HYPOT)
      expect(radius).toBeLessThanOrEqual(outer.radius + outer.pitch / 2)
    }
  })

  it('fills every row of the bank', () => {
    const budget = resolveArenaBudget('high')
    const rows = seatRows(ARENA_CONFIG, budget)
    const plan = arenaSeatPlacements(ARENA_CONFIG, budget, rows)

    for (const row of rows) {
      const onRow = plan.filter((seat) => Math.hypot(seat.x, seat.z) - row.radius < 1 && seat.y === row.y)
      expect(onRow.length).toBeGreaterThan(0)
    }
  })

  it('stays inside the frame budget on the largest plan', () => {
    const budget = resolveArenaBudget('high')
    const plan = arenaSeatPlacements(ARENA_CONFIG, budget, seatRows(ARENA_CONFIG, budget))
    // One instanced mesh draws them all, so what the chairs cost is triangles: 36 a chair,
    // and the whole bowl has to leave the rest of the arena its 40k.
    expect(plan.length).toBeLessThanOrEqual(700)
    expect(plan.length * 36).toBeLessThanOrEqual(25200)
  })
})
