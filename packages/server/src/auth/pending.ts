import { SignJWT, jwtVerify } from 'jose'
import { config } from '../config.js'

/**
 * A verified identity that is not yet an account.
 *
 * A first-time signer-in proves who they are, but the platform still needs *them*
 * to pick a username - it is their public handle, so the server will not invent one.
 * The proven identity is parked in this short-lived token and redeemed at
 * `POST /api/auth/complete`, where the username is claimed and the session issued.
 *
 * This is provider-agnostic on purpose. Google and Phantom prove identity in very
 * different ways, but the thing that happens next - "we know who you are, now tell
 * us what to call you" - is identical, and having two near-identical completion
 * endpoints would mean two copies of the username validation to keep in step.
 *
 * Security notes:
 *  - Signed with the same secret as the session token but its own audience, so it
 *    can never be replayed as a login.
 *  - `provider` is inside the signed payload, so the account is always created under
 *    the provider that actually verified the identity. A client cannot take a Google
 *    token and redeem it as a wallet signup.
 *  - Ten minutes: long enough to choose a username, short enough that an intercepted
 *    link is not useful later.
 */

const PENDING_TTL_SEC = 600
const PENDING_AUDIENCE = 'pending-identity'

/** The values that can appear in `User.authProvider`. Mirrors the schema comment. */
export type AuthProvider = 'PASSWORD' | 'GOOGLE' | 'PHANTOM' | 'BINANCE'

export interface ProviderIdentity {
  provider: AuthProvider
  /**
   * The provider's own stable identifier for this person. Google's `sub`, or a
   * Solana address. This - never the email - is what the account is keyed on.
   */
  subject: string
  email: string | null
  emailVerified: boolean
  name: string | null
  picture: string | null
}

export async function signPendingIdentity(identity: ProviderIdentity): Promise<string> {
  return new SignJWT({
    aud: PENDING_AUDIENCE,
    pr: identity.provider,
    sub: identity.subject,
    email: identity.email,
    email_verified: identity.emailVerified,
    name: identity.name,
    picture: identity.picture
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${PENDING_TTL_SEC}s`)
    .sign(Buffer.from(config.JWT_SECRET, 'utf8'))
}

const KNOWN_PROVIDERS = new Set<string>(['PASSWORD', 'GOOGLE', 'PHANTOM', 'BINANCE'])

export class PendingIdentityError extends Error {
  constructor(message = 'sign-in expired, please try again') {
    super(message)
    this.name = 'PendingIdentityError'
  }
}

export async function verifyPendingIdentity(token: string): Promise<ProviderIdentity> {
  let payload: Record<string, unknown>
  try {
    const { payload: p } = await jwtVerify(token, Buffer.from(config.JWT_SECRET, 'utf8'), {
      audience: PENDING_AUDIENCE
    })
    payload = p as Record<string, unknown>
  } catch {
    // Expired, tampered with, or a different kind of token. One message for all of
    // them, so a caller cannot probe which kind of token it holds.
    throw new PendingIdentityError()
  }

  const { pr, sub } = payload
  if (typeof pr !== 'string' || !KNOWN_PROVIDERS.has(pr)) throw new PendingIdentityError()
  if (typeof sub !== 'string' || sub.length === 0) throw new PendingIdentityError()

  return {
    provider: pr as AuthProvider,
    subject: sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === 'string' ? payload.name : null,
    picture: typeof payload.picture === 'string' ? payload.picture : null
  }
}