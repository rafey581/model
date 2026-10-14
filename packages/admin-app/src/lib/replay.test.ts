import { describe, expect, it } from 'vitest'
import { ballColor, collectShots, eventLabel, frameAt, type ReplayEvent } from './replay'

const shot = { aimAngle: 0, power: 0.2, spin: { x: 0, y: 0 } }

const events: ReplayEvent[] = [
  { seq: 1, type: 'SHOT', data: { byIndex: 0, shot } },
  { seq: 2, type: 'BALL_POTTED', data: { ballId: 1 } },
  { seq: 3, type: 'FOUL', data: { byIndex: 1, penalty: 4 } },
  { seq: 4, type: 'SHOT', data: { byIndex: 1, shot } }
]

describe('collectShots', () => {
  it('keeps only SHOT events that carry a shot', () => {
    const shots = collectShots(events)
    expect(shots).toHaveLength(2)
    expect(shots[0]).toMatchObject({ seq: 1, byIndex: 0 })
    expect(shots[1]).toMatchObject({ seq: 4, byIndex: 1 })
  })

  it('ignores a SHOT event with no payload', () => {
    expect(collectShots([{ seq: 1, type: 'SHOT', data: {} }])).toHaveLength(0)
  })

  it('handles an empty log', () => {
    expect(collectShots([])).toHaveLength(0)
  })
})

describe('ballColor', () => {
  it('uses the cue colour for the cue ball', () => {
    expect(ballColor(0)).toBe('#f0e6d6')
  })

  it('falls back to a neutral colour for an unknown id', () => {
    expect(ballColor(9999)).toBe('#888')
  })
})

describe('frameAt', () => {
  it('returns null when there is nothing to replay', () => {
    expect(frameAt([], 0)).toBeNull()
    expect(frameAt([{ seq: 1, type: 'BALL_POTTED', data: {} }], 0)).toBeNull()
  })

  it('reports the stroke window and clamps the step to the last stroke', () => {
    const first = frameAt(events, 0)
    expect(first?.index).toBe(0)
    expect(first?.total).toBe(2)
    expect(first?.startSeq).toBe(1)
    expect(first?.endSeq).toBe(4)

    const last = frameAt(events, 99)
    expect(last?.index).toBe(1)
    expect(last?.endSeq).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('eventLabel', () => {
  it('summarises the events an admin cares about', () => {
    expect(eventLabel({ seq: 1, type: 'FOUL', data: { byIndex: 1, penalty: 4 } })).toBe('player 1 foul (+4)')
    expect(eventLabel({ seq: 2, type: 'BALL_POTTED', data: { ballId: 1 } })).toBe('pot red')
    expect(eventLabel({ seq: 3, type: 'FRAME_END', data: { winnerIndex: 0 } })).toBe('frame won by player 0')
  })

  it('falls back to a raw dump for unknown events', () => {
    expect(eventLabel({ seq: 1, type: 'MYSTERY', data: { a: 1 } })).toBe('MYSTERY {"a":1}')
  })
})
