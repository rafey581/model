/**
 * Throwaway end-to-end check for the manual withdrawal flow, run against the dev
 * server on :4000. Creates its own admin + player + opponent, drives the whole
 * thing over HTTP, then deletes every row it
 * made.
 *
 * Run: pnpm --filter @snooker/server exec tsx scripts/verify-withdraw.ts
 */
import bcrypt from 'bcryptjs'
import { prisma } from '../src/db/index.js'

const BASE = 'http://localhost:4000'
const TAG = `wdv${Date.now() % 1000000}`
const START = new Date()
const ADDR = 'D1nhYBCDFpEjc3Hnz9ZhjGyMMqkpk3qNcZJmQHcYyXqG'
const MATCH_IDS: string[] = []

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
  const admin = await prisma.user.create({
    data: {
      email: `verify-wdadmin-${TAG}@test.local`,
      username: `vwadmin${TAG}`,
      passwordHash: bcrypt.hashSync('verify-admin-pass', 10),
      role: 'SUPERADMIN',
      status: 'ACTIVE',
      wallet: { create: { available: 0 } }
    }
  })
  const player = await prisma.user.create({
    data: {
      email: `verify-wdplayer-${TAG}@test.local`,
      username: `vwplayer${TAG}`,
      passwordHash: bcrypt.hashSync('verify-player-pass', 10),
      role: 'PLAYER',
      status: 'ACTIVE',
      // Fund directly; this script does not exercise the ledger invariant.
      wallet: { create: { available: 100 } }
    }
  })
  const opponent = await prisma.user.create({
    data: {
      email: `verify-wdopp-${TAG}@test.local`,
      username: `vwopp${TAG}`,
      passwordHash: '!',
      role: 'PLAYER',
      status: 'ACTIVE',
      wallet: { create: { available: 0 } }
    }
  })

  // Two finished matches so the request carries a real snapshot to the admin.
  for (const [i, won] of [true, false].entries()) {
    const finishedAt = new Date(Date.now() - (i + 1) * 3600_000)
    const match = await prisma.match.create({
      data: {
        matchType: 'ONE_V_ONE',
        status: 'PRIZE_SETTLED',
        stakePerPlayer: 10,
        currency: 'USDT',
        format: 'BO1',
        winnerId: won ? player.id : opponent.id,
        startedAt: new Date(finishedAt.getTime() - 3600_000),
        finishedAt,
        players: {
          create: [
            { userId: player.id, seat: 0, result: won ? 'WIN' : 'LOSS' },
            { userId: opponent.id, seat: 1, result: won ? 'LOSS' : 'WIN' }
          ]
        }
      }
    })
    MATCH_IDS.push(match.id)
  }

  const adminJar: CookieJar = new Map()
  const playerJar: CookieJar = new Map()

  try {
    // ── Admin login ────────────────────────────────────────────────────────
    const adminLogin = await req('/api/admin/auth/login', {
      method: 'POST',
      body: { email: admin.email, password: 'verify-admin-pass' }
    })
    assert(adminLogin.status === 200 && adminLogin.json?.ok, 'admin login failed')
    absorb(adminJar, adminLogin.setCookies)
    assert(adminJar.has('admin_session'), 'admin session cookie not set')

    // ── Player login ───────────────────────────────────────────────────────
    const playerLogin = await req('/api/auth/login', {
      method: 'POST',
      body: { username: player.username, password: 'verify-player-pass' }
    })
    assert(playerLogin.status === 200 && playerLogin.json?.ok, 'player login failed')
    absorb(playerJar, playerLogin.setCookies)
    assert(playerJar.has('token'), 'player token cookie not set')

    // ── Withdraw info ──────────────────────────────────────────────────────
    const info = await req('/api/withdraw/info', { cookies: playerJar })
    assert(info.status === 200 && info.json?.ok, 'withdraw info failed')
    assert(info.json.data.enabled === true, 'withdrawals should be enabled')
    assert(info.json.data.minUsdt === 5 && info.json.data.maxUsdt === 1000, 'withdraw min/max should be 5/1000 USDT')

    // ── Below-minimum amount is rejected ───────────────────────────────────
    const tooSmall = await req('/api/withdrawals', {
      method: 'POST',
      cookies: playerJar,
      body: { amountUsdt: 1, address: ADDR }
    })
    assert(tooSmall.status === 400, `below min should 400, got ${tooSmall.status}`)

    // ── A request the player cannot cover is refused ───────────────────────
    const tooBig = await req('/api/withdrawals', {
      method: 'POST',
      cookies: playerJar,
      body: { amountUsdt: 500, address: ADDR } // 500 USDT > 100 USDT balance
    })
    assert(tooBig.status === 400, `insufficient balance should 400, got ${tooBig.status}`)
    assert(String(tooBig.json?.error ?? '').includes('balance'), 'error should mention the balance')

    // ── Create a withdrawal request (50 USDT) ──────────────────────────────
    const created = await req('/api/withdrawals', {
      method: 'POST',
      cookies: playerJar,
      body: { amountUsdt: 50, address: ADDR }
    })
    assert(created.status === 201 && created.json?.ok, `create withdrawal failed: ${JSON.stringify(created.json)}`)
    const withdrawalId = created.json.data.id

    // ── Admin sees it pending, with the last-5-matches snapshot ────────────
    const list = await req('/api/admin/withdrawals', { cookies: adminJar })
    assert(list.status === 200 && list.json?.ok, 'admin withdrawal list failed')
    const row = list.json.data.items.find((w: any) => w.id === withdrawalId)
    assert(row && row.status === 'PENDING', 'withdrawal should be listed as PENDING')
    assert(Array.isArray(row.matchHistory) && row.matchHistory.length === 2, 'snapshot should carry the 2 matches')
    assert(row.matchHistory[0].result === 'WIN', 'newest match should read WIN')
    assert(row.matchHistory[0].opponent === opponent.username, 'snapshot should name the opponent')
    assert(list.json.data.pending >= 1, 'pending count should be >= 1')

    // ── Admin approves → balance is cut from the wallet ────────────────────
    const approve = await req(`/api/admin/withdrawals/${withdrawalId}/approve`, {
      method: 'POST',
      body: {},
      cookies: adminJar
    })
    assert(approve.status === 200 && approve.json?.ok, `approve failed: ${JSON.stringify(approve.json)}`)
    assert(approve.json.data.deducted === 50, `expected 50 USDT deducted, got ${approve.json.data.deducted}`)

    const wallet = await req('/api/wallet', { cookies: playerJar })
    assert(wallet.json.data.balance === 50, `expected wallet 50, got ${wallet.json.data.balance}`)

    const mine = await req('/api/withdrawals', { cookies: playerJar })
    const mineRow = mine.json.data.items.find((w: any) => w.id === withdrawalId)
    assert(mineRow && mineRow.status === 'APPROVED', 'withdrawal should be APPROVED for the player')

    // ── Double review is refused, and does not debit twice ─────────────────
    const again = await req(`/api/admin/withdrawals/${withdrawalId}/approve`, {
      method: 'POST',
      body: {},
      cookies: adminJar
    })
    assert(again.status === 400, `double approve should 400, got ${again.status}`)
    const walletAfter = await req('/api/wallet', { cookies: playerJar })
    assert(walletAfter.json.data.balance === 50, 'double approve must not debit twice')

    // ── Reject path leaves the wallet untouched ────────────────────────────
    const second = await req('/api/withdrawals', {
      method: 'POST',
      cookies: playerJar,
      body: { amountUsdt: 20, address: ADDR }
    })
    assert(second.status === 201, 'second withdrawal create failed')
    const reject = await req(`/api/admin/withdrawals/${second.json.data.id}/reject`, {
      method: 'POST',
      cookies: adminJar,
      body: { reason: 'account could not be verified' }
    })
    assert(reject.status === 200 && reject.json?.ok, 'reject failed')

    const wallet2 = await req('/api/wallet', { cookies: playerJar })
    assert(wallet2.json.data.balance === 50, 'rejected withdrawal must not change the balance')

    const mine2 = await req('/api/withdrawals', { cookies: playerJar })
    const rejRow = mine2.json.data.items.find((w: any) => w.id === second.json.data.id)
    assert(rejRow && rejRow.status === 'REJECTED', 'withdrawal should be REJECTED')

    console.log(
      'PASS: withdraw request (with last-5-matches snapshot) → admin review → approve cuts 50 USDT; reject path; min + balance guards all behave.'
    )
  } finally {
    // ── Cleanup: every row the script created ──────────────────────────────
    await prisma.adminAction.deleteMany({ where: { adminId: admin.id } })
    await prisma.notification.deleteMany({
      where: {
        kind: { in: ['WITHDRAW_PENDING', 'WITHDRAW_APPROVED', 'WITHDRAW_REJECTED'] },
        createdAt: { gte: START }
      }
    })
    await prisma.gameEvent.deleteMany({ where: { matchId: { in: MATCH_IDS } } })
    await prisma.match.deleteMany({ where: { id: { in: MATCH_IDS } } })
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, player.id, opponent.id] } } })
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exitCode = 1
})
