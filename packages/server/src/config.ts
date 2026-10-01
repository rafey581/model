import 'dotenv/config'
import { z } from 'zod'

/**
 * How long a player has to play a shot, in seconds.
 *
 * The one place the number lives. The env key below only exists to let an operator
 * override it, and the admin setting only exists so it can be changed at runtime; both
 * fall back to this. Long enough to line up a shot and read the table, short enough
 * that a stalled turn resolves itself instead of hanging the match.
 */
export const DEFAULT_TURN_TIMEOUT_SEC = 30

/**
 * A boolean that can be written as `true`, `1`, `false` or `0` in a .env file.
 *
 * The point of the helper is the `undefined` case: zod's own `z.boolean()` rejects
 * the *string* "true" that dotenv hands over, so flags silently failed to parse
 * from an env file. An absent variable must fall through to `fallback` rather than
 * fail validation, which is what makes "unset means auto" possible for the
 * provider switches - with no fallback the field resolves to `undefined` and the
 * caller decides what auto means.
 */
function boolFlag(fallback?: boolean) {
  return z.preprocess((v) => {
    if (v === undefined || v === '') return fallback
    if (typeof v === 'boolean') return v
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase()
      if (s === 'true' || s === '1' || s === 'yes') return true
      if (s === 'false' || s === '0' || s === 'no') return false
    }
    return v
  }, z.boolean().optional())
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET is required (16+ chars; never use a committed value)'),
  COOKIE_SECRET: z.string().min(16, 'COOKIE_SECRET is required (16+ chars; never use a committed value)'),
  PORT: z.coerce.number().default(4000),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  CR_START_BALANCE: z.coerce.number().default(1000),
  MATCH_TURN_TIMEOUT_SEC: z.coerce.number().default(DEFAULT_TURN_TIMEOUT_SEC),
  MATCH_RECONNECT_GRACE_SEC: z.coerce.number().default(120),
  COMMISSION_PCT: z.coerce.number().default(0.1),
  MIN_STAKE: z.coerce.number().default(100),
  MAX_STAKE: z.coerce.number().default(1000),

  // --- Google (Sign in with Google) ---------------------------------------
  // Left empty in local dev on purpose: with no client id the provider stays
  // switched off and the login screen renders with no Google button at all,
  // rather than a button that 500s when clicked.
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  // Must match a redirect URI registered in the Google console. Left empty it is
  // derived from the incoming request, which is right for localhost and wrong
  // behind a proxy - so a deployment should set it explicitly.
  GOOGLE_REDIRECT_URI: z.string().default(''),
  // Forces the provider on/off. When unset it follows whether the credentials above
  // are present, so a deployed environment with secrets needs no extra flag.
  GOOGLE_ENABLED: boolFlag(),

  // --- Phantom (Sign In With Solana) ---------------------------------------
  // No credentials at all: a wallet signs a challenge we mint and we verify the
  // signature with Node's own ed25519. That makes this the one provider that works
  // out of the box on a fresh checkout, so it defaults to enabled. The switch is
  // here to be able to turn the button off without a redeploy of config semantics.
  PHANTOM_ENABLED: boolFlag(true),

  // --- Admin access -------------------------------------------------------
  // Admin signs in with email + password on a route that is not linked from the
  // public UI, never with Google. TOTP is on by default; turning it off is an
  // explicit, logged decision rather than the absence of one.
  ADMIN_REQUIRE_TOTP: boolFlag(true),
  // Comma-separated allowlist of CIDR-less IP prefixes. Empty means "anywhere",
  // which is the right answer for local dev and a mistake in production, so boot
  // logs a warning when it is empty.
  ADMIN_ALLOWED_IPS: z.string().default(''),
  ADMIN_SESSION_TTL_MIN: z.coerce.number().default(30),
  ADMIN_MAX_FAILED_ATTEMPTS: z.coerce.number().default(5),
  ADMIN_LOCKOUT_MIN: z.coerce.number().default(15),

  // The internal password path (seeded admin, robot bot). The public auth screen
  // never offers it; this switch exists so it can be killed outright in production
  // once every operator is on Google or TOTP.
  AUTH_ALLOW_PASSWORD_LOGIN: boolFlag(true),

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

/**
 * Google counts as usable only when both halves of the credential exist.
 *
 * `GOOGLE_ENABLED` is only meaningful on top of that: flipping it to `true`
 * without a client id would render a button that fails on click, so the flag
 * alone can never switch the provider on.
 */
export function isGoogleUsable(): boolean {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) return false
  return config.GOOGLE_ENABLED ?? true
}

/**
 * Phantom needs no credentials, so it is usable whenever it is switched on.
 *
 * Kept as a named check rather than read inline so `providers.ts` stays the only
 * place that decides what the login screen shows, and so the boot warnings have one
 * function to call per provider.
 */
export function isPhantomUsable(): boolean {
  return config.PHANTOM_ENABLED ?? true
}

/** IP prefixes allowed to reach the admin login. Empty list = no restriction. */
export function adminAllowedIps(): string[] {
  return config.ADMIN_ALLOWED_IPS.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}