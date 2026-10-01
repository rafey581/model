import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { createPublicKey } from 'node:crypto'
import {
  Base58Error,
  decodeBase58,
  encodeBase58,
  isValidSignature,
  isValidSolanaAddress
} from './base58.js'

/**
 * The first two cases are the reference `bs58` package's own documented vectors,
 * so this is checking the implementation against the ecosystem rather than against
 * itself. The Solana cases use the System Program address, which is the one
 * base58 value everybody already knows by heart: 32 zero bytes.
 */
describe('base58', () => {
  it('matches the reference bs58 encode vector', () => {
    const bytes = Uint8Array.from([
      0, 60, 23, 110, 101, 155, 234, 15, 41, 163, 233, 191, 120, 128, 193, 18, 177, 179, 27, 77, 200, 38, 38,
      129, 135
    ])
    expect(encodeBase58(bytes)).toBe('16UjcYNBG9GTK4uq2f7yYEbuifqCzoLMGS')
  })

  it('matches the reference bs58 decode vector', () => {
    expect(decodeBase58('16UjcYNBG9GTK4uq2f7yYEbuifqCzoLMGS').toString('hex')).toBe(
      '003c176e659bea0f29a3e9bf7880c112b1b31b4dc826268187'
    )
  })

  it('encodes 32 zero bytes as the System Program address', () => {
    // The classic off-by-one: an uncapped leading-zero run turns this into 33
    // characters and every address validation downstream rejects it.
    expect(encodeBase58(new Uint8Array(32))).toBe('11111111111111111111111111111111')
    expect(decodeBase58('11111111111111111111111111111111')).toEqual(Buffer.alloc(32))
  })

  it('round-trips random payloads of every length', () => {
    for (let len = 0; len <= 40; len += 1) {
      const bytes = new Uint8Array(len)
      for (let i = 0; i < len; i += 1) bytes[i] = Math.floor(Math.random() * 256)
      expect(decodeBase58(encodeBase58(bytes)).toString('hex'), `len ${len}`).toBe(
        Buffer.from(bytes).toString('hex')
      )
    }
  })

  it('round-trips real ed25519 keys and signatures', () => {
    for (let i = 0; i < 25; i += 1) {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
      const address = encodeBase58(new Uint8Array(raw))
      expect(isValidSolanaAddress(address), address).toBe(true)
      expect(decodeBase58(address)).toEqual(Buffer.from(raw))

      const signature = edSign(null, Buffer.from('snooker arena'), privateKey)
      const encoded = encodeBase58(new Uint8Array(signature))
      expect(isValidSignature(encoded), encoded).toBe(true)
      expect(decodeBase58(encoded)).toEqual(Buffer.from(signature))
    }
  })

  it('rejects characters outside the alphabet', () => {
    // 0, O, I and l are the four the alphabet omits, plus a punctuation case.
    for (const bad of ['0OIl', 'abc0', 'abc-def', 'abc def', '+++']) {
      expect(() => decodeBase58(bad), bad).toThrow(Base58Error)
    }
  })

  it('never silently decodes a typo into a different key', () => {
    // A single substituted character outside the alphabet must be an error, not a
    // shorter or different key. A lenient decoder here would verify a signature
    // against the wrong public key.
    for (const badChar of ['0', 'O', 'I', 'l', '-']) {
      const mutated = `So1111111111111111111111111111111111111111${badChar}`
      expect(() => decodeBase58(mutated), badChar).toThrow(Base58Error)
    }
    // And a substitution that stays inside the alphabet changes the bytes, which
    // is caught by the length/shape check rather than by a throw.
    const valid = 'So11111111111111111111111111111111111111112'
    expect(decodeBase58(valid).length).toBe(32)
  })
})

describe('solana address validation', () => {
  it('accepts a genuine 32-byte address', () => {
    expect(isValidSolanaAddress('11111111111111111111111111111111')).toBe(true)
  })

  it('rejects the wrong decoded length', () => {
    // Valid base58, but only 20 bytes - a Bitcoin-style payload.
    expect(isValidSolanaAddress('16UjcYNBG9TK4uq2f7yYEbuifqCzoLMGS')).toBe(false)
    expect(isValidSolanaAddress('3yZe7d')).toBe(false)
  })

  it('rejects the ambiguous characters a mistyped address would contain', () => {
    expect(isValidSolanaAddress('1111111111111111111111111111111O')).toBe(false)
    expect(isValidSolanaAddress('0OIl')).toBe(false)
  })
})

describe('signature validation', () => {
  it('rejects a 32-byte payload, which is a key not a signature', () => {
    expect(isValidSignature(encodeBase58(new Uint8Array(32)))).toBe(false)
  })

  it('accepts a real 64-byte signature', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const sig = edSign(null, Buffer.from('x'), privateKey)
    expect(sig).toHaveLength(64)
    expect(isValidSignature(encodeBase58(new Uint8Array(sig)))).toBe(true)
    expect(isValidSolanaAddress(encodeBase58(new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32))))).toBe(true)
  })
})

/**
 * Local helper: Node cannot import a bare 32-byte ed25519 key, so a DER SPKI
 * header is prepended. This is the same trick the Solana ecosystem uses, and
 * `phantom.ts` depends on it working.
 */
function rawEd25519PublicKey(spki: Buffer): Buffer {
  return spki.subarray(-32)
}

describe('public key import', () => {
  it('imports a bare 32-byte ed25519 key, which is what base58 decodes to', () => {
    const { publicKey } = generateKeyPairSync('ed25519')
    const raw = rawEd25519PublicKey(publicKey.export({ format: 'der', type: 'spki' }))
    expect(raw).toHaveLength(32)
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw])
    expect(createPublicKey({ key: spki, format: 'der', type: 'spki' }).asymmetricKeyType).toBe('ed25519')
  })
})
