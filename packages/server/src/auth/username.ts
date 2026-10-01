import { prisma } from '../db/index.js'

/**
 * Username rules, in one place.
 *
 * A username is a player's public handle: it is shown next to their shots in the
 * lobby, printed on tournament brackets and put in URL-ish places. That makes it
 * the one field where "unique" has to be taken literally, including case - which
 * the database now enforces through `User_username_lower_key`.
 */

export const USERNAME_MIN = 3
export const USERNAME_MAX = 24

const PATTERN = /^[a-zA-Z0-9_]+$/

/**
 * Names that would be misleading or impersonate a real surface of the product.
 * Matched case-insensitively against the folded form.
 */
const RESERVED = new Set([
  'admin',
  'administrator',
  'root',
  'superadmin',
  'system',
  'moderator',
  'mod',
  'staff',
  'support',
  'official',
  'snooker',
  'arena',
  'platform',
  'bot',
  'robot',
  'null',
  'undefined',
  'anonymous',
  'api',
  'help',
  'login',
  'logout',
  'register',
  'signup',
  'me',
  'settings'
])

/** The case-insensitive key the database actually indexes. */
export function foldUsername(username: string): string {
  return username.trim().toLowerCase()
}

export function isValidUsernameFormat(username: string): boolean {
  return (
    username.length >= USERNAME_MIN &&
    username.length <= USERNAME_MAX &&
    PATTERN.test(username) &&
    !RESERVED.has(foldUsername(username))
  )
}

export type UsernameProblem =
  | 'too_short'
  | 'too_long'
  | 'bad_characters'
  | 'reserved'
  | 'taken'
  | 'invalid'

const MESSAGES: Record<UsernameProblem, string> = {
  too_short: `Username must be at least ${USERNAME_MIN} characters.`,
  too_long: `Username must be ${USERNAME_MAX} characters or fewer.`,
  bad_characters: 'Username can only use letters, numbers and underscores.',
  reserved: 'That username is reserved.',
  taken: 'That username is already taken.',
  invalid: 'Invalid username.'
}

/**
 * Validates format and availability in one call.
 *
 * Availability is checked against `lower(username)` rather than the raw column so
 * the answer matches what the unique index will actually do on insert. Relying on
 * the insert to throw instead would mean surfacing a raw constraint violation to
 * the player, and the race would still be lost - this narrows the window, and the
 * database closes it.
 */
export async function checkUsername(
  username: string
): Promise<{ available: boolean; problem?: UsernameProblem; message?: string }> {
  const value = username.trim()
  if (value.length < USERNAME_MIN) return { available: false, problem: 'too_short', message: MESSAGES.too_short }
  if (value.length > USERNAME_MAX) return { available: false, problem: 'too_long', message: MESSAGES.too_long }
  if (!PATTERN.test(value)) {
    return { available: false, problem: 'bad_characters', message: MESSAGES.bad_characters }
  }
  if (RESERVED.has(foldUsername(value))) {
    return { available: false, problem: 'reserved', message: MESSAGES.reserved }
  }
  const taken = await prisma.user.findFirst({ where: { username: { equals: value, mode: 'insensitive' } } })
  if (taken) return { available: false, problem: 'taken', message: MESSAGES.taken }
  return { available: true }
}

/** Strips anything the pattern would reject, so provider input can be used as a seed. */
function sanitizeSeed(seed: string): string {
  return seed
    .normalize('NFKD')
    // Accented latin decomposes to base letters plus combining marks; dropping the
    // marks is what turns "José" into the "Jose" that matches the allowed pattern.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, USERNAME_MAX)
}

/**
 * Builds a username that is free right now, derived from provider input.
 *
 * Used to pre-fill the username field on a first Google sign-in. The suffix walk is
 * bounded so a deliberately squatted name like `player1`..`player9` cannot turn
 * this into an unbounded query loop.
 */
export async function suggestUsername(seed: string): Promise<string> {
  const base = sanitizeSeed(seed)
  const stem = (base.length >= USERNAME_MIN ? base : base + 'player').slice(0, USERNAME_MAX - 4)

  for (let n = 0; n < 50; n += 1) {
    const candidate = n === 0 ? stem : `${stem}${n}`
    if (candidate.length < USERNAME_MIN) continue
    if (RESERVED.has(foldUsername(candidate))) continue
    const taken = await prisma.user.findFirst({
      where: { username: { equals: candidate, mode: 'insensitive' } }
    })
    if (!taken) return candidate
  }
  // Nothing free in the numeric suffix space: fall back to randomness, which is
  // effectively guaranteed to hit a free slot given the keyspace.
  return `${stem}${Math.floor(Math.random() * 9000 + 1000)}`.slice(0, USERNAME_MAX)
}
