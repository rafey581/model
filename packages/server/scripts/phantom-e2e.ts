/**
 * End-to-end Phantom sign-in against the running dev server.
 *
 * The vitest suite uses app.inject(), which proves the routes and the crypto but
 * not that a real HTTP server, the real Vite proxy and the real database agree.
 * This drives the live process with a real ed25519 keypair and leaves behind exactly
 * one test user, which it then deletes.
 *
 *   pnpm exec tsx scripts/phantom-e2e.ts
 */

import { generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { decodeBase58, encodeBase58 } from '../src/auth/base58.js'

const BASE = process.env.SERVER_ORIGIN ?? 'http://localhost:4000'
const prisma = new PrismaClient()

function base58(bytes: Uint8Array): string {
  return encodeBase58(bytes)
}

async function post(path: string, body: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await res.text()
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    data = text
  }
  return { status: res.status, data }
}

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`)
  }
}

const created: string[] = []

async function main(): Promise<void> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const address = base58(new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)))
  console.log(`Wallet address: ${address}\n`)

  console.log('providers')
  const providers = await (await fetch(`${BASE}/api/auth/providers`)).json()
  const phantom = providers?.data?.providers?.find((p: any) => p.id === 'phantom')
  check('phantom is advertised', phantom?.enabled === true, JSON.stringify(providers))
  check('it declares only the address', JSON.stringify(phantom?.provides) === '["wallet address (public key)"]', JSON.stringify(phantom?.provides))

  console.log('\nchallenge')
  const bad = await post('/api/auth/phantom/challenge', { address: 'nope' })
  check('a malformed address is refused', bad.status === 400, String(bad.status))

  const challenge = await post('/api/auth/phantom/challenge', { address })
  check('a valid address gets a challenge', challenge.status === 200, JSON.stringify(challenge.data))
  const message = challenge.data?.data?.message as string
  const token = challenge.data?.data?.challenge as string
  check('the message names the wallet', typeof message === 'string' && message.includes(address))
  check('the message says it costs nothing', /will not trigger a blockchain transaction/.test(message ?? ''))
  check('the server echoes the same address', challenge.data?.data?.address === address)

  console.log('\nverify')
  const mallory = generateKeyPairSync('ed25519')
  const forged = base58(new Uint8Array(edSign(null, Buffer.from(message, 'utf8'), mallory.privateKey)))
  const forgedRes = await post('/api/auth/phantom/verify', { challenge: token, signature: forged })
  check('another wallet signature is refused', forgedRes.status === 401, String(forgedRes.status))

  const junk = base58(new Uint8Array(randomBytes(64)))
  const junkRes = await post('/api/auth/phantom/verify', { challenge: token, signature: junk })
  check('garbage is refused identically', junkRes.status === forgedRes.status, `${junkRes.status} vs ${forgedRes.status}`)

  const signature = base58(new Uint8Array(edSign(null, Buffer.from(message, 'utf8'), privateKey)))
  check('the signature is 64 bytes', decodeBase58(signature).length === 64)

  const verified = await post('/api/auth/phantom/verify', { challenge: token, signature })
  check('a genuine signature verifies', verified.status === 200, JSON.stringify(verified.data))
  const pendingToken = verified.data?.data?.pendingToken as string
  const suggested = verified.data?.data?.suggestedUsername as string
  check('a first-time wallet is parked for a username', typeof pendingToken === 'string' && pendingToken.length > 0)
  check('it is given a username suggestion', /^[a-zA-Z0-9_]{3,24}$/.test(suggested ?? ''), suggested)
  created.push(pendingToken)

  console.log('\nreplay')
  const replay = await post('/api/auth/phantom/verify', { challenge: token, signature })
  check('the same challenge cannot be replayed', replay.status === 401, String(replay.status))

  console.log('\ncomplete')
  const username = `e2e${randomBytes(3).toString('hex')}`
  const badUsername = await post('/api/auth/complete', { pendingToken, username: 'admin' })
  check('a reserved username is refused', badUsername.status === 400, JSON.stringify(badUsername.data))

  const complete = await post('/api/auth/complete', { pendingToken, username })
  check('a valid username completes signup', complete.status === 200, JSON.stringify(complete.data))
  const user = complete.data?.data?.user
  const sessionToken = complete.data?.data?.token as string
  check('the account is a player', complete.data?.data?.user?.role === 'PLAYER', user?.role)
  check('it has no email', user?.email === null || user?.email === undefined, String(user?.email))
  check('a session token is issued', typeof sessionToken === 'string' && sessionToken.split('.').length === 3)

  const row = await prisma.user.findUnique({ where: { username }, include: { wallet: true } })
  if (row) created.push(row.id)
  check('the account is keyed on (provider, address)', row?.authProvider === 'PHANTOM' && row?.providerAccountId === address, `${row?.authProvider}/${row?.providerAccountId}`)
  // `available` is a Decimal, so Prisma hands back a Prisma.Decimal rather than a
  // number. Comparing it with `===` against 1000 is always false, which is exactly
  // the sort of assertion that quietly stops testing anything.
  const balance = row?.wallet?.available?.toNumber()
  check('it got the opening balance', balance === 1000, String(balance))
  const ledger = await prisma.walletTransaction.count({ where: { userId: row?.id } })
  check('the opening balance has a ledger entry', ledger === 1, String(ledger))

  console.log('\nreturning player')
  const second = await post('/api/auth/phantom/challenge', { address })
  const msg2 = second.data?.data?.message as string
  const tok2 = second.data?.data?.challenge as string
  const sig2 = base58(new Uint8Array(edSign(null, Buffer.from(msg2, 'utf8'), privateKey)))
  const again = await post('/api/auth/phantom/verify', { challenge: tok2, signature: sig2 })
  check('the same wallet signs straight in', again.status === 200 && typeof again.data?.data?.token === 'string', JSON.stringify(again.data))

  const statusRes = await fetch(`${BASE}/api/auth/status`, {
    headers: { authorization: `Bearer ${sessionToken}` }
  })
  const statusBody = await statusRes.json()
  check('the token authenticates a real request', statusRes.status === 200 && statusBody?.data?.user?.username === username, JSON.stringify(statusBody))
}

main()
  .catch((error) => {
    console.error('\nScript failed:', error)
    failures += 1
  })
  .finally(async () => {
    // Leave the database as it was found. A failed run must not leave a half-made
    // account behind that the next person trips over.
    for (const id of created) {
      if (id.startsWith('ey')) continue
      await prisma.walletTransaction.deleteMany({ where: { userId: id } })
      await prisma.adminAction.deleteMany({ where: { targetId: id } })
      await prisma.user.deleteMany({ where: { id } })
    }
    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
    await prisma.$disconnect()
    process.exit(failures === 0 ? 0 : 1)
  })
