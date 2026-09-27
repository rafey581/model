import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'

export interface CryptoStatus {
  enabled: boolean
  supportedAssets: string[]
  supportedNetworks: string[]
}

export function cryptoStatus(): CryptoStatus {
  return {
    enabled: config.REAL_MONEY_ENABLED,
    supportedAssets: [],
    supportedNetworks: []
  }
}

export async function registerCryptoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/crypto/status', async (_request, reply) => {
    return reply.send({ ok: true, data: cryptoStatus() })
  })

  app.post('/api/crypto/deposit', async (_request, reply) => {
    if (!config.REAL_MONEY_ENABLED) {
      return reply.code(403).send({ ok: false, error: 'crypto deposits are disabled', data: cryptoStatus() })
    }
    return reply.code(501).send({ ok: false, error: 'not implemented until provider integration' })
  })

  app.post('/api/crypto/withdraw', async (_request, reply) => {
    if (!config.REAL_MONEY_ENABLED) {
      return reply.code(403).send({ ok: false, error: 'crypto withdrawals are disabled', data: cryptoStatus() })
    }
    return reply.code(501).send({ ok: false, error: 'not implemented until provider integration' })
  })
}