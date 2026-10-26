import { cueStartPosition } from '@snooker/shared'
import { describe, expect, it } from 'vitest'
import { GUEST_STAKE_PROMPT, isGuestAccount, isUnreachable, LOCAL_GUEST_ID } from './guest.js'
import { freshLocalFrame, placeLocalCue, robotShot, strokeLocal } from './game/localPractice.js'

describe('guest play', () => {
  it('uses the stake prompt and treats a guest account as a guest', () => {
    expect(GUEST_STAKE_PROMPT).toBe('Sign up to play for stakes')
    expect(isGuestAccount({ id: 'abc', authProvider: 'GUEST' })).toBe(true)
    expect(isGuestAccount({ id: LOCAL_GUEST_ID })).toBe(true)
    expect(isGuestAccount({ id: 'abc', authProvider: 'PASSWORD' })).toBe(false)
    expect(isUnreachable(new TypeError('Failed to fetch'))).toBe(true)
    expect(isUnreachable(new Error(GUEST_STAKE_PROMPT))).toBe(false)
  })

  it('plays a local stroke with keyframes and can place the cue ball', () => {
    const frame = freshLocalFrame()
    const spot = cueStartPosition()
    const placed = placeLocalCue(frame, { x: spot.x, y: spot.y })
    expect(placed.ok).toBe(true)
    expect(placed.frame.cueInHand).toBe(false)
    const shot = robotShot(frame)
    expect(Number.isFinite(shot.aimAngle)).toBe(true)
    const played = strokeLocal(frame, 0, shot)
    expect(played.playback?.keyframes.length ?? 0).toBeGreaterThan(0)
  })
})
