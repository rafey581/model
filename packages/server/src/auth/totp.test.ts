import { describe, expect, it } from 'vitest'
import { base32Decode, base32Encode, currentCode, generateSecret, otpauthUri, verifyCode } from './totp.js'

/**
 * The RFC 6238 appendix B vectors for HMAC-SHA1.
 *
 * Worth pinning to the spec rather than to our own output: a TOTP that is
 * self-consistent but subtly wrong (wrong counter width, no dynamic truncation)
 * would still pass a round-trip test and still reject every real code.
 */
const RFC_SECRET_ASCII = '12345678901234567890'

describe('totp', () => {
  it('base32 round-trips', () => {
    const buf = Buffer.from('snooker-arena-secret')
    expect(base32Decode(base32Encode(buf)).toString('hex')).toBe(buf.toString('hex'))
  })

  it('matches the RFC 6238 SHA-1 vectors', () => {
    const secret = base32Encode(Buffer.from(RFC_SECRET_ASCII))
    const vectors: Array<[number, string]> = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130']
    ]
    for (const [seconds, expected] of vectors) {
      expect(currentCode(secret, seconds * 1000), `T=${seconds}`).toBe(expected)
    }
  })

  it('verifies a live code and rejects a wrong one', () => {
    const secret = generateSecret()
    const now = Date.now()
    expect(verifyCode(secret, currentCode(secret, now), now)).toBe(true)
    expect(verifyCode(secret, '000000', now)).toBe(false)
    expect(verifyCode(secret, 'not-a-code', now)).toBe(false)
    expect(verifyCode(secret, '', now)).toBe(false)
  })

  it('tolerates one step of clock drift either way, and no more', () => {
    const secret = generateSecret()
    const now = Date.now()
    expect(verifyCode(secret, currentCode(secret, now - 30_000), now)).toBe(true)
    expect(verifyCode(secret, currentCode(secret, now + 30_000), now)).toBe(true)
    expect(verifyCode(secret, currentCode(secret, now + 120_000), now)).toBe(false)
  })

  it('rejects another secret\'s code', () => {
    const a = generateSecret()
    const b = generateSecret()
    const now = Date.now()
    expect(verifyCode(a, currentCode(b, now), now)).toBe(false)
  })

  it('builds a scannable otpauth uri', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'admin@snooker.test', 'Snooker Arena')
    expect(uri).toContain('otpauth://totp/')
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP')
    expect(uri).toContain('issuer=Snooker%20Arena')
    expect(uri).toContain('digits=6')
    expect(uri).toContain('period=30')
  })
})
