/**
 * Print an account id so it can be copied into OWNER_USER_IDS.
 *
 * This does not change the account, its role, or its password, and it does not
 * decide that the account is the owner. Run it on the server you operate:
 *
 *   pnpm exec tsx scripts/show-user-id.ts --email you@example.com
 */
import { prisma } from '../src/db/index.js'

function emailArg(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--email') return argv[i + 1] ?? null
  }
  return null
}

async function main(): Promise<void> {
  const email = emailArg(process.argv.slice(2))?.trim().toLowerCase()
  if (!email) {
    console.error('usage: tsx scripts/show-user-id.ts --email you@example.com')
    process.exit(1)
  }
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, username: true, role: true, status: true }
  })
  if (!user) {
    console.error(`error: no account with email ${email}`)
    process.exit(1)
  }
  console.log(`id: ${user.id}`)
  console.log(`username: ${user.username}`)
  console.log(`role: ${user.role}`)
  console.log(`status: ${user.status}`)
  console.log('Staff access starts only after OWNER_USER_IDS includes this id and the server is restarted.')
  await prisma.$disconnect()
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
