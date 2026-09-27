import Fastify from 'fastify'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import { config } from './config.js'
import { registerAuthHooks } from './auth/guards.js'
import { registerAuthRoutes } from './auth/routes.js'
import { registerUserRoutes } from './users/routes.js'
import { registerNotificationRoutes } from './notifications/routes.js'
import { registerWalletRoutes } from './wallet/routes.js'
import { registerMatchRoutes } from './matches/routes.js'
import { registerTournamentRoutes } from './tournaments/routes.js'
import { registerAdminRoutes } from './admin/routes.js'
import { registerCryptoRoutes } from './crypto/index.js'
import { createGameServer } from './game/index.js'
import { getPlatformUserId, getBotUserId } from './matches/service.js'
import { ensureSeedSettings, getSettings, isMaintenance } from './settings/index.js'

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: undefined
    }
  })

  await app.register(cors, {
    origin: config.CLIENT_ORIGIN.split(','),
    credentials: true
  })
  await app.register(cookie)

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? ''
    if (path.startsWith('/api/admin/') || path === '/api/health' || path === '/api/settings/public' || path === '/api/auth/login') return
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
  await registerAdminRoutes(app)

  app.get('/api/health', { config: { public: true } }, async () => ({
    ok: true,
    realMoney: config.REAL_MONEY_ENABLED,
    time: new Date().toISOString()
  }))

  app.get('/api/settings/public', { config: { public: true } }, async () => ({
    ok: true,
    data: {
      maintenanceMode: (await getSettings()).maintenanceMode
    }
  }))

  await ensureSeedSettings()
  await getPlatformUserId()
  await getBotUserId()

  return app
}

export async function startServer() {
  const app = await buildApp()
  await app.ready()
  const httpServer = app.server
  await app.listen({ port: config.PORT, host: '0.0.0.0' })
  const gameServer = createGameServer(app, httpServer)
  app.log.info(`game server listening, rooms active: ${gameServer.rooms.size}`)
  return { app, gameServer }
}