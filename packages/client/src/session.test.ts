import { describe, expect, it } from 'vitest'
import { isUnreachable } from './session.js'

describe('isUnreachable', () => {
  it('reads a failed fetch as an unreachable server', () => {
    expect(isUnreachable(new TypeError('Failed to fetch'))).toBe(true)
    expect(isUnreachable(new Error('NetworkError when attempting to fetch resource.'))).toBe(true)
  })

  it('does not read a refusal from the server as unreachable', () => {
    expect(isUnreachable(new Error('invalid credentials'))).toBe(false)
    expect(isUnreachable(null)).toBe(false)
  })
})
