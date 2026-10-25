/**
 * Throwaway end-to-end check for the manual deposit flow, run against the dev
 * server on :4000. Creates its own admin + player, drives the whole thing over
 * HTTP, then deletes every row it made.
 *
 * Run: pnpm --filter @snooker/server exec tsx scripts/verify-deposit.ts
 */
import bcrypt from 'bcryptjs'
import { prisma } from '../src/db/index.js'

const BASE = 'http://localhost:4000'
const TAG = `depv${Date.now() % 1000000}`
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
    // Drop expired/deleted cookies; keep live ones (ignore httponly/samesite bits).
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
      email: `verify-admin-${TAG}@test.local`,
      username: `vadmin${TAG}`,
      passwordHash: bcrypt.hashSync('verify-admin-pass', 10),
      role: 'SUPERADMIN',
      status: 'ACTIVE',
      wallet: { create: { available: 0 } }
    }
  })
  const player = await prisma.user.create({
    data: {
      email: `verify-player-${TAG}@test.local`,
      username: `vplayer${TAG}`,
      passwordHash: bcrypt.hashSync('verify-player-pass', 10),
      role: 'PLAYER',
      status: 'ACTIVE',
      wallet: { create: { available: 0 } }
    }
  })

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

    // ── Deposit info ───────────────────────────────────────────────────────
    const info = await req('/api/deposit/info', { cookies: playerJar })
    assert(info.status === 200 && info.json?.ok, 'deposit info failed')
    assert(info.json.data.enabled === true, 'deposits should be enabled')
    assert(typeof info.json.data.walletAddress === 'string' && info.json.data.walletAddress.length > 0, 'wallet address unset')

    const screenshot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const tx1 = `${TAG}-tx-approve`

    // ── Create a deposit request ───────────────────────────────────────────
    const created = await req('/api/deposits', {
      method: 'POST',
      cookies: playerJar,
      body: { amountUsdt: 50, txHash: tx1, screenshot }
    })
    assert(created.status === 201 && created.json?.ok, `create deposit failed: ${JSON.stringify(created.json)}`)
    const depositId = created.json.data.id

    // ── Duplicate transaction id is rejected ───────────────────────────────
    const dup = await req('/api/deposits', {
      method: 'POST',
      cookies: playerJar,
      body: { amountUsdt: 10, txHash: tx1, screenshot }
    })
    assert(dup.status === 400, `duplicate tx should 400, got ${dup.status}`)

    // ── Under-minimum amount is rejected ───────────────────────────────────
    const tooSmall = await req('/api/deposits', {
      method: 'POST',
      cookies: playerJar,
      body: { amountUsdt: 0.5, txHash: `${TAG}-small`, screenshot }
    })
    assert(tooSmall.status === 400, `below min should 400, got ${tooSmall.status}`)

    // ── Admin sees it pending ──────────────────────────────────────────────
    const list = await req('/api/admin/deposits', { cookies: adminJar })
    assert(list.status === 200 && list.json?.ok, 'admin deposit list failed')
    const row = list.json.data.items.find((d: any) => d.id === depositId)
    assert(row && row.status === 'PENDING', 'deposit should be listed as PENDING')
    assert(list.json.data.pending >= 1, 'pending count should be >= 1')

    // ── Admin approves → USDT lands on the wallet ─────────────────────────
    const approve = await req(`/api/admin/deposits/${depositId}/approve`, {
      method: 'POST',
      body: {},
      cookies: adminJar
    })
    assert(approve.status === 200 && approve.json?.ok, `approve failed: ${JSON.stringify(approve.json)}`)
    assert(approve.json.data.credited === 50, `expected 50 USDT, got ${approve.json.data.credited}`)

    const wallet = await req('/api/wallet', { cookies: playerJar })
    assert(wallet.json.data.balance === 50, `expected wallet 50, got ${wallet.json.data.balance}`)

    const mine = await req('/api/deposits', { cookies: playerJar })
    const mineRow = mine.json.data.items.find((d: any) => d.id === depositId)
    assert(mineRow && mineRow.status === 'APPROVED', 'deposit should be APPROVED for the player')

    // ── Double review is refused ───────────────────────────────────────────
    const again = await req(`/api/admin/deposits/${depositId}/approve`, { method: 'POST', cookies: adminJar })
    assert(again.status === 400, `double approve should 400, got ${again.status}`)

    // ── Reject path leaves the wallet untouched ────────────────────────────
    const tx2 = `${TAG}-tx-reject`
    const second = await req('/api/deposits', {
      method: 'POST',
      cookies: playerJar,
      body: { amountUsdt: 20, txHash: tx2, screenshot }
    })
    assert(second.status === 201, 'second deposit create failed')
    const reject = await req(`/api/admin/deposits/${second.json.data.id}/reject`, {
      method: 'POST',
      cookies: adminJar,
      body: { reason: 'could not find the transaction' }
    })
    assert(reject.status === 200 && reject.json?.ok, 'reject failed')

    const wallet2 = await req('/api/wallet', { cookies: playerJar })
    assert(wallet2.json.data.balance === 50, 'rejected deposit must not change the balance')

    const mine2 = await req('/api/deposits', { cookies: playerJar })
    const rejRow = mine2.json.data.items.find((d: any) => d.id === second.json.data.id)
    assert(rejRow && rejRow.status === 'REJECTED', 'deposit should be REJECTED')

    console.log('PASS: deposit request → admin notify → verify → approve credits 50 USDT; reject path; duplicate + min guards all behave.')
  } finally {
    // ── Cleanup: every row the script created ──────────────────────────────
    await prisma.adminAction.deleteMany({ where: { adminId: admin.id } })
    await prisma.notification.deleteMany({
      where: { kind: { in: ['DEPOSIT_PENDING', 'DEPOSIT_APPROVED', 'DEPOSIT_REJECTED'] }, createdAt: { gte: START } }
    })
    await prisma.user.deleteMany({ where: { id: { in: [admin.id, player.id] } } })
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exitCode = 1
})