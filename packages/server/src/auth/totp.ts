import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * TOTP (RFC 6238) over HMAC-SHA1 - the algorithm every authenticator app speaks.
 *
 * Hand-rolled rather than pulled from npm deliberately: this is the second factor
 * guarding the admin panel, and the surface is small enough (base32 + HMAC + a
 * counter) to read end to end. It also keeps the admin security story auditable
 * from one file instead of spread across a transitive dependency tree.
 *
 * SHA-1 is not a weakness here. TOTP's security does not come from the hash being
 * collision resistant; it comes from the HMAC key never leaving the server and the
 * code being valid for 30 seconds. SHA-1 is the default in the RFC because that is
 * what authenticator apps shipped with.
 */

const DIGITS = 6
const PERIOD_SEC = 30
// Accepts one step either side of now. Without the negative step a phone whose
// clock runs slightly fast locks the owner out on roughly one attempt in three.
const WINDOW = 1

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buffer: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char)
    if (idx === -1) throw new Error('invalid base32 character')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes))
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', secret).update(buf).digest()
  // Dynamic truncation (RFC 4226 §5.4).
  const offset = digest[digest.length - 1]! & 0x0f
  const bin =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff)
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0')
}

export function currentCode(secret: string, atMs = Date.now()): string {
  return hotp(base32Decode(secret), Math.floor(atMs / 1000 / PERIOD_SEC))
}

/**
 * Verifies a submitted code.
 *
 * The candidate codes are compared one at a time with a constant-time compare and
 * the loop stops at the first match, so a valid code in an earlier window cannot be
 * learned from response timing.
 */
export function verifyCode(secret: string, code: string, atMs = Date.now()): boolean {
  const trimmed = code.trim()
  if (!/^\d{6}$/.test(trimmed)) return false
  const secretBuf = base32Decode(secret)
  const counter = Math.floor(atMs / 1000 / PERIOD_SEC)
  for (let drift = -WINDOW; drift <= WINDOW; drift += 1) {
    const expected = hotp(secretBuf, counter + drift)
    const a = Buffer.from(expected)
    const b = Buffer.from(trimmed)
    if (a.length === b.length && timingSafeEqual(a, b)) return true
  }
  return false
}

/**
 * The provisioning URI an authenticator app scans.
 *
 * `issuer` and the label both carry the product name because several apps show the
 * issuer in the account list, and an entry that only says "Snooker Arena - admin"
 * with no issuer is genuinely confusing when you have several entries.
 */
export function otpauthUri(secret: string, accountName: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`)
  return (
    `otpauth://totp/${label}` +
    `?secret=${secret}` +
    `&issuer=${encodeURIComponent(issuer)}` +
    `&algorithm=SHA1` +
    `&digits=${DIGITS}` +
    `&period=${PERIOD_SEC}`
  )
}
