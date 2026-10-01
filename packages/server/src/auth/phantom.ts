import { createPublicKey, randomBytes, verify as edVerify, createHash } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { config } from '../config.js'
import { decodeBase58, encodeBase58, isValidSignature, isValidSolanaAddress } from './base58.js'

/**
 * Sign In With Solana (SIWS) for Phantom.
 *
 * A wallet proves control of an address by signing a message with its private
 * key. Nothing is sent to us except the signature, so the whole of the security
 * rests on two things: the message must be one *we* chose (so a signature harvested
 * for some other purpose cannot be replayed here), and the signature must be
 * checked against the address being claimed.
 *
 * The design decision that matters: **the server generates the message and stores
 * it inside a signed challenge token.** The client signs that message verbatim, and
 * verification reads the message back out of the token. The server never
 * re-serialises a message from fields, which is where SIWS implementations
 * classically go wrong - a byte-order or line-ending mismatch reconstructs a
 * different message and every legitimate signature is rejected, or worse, a
 * mismatch is papered over and a challenge is accepted that was never signed.
 *
 * What a wallet returns is a 64-byte ed25519 signature over the UTF-8 bytes of the
 * message, and the public key is the 32 bytes behind the base58 address. Node
 * verifies this natively, so this adds no dependency to the auth path.
 */

const CHALLENGE_TTL_SEC = 300
const ISSUER = 'Snooker Arena'
const CHAIN_ID = 'mainnet-beta'

/** SIWS version 1, which added Chain ID. */
const SIWS_VERSION = '1'

/**
 * Nonces are single-use.
 *
 * The challenge token is stateless and its 5-minute window is the only thing
 * bounding a replay. A leaked (token, signature) pair is otherwise a valid login
 * for the rest of that window - so the nonce is burned on first use. In-memory is
 * the right scope: the token is already only valid for 5 minutes, and a restart
 * clearing the list only shortens the replay window.
 */
const spentNonces = new Set<string>()
const MAX_TRACKED_NONCES = 50_000

/**
 * Burns a nonce, returning false if it was already spent.
 *
 * Called *after* the signature verifies, not before. Doing it first would let
 * anyone who can reach the challenge endpoint invalidate an in-flight signature by
 * posting a garbage one against the same nonce.
 */
export function burnNonce(nonce: string): boolean {
  if (spentNonces.has(nonce)) return false
  if (spentNonces.size >= MAX_TRACKED_NONCES) {
    // Oldest-first eviction. Entries are only added on use, so the front of the
    // insertion order is the closest to expiring anyway.
    const oldest = spentNonces.values().next()
    if (!oldest.done) spentNonces.delete(oldest.value)
  }
  spentNonces.add(nonce)
  return true
}

/** Exposed for tests. */
export function resetNonces(): void {
  spentNonces.clear()
}

export function newNonce(): string {
  // 16 bytes, base64url. The nonce is the anti-replay value, so its only
  // requirement is unpredictability to the client.
  return randomBytes(16).toString('base64url')
}

export interface SiwsMessage {
  /** The exact text the wallet must sign. */
  message: string
  nonce: string
  issuedAt: string
  expirationTime: string
}

/**
 * Builds an SIWS message for `address`.
 *
 * Field order and separators follow the SIWS spec. The address is included in the
 * body *and* is the key the signature is verified against, so a signature over
 * this message can only ever authenticate that one address - a signature for
 * wallet A cannot be presented as wallet B, because the message text differs.
 */
export function buildSiwsMessage(
  address: string,
  nonce: string,
  origin: string,
  now: Date = new Date()
): SiwsMessage {
  const issuedAt = now.toISOString()
  const expirationTime = new Date(now.getTime() + CHALLENGE_TTL_SEC * 1000).toISOString()
  // SIWS derives `domain` from the URI's host and uses the full URI as `URI:`. Both
  // come from one value so they cannot drift apart.
  let host = origin
  let uri = origin
  try {
    const parsed = new URL(origin)
    host = parsed.host
    uri = parsed.origin
  } catch {
    // A configured origin that is not a URL still produces a readable message; the
    // signature check does not depend on either field.
  }
  const message = [
    `${host} wants you to sign in with your Solana account:`,
    address,
    '',
    'Sign in to Snooker Arena. This request will not trigger a blockchain transaction or cost any SOL.',
    '',
    `URI: ${uri}`,
    `Version: ${SIWS_VERSION}`,
    `Chain ID: ${CHAIN_ID}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`
  ].join('\n')
  return { message, nonce, issuedAt, expirationTime }
}

/** The audience on the challenge token. Distinct from every other token we mint. */
const CHALLENGE_AUDIENCE = 'phantom-challenge'

export interface PhantomChallenge {
  address: string
  nonce: string
  message: string
  issuedAt: string
  expirationTime: string
}

export async function signChallenge(challenge: PhantomChallenge): Promise<string> {
  return new SignJWT({
    aud: CHALLENGE_AUDIENCE,
    sub: challenge.address,
    nonce: challenge.nonce,
    msg: challenge.message,
    iat_iso: challenge.issuedAt,
    exp_iso: challenge.expirationTime
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${CHALLENGE_TTL_SEC}s`)
    .sign(Buffer.from(config.JWT_SECRET, 'utf8'))
}

export class ChallengeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChallengeError'
  }
}

export async function verifyChallengeToken(token: string): Promise<PhantomChallenge> {
  let payload: Record<string, unknown>
  try {
    const result = await jwtVerify(token, Buffer.from(config.JWT_SECRET, 'utf8'), {
      audience: CHALLENGE_AUDIENCE
    })
    payload = result.payload as Record<string, unknown>
  } catch {
    // Expired, tampered with, or signed with a different secret. Deliberately one
    // message for all three.
    throw new ChallengeError('sign-in challenge expired, please try again')
  }
  const { sub, nonce, msg, iat_iso, exp_iso } = payload
  if (
    typeof sub !== 'string' ||
    typeof nonce !== 'string' ||
    typeof msg !== 'string' ||
    typeof iat_iso !== 'string' ||
    typeof exp_iso !== 'string'
  ) {
    throw new ChallengeError('malformed sign-in challenge')
  }
  if (!isValidSolanaAddress(sub)) {
    throw new ChallengeError('challenge is not bound to a valid wallet address')
  }
  return { address: sub, nonce, message: msg, issuedAt: iat_iso, expirationTime: exp_iso }
}

/**
 * Verifies a wallet signature over the challenge message.
 *
 * The message comes from the *signed* token, never from the request body - so a
 * client cannot present a signature it captured from some other context alongside
 * an address of its choosing, and cannot re-point a valid signature at a
 * different wallet.
 *
 * Returns false rather than throwing for a bad signature, so the caller can treat
 * every failure as one generic "invalid credentials" and avoid telling an attacker
 * which part they got wrong.
 */
export function verifyWalletSignature(challenge: PhantomChallenge, signatureB58: string): boolean {
  if (!isValidSignature(signatureB58)) return false
  if (!isValidSolanaAddress(challenge.address)) return false

  let publicKeyRaw: Buffer
  let signature: Buffer
  try {
    publicKeyRaw = decodeBase58(challenge.address)
    signature = decodeBase58(signatureB58)
  } catch {
    return false
  }
  if (publicKeyRaw.length !== 32 || signature.length !== 64) return false

  // Node has no bare-key import, so a DER SPKI header is prepended. This is the
  // standard encoding for an ed25519 SubjectPublicKeyInfo.
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKeyRaw])
  let key
  try {
    key = createPublicKey({ key: spki, format: 'der', type: 'spki' })
  } catch {
    return false
  }

  try {
    return edVerify(null, Buffer.from(challenge.message, 'utf8'), key, signature)
  } catch {
    return false
  }
}

/** Stable hash of an address, for logs and audit rows that must not hold it raw. */
export function addressFingerprint(address: string): string {
  return createHash('sha256').update(address).digest('hex').slice(0, 16)
}

/**
 * A username seed for a wallet-only account.
 *
 * A Phantom identity has no name and no email, so the only thing to derive from is
 * the address itself - which is a public value and must not be used as an identity
 * on its own, hence the `player_` prefix and the short slice.
 */
export function seedFromAddress(address: string): string {
  return `player_${address.slice(0, 6)}`
}

export { encodeBase58 }
