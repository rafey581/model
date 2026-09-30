import { describe, expect, it } from 'vitest'
import type { FrameSnapshotData } from './renderer.js'
import { frameForHud } from './hudFrame.js'

const frame = (overrides: Partial<FrameSnapshotData> = {}): FrameSnapshotData =>
  ({
    turnIndex: 0,
    ballOn: 'RED',
    scores: { player0: 0, player1: 0 },
    breakScore: 0,
    remainingReds: 15,
    balls: [],
    ...overrides
  }) as FrameSnapshotData

describe('the frame the HUD is allowed to describe', () => {
  it('follows the server when no replay is running', () => {
    const settled = frame({ scores: { player0: 34, player1: 12 } })
    expect(frameForHud({ replayRunning: false, shown: frame(), authoritative: settled })).toBe(settled)
  })

  it('keeps the frame the replay started from while the replay is on screen', () => {
    // The snapshot that lands with a shot already has that shot's points in it. Holding
    // it back is the whole point: the score must not move while the balls are rolling.
    const before = frame({ scores: { player0: 34, player1: 12 }, remainingReds: 6 })
    const after = frame({ scores: { player0: 41, player1: 12 }, remainingReds: 5 })
    const shown = frameForHud({ replayRunning: true, shown: before, authoritative: after })
    expect(shown).toBe(before)
    expect(shown?.scores.player0).toBe(34)
    expect(shown?.remainingReds).toBe(6)
  })

  it('catches up the moment the replay ends, and takes the whole shot with it', () => {
    // One settled shot: the points, the reds left and the ball on all arrive together,
    // because they are all consequences of the shot the player has now watched.
    const before = frame({ scores: { player0: 34, player1: 12 }, remainingReds: 6 })
    const after = frame({ scores: { player0: 41, player1: 19 }, remainingReds: 5, ballOn: 'BLACK' })
    const shown = frameForHud({ replayRunning: false, shown: before, authoritative: after })
    expect(shown?.scores).toEqual({ player0: 41, player1: 19 })
    expect(shown?.remainingReds).toBe(5)
    expect(shown?.ballOn).toBe('BLACK')
  })

  it('holds a foul penalty back as firmly as a pot', () => {
    const before = frame({ scores: { player0: 34, player1: 0 } })
    const fouled = frame({ scores: { player0: 34, player1: 4 } })
    expect(frameForHud({ replayRunning: true, shown: before, authoritative: fouled })?.scores.player1).toBe(0)
  })

  it('does not lose the shown frame when the authoritative one is still absent', () => {
    const before = frame()
    expect(frameForHud({ replayRunning: true, shown: before, authoritative: null })).toBe(before)
    expect(frameForHud({ replayRunning: false, shown: before, authoritative: null })).toBeNull()
  })

  it('has nothing to show before the first snapshot', () => {
    expect(frameForHud({ replayRunning: false, shown: null, authoritative: null })).toBeNull()
  })
})