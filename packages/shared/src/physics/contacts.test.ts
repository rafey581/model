import { describe, expect, it } from 'vitest'
import { MAX_CUE_SPEED, TABLE_LENGTH, TABLE_WIDTH } from '../constants.js'
import { layoutTableBalls } from './layout.js'
import { simulateStroke } from './world.js'

/**
 * The contacts recorded for the client's sound effects.
 *
 * The one thing that matters most here is the first test: recording them changes nothing.
 * The simulation with a replay asked for and the simulation without are the same shot.
 */

const breakOff = { aimAngle: 0.02, power: 0.85, spin: { x: 0, y: 0 } }

describe('contacts recorded for the sounds', () => {
  it('does not change the shot: with and without a replay, every ball ends in the same place', () => {
    const plain = simulateStroke(layoutTableBalls(), breakOff)
    const recorded = simulateStroke(layoutTableBalls(), breakOff, { playback: { rate: 30 } })
    expect(recorded.balls).toEqual(plain.balls)
    expect(recorded.events).toEqual(plain.events)
    expect(recorded.pottedIds).toEqual(plain.pottedIds)
    expect(recorded.firstContactId).toBe(plain.firstContactId)
    expect(recorded.simSeconds).toBe(plain.simSeconds)
    expect(recorded.ticksUsed).toBe(plain.ticksUsed)
  })

  it('is only there when a replay was asked for', () => {
    expect(simulateStroke(layoutTableBalls(), breakOff).contacts).toBeUndefined()
    expect(simulateStroke(layoutTableBalls(), breakOff, { playback: {} }).contacts).toBeDefined()
  })

  it('records a break as ball contacts and cushion contacts, in order, on the table, at believable speeds', () => {
    const { contacts, simSeconds } = simulateStroke(layoutTableBalls(), breakOff, { playback: { rate: 30 } })
    expect(contacts!.length).toBeGreaterThan(10)
    // A couple of hundred at most: resting and creeping contacts are not recorded.
    expect(contacts!.length).toBeLessThan(600)
    expect(contacts!.some((c) => c[0] === 0)).toBe(true)
    expect(contacts!.some((c) => c[0] === 1)).toBe(true)
    let previous = 0
    for (const [kind, t, idA, idB, speed, x, y] of contacts!) {
      expect([0, 1, 2]).toContain(kind)
      expect(t).toBeGreaterThanOrEqual(previous)
      expect(t).toBeLessThanOrEqual(simSeconds + 0.01)
      previous = t
      expect(speed).toBeGreaterThan(0)
      // Two balls closing head-on cannot beat twice the fastest a ball can be sent.
      expect(speed).toBeLessThanOrEqual(MAX_CUE_SPEED * 2)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(TABLE_LENGTH)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(TABLE_WIDTH)
      expect(Number.isInteger(idA)).toBe(true)
      expect(Number.isInteger(idB)).toBe(true)
      if (kind === 0) expect(idA).not.toBe(idB)
    }
  })

  it('makes the first contact the cue ball arriving at the pack, at about the pace it was sent', () => {
    const { contacts, firstContactId } = simulateStroke(layoutTableBalls(), breakOff, { playback: { rate: 30 } })
    const first = contacts!.find((c) => c[0] === 0)!
    expect([first[2], first[3]]).toContain(0)
    expect([first[2], first[3]]).toContain(firstContactId)
    // Slowed by the cloth on the way down the table, but still most of the launch speed.
    expect(first[4]).toBeGreaterThan(MAX_CUE_SPEED * breakOff.power * 0.3)
    expect(first[4]).toBeLessThanOrEqual(MAX_CUE_SPEED * breakOff.power)
  })

  it('records nothing for a shot that touches nothing', () => {
    const balls = layoutTableBalls().filter((b) => b.isCue)
    const { contacts } = simulateStroke(balls, { aimAngle: 0, power: 0.01, spin: { x: 0, y: 0 } }, { playback: {} })
    expect(contacts).toEqual([])
  })
})
