import { describe, expect, it } from 'vitest'
import { foreignMatchRooms, matchIdFromRoom } from './matchRooms.js'

describe('leaving match rooms that are not the one on screen', () => {
  const joined = ['socket-1', 'user:alice', 'match:practice-1', 'match:practice-2']

  it('keeps the match being entered and drops every other match room', () => {
    expect(foreignMatchRooms(joined, 'practice-2')).toEqual(['match:practice-1'])
    expect(matchIdFromRoom('match:practice-1')).toBe('practice-1')
  })

  it('drops every match room when the player is no longer in one', () => {
    expect(foreignMatchRooms(joined, null)).toEqual(['match:practice-1', 'match:practice-2'])
  })

  it('ignores the personal rooms socket.io keeps beside the match', () => {
    expect(foreignMatchRooms(['socket-1', 'user:alice'], 'practice-2')).toEqual([])
  })
})
