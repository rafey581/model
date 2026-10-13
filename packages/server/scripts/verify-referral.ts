/**
 * Throwaway end-to-end check for the invitation programme, run against the dev
 * server on :4000. Registers an inviter, reads their code off the API, signs a new
 * player up with that code (and proves a bogus code is refused), then plays the
 * invited player's first match and confirms the inviter is paid exactly once.
 *
 * Run: pnpm --filter @snooker/server exec tsx scripts/verify-referral.ts
 */
import { prisma } from '../src/db/index.js'
import { createOneVsOneMatch, joinOneVsOneMatch, settleMatch } from '../src/matches/service.js'
import { ledger, runInTransaction } from '../src/wallet/service.js'

const BASE = 'http://localhost:4000'
const TAG = `refv${Date.now() % 1000000}`
const START = new Date()
const PASSWORD = 'verify-referral-pass'

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

async function register(username: string, email: string, ref?: string): Promise<{ id: string; username: string }> {
  const res = await req('/api/auth/register', {
    method: 'POST',
    body: { username, email, password: PASSWORD, ...(ref ? { ref } : {}) }
  })
  assert(res.status === 200 && res.json?.ok, `register ${username} failed: ${res.status} ${JSON.stringify(res.json)}`)
  return { id: res.json.data.user.id, username }
}

async function main(): Promise<void> {
  await waitForHealth()

  const inviter = await register(`inv_${TAG}`, `inv-${TAG}@test.local`)
  const opponent = await register(`opp_${TAG}`, `opp-${TAG}@test.local`)
  const matchIds: string[] = []

  try {
    // ── The inviter logs in and reads their code + link off the API ─────────
    const jar: CookieJar = new Map()
    const login = await req('/api/auth/login', { method: 'POST', body: { username: inviter.username, password: PASSWORD } })
    assert(login.status === 200 && login.json?.ok, `inviter login failed: ${login.status}`)
    absorb(jar, login.setCookies)
    assert(jar.has('token'), 'player token cookie not set')

    const before = await req('/api/referrals', { cookies: jar })
    assert(before.status === 200 && before.json?.ok, `referral summary failed: ${before.status}`)
    const code = before.json.data.code as string
    assert(/^[A-Z0-9]{8}$/.test(code), `invite code should be an 8-char code, got ${code}`)
    assert(String(before.json.data.link).includes(`ref=${code}`), 'invite link should carry the code')
    assert(before.json.data.invitedCount === 0, 'a new inviter has invited nobody')

    // The inviter also holds the normal welcome grant, so measure the *change*.
    const walletBefore = Number((await prisma.wallet.findUnique({ where: { userId: inviter.id } }))?.available)
    assert(walletBefore === 1, `an account should start with the 1 USDT welcome grant, got ${walletBefore}`)

    // ── A bogus code is refused while the player is still on the form ───────
    const bogus = await req('/api/auth/register', {
      method: 'POST',
      body: { username: `bad_${TAG}`, email: `bad-${TAG}@test.local`, password: PASSWORD, ref: 'ZZZZZZZZ' }
    })
    assert(bogus.status === 400, `a bad invite code should be refused with 400, got ${bogus.status}`)

    // ── A new player signs up with the code; the inviter is recorded ────────
    const invitee = await register(`guest_${TAG}`, `guest-${TAG}@test.local`, code)
    const stored = await prisma.user.findUnique({ where: { id: invitee.id }, select: { referredById: true } })
    assert(stored?.referredById === inviter.id, 'the invited player should point back at the inviter')

    const afterSignup = await req('/api/referrals', { cookies: jar })
    assert(afterSignup.json.data.invitedCount === 1, 'invitedCount should be 1 after the signup')
    assert(afterSignup.json.data.pendingCount === 1, 'the invite should still be pending until the first match')
    assert(afterSignup.json.data.earnedUsdt === 0, 'nothing should be earned at signup')

    // ── The invited player finishes their first real match → the inviter is paid ─
    const first = await createOneVsOneMatch(invitee.id, 'TIER_1', 'BO1')
    matchIds.push(first.id)
    await joinOneVsOneMatch(first.id, opponent.id)
    await settleMatch({ matchId: first.id, winnerId: opponent.id, reason: 'frames' })

    const afterMatch = await req('/api/referrals', { cookies: jar })
    assert(afterMatch.json.data.rewardedCount === 1, 'the invite should be rewarded after the first match')
    assert(afterMatch.json.data.pendingCount === 0, 'nothing should remain pending')
    assert(afterMatch.json.data.earnedUsdt === 1, 'the inviter should have earned 1 USDT')

    const inviterWallet = await prisma.wallet.findUnique({ where: { userId: inviter.id } })
    assert(
      Number(inviterWallet?.available) === walletBefore + 1,
      `inviter wallet should gain 1 USDT (${walletBefore} → ${walletBefore + 1}), got ${inviterWallet?.available}`
    )

    const bonuses = await prisma.walletTransaction.count({ where: { userId: inviter.id, type: 'REFERRAL_BONUS' } })
    assert(bonuses === 1, `exactly one REFERRAL_BONUS ledger row expected, got ${bonuses}`)

    // The reward notification is fire-and-forget, so give it a moment to land.
    let rewardNotice: { body: string | null } | null = null
    for (let i = 0; i < 20 && !rewardNotice; i++) {
      rewardNotice = await prisma.notification.findFirst({
        where: { userId: inviter.id, kind: 'REFERRAL_BONUS', createdAt: { gte: START } },
        select: { body: true }
      })
      if (!rewardNotice) await new Promise((r) => setTimeout(r, 50))
    }
    assert(rewardNotice?.body?.includes(invitee.username) === true, 'the inviter should be notified, naming the invitee')

    // ── A second match must not pay twice ───────────────────────────────────
    // The invitee spent their 1 USDT losing the first match, so top them back up
    // through the ledger (the ledger invariant needs the matching transaction).
    await runInTransaction(async (tx) => {
      await ledger.creditAvailable(tx, { userId: invitee.id, amount: 5, type: 'TEST_CREDIT', meta: { verify: true } })
    })
    const second = await createOneVsOneMatch(invitee.id, 'TIER_1', 'BO1')
    matchIds.push(second.id)
    await joinOneVsOneMatch(second.id, opponent.id)
    await settleMatch({ matchId: second.id, winnerId: invitee.id, reason: 'frames' })

    const walletAfter = await prisma.wallet.findUnique({ where: { userId: inviter.id } })
    assert(Number(walletAfter?.available) === walletBefore + 1, 'the bonus must be paid once, never twice')
    assert(
      (await prisma.walletTransaction.count({ where: { userId: inviter.id, type: 'REFERRAL_BONUS' } })) === 1,
      'no second REFERRAL_BONUS row'
    )

    console.log(
      `PASS: code+link served by /api/referrals → bad code refused → signup with ${code} records the inviter → ` +
        'invitedCount/pending before play → first match pays the inviter 1 USDT (+ledger+notification) → second match does not pay again.'
    )
  } finally {
    // Let the fire-and-forget notifications from the last settle land before the
    // rows they point at are deleted (otherwise they log an FK error on the way out).
    await new Promise((r) => setTimeout(r, 250))
    const userIds = [inviter.id, opponent.id]
    const inviteeRow = await prisma.user.findFirst({ where: { username: `guest_${TAG}` }, select: { id: true } })
    if (inviteeRow) userIds.push(inviteeRow.id)
    const bogusRow = await prisma.user.findFirst({ where: { username: `bad_${TAG}` }, select: { id: true } })
    if (bogusRow) userIds.push(bogusRow.id)

    await prisma.gameEvent.deleteMany({ where: { matchId: { in: matchIds } } })
    await prisma.match.deleteMany({ where: { id: { in: matchIds } } })
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exitCode = 1
})
