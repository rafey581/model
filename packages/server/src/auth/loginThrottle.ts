import { createHash, randomUUID } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { prisma } from '../db/index.js'
import { config } from '../config.js'

/**
 * Failed sign-in limits, stored in Postgres.
 *
 * Two counters, kept apart so one cannot reset the other:
 *
 *  - **Account.** The identifier the client typed (email or username), hashed.
 *    The same limit applies when no such account exists, so the cooldown is not
 *    an oracle for "that account is real".
 *  - **Address.** `request.ip` after Fastify's trust-proxy handling. With
 *    `TRUST_PROXY` left false (the default) a client-supplied forwarding header
 *    is ignored. Turn the flag on only behind a proxy that overwrites that header.
 *
 * Crossing the limit starts a fixed cooldown. Further failures while it is in
 * force do not extend it, so an attacker cannot keep an account locked by
 * continuing to guess. A correct password for that surface clears the account
 * counter only. The address counter is left alone, so one success on a shared
 * network does not wipe the protection for everyone behind it.
 *
 * Defaults, clamped so a bad env value cannot lock everyone immediately or for
 * days: 5 failures on an identifier (`ADMIN_MAX_FAILED_ATTEMPTS`, allowed 3–20)
 * and 15 on an address (three times that, allowed up to 60), inside a 15 minute
 * window (`ADMIN_LOCKOUT_MIN`, allowed 1–60). The cooldown is that same length.
 * Player sign-in, staff sign-in and password recovery each have their own rows.
 */

export type ThrottleSurface = 'player' | 'staff' | 'recovery'

const ACCOUNT_MIN = 3
const ACCOUNT_MAX = 20
const IP_MAX = 60
const COOLDOWN_MIN_MINUTES = 1
const COOLDOWN_MAX_MINUTES = 60

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

export function accountFailureLimit(): number {
  return clamp(config.ADMIN_MAX_FAILED_ATTEMPTS, ACCOUNT_MIN, ACCOUNT_MAX, 5)
}

export function ipFailureLimit(): number {
  return clamp(accountFailureLimit() * 3, accountFailureLimit(), IP_MAX, 15)
}

export function cooldownSeconds(): number {
  return clamp(config.ADMIN_LOCKOUT_MIN, COOLDOWN_MIN_MINUTES, COOLDOWN_MAX_MINUTES, 15) * 60
}

export function cooldownMessage(retryAfterSec: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60))
  const unit = minutes === 1 ? 'minute' : 'minutes'
  return `Too many sign-in attempts. Try again in ${minutes} ${unit}.`
}

export function cooldownBody(retryAfterSec: number): {
  ok: false
  error: string
  code: 'login_cooldown'
  retryAfterSec: number
} {
  return {
    ok: false,
    error: cooldownMessage(retryAfterSec),
    code: 'login_cooldown',
    retryAfterSec
  }
}

/** The address Fastify already resolved. Forwarding headers are not read here. */
export function clientIp(request: FastifyRequest): string {
  const raw = request.ip || 'unknown'
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw
}

function digest(surface: string, kind: string, key: string): string {
  return createHash('sha256').update(`${surface}\0${kind}\0${key}`).digest('hex')
}

interface ThrottleRow {
  failures: number
  lockedUntil: Date | null
}

function retryAfterSec(until: Date | null): number {
  if (!until) return 0
  return Math.max(0, Math.ceil((until.getTime() - Date.now()) / 1000))
}

/**
 * Insert or advance one counter. The upsert is one statement, so concurrent
 * requests serialize on the unique row instead of each reading "4" and all
 * writing "5". A cooldown already in the future is left exactly as it is.
 */
async function bump(surface: ThrottleSurface, kind: 'account' | 'ip', key: string, limit: number): Promise<ThrottleRow> {
  const seconds = cooldownSeconds()
  const rows = await prisma.$queryRaw<ThrottleRow[]>`
    INSERT INTO "LoginThrottle" ("id", "surface", "kind", "keyHash", "failures", "windowStart", "lockedUntil", "updatedAt")
    VALUES (
      ${randomUUID()},
      ${surface},
      ${kind},
      ${digest(surface, kind, key)},
      1,
      NOW(),
      NULL,
      NOW()
    )
    ON CONFLICT ("surface", "kind", "keyHash") DO UPDATE SET
      "failures" = CASE
        WHEN "LoginThrottle"."lockedUntil" IS NOT NULL AND "LoginThrottle"."lockedUntil" > NOW()
          THEN "LoginThrottle"."failures"
        WHEN "LoginThrottle"."windowStart" <= NOW() - make_interval(secs => ${seconds})
          THEN 1
        ELSE "LoginThrottle"."failures" + 1
      END,
      "windowStart" = CASE
        WHEN "LoginThrottle"."lockedUntil" IS NOT NULL AND "LoginThrottle"."lockedUntil" > NOW()
          THEN "LoginThrottle"."windowStart"
        WHEN "LoginThrottle"."windowStart" <= NOW() - make_interval(secs => ${seconds})
          THEN NOW()
        ELSE "LoginThrottle"."windowStart"
      END,
      "lockedUntil" = CASE
        WHEN "LoginThrottle"."lockedUntil" IS NOT NULL AND "LoginThrottle"."lockedUntil" > NOW()
          THEN "LoginThrottle"."lockedUntil"
        WHEN (
          CASE
            WHEN "LoginThrottle"."windowStart" <= NOW() - make_interval(secs => ${seconds}) THEN 1
            ELSE "LoginThrottle"."failures" + 1
          END
        ) >= ${limit}
          THEN NOW() + make_interval(secs => ${seconds})
        ELSE NULL
      END,
      "updatedAt" = NOW()
    RETURNING "failures", "lockedUntil"
  `
  return rows[0] ?? { failures: 1, lockedUntil: null }
}

async function activeLocks(surface: ThrottleSurface, ip: string, accountKey: string | null): Promise<Date | null> {
  const accountHash = accountKey ? digest(surface, 'account', accountKey) : null
  const ipHash = digest(surface, 'ip', ip)
  const rows = await prisma.$queryRaw<Array<{ lockedUntil: Date }>>`
    SELECT "lockedUntil" FROM "LoginThrottle"
    WHERE "surface" = ${surface}
      AND "lockedUntil" IS NOT NULL
      AND "lockedUntil" > NOW()
      AND (
        ("kind" = 'ip' AND "keyHash" = ${ipHash})
        OR ("kind" = 'account' AND "keyHash" = ${accountHash})
      )
  `
  let latest: Date | null = null
  for (const row of rows) {
    if (!latest || row.lockedUntil.getTime() > latest.getTime()) latest = row.lockedUntil
  }
  return latest
}

export interface ThrottleResult {
  locked: boolean
  retryAfterSec: number
}

export async function loginBlock(
  surface: ThrottleSurface,
  ip: string,
  accountKey: string | null
): Promise<ThrottleResult> {
  const until = await activeLocks(surface, ip, accountKey)
  const wait = retryAfterSec(until)
  return { locked: wait > 0, retryAfterSec: wait }
}

export async function recordLoginFailure(
  surface: ThrottleSurface,
  ip: string,
  accountKey: string | null
): Promise<ThrottleResult> {
  const account = accountKey ? await bump(surface, 'account', accountKey, accountFailureLimit()) : null
  const address = await bump(surface, 'ip', ip, ipFailureLimit())
  const until = [account?.lockedUntil ?? null, address.lockedUntil].reduce<Date | null>((latest, next) => {
    if (!next) return latest
    if (!latest || next.getTime() > latest.getTime()) return next
    return latest
  }, null)
  const wait = retryAfterSec(until)
  return { locked: wait > 0, retryAfterSec: wait }
}

/** Drops the identifier counter after a correct password. The address counter stays. */
export async function clearAccountFailures(surface: ThrottleSurface, accountKey: string): Promise<void> {
  await prisma.loginThrottle.deleteMany({
    where: { surface, kind: 'account', keyHash: digest(surface, 'account', accountKey) }
  })
}

/** Test isolation. Production never needs a global reset. */
export async function resetLoginThrottles(): Promise<void> {
  await prisma.loginThrottle.deleteMany()
}
