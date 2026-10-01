import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { config } from '../config.js'

/**
 * Sign in with Google, OIDC authorization-code flow with PKCE.
 *
 * What is actually trusted here, and why:
 *
 *  - The authorization code is redeemed server-to-server over TLS, so it cannot
 *    be intercepted the way a front-channel token would.
 *  - The returned `id_token` is verified against Google's published JWKS, and its
 *    `aud` must equal our client id, `iss` must be Google, and `nonce` must match
 *    the one we minted for this flow. Verifying the signature is the part that
 *    cannot be skipped: without it any party could mint a token claiming to be
 *    any `sub`.
 *  - The account is keyed on `sub`, never on email. Email is mutable by the user
 *    and reassignable by an admin, so keying on it would let someone take over an
 *    account by changing their address.
 *
 * The user is deliberately *not* created on the callback. A first-time identity is
 * parked in a short-lived pending token so the client can ask for a username
 * first - the platform requires a unique one, and inventing it server-side would
 * take the choice away from the player.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs'
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])

const SCOPES = ['openid', 'email', 'profile']

// The JWKS is fetched once and cached by jose, with conditional revalidation.
const jwks = createRemoteJWKSet(new URL(JWKS_URI))

export interface GoogleIdentity {
  sub: string
  email: string | null
  emailVerified: boolean
  name: string | null
  picture: string | null
}

export interface OAuthFlowState {
  state: string
  nonce: string
  codeVerifier: string
}

function b64url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

export function newFlowState(): OAuthFlowState {
  return {
    state: b64url(randomBytes(24)),
    nonce: b64url(randomBytes(24)),
    codeVerifier: b64url(randomBytes(32))
  }
}

export function pkceChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest())
}

/** Constant-time compare, so a wrong `state` cannot be discovered byte by byte. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export function redirectUriFor(requestOrigin: string): string {
  if (config.GOOGLE_REDIRECT_URI) return config.GOOGLE_REDIRECT_URI
  return `${requestOrigin.replace(/\/$/, '')}/api/auth/google/callback`
}

export function authorizeUrl(flow: OAuthFlowState, redirectUri: string): string {
  const url = new URL(AUTH_ENDPOINT)
  url.search = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: pkceChallenge(flow.codeVerifier),
    code_challenge_method: 'S256',
    // Lets someone who is already signed in to Google use a different account,
    // which is the common case when a family shares a browser.
    prompt: 'select_account'
  }).toString()
  return url.toString()
}

interface TokenResponse {
  access_token?: string
  id_token?: string
  error?: string
  error_description?: string
}

export async function exchangeCode(
  code: string,
  verifier: string,
  redirectUri: string
): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    })
  })
  const json = (await res.json()) as TokenResponse
  if (!res.ok) {
    throw new Error(json.error_description ?? json.error ?? `token exchange failed (${res.status})`)
  }
  return json
}

/**
 * Verifies the id_token and reduces it to the claims we are willing to rely on.
 *
 * `email_verified` is read but not enforced here: Google is the only issuer we
 * accept, and it will not issue an unverified email for a normal Google account.
 * Enforcing it would lock out Workspace tenants that gate mail differently, and
 * the value is stored on the account so a policy change needs no re-login.
 */
export async function verifyIdToken(idToken: string, expectedNonce: string): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: [...ISSUERS],
    audience: config.GOOGLE_CLIENT_ID
  })
  if (typeof payload.nonce !== 'string' || !safeEqual(payload.nonce, expectedNonce)) {
    throw new Error('nonce mismatch')
  }
  const sub = payload.sub
  if (typeof sub !== 'string' || sub.length === 0) throw new Error('missing sub')
  return {
    sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === 'string' ? payload.name : null,
    picture: typeof payload.picture === 'string' ? payload.picture : null
  }
}

/**
 * The parked-identity token lives in `pending.ts` rather than here, because Phantom
 * parks an identity the same way and the two must not drift apart. Google only
 * contributes the verification above; turning it into a token is one call to
 * `signPendingIdentity(identityFromGoogle(identity))`.
 */
