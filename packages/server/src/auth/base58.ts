/**
 * Base58 (Bitcoin alphabet), the encoding Solana uses for addresses and signatures.
 *
 * Hand-rolled rather than pulled from `bs58` so the auth path depends on nothing
 * but Node's own crypto. It is a small, fully testable piece of arithmetic, and the
 * test suite pins it to the reference `bs58` implementation's own vectors - so
 * "hand-rolled" is verified rather than assumed.
 */

/** Bitcoin's alphabet. Deliberately excludes 0, O, I and l, which are ambiguous. */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

const INDEX: Record<string, number> = {}
for (let i = 0; i < ALPHABET.length; i += 1) INDEX[ALPHABET[i]!] = i

export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''

  // Repeated division of the big-endian number by 58, collecting remainders.
  // A copy is made because `digits` is mutated and the caller may still need
  // `bytes` - and because a Uint8Array view onto a larger buffer must not be
  // written through.
  const digits: number[] = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j]! << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }

  let out = ''
  // Every leading zero byte is a leading '1' in base58, because 0 has no
  // representation otherwise. The run stops one short of the full length so the
  // digit loop below still emits the final element - without that cap, an all-zero
  // input (32 zero bytes is the Solana System Program address) comes out one
  // character too long.
  const zeros = leadingZeroCount(bytes)
  for (let i = 0; i < zeros; i += 1) out += ALPHABET[0]
  for (let i = digits.length - 1; i >= 0; i -= 1) out += ALPHABET[digits[i]!]
  return out
}

function leadingZeroCount(bytes: Uint8Array): number {
  let n = 0
  while (n < bytes.length - 1 && bytes[n] === 0) n += 1
  return n
}

export class Base58Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Base58Error'
  }
}

/**
 * Decodes to a Buffer.
 *
 * Rejects rather than skipping any character outside the alphabet. A lenient
 * decoder that quietly dropped an invalid character would let a mistyped address
 * decode to a *different valid* public key, which in a signature check means
 * checking a signature against the wrong key.
 */
export function decodeBase58(input: string): Buffer {
  if (input.length === 0) return Buffer.alloc(0)

  const bytes: number[] = [0]
  for (const char of input) {
    const value = INDEX[char]
    if (value === undefined) {
      throw new Base58Error(`invalid base58 character: ${JSON.stringify(char)}`)
    }
    let carry = value
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j]! * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }

  // Same one-short-of-the-run rule as encode, so the two are exact inverses for
  // inputs that are entirely zero bytes.
  let leadingZeros = 0
  while (leadingZeros < input.length - 1 && input[leadingZeros] === ALPHABET[0]) leadingZeros += 1

  return Buffer.from([...new Array<number>(leadingZeros).fill(0), ...bytes.reverse()])
}

/** A Solana address is exactly 32 bytes, so 32-44 base58 characters. */
export const SOLANA_ADDRESS_BYTES = 32

export function isValidSolanaAddress(address: string): boolean {
  if (address.length < 32 || address.length > 44) return false
  try {
    return decodeBase58(address).length === SOLANA_ADDRESS_BYTES
  } catch {
    return false
  }
}

/** An ed25519 signature is exactly 64 bytes, so ~86-88 base58 characters. */
export const ED25519_SIGNATURE_BYTES = 64

export function isValidSignature(signature: string): boolean {
  if (signature.length < 86 || signature.length > 88) return false
  try {
    return decodeBase58(signature).length === ED25519_SIGNATURE_BYTES
  } catch {
    return false
  }
}
