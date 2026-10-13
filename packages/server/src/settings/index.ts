import { prisma } from '../db/index.js'
import type { Prisma } from '@prisma/client'
import { config } from '../config.js'

export interface GameSettings {
  commissionPct: number
  minStake: number
  maxStake: number
  matchFormats: string[]
  turnTimeoutSec: number
  reconnectGraceSec: number
  maintenanceMode: boolean
  realMoneyEnabled: boolean
}

export const SETTING_KEYS: Array<keyof GameSettings> = [
  'commissionPct',
  'minStake',
  'maxStake',
  'matchFormats',
  'turnTimeoutSec',
  'reconnectGraceSec',
  'maintenanceMode',
  'realMoneyEnabled'
]

export const DEFAULT_SETTINGS: GameSettings = {
  commissionPct: config.COMMISSION_PCT,
  minStake: config.MIN_STAKE,
  maxStake: config.MAX_STAKE,
  matchFormats: ['BO1', 'BO3', 'BO5'],
  turnTimeoutSec: config.MATCH_TURN_TIMEOUT_SEC,  reconnectGraceSec: config.MATCH_RECONNECT_GRACE_SEC,
  maintenanceMode: false,
  realMoneyEnabled: config.REAL_MONEY_ENABLED
}

const TTL_MS = 2000

let cache: { snapshot: GameSettings; at: number } | null = null

function coerceSetting(key: keyof GameSettings, value: unknown): GameSettings[typeof key] | undefined {
  const fallback = DEFAULT_SETTINGS[key]
  if (value === undefined || value === null) return fallback
  if (typeof fallback === 'boolean') return Boolean(value)
  if (typeof fallback === 'number') {
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
  }
  if (Array.isArray(fallback)) {
    if (!Array.isArray(value)) return fallback
    return value.filter((v): v is string => typeof v === 'string')
  }
  return value as GameSettings[typeof key]
}

export async function getSettings(): Promise<GameSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.snapshot
  const rows = await prisma.appSetting.findMany()
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const raw = { ...DEFAULT_SETTINGS } as Record<string, unknown>
  for (const key of SETTING_KEYS) {
    const coerced = coerceSetting(key, map.get(key))
    if (coerced !== undefined) raw[key] = coerced
  }
  const snapshot = raw as unknown as GameSettings
  cache = { snapshot, at: Date.now() }
  return snapshot
}

export function invalidateSettingsCache(): void {
  cache = null
}

export async function isMaintenance(): Promise<boolean> {
  return (await getSettings()).maintenanceMode
}

export async function ensureSeedSettings(): Promise<void> {
  await Promise.all(
    SETTING_KEYS.map((key) =>
      prisma.appSetting.upsert({
        where: { key },
        create: { key, value: DEFAULT_SETTINGS[key] as unknown as Prisma.InputJsonValue },
        update: {}
      })
    )
  )
}