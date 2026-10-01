import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import { createRequire } from 'node:module'
import { config } from './config.js'
import { prisma } from './db/index.js'
import { registerAuthHooks } from './auth/guards.js'
import { registerAuthRoutes } from './auth/routes.js'
import { registerUserRoutes } from './users/routes.js'
import { registerNotificationRoutes } from './notifications/routes.js'
import { registerWalletRoutes } from './wallet/routes.js'
import { registerMatchRoutes } from './matches/routes.js'
import { registerTournamentRoutes } from './tournaments/routes.js'
import { registerAdminRoutes } from './admin/routes.js'
import { registerAdminAuthRoutes } from './admin/auth-routes.js'
import { purgeExpiredSessions } from './admin/auth.js'
import { providerConfigWarnings } from './auth/providers.js'
import { registerCryptoRoutes } from './crypto/index.js'
import { createGameServer, recoverMatchValidity } from './game/index.js'
import { getPlatformUserId, getBotUserId } from './matches/service.js'
import { ensureSeedSettings, getSettings, isMaintenance } from './settings/index.js'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      transport: undefined,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie'],
        censor: '[REDACTED]'
      }
    }
  })

  await app.register(cors, {
    origin: config.CLIENT_ORIGIN.split(','),
    credentials: true
  })
  await app.register(cookie)

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? ''
    if (
      path.startsWith('/api/admin/') ||
      path === '/api/health' ||
      path === '/api/ready' ||
      path === '/api/settings/public' ||
      path === '/api/auth/login'
    )
      return
    if (await isMaintenance()) {
      await reply.code(503).send({ ok: false, error: 'maintenance in progress' })
    }
  })

  await registerAuthHooks(app)
  await registerAuthRoutes(app)
  await registerUserRoutes(app)
  await registerWalletRoutes(app)
  await registerNotificationRoutes(app)
  await registerMatchRoutes(app)
  await registerTournamentRoutes(app)
  await registerCryptoRoutes(app)
  await registerAdminAuthRoutes(app)
  await registerAdminRoutes(app)

  app.get('/api/health', { config: { public: true } }, async (request) => {
    let db = 'up'
    try {
      await prisma.$queryRawUnsafe('SELECT 1')
    } catch (error) {
      db = 'down'
      request.log.error({ err: error }, 'health db probe failed')
    }
    const maintenance = db === 'up' ? (await getSettings()).maintenanceMode : false
    return {
      ok: db === 'up',
      status: db === 'up' ? (maintenance ? 'maintenance' : 'ok') : 'down',
      db,
      maintenance,
      version: pkg.version,
      realMoney: config.REAL_MONEY_ENABLED,
      uptimeSec: Math.round(process.uptime()),
      time: new Date().toISOString()
    }
  })

  app.get('/api/ready', { config: { public: true } }, async (request, reply) => {
    try {
      await prisma.$queryRawUnsafe('SELECT 1')
    } catch (error) {
      request.log.error({ err: error }, 'readiness db probe failed')
      return reply.code(503).send({ ok: false, status: 'down', db: 'down' })
    }
    return { ok: true, status: 'ready', db: 'up', maintenance: (await getSettings()).maintenanceMode }
  })

  app.get('/api/settings/public', { config: { public: true } }, async () => ({
    ok: true,
    data: {
      maintenanceMode: (await getSettings()).maintenanceMode
    }
  }))

  await ensureSeedSettings()
  await getPlatformUserId()
  await getBotUserId()

  // Expired admin sessions are deleted rather than left to be rejected on every
  // request, so the table reflects only live access.
  const purged = await purgeExpiredSessions()
  if (purged > 0) app.log.info({ count: purged }, 'purged expired admin sessions')

  for (const warning of providerConfigWarnings()) {
    app.log.warn(warning)
  }

  return app
}

export async function startServer() {
  const app = await buildApp()
  await app.ready()
  const recovered = await recoverMatchValidity()
  app.log.info({ count: recovered }, 'recovered stale matches after restart')
  const httpServer = app.server
  await app.listen({ port: config.PORT, host: '0.0.0.0' })
  const gameServer = createGameServer(app, httpServer)
  app.log.info({
    event: 'boot',
    version: pkg.version,
    port: config.PORT,
    host: '0.0.0.0',
    env: process.env.NODE_ENV ?? 'development',
    realMoney: config.REAL_MONEY_ENABLED,
    rooms: gameServer.rooms.size
  }, 'server listening')
  return { app, gameServer }
}