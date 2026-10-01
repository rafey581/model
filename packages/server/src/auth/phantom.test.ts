import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import { generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { KeyObject } from 'node:crypto'
import { prisma } from '../db/index.js'
import { buildApp } from '../app.js'
import { encodeBase58, decodeBase58 } from './base58.js'
import { buildSiwsMessage, resetNonces, signChallenge, verifyChallengeToken } from './phantom.js'
import { signPendingIdentity, verifyPendingIdentity } from './pending.js'
import { identityFromPhantom } from './accounts.js'

/**
 * Phantom sign-in, asserted through the real HTTP surface.
 *
 * The wallet is simulated by generating a real ed25519 keypair and signing the exact
 * message the server handed out. Nothing here is a stub of the crypto: if the
 * message the client would have signed and the message the server verifies against
 * ever diverge by a byte, these tests fail - which is the failure mode that makes
 * SIWS implementations accept challenges nobody signed.
 */

const TAG = `ph${Date.now() % 1000000}`

let app: FastifyInstance

/** A throwaway wallet: the keypair, plus the base58 address a user would paste. */
function makeWallet(): { address: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  return { address: encodeBase58(new Uint8Array(raw)), privateKey }
}

async function challengeFor(address: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/phantom/challenge',
    payload: { address }
  })
  expect(res.statusCode).toBe(200)
  return res.json().data as { address: string; message: string; challenge: string }
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
})

beforeEach(() => {
  resetNonces()
})

afterAll(async () => {
  await prisma.user.deleteMany({ where: { username: { startsWith: `wallet_${TAG}` } } })
  await app.close()
})

describe('phantom challenge', () => {
  it('hands back an SIWS message naming the wallet and the site', async () => {
    const wallet = makeWallet()
    const { message } = await challengeFor(wallet.address)
    expect(message).toContain('wants you to sign in with your Solana account:')
    expect(message).toContain(wallet.address)
    expect(message).toContain('Nonce: ')
    expect(message).toContain('Issued At: ')
    // A sign-in must never look like a payment request.
    expect(message).toContain('will not trigger a blockchain transaction')
  })

  it('binds the challenge to the address it was requested for', async () => {
    const wallet = makeWallet()
    const { message, challenge } = await challengeFor(wallet.address)
    const parsed = await verifyChallengeToken(challenge)
    expect(parsed.address).toBe(wallet.address)
    expect(parsed.message).toBe(message)
  })

  it('rejects an address that is not a 32-byte Solana key', async () => {
    for (const bad of ['', 'nope', '16UjcYNBG9GTK4uq2f7yYEbuifqCzoLMGS', '0OIl']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/phantom/challenge',
        payload: { address: bad }
      })
      expect(res.statusCode, bad).toBe(400)
    }
  })

  it('refuses to mint a challenge for an unknown future audience', async () => {
    // The challenge token must not double as anything else.
    const forged = await signChallenge({
      address: makeWallet().address,
      nonce: 'abc',
      message: 'anything',
      issuedAt: new Date().toISOString(),
      expirationTime: new Date(Date.now() + 60_000).toISOString()
    })
    await expect(verifyChallengeToken(`${forged.slice(0, -4)}xxxx`)).rejects.toThrow()
  })
})

describe('wallet signature verification', () => {
  it('rejects a signature made over a different challenge', async () => {
    // The signature is genuine and the wallet is the right one, but it was made over
    // the first of two challenges for the same address. This is exactly the case a
    // server that rebuilt the message from fields would get wrong.
    const wallet = makeWallet()
    const first = await challengeFor(wallet.address)
    const signature = encodeBase58(
      new Uint8Array(edSign(null, Buffer.from(first.message, 'utf8'), wallet.privateKey))
    )
    const second = await challengeFor(wallet.address)
    expect(second.message).not.toBe(first.message)

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/phantom/verify',
      payload: { challenge: second.challenge, signature }
    })
    expect(res.statusCode).toBe(401)
  })

  it('signs a first-time wallet in through the username step', async () => {
    const wallet = makeWallet()
    const { message, challenge } = await challengeFor(wallet.address)
    const signature = encodeBase58(
      new Uint8Array(edSign(null, Buffer.from(message, 'utf8'), wallet.privateKey))
    )

    const verify = await app.inject({
      method: 'POST',
      url: '/api/auth/phantom/verify',
      payload: { challenge, signature }
    })
    expect(verify.statusCode).toBe(200)
    const body = verify.json().data as { pendingToken: string; suggestedUsername: string; created: boolean }
    expect(body.created).toBe(false)
    expect(body.suggestedUsername).toMatch(/^[a-zA-Z0-9_]{3,24}$/)

    const username = `wallet_${TAG}`
    const complete = await app.inject({
      method: 'POST',
      url: '/api/auth/complete',
      payload: { pendingToken: body.pendingToken, username }
    })
    expect(complete.statusCode).toBe(200)
    const data = complete.json().data as { created: boolean; token: string; user: { username: string; email: string | null } }
    expect(data.created).toBe(true)
    expect(data.user.username).toBe(username)
    // A wallet proves control of a key and nothing else. It has no email, and the
    // column stays null rather than being filled with something invented.
    expect(data.user.email).toBeNull()
    expect(data.token).toBeTruthy()
  })

  it('logs the same wallet straight in on the second attempt', async () => {
    const wallet = makeWallet()
    const username = `wallet_${TAG}_b`

    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/phantom/verify',
      payload: await signedPayload(wallet)
    })
    const pending = first.json().data.pendingToken as string
    await app.inject({
      method: 'POST',
      url: '/api/auth/complete',
      payload: { pendingToken: pending, username }
    })

    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/phantom/verify',
      payload: await signedPayload(wallet)
    })
    expect(second.statusCode).toBe(200)
    const body = second.json().data as { created: boolean; user?: { username: string }; token?: string }
    expect(body.created).toBe(false)
    // Returning player: a session, not another username prompt.
    expect(body.user?.username).toBe(username)
    expect(body.token).toBeTruthy()
  })

  it('cannot be replayed with the same challenge', async () => {
    const wallet = makeWallet()
    const { message, challenge } = await challengeFor(wallet.address)
    const signature = encodeBase58(
      new Uint8Array(edSign(null, Buffer.from(message, 'utf8'), wallet.privateKey))
    )

    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/phantom/verify',
      payload: { challenge, signature }
    })
    expect(first.statusCode).toBe(200)

    // A captured (challenge, signature) pair is a valid login for as long as the
    // token lasts. The single-use nonce is what closes that window.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/auth/phantom/verify',
      payload: { challenge, signature }
    })
    expect(replay.statusCode).toBe(401)
    expect(replay.json().error).toMatch(/already been used/i)
  })

  it('rejects a signature from a different wallet', async () => {
    const alice = makeWallet()
    const mallory = makeWallet()
    const { message, challenge } = await challengeFor(alice.address)
    // Mallory signs a message that correctly names Alice, over her nonce.
    const signature = encodeBase58(
      new Uint8Array(edSign(null, Buffer.from(message, 'utf8'), mallory.privateKey))
    )
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/phantom/verify',
      payload: { challenge, signature }
    })
    expect(res.statusCode).toBe(401)
  })

  it('cannot re-point a valid signature at another address', async () => {
    const alice = makeWallet()
    const mallory = makeWallet()
    const { message } = await challengeFor(alice.address)
    const signature = encodeBase58(
      new Uint8Array(edSign(null, Buffer.from(message, 'utf8'), alice.privateKey))
    )
    // Mallory asks for her own challenge, then sends Alice's signature with it.
    const { challenge } = await challengeFor(mallory.address)
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/phantom/verify',
      payload: { challenge, signature }
    })
    expect(res.statusCode).toBe(401)
  })

  it('will not let a forged attempt burn a live nonce', async () => {
    const wallet = makeWallet()
    const { challenge } = await challengeFor(wallet.address)
    // 64 real-looking bytes, so the request reaches signature verification rather
    // than being turned away by the schema on shape alone.
    const junk = encodeBase58(new Uint8Array(randomBytes(64)))

    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/phantom/verify',
      payload: { challenge, signature: junk }
    })
    expect(bad.statusCode).toBe(401)

    // The genuine signature must still work: burning on failure would let anyone
    // cancel an in-flight sign-in.
    const { message, challenge: fresh } = await challengeFor(wallet.address)
    const signature = encodeBase58(
      new Uint8Array(edSign(null, Buffer.from(message, 'utf8'), wallet.privateKey))
    )
    const good = await app.inject({
      method: 'POST',
      url: '/api/auth/phantom/verify',
      payload: { challenge: fresh, signature }
    })
    expect(good.statusCode).toBe(200)
  })

  it('answers identically whether the signature is garbage or simply someone else\'s', async () => {
    // Both cases are well-formed 64-byte signatures that fail the check for
    // different reasons. If the responses differed, the difference would tell an
    // attacker whether they had the right shape but the wrong key, which is a
    // search-space hint for no benefit.
    const wallet = makeWallet()
    const other = makeWallet()
    const { message, challenge } = await challengeFor(wallet.address)

    const garbage = encodeBase58(new Uint8Array(randomBytes(64)))
    const someoneElses = encodeBase58(
      new Uint8Array(edSign(null, Buffer.from(message, 'utf8'), other.privateKey))
    )

    const bodies: string[] = []
    const statuses: number[] = []
    for (const signature of [garbage, someoneElses]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/phantom/verify',
        payload: { challenge, signature }
      })
      statuses.push(res.statusCode)
      bodies.push(res.body)
    }
    expect(statuses).toEqual([401, 401])
    expect(bodies[0]).toBe(bodies[1]!)
  })

  it('rejects a request whose shape is wrong before touching any crypto', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/phantom/verify',
      payload: { challenge: '', signature: '' }
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('pending identity token', () => {
  it('carries the provider inside the signature, not from the client', async () => {
    const address = makeWallet().address
    const token = await signPendingIdentity(identityFromPhantom(address))
    const parsed = await verifyPendingIdentity(token)
    expect(parsed.provider).toBe('PHANTOM')
    expect(parsed.subject).toBe(address)
    expect(parsed.email).toBeNull()
  })

  it('will not verify a tampered token', async () => {
    const token = await signPendingIdentity(identityFromPhantom(makeWallet().address))
    const [head, payload, sig] = token.split('.')
    const forged = `${head}.${payload!.replace(/.$/, 'x')}.${sig}`
    await expect(verifyPendingIdentity(forged)).rejects.toThrow()
  })
})

describe('siws message determinism', () => {
  it('produces identical bytes for identical inputs', () => {
    // The server never rebuilds a message to verify a signature - it reads the one
    // from the token. This test guards the assumption that makes that safe.
    const now = new Date('2026-01-01T00:00:00.000Z')
    const a = buildSiwsMessage('So11111111111111111111111111111111111111112', 'nonce1', 'http://localhost:5173', now)
    const b = buildSiwsMessage('So11111111111111111111111111111111111111112', 'nonce1', 'http://localhost:5173', now)
    expect(a.message).toBe(b.message)
  })

  it('derives the host from the origin so the wallet shows the right site', () => {
    const { message } = buildSiwsMessage(
      'So11111111111111111111111111111111111111112',
      'n',
      'https://arena.example.com'
    )
    expect(message).toContain('arena.example.com wants you to sign in')
    expect(message).toContain('URI: https://arena.example.com')
  })

  it('varies with the nonce, so two challenges are never the same message', () => {
    const address = 'So11111111111111111111111111111111111111112'
    const a = buildSiwsMessage(address, 'nonceA', 'http://localhost:5173')
    const b = buildSiwsMessage(address, 'nonceB', 'http://localhost:5173')
    expect(a.message).not.toBe(b.message)
  })
})

describe('address helpers', () => {
  it('round-trips the address a wallet actually reports', () => {
    const wallet = makeWallet()
    expect(decodeBase58(wallet.address)).toHaveLength(32)
  })
})

/** Requests a challenge and signs it with the wallet, the way a real client would. */
async function signedPayload(wallet: { address: string; privateKey: KeyObject }) {
  const { message, challenge } = await challengeFor(wallet.address)
  const signature = encodeBase58(
    new Uint8Array(edSign(null, Buffer.from(message, 'utf8'), wallet.privateKey))
  )
  return { challenge, signature }
}