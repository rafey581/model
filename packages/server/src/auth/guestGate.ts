import { GUEST_STAKE_PROMPT } from '@snooker/shared'
import { prisma } from '../db/index.js'

/** The sentence a guest sees when they try anything that needs an account with a wallet. */
export async function guestStakeMessage(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { authProvider: true } })
  return user?.authProvider === 'GUEST' ? GUEST_STAKE_PROMPT : null
}
