/**
 * Operator tool: set an admin's password.
 *
 * Why this exists. `prisma/seed.ts` takes the password from `SEED_ADMIN_PASSWORD`
 * and the seed uses `update: {}`, so re-seeding cannot change a password that was
 * set once at seed time - and a bcrypt hash is one-way, so a forgotten password
 * cannot be recovered. When that happens the only routes back in are this script
 * or a direct database edit. This is the scripted one, and it is auditable.
 *
 * Usage, from packages/server:
 *
 *   pnpm exec tsx scripts/set-admin-password.ts --email admin@snooker.test --password '...'
 *
 *   # generate a strong password instead of typing one
 *   pnpm exec tsx scripts/set-admin-password.ts --email admin@snooker.test --generate
 *
 * Deliberately not a general "edit any user" tool: it refuses every account that
 * is not listed in OWNER_USER_IDS, and it refuses to touch roles or balances, so
 * it cannot be repurposed into a way of minting an admin or moving money.
 * Set OWNER_USER_IDS to the account id (see show-user-id.ts) before running it.
 */
import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { prisma } from '../src/db/index.js'
import { isOwnerUser } from '../src/auth/owners.js'
import { clearAccountFailures } from '../src/auth/loginThrottle.js'

interface Args {
  email: string | null
  password: string | null
  generate: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { email: null, password: null, generate: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const next = (): string => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${flag} needs a value`)
      }
      i += 1
      return value
    }
    if (flag === '--email') args.email = next()
    else if (flag === '--password') args.password = next()
    else if (flag === '--generate') args.generate = true
    else if (flag === '--help' || flag === '-h') {
      printUsage()
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${flag}`)
    }
  }
  return args
}

function printUsage(): void {
  console.log(`
Set an admin password.

  --email <address>     the admin account to update (required)
  --password <value>    the new password; omit to use --generate
  --generate            generate a strong password and print it once
`)
}

/**
 * 20 bytes of CSPRNG output, base64url encoded.
 *
 * 160 bits is far past anything a human types, which is the point: a generated
 * admin password should not be a memorable string, because it is written to the
 * console exactly once and never stored anywhere recoverable.
 */
function generatePassword(): string {
  return randomBytes(20).toString('base64url')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (!args.email) {
    console.error('error: --email is required\n')
    printUsage()
    process.exit(1)
  }
  if (!args.password && !args.generate) {
    console.error('error: pass --password <value> or --generate\n')
    printUsage()
    process.exit(1)
  }
  if (args.password !== null && args.password.length < 12) {
    // bcrypt truncates at 72 bytes, and anything shorter than this is not worth
    // putting in front of the panel that can change money.
    console.error('error: password must be at least 12 characters')
    process.exit(1)
  }

  const email = args.email.trim().toLowerCase()
  const existing = await prisma.user.findUnique({ where: { email } })
  if (!existing) {
    console.error(`error: no account with email ${email}`)
    process.exit(1)
  }
  if (!isOwnerUser(existing.id)) {
    // The id is printed because the operator already named the email and needs
    // it to fill OWNER_USER_IDS. The password is not printed here.
    console.error(`error: ${email} is not listed in OWNER_USER_IDS, so this script will not change it.`)
    console.error('If this is the owner account, set OWNER_USER_IDS to the id below, restart the server, then run this script again.')
    console.error(`id: ${existing.id}`)
    process.exit(1)
  }

  const password = args.generate ? generatePassword() : (args.password as string)
  const passwordHash = bcrypt.hashSync(password, 10)

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: existing.id },
      data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null, tokenVersion: { increment: 1 } }
    })
    await tx.session.deleteMany({ where: { userId: existing.id, purpose: 'ADMIN' } })
    await tx.adminAction.create({
      data: {
        adminId: existing.id,
        action: 'admin.password.reset',
        targetType: 'User',
        targetId: existing.id,
        meta: {
          email,
          // Deliberately no password or hash in the audit trail.
          via: 'scripts/set-admin-password.ts'
        }
      }
    })
  })
  await clearAccountFailures('staff', `email:${email}`)
  await clearAccountFailures('player', `email:${email}`)
  await clearAccountFailures('player', `user:${existing.username.toLowerCase()}`)

  console.log(`updated ${email} (${existing.username}, ${existing.role})`)
  if (args.generate) {
    console.log('\n  password (shown once, not stored anywhere):')
    console.log(`  ${password}\n`)
  }
  console.log('sign in from the admin app with this email and password')

  await prisma.$disconnect()
}

main().catch(async (error) => {
  console.error('failed:', error)
  await prisma.$disconnect()
  process.exit(1)
})
