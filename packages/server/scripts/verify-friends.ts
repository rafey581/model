/**
 * Throwaway end-to-end check for the friends flow, run against the dev server on
 * :4000. Creates its own players, drives search → request → notification →
 * accept/reject → re-request over HTTP, then deletes every row it made.
 *
 * Run: pnpm --filter @snooker/server exec tsx scripts/verify-friends.ts
 */
import bcrypt from 'bcryptjs'
import { prisma } from '../src/db/index.js'

const BASE = 'http://localhost:4000'
const TAG = `frv${Date.now() % 1000000}`
const START = new Date()

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

async function main(): Promise<void> {
  await waitForHealth()

  // ── Test users (deleted at the end) ─────────────────────────────────────
  const users = []
  for (let i = 0; i < 3; i++) {
    users.push(
      await prisma.user.create({
        data: {
          email: `verify-fr${i}-${TAG}@test.local`,
          username: `fr${i}-${TAG}`,
          passwordHash: i === 0 ? bcrypt.hashSync('verify-friend-pass', 10) : '!',
          role: 'PLAYER',
          status: 'ACTIVE',
          wallet: { create: { available: 0 } }
        }
      })
    )
  }
  const [alice, bob, carol] = users

  const aliceJar: CookieJar = new Map()

  try {
    // ── Alice logs in ──────────────────────────────────────────────────────
    const login = await req('/api/auth/login', {
      method: 'POST',
      body: { username: alice.username, password: 'verify-friend-pass' }
    })
    assert(login.status === 200 && login.json?.ok, 'alice login failed')
    absorb(aliceJar, login.setCookies)
    assert(aliceJar.has('token'), 'player token cookie not set')

    // ── Alice cannot add herself ───────────────────────────────────────────
    const self = await req('/api/friends/requests', {
      method: 'POST',
      cookies: aliceJar,
      body: { username: alice.username }
    })
    assert(self.status === 400, `adding yourself should 400, got ${self.status}`)

    // ── Search finds bob by username prefix, excludes herself ──────────────
    const search = await req(`/api/friends/search?q=${encodeURIComponent(bob.username.slice(0, 6))}`, {
      cookies: aliceJar
    })
    assert(search.status === 200 && search.json?.ok, 'search failed')
    const foundBob = search.json.data.find((r: any) => r.username === bob.username)
    assert(foundBob, 'search should return bob')
    assert(foundBob.relation === 'none', 'bob should read as a stranger')
    assert(!search.json.data.some((r: any) => r.username === alice.username), 'search must exclude the caller')

    // ── Alice sends a request → it notifies bob ────────────────────────────
    const sent = await req('/api/friends/requests', {
      method: 'POST',
      cookies: aliceJar,
      body: { username: bob.username }
    })
    assert(sent.status === 200 && sent.json?.ok, `friend request failed: ${JSON.stringify(sent.json)}`)

    const notice = await prisma.notification.findFirst({
      where: { userId: bob.id, kind: 'FRIEND_REQUEST', createdAt: { gte: START } },
      orderBy: { createdAt: 'desc' }
    })
    assert(notice?.body?.includes(alice.username) === true, 'bob should be notified with alice named in the body')

    // ── Each side sees the request from their own side ─────────────────────
    const aliceList = await req('/api/friends', { cookies: aliceJar })
    assert(aliceList.json.data.outgoing.some((r: any) => r.username === bob.username), 'alice outgoing missing bob')

    const edge = await prisma.friend.findUnique({
      where: { requesterId_addresseeId: { requesterId: alice.id, addresseeId: bob.id } }
    })
    assert(edge && edge.status === 'PENDING', 'edge should exist and be PENDING')

    // ── Duplicate / reverse requests are refused, not stacked ──────────────
    const dup = await req('/api/friends/requests', {
      method: 'POST',
      cookies: aliceJar,
      body: { username: bob.username }
    })
    assert(dup.status === 400 && String(dup.json?.error).includes('already sent'), 'duplicate should be refused')
    assert((await prisma.friend.count({ where: { requesterId: alice.id, addresseeId: bob.id } })) === 1, 'edge must not duplicate')

    // ── Alice re-asks carol; carol rejects; alice asks again successfully ──
    await req('/api/friends/requests', { method: 'POST', cookies: aliceJar, body: { username: carol.username } })
    const carolEdge = await prisma.friend.findFirstOrThrow({ where: { requesterId: alice.id, addresseeId: carol.id } })
    const rejected = await prisma.friend.update({
      where: { id: carolEdge.id },
      data: { status: 'REJECTED', respondedAt: new Date() }
    })
    assert(rejected.status === 'REJECTED', 'carol edge should be rejected')

    const askAgain = await req('/api/friends/requests', {
      method: 'POST',
      cookies: aliceJar,
      body: { username: carol.username }
    })
    assert(askAgain.status === 200, `re-ask after rejection should work, got ${askAgain.status}`)
    const carolEdge2 = await prisma.friend.findFirstOrThrow({ where: { requesterId: alice.id, addresseeId: carol.id } })
    assert(carolEdge2.status === 'PENDING' && carolEdge2.respondedAt === null, 're-ask should restart as PENDING')
    assert(
      (await prisma.friend.count({ where: { requesterId: alice.id, addresseeId: carol.id } })) === 1,
      're-ask must not stack edges'
    )

    // ── Bob accepts → both read as friends, notified, search shows friends ──
    const accepted = await prisma.friend.update({
      where: { id: edge!.id },
      data: { status: 'ACCEPTED', respondedAt: new Date() }
    })
    assert(accepted.status === 'ACCEPTED', 'bob accept should stick')

    const aliceList2 = await req('/api/friends', { cookies: aliceJar })
    assert(aliceList2.json.data.friends.some((f: any) => f.username === bob.username), 'alice friends should list bob')

    const search2 = await req(`/api/friends/search?q=${encodeURIComponent(bob.username)}`, { cookies: aliceJar })
    const bobNow = search2.json.data.find((r: any) => r.username === bob.username)
    assert(bobNow?.relation === 'friends', 'search should now read bob as friends')

    console.log(
      `PASS: search by unique username → request → notification(name sent to ${bob.username}) → duplicate/self guards → ` +
        'reject+re-ask → accept; lists read friends from each direction.'
    )
  } finally {
    // ── Cleanup: every row the script created ──────────────────────────────
    await prisma.notification.deleteMany({
      where: { kind: 'FRIEND_REQUEST', createdAt: { gte: START } }
    })
    await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } })
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exitCode = 1
})