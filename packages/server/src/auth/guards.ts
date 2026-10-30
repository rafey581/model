import type { FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import { prisma } from '../db/index.js'
import { config } from '../config.js'
import { touchLastSeen } from '../users/activity.js'

export interface AuthUser {
  id: string
  username: string
  role: string
  status: string
  /** The account's tokenVersion when this token was issued (absent on tokens from before it existed, read as 0). */
  tv?: number
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser
  }
  interface FastifyInstance {
    authRequired: () => void
  }
  interface FastifyContextConfig {
    public?: boolean
    /**
     * Documentation marker for routes that require an ADMIN session. It is not read
     * by any code - the gate is `requireAdminSession` in the route's preHandler -
     * but it makes an admin route identifiable at a glance in review.
     */
    admin?: boolean
  }
}

export function signToken(user: AuthUser, expiresInSeconds = 60 * 60 * 24 * 7): string {
  const claims: AuthUser = { id: user.id, username: user.username, role: user.role, status: user.status, tv: user.tv ?? 0 }
  return jwt.sign(claims, config.JWT_SECRET, { expiresIn: expiresInSeconds, algorithm: 'HS256' })
}

export function verifyToken(token: string): AuthUser | null {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] }) as AuthUser & { purpose?: string }
    // A password-reset token is signed with the same key, and must never pass as a login.
    if (payload.purpose) return null
    return payload
  } catch {
    return null
  }
}

/**
 * Whether a token still belongs to the account as it is now. A password reset bumps
 * the account's tokenVersion, which signs it out of every phone that was logged in
 * (including whoever had stolen the old password or token).
 */
export function tokenIsCurrent(payload: AuthUser, user: { tokenVersion: number }): boolean {
  return (payload.tv ?? 0) === user.tokenVersion
}

export async function registerAuthHooks(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (request, reply) => {
    if (request.routeOptions.config.public) return
    const header = request.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice(7) : (request.cookies.token ?? '')
    if (!token) {
      await reply.code(401).send({ ok: false, error: 'unauthorized' })
      return
    }
    const payload = verifyToken(token)
    if (!payload) {
      await reply.code(401).send({ ok: false, error: 'invalid token' })
      return
    }
    const user = await prisma.user.findUnique({ where: { id: payload.id } })
    if (!user || user.status !== 'ACTIVE') {
      await reply.code(403).send({ ok: false, error: 'account not active' })
      return
    }
    if (!tokenIsCurrent(payload, user)) {
      await reply.code(401).send({ ok: false, error: 'session expired, please log in again' })
      return
    }
    request.authUser = { id: user.id, username: user.username, role: user.role, status: user.status }
    touchLastSeen(user)
  })
}

export function requireRole(app: FastifyInstance, roles: readonly string[]) {
  return async (request: { authUser?: AuthUser }, reply: { code: (n: number) => { send: (o: object) => void } }) => {
    if (!request.authUser || !roles.includes(request.authUser.role)) {
      reply.code(403).send({ ok: false, error: 'forbidden' })
    }
  }
}