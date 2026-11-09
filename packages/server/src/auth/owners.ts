/**
 * Who may use the admin app.
 *
 * The list is an explicit set of account ids in `OWNER_USER_IDS`. Nothing else
 * qualifies: not a role, not the seed email, not the oldest admin, not "whoever
 * is already signed in". An empty or unreadable value means nobody, so a deploy
 * cannot silently hand the app to an account that happens to be in the database.
 *
 * Read on every check, not frozen at import, so a process started with the
 * variable set keeps using the value the operator exported. Tests bind a
 * disposable id the same way.
 */

import { prisma } from '../db/index.js'

const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

export function ownerUserIds(): string[] {
  const raw = process.env.OWNER_USER_IDS ?? ''
  const seen = new Set<string>()
  const ids: string[] = []
  for (const part of raw.split(',')) {
    const id = part.trim()
    if (!id || seen.has(id) || !ID_PATTERN.test(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

export function isOwnerUser(userId: string | null | undefined): boolean {
  if (!userId) return false
  return ownerUserIds().includes(userId)
}

/** Test and script helper. Production sets the variable in the environment. */
export function bindOwnerUserIds(ids: readonly string[]): void {
  process.env.OWNER_USER_IDS = ids.join(',')
}

/**
 * Boot warning. The raw variable is never included: a typo could be a secret,
 * and the ids themselves are the whole of the staff allowlist.
 */
export function ownerConfigWarning(): string | null {
  const raw = (process.env.OWNER_USER_IDS ?? '').trim()
  if (!raw) {
    return 'OWNER_USER_IDS is empty: the admin app will refuse every sign-in until you set the owner account id.'
  }
  const parts = raw.split(',').map((part) => part.trim()).filter((part) => part.length > 0)
  const accepted = ownerUserIds()
  if (accepted.length === 0) {
    return 'OWNER_USER_IDS is set but none of the values are account ids. The admin app will refuse every sign-in.'
  }
  if (accepted.length < parts.length) {
    return 'OWNER_USER_IDS contains values that were ignored. Only account ids are accepted.'
  }
  return null
}

/** How many of the configured ids are real accounts. The ids themselves are not logged. */
export async function ownerAccountWarning(): Promise<string | null> {
  const ids = ownerUserIds()
  if (ids.length === 0) return null
  const found = await prisma.user.count({ where: { id: { in: ids } } })
  if (found === 0) {
    return `OWNER_USER_IDS lists ${ids.length} id(s) and none match an account. Staff sign-in will fail until an id is the account's own id.`
  }
  if (found < ids.length) {
    return `OWNER_USER_IDS lists ${ids.length} id(s) and ${found} match an account.`
  }
  return null
}
