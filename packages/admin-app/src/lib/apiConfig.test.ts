import { describe, expect, it } from 'vitest'
import { DEFAULT_API_BASE, hostFromUri, resolveApiBaseUrl, stripTrailingSlashes } from './apiConfig'

describe('stripTrailingSlashes', () => {
  it('removes one or many trailing slashes', () => {
    expect(stripTrailingSlashes('http://x:4000/api/')).toBe('http://x:4000/api')
    expect(stripTrailingSlashes('http://x:4000/api///')).toBe('http://x:4000/api')
  })

  it('leaves a clean url alone', () => {
    expect(stripTrailingSlashes('http://x:4000/api')).toBe('http://x:4000/api')
  })
})

describe('hostFromUri', () => {
  it('takes the host and drops the port', () => {
    expect(hostFromUri('192.168.1.10:8081')).toBe('192.168.1.10')
  })

  it('handles a bare host', () => {
    expect(hostFromUri('localhost')).toBe('localhost')
  })

  it('returns null for empty or missing input', () => {
    expect(hostFromUri(null)).toBeNull()
    expect(hostFromUri(undefined)).toBeNull()
    expect(hostFromUri('')).toBeNull()
    expect(hostFromUri('   ')).toBeNull()
  })
})

describe('resolveApiBaseUrl', () => {
  it('prefers an explicit override, trimmed of trailing slashes', () => {
    expect(resolveApiBaseUrl('https://api.example.com/api/', '192.168.1.10')).toBe('https://api.example.com/api')
  })

  it('treats blank or whitespace overrides as absent', () => {
    expect(resolveApiBaseUrl('   ', '192.168.1.10')).toBe('http://192.168.1.10:4000/api')
    expect(resolveApiBaseUrl('', null)).toBe(DEFAULT_API_BASE)
    expect(resolveApiBaseUrl(undefined, null)).toBe(DEFAULT_API_BASE)
  })

  it('falls back to the dev host on the server port', () => {
    expect(resolveApiBaseUrl(undefined, '192.168.1.10')).toBe('http://192.168.1.10:4000/api')
  })

  it('falls back to localhost when there is no dev host', () => {
    expect(resolveApiBaseUrl(null, null)).toBe('http://localhost:4000/api')
  })
})
