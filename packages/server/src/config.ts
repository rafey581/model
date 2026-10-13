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
 * fail validation - with no fallback the field resolves to `undefined` and the
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
  // The game plays in real USDT at 1:1 (1 USDT = 1 unit): a new account starts
  // with START_BALANCE USDT and stakes are quoted directly in USDT. This is the
  // welcome grant only; it is deliberately small (1 USDT) because the invitation
  // programme, not the grant, is what funds a new player.
  START_BALANCE: z.coerce.number().default(1),
  MATCH_TURN_TIMEOUT_SEC: z.coerce.number().default(DEFAULT_TURN_TIMEOUT_SEC),
  MATCH_RECONNECT_GRACE_SEC: z.coerce.number().default(120),
  COMMISSION_PCT: z.coerce.number().default(0.1),
  MIN_STAKE: z.coerce.number().default(1),
  MAX_STAKE: z.coerce.number().default(10),

  // --- Invitations (referral programme) -----------------------------------
  // Every account gets a unique invite code. A new player may enter a code (or
  // arrive through the invite link) at signup, and the inviter earns
  // REFERRAL_BONUS_USDT once — not at signup, but when the invited player
  // finishes their first real match. A practice match only counts when
  // REFERRAL_COUNT_PRACTICE is on, so the reward tracks genuine activity.
  REFERRAL_ENABLED: boolFlag(true),
  REFERRAL_BONUS_USDT: z.coerce.number().default(1),
  REFERRAL_COUNT_PRACTICE: boolFlag(false),

  // --- Deposits (manual USDT on Solana) ------------------------------------
  // Players send USDT to DEPOSIT_WALLET_ADDRESS, then post a transaction id + a
  // proof screenshot. An admin verifies the transaction from their side and
  // approves, which credits the player the same amount in USDT (1:1). No crypto
  // ever moves through this server - the address lives on an external wallet the
  // operator controls.
  // Deposits are on by default. Set to `false` to hide and reject the flow.
  DEPOSIT_ENABLED: z
    .preprocess((v) => {
      if (typeof v === 'boolean') return v
      if (typeof v === 'string') return v === 'true' || v === '1'
      return true
    }, z.boolean()),
  // Solana program (SPL) USDT is what the player is told to send.
  DEPOSIT_NETWORK: z.string().default('SOL'),
  DEPOSIT_CURRENCY: z.string().default('USDT'),
  // The operator's USDT-on-Solana address shown to players. Empty means deposits
  // are advertised as not configured and requests are rejected.
  DEPOSIT_WALLET_ADDRESS: z.string().default(''),
  DEPOSIT_MIN_USDT: z.coerce.number().default(5),
  DEPOSIT_MAX_USDT: z.coerce.number().default(1000),
  // Proof screenshot size cap (raw bytes). Suggested: keep phones low-res.
  DEPOSIT_SCREENSHOT_MAX_BYTES: z.coerce.number().default(4 * 1024 * 1024),

  // --- Withdrawals (manual USDT on Solana) --------------------------------
  // The player asks to cash out: they post an amount + their own Solana address,
  // the request (with a snapshot of their last matches) goes to the admins, and an
  // admin approves it after paying out of band. Approval debits the same amount in
  // USDT (1:1) from the player's wallet, so a payout is always backed by balance.
  WITHDRAW_ENABLED: z
    .preprocess((v) => {
      if (typeof v === 'boolean') return v
      if (typeof v === 'string') return v === 'true' || v === '1'
      return true
    }, z.boolean()),
  WITHDRAW_NETWORK: z.string().default('SOL'),
  WITHDRAW_CURRENCY: z.string().default('USDT'),
  WITHDRAW_MIN_USDT: z.coerce.number().default(5),
  WITHDRAW_MAX_USDT: z.coerce.number().default(1000),
  // How many of the player's most recent finished matches travel with each
  // request for the admin to authenticate the account.
  WITHDRAW_MATCH_SNAPSHOT_COUNT: z.coerce.number().default(5),

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

  // The internal direct-registration path, used by tests, e2e and the seed. It creates
  // an account with no OTP step, so it is off in any real deployment; players are
  // expected to go through the OTP signup flow.
  AUTH_ALLOW_DIRECT_REGISTER: boolFlag(true),

  // --- OTP (email / WhatsApp verification) --------------------------------
  // A one-time code proves the player owns the email or WhatsApp number they signed
  // up with. The code is short and lives briefly, so the window and the attempt cap
  // are the whole defence; both are configurable so a real deployment can tighten
  // them without a code change.
  OTP_TTL_SEC: z.coerce.number().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().default(5),
  OTP_RESEND_COOLDOWN_SEC: z.coerce.number().default(30),

  // Email delivery over SMTP. An empty host keeps email OTP on the console dev
  // channel - the code is logged, never emailed, so a fresh checkout works offline.
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: boolFlag(false),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_FROM: z.string().default('Snooker Arena <no-reply@snooker.test>'),

  // WhatsApp delivery. `none` logs to the console; `twilio` posts to the Twilio
  // WhatsApp API, which is the only widely available channel for this.
  WHATSAPP_PROVIDER: z.enum(['none', 'twilio']).default('none'),
  TWILIO_ACCOUNT_SID: z.string().default(''),
  TWILIO_AUTH_TOKEN: z.string().default(''),
  TWILIO_WHATSAPP_FROM: z.string().default(''),

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

/** IP prefixes allowed to reach the admin login. Empty list = no restriction. */
export function adminAllowedIps(): string[] {
  return config.ADMIN_ALLOWED_IPS.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** True when a real SMTP server is configured; otherwise email OTP stays on console. */
export function isEmailDeliveryConfigured(): boolean {
  return config.SMTP_HOST.trim().length > 0
}

/** True when WhatsApp delivery is fully configured; otherwise it stays on console. */
export function isWhatsAppDeliveryConfigured(): boolean {
  return (
    config.WHATSAPP_PROVIDER === 'twilio' &&
    config.TWILIO_ACCOUNT_SID.trim() !== '' &&
    config.TWILIO_AUTH_TOKEN.trim() !== '' &&
    config.TWILIO_WHATSAPP_FROM.trim() !== ''
  )
}