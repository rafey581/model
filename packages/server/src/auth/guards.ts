import type { FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import { prisma } from '../db/index.js'
import { config } from '../config.js'

export interface AuthUser {
  id: string
  username: string
  role: string
  status: string
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

export function signToken(user: AuthUser): string {
  return jwt.sign(user, config.JWT_SECRET, { expiresIn: '7d' })
}

export function verifyToken(token: string): AuthUser | null {
  try {
    return jwt.verify(token, config.JWT_SECRET) as AuthUser
  } catch {
    return null
  }
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
    request.authUser = { id: user.id, username: user.username, role: user.role, status: user.status }
  })
}

export function requireRole(app: FastifyInstance, roles: readonly string[]) {
  return async (request: { authUser?: AuthUser }, reply: { code: (n: number) => { send: (o: object) => void } }) => {
    if (!request.authUser || !roles.includes(request.authUser.role)) {
      reply.code(403).send({ ok: false, error: 'forbidden' })
    }
  }
}