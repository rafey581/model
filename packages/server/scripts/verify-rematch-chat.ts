/**
 * Throwaway end-to-end check for the rematch + quick-chat features, run against
 * the dev server on :4000.
 *
 * Rematch: two players settle a match, then the winner opens a targeted invite
 * at the same stake/format with `rematch: true` — which must work WITHOUT the two
 * being friends, must be refused for a third party, and must then be accepted
 * into a fresh staked match. Friendship is still required for a normal invite.
 *
 * Quick chat: two sockets sit in a match and trade a phrase (id in → text out).
 * A phrase id that is not on the shared whitelist is refused with `bad_phrase`,
 * and the per-user cooldown refuses a second line inside the window.
 *
 * Run: pnpm --filter @snooker/server exec tsx scripts/verify-rematch-chat.ts
 */
import { io as connectIo } from 'socket.io-client'
import type { Socket } from 'socket.io-client'
import { prisma } from '../src/db/index.js'
import { createOneVsOneMatch, joinOneVsOneMatch, settleMatch } from '../src/matches/service.js'
import { ledger, runInTransaction } from '../src/wallet/service.js'

const BASE = 'http://localhost:4000'
const TAG = `rmv${Date.now() % 1000000}`
const PASSWORD = 'verify-rematch-chat-pass'

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

async function register(username: string, email: string): Promise<{ id: string; username: string }> {
  const res = await req('/api/auth/register', {
    method: 'POST',
    body: { username, email, password: PASSWORD }
  })
  assert(res.status === 200 && res.json?.ok, `register ${username} failed: ${res.status} ${JSON.stringify(res.json)}`)
  return { id: res.json.data.user.id, username }
}

async function login(username: string): Promise<{ jar: CookieJar; token: string }> {
  const jar: CookieJar = new Map()
  const login = await req('/api/auth/login', { method: 'POST', body: { username, password: PASSWORD } })
  assert(login.status === 200 && login.json?.ok, `login ${username} failed: ${login.status}`)
  absorb(jar, login.setCookies)
  assert(jar.has('token'), 'player token cookie not set')
  return { jar, token: jar.get('token')! }
}

/** Resolves on the first `event` matching `match` (or any if none given). */
function once<T extends unknown[]>(socket: Socket, event: string, match?: (args: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler)
      reject(new Error(`timed out waiting for ${event}`))
    }, 5000)
    const handler = (...args: T) => {
      if (match && !match(args)) return
      clearTimeout(timer)
      socket.off(event, handler)
      resolve(args)
    }
    socket.on(event, handler as never)
  })
}

async function main(): Promise<void> {
  await waitForHealth()

  const alice = await register(`ali_${TAG}`, `ali-${TAG}@test.local`)
  const bob = await register(`bob_${TAG}`, `bob-${TAG}@test.local`)
  const carol = await register(`car_${TAG}`, `car-${TAG}@test.local`)
  const matchIds: string[] = []
  const sockets: Socket[] = []
  let rematchId: string | null = null

  try {
    // ── Alice settles a real match against Bob (they are NOT friends) ────────
    const first = await createOneVsOneMatch(alice.id, 'TIER_1', 'BO1')
    matchIds.push(first.id)
    await joinOneVsOneMatch(first.id, bob.id)
    await settleMatch({ matchId: first.id, winnerId: alice.id, reason: 'frames' })

    const friendship = await prisma.friend.findFirst({
      where: {
        status: 'ACCEPTED',
        OR: [
          { requesterId: alice.id, addresseeId: bob.id },
          { requesterId: bob.id, addresseeId: alice.id }
        ]
      }
    })
    assert(!friendship, 'fixture broke: alice and bob should not be friends')

    const aliceJar = await login(alice.username)

    // ── The winner asks for a rematch: allowed without friendship, flagged ────
    const rematch = await req('/api/challenges', {
      method: 'POST',
      cookies: aliceJar.jar,
      body: { stakeTier: 'TIER_1', format: 'BO1', targetUsername: bob.username, rematch: true }
    })
    assert(rematch.status === 200 && rematch.json?.ok, `rematch invite failed: ${rematch.status} ${JSON.stringify(rematch.json)}`)
    assert(rematch.json.data.rematch === true, 'the rematch invite should carry the rematch flag')
    assert(rematch.json.data.kind === 'FRIEND', 'a targeted rematch is a friend-kind invite')
    assert(rematch.json.data.targetUserId === bob.id, 'the rematch should be addressed to the exact opponent')
    rematchId = rematch.json.data.id as string

    // ── A rematch to anybody else is refused inside the same window ──────────
    const wrong = await req('/api/challenges', {
      method: 'POST',
      cookies: aliceJar.jar,
      body: { stakeTier: 'TIER_1', format: 'BO1', targetUsername: carol.username, rematch: true }
    })
    assert(wrong.status === 400 && /just played/.test(wrong.json?.error ?? ''), `rematch to a non-opponent should be refused: ${wrong.status} ${JSON.stringify(wrong.json)}`)

    // ── A normal (non-rematch) targeted invite still needs friendship ────────
    const normal = await req('/api/challenges', {
      method: 'POST',
      cookies: aliceJar.jar,
      body: { stakeTier: 'TIER_1', format: 'BO1', targetUsername: carol.username }
    })
    assert(normal.status === 400 && /friend/.test(normal.json?.error ?? ''), `a plain invite to a non-friend should still be refused: ${normal.status} ${JSON.stringify(normal.json)}`)

    // Bob lost the first match outright, so top him back up to cover the rematch stake.
    await runInTransaction(async (tx) => {
      await ledger.creditAvailable(tx, { userId: bob.id, amount: 5, type: 'TEST_CREDIT', meta: { verify: true } })
    })

    // ── Bob accepts the rematch → a fresh, staked match between the two ───────
    const bobLogin = await login(bob.username)
    const accepted = await req(`/api/challenges/${rematchId}/accept`, { method: 'POST', cookies: bobLogin.jar, body: {} })
    assert(accepted.status === 200 && accepted.json?.ok, `rematch accept failed: ${accepted.status} ${JSON.stringify(accepted.json)}`)
    const rematchMatchId = accepted.json.data.matchId as string
    matchIds.push(rematchMatchId)

    await new Promise((r) => setTimeout(r, 150))
    const match = await prisma.match.findUnique({
      where: { id: rematchMatchId },
      include: { players: true }
    })
    assert(match?.status === 'MATCH_STARTED', `the rematch should be a staked, started match, got ${match?.status}`)
    assert(match.stakePerPlayer.toNumber() === 1, 'the rematch should re-freeze the same stake')
    assert(match.format === 'BO1', 'the rematch should reuse the same format')
    assert(match.players.map((p) => p.userId).sort().join(',') === [alice.id, bob.id].sort().join(','), 'the rematch should seat exactly the same two players')

    // ── Quick chat, live: both players in the room exchange a phrase ─────────
    const aliceSocket = connectIo(BASE, { auth: { token: aliceJar.token }, transports: ['websocket'] })
    const bobSocket = connectIo(BASE, { auth: { token: bobLogin.token }, transports: ['websocket'] })
    sockets.push(aliceSocket, bobSocket)

    const aliceJoined = once(aliceSocket, 'match:joined')
    const bobJoined = once(bobSocket, 'match:joined')
    const aliceErrors: Array<{ code?: string }> = []
    aliceSocket.on('error', (e: { code?: string }) => aliceErrors.push(e))
    await new Promise<void>((resolve, reject) => {
      aliceSocket.once('connect', () => resolve())
      aliceSocket.once('connect_error', (e) => reject(new Error(`socket connect failed: ${e.message}`)))
    })
    await new Promise<void>((resolve, reject) => {
      bobSocket.once('connect', () => resolve())
      bobSocket.once('connect_error', (e) => reject(new Error(`socket connect failed: ${e.message}`)))
    })
    aliceSocket.emit('match:join', { matchId: rematchMatchId })
    bobSocket.emit('match:join', { matchId: rematchMatchId })
    const [aJoined] = await aliceJoined
    const [bJoined] = await bobJoined
    const aSeat = (aJoined as { seat: number }).seat
    const bSeat = (bJoined as { seat: number }).seat
    assert(aSeat === 0 && bSeat === 1, `seats should be 0 and 1, got ${aSeat} and ${bSeat}`)

    // Alice says "GG": both clients see it.
    const aliceHeard = once(aliceSocket, 'match:chat', (args: unknown[]) => (args[0] as { phraseId: string }).phraseId === 'gg')
    const bobHeard = once(bobSocket, 'match:chat', (args: unknown[]) => (args[0] as { phraseId: string }).phraseId === 'gg')
    aliceSocket.emit('match:chat', { matchId: rematchMatchId, phraseId: 'gg' })
    const [aliceChat] = await aliceHeard
    const [bobChat] = await bobHeard
    assert((aliceChat as { seat: number }).seat === aSeat, 'the sender should see their own line with their seat')
    assert((bobChat as { seat: number }).seat === aSeat, 'the opponent should see the line with the sender seat')

    // Bob replies: both see it again.
    const echoBack = once(bobSocket, 'match:chat', (args: unknown[]) => (args[0] as { phraseId: string }).phraseId === 'ha')
    bobSocket.emit('match:chat', { matchId: rematchMatchId, phraseId: 'ha' })
    await echoBack

    // ID that is NOT on the whitelist → bad_phrase, and nothing is broadcast.
    const badPhrase = once(aliceSocket, 'error', (args: unknown[]) => (args[0] as { code: string }).code === 'bad_phrase')
    aliceSocket.emit('match:chat', { matchId: rematchMatchId, phraseId: 'gg; drop table users' })
    await badPhrase
    await new Promise((r) => setTimeout(r, 120))
    assert(aliceErrors.length === 1 && aliceErrors[0]!.code === 'bad_phrase', `expected exactly one bad_phrase refusal, got ${JSON.stringify(aliceErrors)}`)

    // A second line inside the cooldown window → chat_rate_limited.
    const rateLtd = once(aliceSocket, 'error', (args: unknown[]) => (args[0] as { code: string }).code === 'chat_rate_limited')
    aliceSocket.emit('match:chat', { matchId: rematchMatchId, phraseId: 'wp' })
    await rateLtd

    console.log(
      `PASS: settle → rematch invite to the (non-friend) opponent accepted (rematch flag on, ${match.format} reused, ` +
        'stake re-frozen, same two players) → non-opponent rematch refused, plain friend-gate intact → ' +
        'socket chat relayed to both seats, non-whitelisted id refused with bad_phrase, cooldown refused a second line.'
    )
  } finally {
    for (const socket of sockets) socket.close()
    // Let fire-and-forget notifications from the settles land before cleanup.
    await new Promise((r) => setTimeout(r, 250))
    const userIds = [alice.id, bob.id, carol.id]
    await prisma.gameEvent.deleteMany({ where: { matchId: { in: matchIds } } })
    await prisma.match.deleteMany({ where: { id: { in: matchIds } } })
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.matchChallenge.deleteMany({ where: { challengerId: { in: userIds } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exitCode = 1
})