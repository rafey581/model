import { prisma } from '../db/index.js'
import { config } from '../config.js'
import { ledger } from '../wallet/service.js'
import type { Tx } from '../wallet/service.js'

/**
 * Invitations.
 *
 * Every account carries one unique, shareable invite code. A new player may
 * enter that code (or arrive through the `?ref=` link) at signup, which records
 * the inviter on the new account. The inviter is paid REFERRAL_BONUS_USDT once,
 * and only once — when the invited player finishes their first real match.
 *
 * Only the inviter is paid; the invited player just gets the normal welcome
 * balance. The reward is gated on a played match (not on signup) so that a
 * burst of throwaway signups cannot mint balance on its own.
 */

export class ReferralError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReferralError'
  }
}

// Characters that survive being read aloud or retyped: no I/O/0/1.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generateReferralCode(length = 8): string {
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return out
}

/** A candidate code that no account currently holds. Uniqueness is the DB's job too. */
export async function pickReferralCode(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = generateReferralCode()
    const taken = await prisma.user.findUnique({ where: { referralCode: code }, select: { id: true } })
    if (!taken) return code
  }
  throw new ReferralError('could not generate an invite code — please try again')
}

export function normalizeReferralCode(raw: string): string {
  return raw.trim().toUpperCase()
}

/** The inviter a code points at, or null when it is unknown/inactive. */
export async function resolveReferrerByCode(raw: string): Promise<{ id: string; username: string } | null> {
  const code = normalizeReferralCode(raw)
  if (!code) return null
  const user = await prisma.user.findUnique({
    where: { referralCode: code },
    select: { id: true, username: true, status: true }
  })
  if (!user || user.status !== 'ACTIVE') return null
  return { id: user.id, username: user.username }
}

/**
 * Validate a code a player typed at signup. An unknown code is a real error the
 * player should see and fix, not a value to silently drop — unlike the code that
 * arrives pre-filled from the invite link, which the form sends only after the
 * player has had a chance to see it.
 */
export async function assertValidReferralCode(raw: string, newUsername: string): Promise<{ id: string; username: string }> {
  const referrer = await resolveReferrerByCode(raw)
  if (!referrer) throw new ReferralError('That invite code is not valid.')
  if (referrer.username.toLowerCase() === newUsername.trim().toLowerCase()) {
    throw new ReferralError('You cannot use your own invite code.')
  }
  return referrer
}

export interface ReferralRow {
  username: string
  joinedAt: string
  rewarded: boolean
  rewardedAt: string | null
}

export interface ReferralSummary {
  enabled: boolean
  code: string
  link: string
  bonusUsdt: number
  /** Everyone who signed up with this player's code. */
  invitedCount: number
  /** Of those, the ones whose first match has already paid the bonus. */
  rewardedCount: number
  /** Signed up but has not played yet — the bonus is still pending. */
  pendingCount: number
  earnedUsdt: number
  referrals: ReferralRow[]
}

function buildInviteLink(code: string): string {
  const base = config.CLIENT_ORIGIN.split(',')[0]?.trim() ?? ''
  return base ? `${base}/?ref=${encodeURIComponent(code)}` : `/?ref=${encodeURIComponent(code)}`
}

/**
 * The invite code for an account, minted on first use. Existing accounts from
 * before the programme get one lazily the first time they open the screen.
 */
export async function getOrCreateReferralCode(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } })
  if (!user) throw new ReferralError('account not found')
  if (user.referralCode) return user.referralCode

  const code = await pickReferralCode()
  // Guard against a concurrent mint: only the first writer's code wins.
  const updated = await prisma.user.updateMany({
    where: { id: userId, referralCode: null },
    data: { referralCode: code }
  })
  if (updated.count === 0) {
    const current = await prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } })
    if (current?.referralCode) return current.referralCode
  }
  return code
}

export async function getReferralSummary(userId: string): Promise<ReferralSummary> {
  const code = await getOrCreateReferralCode(userId)
  const referrals = await prisma.user.findMany({
    where: { referredById: userId },
    select: { username: true, createdAt: true, referralRewardedAt: true },
    orderBy: { createdAt: 'desc' }
  })

  const rewardedCount = referrals.filter((r) => r.referralRewardedAt).length
  return {
    enabled: config.REFERRAL_ENABLED !== false,
    code,
    link: buildInviteLink(code),
    bonusUsdt: config.REFERRAL_BONUS_USDT,
    invitedCount: referrals.length,
    rewardedCount,
    pendingCount: referrals.length - rewardedCount,
    earnedUsdt: rewardedCount * config.REFERRAL_BONUS_USDT,
    referrals: referrals.map((r) => ({
      username: r.username,
      joinedAt: r.createdAt.toISOString(),
      rewarded: Boolean(r.referralRewardedAt),
      rewardedAt: r.referralRewardedAt?.toISOString() ?? null
    }))
  }
}

/** What to tell the inviter after their bonus has actually been credited. */
export interface ReferralReward {
  referrerId: string
  inviteeUsername: string
  amount: number
}

/**
 * Pay the inviter for this player's first match.
 *
 * Runs inside the settlement transaction. The `referralRewardedAt` stamp is the
 * gate: a conditional update that only matches while it is still null means a
 * player can only ever trigger one reward, even if two settlements race. Returns
 * null when there is nothing to pay (no inviter, already rewarded, or racing
 * loser). The caller sends the notification after the transaction commits.
 */
export async function rewardReferralForFirstMatch(tx: Tx, inviteeId: string): Promise<ReferralReward | null> {
  if (config.REFERRAL_ENABLED === false) return null

  const invitee = await tx.user.findUnique({
    where: { id: inviteeId },
    select: { id: true, username: true, referredById: true, referralRewardedAt: true }
  })
  if (!invitee || !invitee.referredById || invitee.referralRewardedAt) return null

  const gate = await tx.user.updateMany({
    where: { id: inviteeId, referredById: { not: null }, referralRewardedAt: null },
    data: { referralRewardedAt: new Date() }
  })
  if (gate.count === 0) return null

  const amount = config.REFERRAL_BONUS_USDT
  await ledger.creditAvailable(tx, {
    userId: invitee.referredById,
    amount,
    type: 'REFERRAL_BONUS',
    refId: inviteeId,
    counterpartyId: inviteeId,
    meta: { inviteeUsername: invitee.username, stage: 'first_match' }
  })
  return { referrerId: invitee.referredById, inviteeUsername: invitee.username, amount }
}
