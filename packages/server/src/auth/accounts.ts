import { Prisma } from '@prisma/client'
import { prisma } from '../db/index.js'
import { config } from '../config.js'
import type { GoogleIdentity } from './google.js'
import type { ProviderIdentity } from './pending.js'

/**
 * Turning a verified provider identity into a local account.
 *
 * The one rule that matters here: **identity is `(authProvider, providerAccountId)`,
 * never email.** Email is a mutable, user-controlled field, so matching on it would
 * let anyone claim an existing account by registering the same address with a
 * provider. The consequence is deliberate - signing in with Google using the same
 * address as an existing password account creates a *separate* player account
 * rather than silently inheriting it, because a verified provider address is still
 * not proof that the two belong to the same person.
 *
 * Everything here is provider-agnostic. Google contributes a `sub` and an email;
 * Phantom contributes a Solana address and nothing else. Both land in the same two
 * columns, so adding a third provider means writing its verification and nothing
 * more.
 */

export const GOOGLE_PROVIDER = 'GOOGLE'
export const PHANTOM_PROVIDER = 'PHANTOM'

/** Normalises either provider's native shape into the one identity we store. */
export function identityFromGoogle(identity: GoogleIdentity): ProviderIdentity {
  return {
    provider: GOOGLE_PROVIDER,
    subject: identity.sub,
    email: identity.email,
    emailVerified: identity.emailVerified,
    name: identity.name,
    picture: identity.picture
  }
}

export function identityFromPhantom(address: string): ProviderIdentity {
  // A wallet has no name, no email and no avatar. It contributes exactly one thing:
  // proof that whoever holds the private key signed our challenge.
  return {
    provider: PHANTOM_PROVIDER,
    subject: address,
    email: null,
    emailVerified: false,
    name: null,
    picture: null
  }
}

export async function findByProviderIdentity(provider: string, subject: string) {
  return prisma.user.findUnique({
    where: { authProvider_providerAccountId: { authProvider: provider, providerAccountId: subject } }
  })
}

export interface CreateProviderUserInput {
  identity: ProviderIdentity
  username: string
}

/**
 * Creates the account, its profile, its wallet and the opening ledger entry in one
 * transaction.
 *
 * The ledger row is not decoration: `wallet/ledger.test.ts` asserts that every
 * balance movement has a matching entry, so a wallet created without it fails the
 * suite and breaks the audit trail that settlement depends on.
 */
export async function createProviderUser({ identity, username }: CreateProviderUserInput) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: identity.email,
        username,
        authProvider: identity.provider,
        providerAccountId: identity.subject,
        profile: {
          create: {
            avatarUrl: identity.picture,
            // No country to infer from a provider, and inferring one from a locale
            // would be a guess. KYB stays a separate step.
            countryCode: null
          }
        },
        wallet: { create: { available: config.CR_START_BALANCE } }
      }
    })
    await tx.walletTransaction.create({
      data: {
        userId: user.id,
        type: 'START_BALANCE',
        amount: config.CR_START_BALANCE,
        currency: 'CR',
        status: 'COMPLETED',
        balanceBefore: 0,
        balanceAfter: config.CR_START_BALANCE,
        meta: { description: 'welcome virtual balance', provider: identity.provider }
      }
    })
    return user
  })
}

/**
 * Creates the account, tolerating a lost race.
 *
 * Two requests for the same provider identity, or the same username picked twice,
 * both pass the pre-checks and then collide on the unique index. Catching P2002 and
 * re-reading turns that into "log in as the account that won" instead of a 500,
 * which is the difference between a confusing error and a working login.
 */
export async function createProviderUserOrReadExisting(input: CreateProviderUserInput) {
  try {
    return { user: await createProviderUser(input), created: true as const }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = (error.meta?.target as string[] | undefined) ?? []
      // The collision was on the provider identity: the account already exists and
      // the other request simply got there first.
      if (target.includes('providerAccountId')) {
        const existing = await findByProviderIdentity(input.identity.provider, input.identity.subject)
        if (existing) return { user: existing, created: false as const }
      }
      throw new UsernameTakenError()
    }
    throw error
  }
}

export class UsernameTakenError extends Error {
  constructor() {
    super('That username is already taken.')
    this.name = 'UsernameTakenError'
  }
}

/**
 * Refreshes the cached provider profile on sign-in, without ever touching role.
 *
 * Google-only: it is the only provider that has a picture or an email to refresh.
 * A wallet sign-in changes nothing, which is itself worth recording - the account is
 * keyed on the address, so there is no profile data that can drift.
 */
export async function refreshGoogleProfile(userId: string, identity: GoogleIdentity): Promise<void> {
  if (!identity.picture && !identity.email) return
  await prisma.user.update({
    where: { id: userId },
    data: {
      email: identity.email,
      profile: { update: { avatarUrl: identity.picture } }
    }
  })
}