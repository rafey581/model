import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../db/index.js'
import { config } from '../config.js'

/**
 * One-time codes for verifying an email address or WhatsApp number.
 *
 * A code is short and short-lived, and the only thing standing between a stranger and
 * someone else's inbox is the window it is valid for and the number of guesses allowed.
 * So: the code is generated with `crypto.randomInt` (uniform, unpredictable - a
 * `Math.random` code is guessable), only its SHA-256 is ever stored, it is burned the
 * moment it is used, and every wrong guess is counted against an attempt cap.
 */

export const OTP_LENGTH = 6

export type OtpChannel = 'EMAIL' | 'WHATSAPP'
export type OtpPurpose = 'SIGNUP' | 'PASSWORD_RESET'

/** Six digits, zero-padded, drawn from a CSPRNG. */
export function generateOtpCode(): string {
  return String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0')
}

export function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex')
}

/** Constant-time comparison of two hex digests, so a wrong code is not a timing oracle. */
function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  if (left.length !== right.length || left.length === 0) return false
  return timingSafeEqual(left, right)
}

// --- identifier normalisation ----------------------------------------------
// The stored value and the value a code is sent to have to be the same string, or a
// code minted for "+1 555 0100" would not verify against the stored "+15550100".

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

/** Digits with an optional single leading `+`. Spaces, dashes and brackets are dropped. */
export function normalizePhone(value: string): string {
  const trimmed = value.trim()
  const digits = trimmed.replace(/[^0-9]/g, '')
  return trimmed.startsWith('+') ? `+${digits}` : digits
}

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

export function isPhone(value: string): boolean {
  const digits = value.replace(/[^0-9]/g, '')
  return digits.length >= 8 && digits.length <= 15
}

/** A hint of where the code went, without echoing the whole address back. */
export function maskIdentifier(identifier: string): string {
  if (identifier.includes('@')) {
    const [user = '', domain = ''] = identifier.split('@')
    const head = user.slice(0, 2)
    return `${head}${'*'.repeat(Math.max(user.length - head.length, 1))}@${domain}`
  }
  return identifier.length > 4 ? `${'*'.repeat(identifier.length - 4)}${identifier.slice(-4)}` : identifier
}

export interface CreateOtpInput {
  identifier: string
  channel: OtpChannel
  purpose: OtpPurpose
  payload?: Prisma.InputJsonValue
}

/**
 * Mints a code and stores its challenge.
 *
 * The plaintext code is returned to the caller (which delivers it) and never stored;
 * only the hash goes to the database.
 */
export async function createOtpChallenge(input: CreateOtpInput): Promise<{ challengeId: string; code: string; expiresAt: Date }> {
  const code = generateOtpCode()
  const expiresAt = new Date(Date.now() + config.OTP_TTL_SEC * 1000)
  const challenge = await prisma.otpChallenge.create({
    data: {
      identifier: input.identifier,
      channel: input.channel,
      purpose: input.purpose,
      codeHash: hashCode(code),
      payload: input.payload ?? Prisma.JsonNull,
      expiresAt
    }
  })
  return { challengeId: challenge.id, code, expiresAt }
}

/** Seconds remaining before another code may be sent for this identifier, or 0. */
export async function secondsUntilResendAllowed(identifier: string, purpose: OtpPurpose): Promise<number> {
  const latest = await prisma.otpChallenge.findFirst({
    where: { identifier, purpose },
    orderBy: { createdAt: 'desc' }
  })
  if (!latest) return 0
  const elapsed = (Date.now() - latest.createdAt.getTime()) / 1000
  return Math.max(0, Math.ceil(config.OTP_RESEND_COOLDOWN_SEC - elapsed))
}

export type OtpVerifyResult =
  | { ok: true; identifier: string; payload: unknown }
  | { ok: false; message: string }

/**
 * Checks a code against its challenge, counting attempts.
 *
 * The failure messages are deliberately specific here, unlike the admin login: the
 * caller already holds the challenge id, which is only ever handed to the person who
 * started the flow, so there is nothing to enumerate. A wrong code, an expired one and
 * a spent one read differently because each calls for a different next step.
 */
export async function verifyOtpChallenge(
  challengeId: string,
  code: string,
  purpose: OtpPurpose
): Promise<OtpVerifyResult> {
  const challenge = await prisma.otpChallenge.findUnique({ where: { id: challengeId } })
  if (!challenge || challenge.purpose !== purpose) {
    return { ok: false, message: 'That code is no longer valid. Please start again.' }
  }
  if (challenge.consumedAt) {
    return { ok: false, message: 'That code has already been used. Please start again.' }
  }
  if (challenge.expiresAt.getTime() < Date.now()) {
    return { ok: false, message: 'That code has expired. Please request a new one.' }
  }
  if (challenge.attempts >= config.OTP_MAX_ATTEMPTS) {
    return { ok: false, message: 'Too many attempts. Please request a new code.' }
  }
  if (!hashesEqual(hashCode(code.trim()), challenge.codeHash)) {
    await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } })
    const left = Math.max(0, config.OTP_MAX_ATTEMPTS - (challenge.attempts + 1))
    return { ok: false, message: left > 0 ? `That code is not correct. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many attempts. Please request a new code.' }
  }
  // Burn only on success, so a wrong guess cannot cancel a legitimate in-flight code.
  await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } })
  return { ok: true, identifier: challenge.identifier, payload: challenge.payload }
}
