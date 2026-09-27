import 'dotenv/config'
import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().default('postgresql://snooker:snooker@localhost:5432/snooker'),
  JWT_SECRET: z.string().min(8).default('dev-secret-change-me'),
  COOKIE_SECRET: z.string().min(8).default('dev-cookie-secret'),
  PORT: z.coerce.number().default(4000),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
  CR_START_BALANCE: z.coerce.number().default(1000),
  MATCH_TURN_TIMEOUT_SEC: z.coerce.number().default(60),
  MATCH_RECONNECT_GRACE_SEC: z.coerce.number().default(120),
  COMMISSION_PCT: z.coerce.number().default(0.1),
  MIN_STAKE: z.coerce.number().default(100),
  MAX_STAKE: z.coerce.number().default(1000),
  REAL_MONEY_ENABLED: z
    .preprocess((v) => {
      if (typeof v === 'boolean') return v
      if (typeof v === 'string') return v === 'true' || v === '1'
      return undefined
    }, z.boolean().default(false))
})

export type ServerConfig = z.infer<typeof envSchema>

export function loadConfig(): ServerConfig {
  return envSchema.parse(process.env)
}

export const config = loadConfig()