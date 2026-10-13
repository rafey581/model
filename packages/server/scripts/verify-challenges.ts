/**
 * Throwaway end-to-end check for the match-challenge flow (broadcast tables and
 * friend invites), run against the dev server on :4000. Creates its own players,
 * drives create → incoming list → accept (money) → cancel / decline over HTTP,
 * then deletes every row it made.
 *
 * Run: pnpm --filter @snooker/server exec tsx scripts/verify-challenges.ts
 */
import bcrypt from 'bcryptjs'
import { prisma } from '../src/db/index.js'

const BASE = 'http://localhost:4000'
const TAG = `chv${Date.now() % 1000000}`
const PASSWORD = 'verify-chal-pass'

type CookieJar = Map<string, string>

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return
    } catch {
      /* server not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('server did not become healthy in time')
}

async function req(
  path: string,
  opts: { method?: string; body?: unknown; cookies?: CookieJar } = {}
): Promise<{ status: number; json: any; setCookies: string[] }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.cookies && opts.cookies.size > 0) {
    headers.Cookie = [...opts.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  })
  const setCookies: string[] = []
  for (const c of res.headers.getSetCookie()) {
    const kv = c.split(';')[0]
    if (kv) setCookies.push(kv)
  }
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, json, setCookies }
}

function absorb(jar: CookieJar, setCookies: string[]): void {
  for (const c of setCookies) {
    const eq = c.indexOf('=')
    if (eq === -1) continue
    const key = c.slice(0, eq)
    if (c.toLowerCase().includes('max-age=0') || c.toLowerCase().includes('expires=thu, 01 jan 1970')) jar.delete(key)
    else jar.set(key, c.slice(eq + 1))
  }
}

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${message}`)
}

async function login(username: string): Promise<CookieJar> {
  const res = await req('/api/auth/login', { method: 'POST', body: { username, password: PASSWORD } })
  assert(res.status === 200 && res.json?.ok, `login failed for ${username}`)
  const jar: CookieJar = new Map()
  absorb(jar, res.setCookies)
  assert(jar.has('token'), `no token cookie for ${username}`)
  return jar
}

async function main(): Promise<void> {
  await waitForHealth()

  const hash = bcrypt.hashSync(PASSWORD, 10)
  const makeUser = (name: string, available: number) =>
    prisma.user.create({
      data: {
        email: `verify-ch-${name}-${TAG}@test.local`,
        username: `${name}-${TAG}`,
        passwordHash: hash,
        role: 'PLAYER',
        status: 'ACTIVE',
        wallet: { create: { available } }
      }
    })

  const alice = await makeUser('alice', 10)
  const bob = await makeUser('bob', 10)
  const carol = await makeUser('carol', 10)
  const poor = await makeUser('poor', 0)
  const users = [alice, bob, carol, poor]
  const matches: string[] = []

  try {
    // ── Auth guard ─────────────────────────────────────────────────────────
    const anon = await req('/api/challenges/incoming')
    assert(anon.status === 401, `incoming must be 401 unauthenticated, got ${anon.status}`)

    const aliceJar = await login(alice.username)
    const bobJar = await login(bob.username)
    const carolJar = await login(carol.username)
    const poorJar = await login(poor.username)

    // ── Alice broadcasts a public table ────────────────────────────────────
    const created = await req('/api/challenges', {
      method: 'POST',
      cookies: aliceJar,
      body: { stakeTier: 'TIER_1', format: 'BO1' }
    })
    assert(created.status === 200 && created.json?.ok, `create failed: ${JSON.stringify(created.json)}`)
    const challenge = created.json.data
    assert(challenge.kind === 'PUBLIC', 'should be a public challenge')
    assert(challenge.challengerUsername === alice.username, 'challenge should name alice')
    assert(challenge.stakePerPlayer === 1, 'TIER_1 should be 1 USDT')
    assert(challenge.stakeLabel === '1 USDT', `stake label wrong: ${challenge.stakeLabel}`)

    // ── Others see it, the challenger does not ─────────────────────────────
    const bobIncoming = await req('/api/challenges/incoming', { cookies: bobJar })
    assert(bobIncoming.json.data.some((c: any) => c.id === challenge.id), 'bob should see the public table')
    const carolIncoming = await req('/api/challenges/incoming', { cookies: carolJar })
    assert(carolIncoming.json.data.some((c: any) => c.id === challenge.id), 'carol should see the public table')
    const aliceIncoming = await req('/api/challenges/incoming', { cookies: aliceJar })
    assert(!aliceIncoming.json.data.some((c: any) => c.id === challenge.id), 'alice must not see her own table')

    // ── Nothing is staked while the table waits ────────────────────────────
    const waitingWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: alice.id } })
    assert(waitingWallet.locked.toNumber() === 0, 'no stake may be frozen on an open table')

    // ── Bob accepts → the match exists and both stakes are frozen ──────────
    const accepted = await req(`/api/challenges/${challenge.id}/accept`, { method: 'POST', cookies: bobJar, body: {} })
    assert(accepted.status === 200 && accepted.json?.ok, `accept failed: ${JSON.stringify(accepted.json)}`)
    const matchId = accepted.json.data.matchId
    matches.push(matchId)
    assert(accepted.json.data.opponentUsername === alice.username, 'bob should see alice as the opponent')

    const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId }, include: { players: true } })
    assert(match.status === 'MATCH_STARTED', `match should be started, got ${match.status}`)
    assert(match.players.length === 2, 'match should hold two players')
    assert(match.stakePerPlayer.toNumber() === 1, 'match stake should be 1 USDT')

    for (const u of [alice, bob]) {
      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: u.id } })
      assert(wallet.locked.toNumber() === 1, `${u.username} should have 1 USDT frozen`)
      assert(wallet.available.toNumber() === 9, `${u.username} should have 9 USDT available`)
    }

    // ── The table is single-use ────────────────────────────────────────────
    const secondAccept = await req(`/api/challenges/${challenge.id}/accept`, { method: 'POST', cookies: carolJar, body: {} })
    assert(secondAccept.status === 400, `a taken table must refuse a second accept, got ${secondAccept.status}`)

    // ── Cancel path ────────────────────────────────────────────────────────
    const open2 = await req('/api/challenges', { method: 'POST', cookies: aliceJar, body: { stakeTier: 'TIER_1', format: 'BO1' } })
    const challenge2 = open2.json.data
    const foreignCancel = await req(`/api/challenges/${challenge2.id}/cancel`, { method: 'POST', cookies: bobJar, body: {} })
    assert(foreignCancel.status === 400, 'only the challenger may cancel')
    const cancelled = await req(`/api/challenges/${challenge2.id}/cancel`, { method: 'POST', cookies: aliceJar, body: {} })
    assert(cancelled.status === 200, 'the challenger may cancel')
    const acceptCancelled = await req(`/api/challenges/${challenge2.id}/accept`, { method: 'POST', cookies: bobJar, body: {} })
    assert(acceptCancelled.status === 400, 'a cancelled table cannot be accepted')

    // ── Friend invite goes only to the friend ──────────────────────────────
    await prisma.friend.create({
      data: { requesterId: alice.id, addresseeId: bob.id, status: 'ACCEPTED', respondedAt: new Date() }
    })
    const invite = await req('/api/challenges', {
      method: 'POST',
      cookies: aliceJar,
      body: { stakeTier: 'TIER_1', format: 'BO1', targetUsername: bob.username }
    })
    assert(invite.status === 200 && invite.json?.ok, `friend invite failed: ${JSON.stringify(invite.json)}`)
    assert(invite.json.data.kind === 'FRIEND', 'friend invite should be FRIEND')
    assert(invite.json.data.targetUsername === bob.username, 'invite should name the friend')

    const bobInvite = await req('/api/challenges/incoming', { cookies: bobJar })
    assert(bobInvite.json.data.some((c: any) => c.id === invite.json.data.id), 'the friend should see the invite')
    const carolInvite = await req('/api/challenges/incoming', { cookies: carolJar })
    assert(!carolInvite.json.data.some((c: any) => c.id === invite.json.data.id), 'a stranger must not see the invite')
    const carolTakeInvite = await req(`/api/challenges/${invite.json.data.id}/accept`, {
      method: 'POST',
      cookies: carolJar,
      body: {}
    })
    assert(carolTakeInvite.status === 400, 'a stranger must not take a friend invite')

    const declined = await req(`/api/challenges/${invite.json.data.id}/decline`, { method: 'POST', cookies: bobJar, body: {} })
    assert(declined.status === 200, 'the friend may decline')
    const declinedRow = await prisma.matchChallenge.findUniqueOrThrow({ where: { id: invite.json.data.id } })
    assert(declinedRow.status === 'DECLINED', 'declined invite should be DECLINED')

    // ── Guards: only friends, and the stake must be coverable ──────────────
    const strangerInvite = await req('/api/challenges', {
      method: 'POST',
      cookies: aliceJar,
      body: { stakeTier: 'TIER_1', format: 'BO1', targetUsername: carol.username }
    })
    assert(strangerInvite.status === 400, 'inviting a non-friend must fail')
    const selfInvite = await req('/api/challenges', {
      method: 'POST',
      cookies: aliceJar,
      body: { stakeTier: 'TIER_1', format: 'BO1', targetUsername: alice.username }
    })
    assert(selfInvite.status === 400, 'inviting yourself must fail')

    const broke = await req('/api/challenges', { method: 'POST', cookies: poorJar, body: { stakeTier: 'TIER_1', format: 'BO1' } })
    assert(broke.status === 400 && String(broke.json?.error).includes('USDT'), 'an uncoverable table must be refused')

    console.log(
      'PASS: broadcast table → visible to others only → accept freezes both stakes + starts match → single-use; ' +
        'cancel by owner only; friend invite delivered only to the friend, declined by them; non-friend/self/underfunded refused.'
    )
  } finally {
    if (matches.length > 0) await prisma.match.deleteMany({ where: { id: { in: matches } } })
    await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } })
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exitCode = 1
})
