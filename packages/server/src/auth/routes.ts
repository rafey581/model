import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { SignJWT } from 'jose'
import { prisma } from '../db/index.js'
import { config } from '../config.js'
import { signToken, verifyToken } from './guards.js'
import { toPublicUser } from '../users/types.js'
import { isMaintenance } from '../settings/index.js'
import { enabledProviders, isProviderEnabled } from './providers.js'
import { checkUsername, isValidUsernameFormat, suggestUsername } from './username.js'
import {
  authorizeUrl,
  exchangeCode,
  newFlowState,
  redirectUriFor,
  safeEqual,
  verifyIdToken
} from './google.js'
import {
  PendingIdentityError,
  signPendingIdentity,
  verifyPendingIdentity,
  type ProviderIdentity
} from './pending.js'
import {
  burnNonce,
  buildSiwsMessage,
  newNonce,
  seedFromAddress,
  signChallenge,
  verifyChallengeToken,
  verifyWalletSignature
} from './phantom.js'
import { isValidSolanaAddress } from './base58.js'
import {
  UsernameTakenError,
  createProviderUserOrReadExisting,
  findByProviderIdentity,
  identityFromGoogle,
  identityFromPhantom,
  refreshGoogleProfile
} from './accounts.js'

/**
 * Player-facing authentication.
 *
 * The public surface is Google and Phantom. Both prove an identity, then hand the
 * same question to the same code - "now pick a username" - so they share the pending
 * token and the completion endpoint. Binance is in the provider registry but
 * disabled, and the client renders whatever the server says is enabled, so there is
 * no button that can fail.
 *
 * Email + password survives here solely for the internal accounts - the seeded
 * admin and the robot bot - and it is fenced off in two ways: it is switched off
 * wholesale by `AUTH_ALLOW_PASSWORD_LOGIN`, and it can never authenticate an admin
 * or bot account. The admin panel has its own entry point (see `admin/auth-routes`),
 * and a leaked player credential must not be a way in.
 */

const FLOW_COOKIE = 'oauth_flow'
const FLOW_TTL_SEC = 600

const registerSchema = z.object({
  email: z.string().email(),
  username: z.string().min(3).max(24),
  password: z.string().min(6).max(72)
})

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
})

const usernameSchema = z.object({ username: z.string().min(1).max(64) })

const completeSchema = z.object({
  pendingToken: z.string().min(10).max(4000),
  username: z.string().min(3).max(24)
})

const phantomChallengeSchema = z.object({ address: z.string().min(32).max(44) })

const phantomVerifySchema = z.object({
  challenge: z.string().min(10).max(4000),
  signature: z.string().min(86).max(88)
})

function clientOrigin(): string {
  return (config.CLIENT_ORIGIN.split(',')[0] ?? 'http://localhost:5173').trim().replace(/\/$/, '')
}

/** The state/nonce/verifier for one in-flight OAuth attempt, sealed into a cookie. */
async function sealFlow(flow: { state: string; nonce: string; codeVerifier: string }): Promise<string> {
  return new SignJWT({ aud: 'oauth-flow', state: flow.state, nonce: flow.nonce, v: flow.codeVerifier })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${FLOW_TTL_SEC}s`)
    .sign(Buffer.from(config.JWT_SECRET, 'utf8'))
}

async function readFlow(cookieValue: string | undefined) {
  if (!cookieValue) return null
  try {
    const { jwtVerify } = await import('jose')
    const { payload } = await jwtVerify(cookieValue, Buffer.from(config.JWT_SECRET, 'utf8'), {
      audience: 'oauth-flow'
    })
    const { state, nonce, v } = payload as { state?: unknown; nonce?: unknown; v?: unknown }
    if (typeof state !== 'string' || typeof nonce !== 'string' || typeof v !== 'string') return null
    return { state, nonce, codeVerifier: v }
  } catch {
    return null
  }
}

function issueSession(reply: FastifyReply, user: { id: string; username: string; role: string; status: string }) {
  const token = signToken({ id: user.id, username: user.username, role: user.role, status: user.status })
  reply.setCookie('token', token, { httpOnly: true, sameSite: 'lax', path: '/' })
  return token
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/auth/providers
   *
   * The login screen is built from this rather than hard-coded, so a provider that
   * is switched off never appears and a newly enabled one needs no client change.
   */
  app.get('/api/auth/providers', { config: { public: true } }, async (_request, reply) => {
    return reply.send({ ok: true, data: { providers: enabledProviders() } })
  })

  /** GET /api/auth/username/check?username=... - live availability for the picker. */
  app.get('/api/auth/username/check', { config: { public: true } }, async (request, reply) => {
    const parsed = usernameSchema.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid username' })
    const result = await checkUsername(parsed.data.username)
    return reply.send({ ok: true, data: result })
  })

  /**
   * GET /api/auth/google - start the flow.
   *
   * Mints state/nonce/PKCE, seals them into an httpOnly cookie and redirects.
   * Nothing about the flow is kept server-side, so there is no session store to
   * grow and no cleanup job.
   */
  app.get('/api/auth/google', { config: { public: true } }, async (request, reply) => {
    if (!isProviderEnabled('google')) {
      return reply.code(404).send({ ok: false, error: 'google sign-in is not available' })
    }
    const flow = newFlowState()
    reply.setCookie(FLOW_COOKIE, await sealFlow(flow), {
      httpOnly: true,
      // Lax, not strict: this cookie has to survive the top-level navigation back
      // from Google, and SameSite=Strict would withhold it on exactly that request.
      sameSite: 'lax',
      path: '/api/auth',
      maxAge: FLOW_TTL_SEC
    })
    return reply.redirect(authorizeUrl(flow, redirectUriFor(`${request.protocol}://${request.hostname}`)), 302)
  })

  /**
   * GET /api/auth/google/callback
   *
   * Verifies, then either logs the player straight in or parks a first-time
   * identity for the username step. A user is never created without a username
   * they chose, because the username is their public handle.
   */
  app.get('/api/auth/google/callback', { config: { public: true } }, async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string }
    const origin = clientOrigin()

    if (query.error) {
      request.log.info({ err: query.error }, 'google sign-in was declined')
      return reply.redirect(`${origin}/?auth=cancelled`, 302)
    }
    if (!query.code || !query.state) {
      return reply.redirect(`${origin}/?auth=invalid`, 302)
    }

    const flow = await readFlow(request.cookies[FLOW_COOKIE])
    if (!flow || !safeEqual(flow.state, query.state)) {
      request.log.warn('google callback rejected: state mismatch')
      return reply.redirect(`${origin}/?auth=invalid`, 302)
    }
    // The flow is spent; drop it so a replayed callback finds nothing.
    reply.clearCookie(FLOW_COOKIE, { path: '/api/auth' })

    let identity
    try {
      const redirectUri = redirectUriFor(`${request.protocol}://${request.hostname}`)
      const tokens = await exchangeCode(query.code, flow.codeVerifier, redirectUri)
      if (!tokens.id_token) throw new Error('no id_token in token response')
      identity = await verifyIdToken(tokens.id_token, flow.nonce)
    } catch (error) {
      request.log.warn({ err: error }, 'google token exchange failed')
      return reply.redirect(`${origin}/?auth=failed`, 302)
    }

    const existing = await findByProviderIdentity('GOOGLE', identity.sub)
    if (existing) {
      if (existing.status !== 'ACTIVE') {
        return reply.redirect(`${origin}/?auth=suspended`, 302)
      }
      await refreshGoogleProfile(existing.id, identity)
      issueSession(reply, existing)
      return reply.redirect(`${origin}/?auth=ok`, 302)
    }

    // First time here. Park the identity and let the player choose a username.
    const pending = await signPendingIdentity(identityFromGoogle(identity))
    const suggested = await suggestUsername(identity.name ?? identity.email?.split('@')[0] ?? 'player')
    return reply.redirect(`${origin}/?auth=pending&t=${encodeURIComponent(pending)}&u=${encodeURIComponent(suggested)}`, 302)
  })

  /**
   * POST /api/auth/phantom/challenge
   *
   * Mints the message the wallet will sign.
   *
   * The client connects the wallet first and sends the address, because the message
   * has to name the account it is asking about - that is what stops a signature for
   * wallet A being replayed as a login for wallet B.
   *
   * The message goes out inside a signed, 5-minute challenge token. The client
   * signs the message verbatim and returns the token with the signature, so
   * verification reads the exact bytes that were signed out of the token instead of
   * rebuilding a message from fields and hoping they match.
   */
  app.post('/api/auth/phantom/challenge', { config: { public: true } }, async (request, reply) => {
    if (!isProviderEnabled('phantom')) {
      return reply.code(404).send({ ok: false, error: 'wallet sign-in is not available' })
    }
    const parsed = phantomChallengeSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid wallet address' })

    const { address } = parsed.data
    if (!isValidSolanaAddress(address)) {
      return reply.code(400).send({ ok: false, error: 'that does not look like a Solana address' })
    }

    // The message names the client origin, not the API host: it is the site the
    // person typed, and that is what the wallet should display back to them.
    const built = buildSiwsMessage(address, newNonce(), clientOrigin())
    const challenge = await signChallenge({
      address,
      nonce: built.nonce,
      message: built.message,
      issuedAt: built.issuedAt,
      expirationTime: built.expirationTime
    })
    return reply.send({
      ok: true,
      data: { address, message: built.message, challenge, expiresIn: FLOW_TTL_SEC }
    })
  })

  /**
   * POST /api/auth/phantom/verify
   *
   * Checks the signature and, like Google, either signs the player in or parks them
   * for the username step. The address is taken from the *signed* challenge, never
   * from the request body.
   */
  app.post('/api/auth/phantom/verify', { config: { public: true } }, async (request, reply) => {
    if (!isProviderEnabled('phantom')) {
      return reply.code(404).send({ ok: false, error: 'wallet sign-in is not available' })
    }
    const parsed = phantomVerifySchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid request' })

    let challenge
    try {
      challenge = await verifyChallengeToken(parsed.data.challenge)
    } catch {
      return reply.code(401).send({ ok: false, error: 'sign-in challenge expired, please try again' })
    }

    // Every failure past here is the same 401, and the same log line without the
    // signature: a client must not be able to learn which part of a forged attempt
    // was wrong.
    if (!verifyWalletSignature(challenge, parsed.data.signature)) {
      request.log.warn({ address: challenge.address }, 'phantom signature verification failed')
      return reply.code(401).send({ ok: false, error: 'signature did not verify' })
    }
    // Burn only now that the signature is proven, so a forged attempt cannot cancel
    // a legitimate sign-in that is in flight for the same nonce.
    if (!burnNonce(challenge.nonce)) {
      return reply.code(401).send({ ok: false, error: 'that sign-in has already been used' })
    }

    const identity = identityFromPhantom(challenge.address)
    const existing = await findByProviderIdentity(identity.provider, identity.subject)
    if (existing) {
      if (existing.status !== 'ACTIVE') {
        return reply.code(403).send({ ok: false, error: 'account not active' })
      }
      const token = issueSession(reply, existing)
      return reply.send({ ok: true, data: { user: toPublicUser(existing), token, created: false } })
    }

    const pending = await signPendingIdentity(identity)
    const suggested = await suggestUsername(seedFromAddress(challenge.address))
    return reply.send({
      ok: true,
      data: { pendingToken: pending, suggestedUsername: suggested, created: false }
    })
  })

  /**
   * POST /api/auth/complete
   *
   * Consumes a pending identity from any provider, claims a username and signs the
   * player in. The username is re-validated here rather than trusted from the picker
   * - the client is not a trust boundary.
   */
  app.post('/api/auth/complete', { config: { public: true } }, async (request, reply) => {
    const parsed = completeSchema.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid request' })
    const { pendingToken, username } = parsed.data

    let identity: ProviderIdentity
    try {
      identity = await verifyPendingIdentity(pendingToken)
    } catch (error) {
      if (error instanceof PendingIdentityError) {
        return reply.code(401).send({ ok: false, error: error.message })
      }
      throw error
    }

    const value = username.trim()
    if (!isValidUsernameFormat(value)) {
      const check = await checkUsername(value)
      return reply.code(400).send({ ok: false, error: check.message ?? 'invalid username' })
    }
    const availability = await checkUsername(value)
    if (!availability.available) {
      return reply.code(409).send({ ok: false, error: availability.message ?? 'username taken' })
    }

    try {
      const { user, created } = await createProviderUserOrReadExisting({ identity, username: value })
      if (created) {
        await prisma.adminAction.create({
          data: {
            adminId: user.id,
            action: `auth.${identity.provider.toLowerCase()}.registered`,
            targetType: 'User',
            targetId: user.id,
            // A wallet account has no email to record, which is itself the fact an
            // auditor wants to see rather than an empty column.
            meta: { username: value, email: identity.email, verifiedEmail: identity.emailVerified }
          }
        })
      }
      const token = issueSession(reply, user)
      return reply.send({ ok: true, data: { user: toPublicUser(user), token, created } })
    } catch (error) {
      if (error instanceof UsernameTakenError) {
        return reply.code(409).send({ ok: false, error: error.message })
      }
      throw error
    }
  })

  /**
   * POST /api/auth/register
   *
   * Internal only - the seeded dev accounts and the e2e suite. It is switched off
   * with `AUTH_ALLOW_PASSWORD_LOGIN`, always creates a PLAYER, and never reads a
   * role from the body, so it cannot be used to mint an admin.
   */
  app.post('/api/auth/register', { config: { public: true } }, async (request, reply) => {
    if (!config.AUTH_ALLOW_PASSWORD_LOGIN) {
      return reply.code(403).send({ ok: false, error: 'password accounts are disabled' })
    }
    const parsed = registerSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: parsed.error.flatten() })
    }
    const { email, username, password } = parsed.data
    const value = username.trim()
    if (!isValidUsernameFormat(value)) {
      const check = await checkUsername(value)
      return reply.code(400).send({ ok: false, error: check.message ?? 'invalid username' })
    }
    const availability = await checkUsername(value)
    if (!availability.available) {
      return reply.code(409).send({ ok: false, error: availability.message ?? 'username taken' })
    }
    const passwordHash = bcrypt.hashSync(password, 10)
    try {
      const user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email,
            username: value,
            passwordHash,
            // Explicit rather than defaulted, so that adding a field to the schema
            // can never silently promote this endpoint into creating staff.
            role: 'PLAYER',
            authProvider: 'PASSWORD',
            profile: { create: {} },
            wallet: { create: { available: config.CR_START_BALANCE } }
          }
        })
        await tx.walletTransaction.create({
          data: {
            userId: created.id,
            type: 'START_BALANCE',
            amount: config.CR_START_BALANCE,
            currency: 'CR',
            status: 'COMPLETED',
            balanceBefore: 0,
            balanceAfter: config.CR_START_BALANCE,
            meta: { description: 'welcome virtual balance' }
          }
        })
        return created
      })
      const token = issueSession(reply, user)
      return reply.send({ ok: true, data: { user: toPublicUser(user), token } })
    } catch (error) {
      if (error instanceof UsernameTakenError) {
        return reply.code(409).send({ ok: false, error: error.message })
      }
      // P2002 on email is a genuine conflict the pre-check raced past.
      if (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002') {
        return reply.code(409).send({ ok: false, error: 'email or username already taken' })
      }
      throw error
    }
  })

  /**
   * POST /api/auth/login
   *
   * Internal only, and explicitly not an admin door. An account whose role is
   * ADMIN or SUPERADMIN is refused here even with the right password, so the only
   * way to obtain an admin session is the hardened route that also demands TOTP.
   */
  app.post('/api/auth/login', { config: { public: true } }, async (request, reply) => {
    if (!config.AUTH_ALLOW_PASSWORD_LOGIN) {
      return reply.code(403).send({ ok: false, error: 'password accounts are disabled' })
    }
    const parsed = loginSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: 'invalid input' })
    }
    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } })
    if (!user?.passwordHash || !bcrypt.compareSync(parsed.data.password, user.passwordHash)) {
      return reply.code(401).send({ ok: false, error: 'invalid credentials' })
    }
    if (user.role === 'ADMIN' || user.role === 'SUPERADMIN') {
      // Audited: someone reaching for the player door with an admin address is
      // either confused or probing, and both are worth a line in the feed.
      await prisma.adminAction.create({
        data: {
          adminId: user.id,
          action: 'auth.admin_login_refused',
          targetType: 'User',
          targetId: user.id,
          meta: { email: user.email, ip: request.ip }
        }
      })
      return reply.code(403).send({ ok: false, error: 'use the admin sign-in' })
    }
    if (user.status !== 'ACTIVE') {
      return reply.code(403).send({ ok: false, error: 'account not active' })
    }
    if ((await isMaintenance()) && user.role !== 'ADMIN' && user.role !== 'SUPERADMIN') {
      return reply.code(503).send({ ok: false, error: 'maintenance in progress' })
    }
    const token = issueSession(reply, user)
    return reply.send({ ok: true, data: { user: toPublicUser(user), token } })
  })

  app.post('/api/auth/logout', async (request, reply) => {
    reply.clearCookie('token', { path: '/' })
    return reply.send({ ok: true })
  })

  app.get('/api/auth/status', async (request, reply) => {
    if (!request.authUser) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' })
    }
    return reply.send({ ok: true, data: { user: request.authUser } })
  })

  /**
   * GET /api/auth/session
   *
   * Exchanges the httpOnly cookie for a socket token.
   *
   * The OAuth callback ends in a top-level redirect, so the client comes back with
   * its in-memory token gone. Rather than putting a token in the URL - where it
   * would land in history, referrers and server logs - the client asks for a fresh
   * one here, authenticated by the cookie it already has. Same trust decision as
   * the cookie itself.
   */
  app.get('/api/auth/session', { config: { public: true } }, async (request, reply) => {
    const header = request.headers.authorization
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined
    const raw = bearer ?? request.cookies.token
    if (!raw) return reply.code(401).send({ ok: false, error: 'unauthorized' })
    const user = await prisma.user.findUnique({ where: { id: verifyToken(raw)?.id ?? '' } })
    if (!user || user.status !== 'ACTIVE') {
      return reply.code(401).send({ ok: false, error: 'unauthorized' })
    }
    const token = issueSession(reply, user)
    return reply.send({ ok: true, data: { user: toPublicUser(user), token } })
  })
}
