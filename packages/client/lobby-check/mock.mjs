export const EXEC =
  'C:\\Users\\ITW\\AppData\\Local\\ms-playwright\\chromium_headless_shell-1234\\chrome-headless-shell-win64\\chrome-headless-shell.exe'

export const BASE = 'http://localhost:5173/'

const user = { id: 'u1', username: 'Player', role: 'player', status: 'active' }
const tiers = [
  { id: 'TIER_1', usd: 1, credits: 100, label: '$1 table' },
  { id: 'TIER_5', usd: 5, credits: 500, label: '$5 table' },
  { id: 'TIER_10', usd: 10, credits: 1000, label: '$10 table' }
]

const ok = (data) => ({ json: { ok: true, data } })

export async function mock(page, { verbose = false } = {}) {
  if (verbose) {
    page.on('console', (m) => console.log('[console]', m.type(), m.text()))
    page.on('pageerror', (e) => console.log('[pageerror]', e.message))
  }
  await page.route('**/socket.io/**', (r) => r.abort().catch(() => {}))
  await page.route('**/api/**', (r) => {
    const p = new URL(r.request().url()).pathname
    if (verbose) console.log('[api]', r.request().method(), p)
    if (p.endsWith('/auth/status') || p.endsWith('/auth/session'))
      return r.fulfill(ok({ user, token: 'test-token' }))
    if (p.endsWith('/notifications')) return r.fulfill(ok({ items: [], unread: 0 }))
    if (p.endsWith('/wallet')) return r.fulfill(ok({ balance: 25000, locked: 0 }))
    if (p.endsWith('/matches/tiers')) return r.fulfill(ok(tiers))
    if (p.endsWith('/matches/history'))
      return r.fulfill(
        ok([
          {
            id: 'm1',
            format: 'BO3',
            winnerId: 'u1',
            finishedAt: new Date().toISOString(),
            players: [
              { userId: 'u1', user: { username: 'Player' } },
              { userId: 'u2', user: { username: 'Rival' } }
            ]
          }
        ])
      )
    if (p.endsWith('/me'))
      return r.fulfill(ok({ stats: { matches: 7, wins: 4, losses: 3, winRate: 57, highestBreak: 42 } }))
    if (p.endsWith('/settings/public')) return r.fulfill(ok({ maintenanceMode: false }))
    return r.fulfill({ json: { ok: true, data: {} } })
  })
}
