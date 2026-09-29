import { io } from 'socket.io-client'
import type { Socket } from 'socket.io-client'
import { PrismaClient } from '@prisma/client'
import { signToken } from '../src/auth/guards.js'
import { getBotUserId, createOneVsOneMatch, MatchError, joinOneVsOneMatch } from '../src/matches/service.js'
import { createTournament, joinTournament } from '../src/tournaments/service.js'
import { frameFromSnapshot, type FrameSnapshot } from '@snooker/shared'
import { computeBotShot } from '../src/bot/bot.js'
import { DEFAULT_TURN_TIMEOUT_SEC } from '../src/config.js'
import { ledger, runInTransaction } from '../src/wallet/service.js'

const BASE = 'http://localhost:4000'

/**
 * Rejections that mean "not yet, try again" rather than "that shot was bad".
 *
 * All three leave the table exactly as it was, so retrying is the correct client
 * behaviour and none of them should end the test.
 */
const PACE_REJECTIONS = new Set([
  'wait for the table to settle',
  'rate_limited',
  'duplicate_shot'
])
const prisma = new PrismaClient()
let failures = 0
let passed = 0

function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failures++
    console.log(`  FAIL ${name} ${extra !== undefined ? JSON.stringify(extra) : ''}`)
  }
}

interface ApiResult {
  status: number
  json: Record<string, any> | null
}

async function api(path: string, opts: { method?: string; body?: unknown; token?: string } = {}): Promise<ApiResult> {
  const method = opts.method ?? 'GET'
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {})
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    })
  } catch (error) {
    const wrapped = new Error(`api ${method} ${path} failed: ${(error as Error).message}`)
    wrapped.stack = (error as Error)?.stack
    throw wrapped
  }
  const json = (await res.json().catch(() => null)) as Record<string, any> | null
  return { status: res.status, json }
}

async function register(suffix: number, tag: string): Promise<{ id: string; token: string; username: string }> {
  const username = `e2e${tag}${suffix}`
  const email = `${username}@e2e.test`
  const res = await api('/api/auth/register', { method: 'POST', body: { email, username, password: 'password123' } })
  if (res.status !== 200 || !res.json?.ok) throw new Error(`register failed ${tag}: ${JSON.stringify(res.json)}`)
  const user = res.json.data.user as { id: string }
  const token = res.json.data.token as string
  return { id: user.id, token, username }
}

function waitFor<T>(socket: Socket, event: string, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler)
      reject(new Error(`timeout waiting for ${event}`))
    }, timeoutMs)
    const handler = (payload: T) => {
      clearTimeout(timer)
      socket.off(event, handler)
      resolve(payload)
    }
    socket.on(event, handler)
  })
}

function waitAny<T>(
  socket: Socket,
  events: string[],
  timeoutMs = 8000
): Promise<{ event: string; payload: T }> {
  return new Promise((resolve, reject) => {
    const timers = events.map((event) =>
      setTimeout(() => {
        for (const e of events) socket.off(e)
        reject(new Error(`timeout waiting for any of ${events.join(',')}`))
      }, timeoutMs)
    )
    const handlers = events.map((event) => {
      const handler = (payload: T) => {
        for (const t of timers) clearTimeout(t)
        for (const e of events) socket.off(e)
        resolve({ event, payload })
      }
      socket.on(event, handler)
      return handler
    })
    ;(void handlers)
  })
}

function connectSocket(token: string): Socket {
  return io('http://localhost:4000', { auth: { token }, transports: ['websocket'], timeout: 10000 })
}

type ShotInput = {
  aimAngle: number
  power: number
  spin: { x: number; y: number }
  cuePos?: { x: number; y: number }
  timestamp?: number
}

/**
 * Reports that a shot has finished animating, releasing the room's pacing hold.
 *
 * The browser client sends this from `finishShot()`, which fires for *any* shot it
 * watches - its own, the opponent's, or the bot's - because the point of the hold is
 * that the table must be seen to settle before the next shot is broadcast. The
 * acknowledgement is idempotent, so sending it when no hold is active is a no-op.
 *
 * The token has to be echoed back. The room stamps every shot it broadcasts with a
 * number and only accepts an acknowledgement carrying the current one, so a report
 * left over from a shot that has already been released cannot cut short the shot
 * that is on screen now. A client that is behind sends no token, and the room
 * ignores that rather than guessing which shot it meant.
 */
function ackShot(socket: Socket, matchId: string, token?: number): void {
  socket.emit('shot:done', token === undefined ? { matchId } : { matchId, token })
}

/**
 * Waits for the next `game:update` on one socket and acknowledges the shot it
 * carries, which is what a client does with a shot it did not take itself (the bot's,
 * in a practice match). Without the ack the bot's next shot stays blocked behind the
 * hold and the match stalls.
 */
async function watchShotLikeAClient(socket: Socket, matchId: string, timeoutMs = 45000): Promise<any> {
  try {
    const update = await waitFor<any>(socket, 'game:update', timeoutMs)
    ackShot(socket, matchId, update?.playback?.token)
    return update
  } catch (error) {
    ackShot(socket, matchId)
    throw error
  }
}

/**
 * Plays a shot the way a real client does, and returns the `game:update` both seats
 * receive.
 *
 * The room holds the turn after every shot until someone reports that its playback has
 * finished (`shot:done`). That pacing signal is what stops a shot being fired into the
 * middle of the previous one's replay, and the browser client sends it as soon as its
 * animation completes. The harness has no animation, but it has to behave the same
 * way: without the acknowledgement the hold rejects every shot after the first with
 * `wait for the table to settle` and the match silently stalls with no further
 * `game:update` at all.
 *
 * The acknowledgement and the following shot arrive on different sockets, so the room
 * may not have processed the ack by the time the next shot lands. A real client can
 * hit that race too, so the shot is retried when the room reports the table is still
 * settling. The gate itself is left untouched.
 *
 * `watchers` is the list of connected sockets that should see the resulting update.
 * A disconnected seat is deliberately left out: it receives no broadcast, so waiting
 * on one would hang on a client that is behaving exactly as intended.
 */
async function playShotLikeAClient(
  matchId: string,
  shooter: Socket,
  watchers: Socket[],
  input: ShotInput,
  timeoutMs = 45000
): Promise<any[]> {
  const deadline = Date.now() + timeoutMs
  for (let attempt = 1; ; attempt++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`timeout waiting for game:update on ${matchId}`)
    const update = Promise.all(
      watchers.map((s) => waitFor<any>(s, 'game:update', remaining))
    ).then((list) => ({ kind: 'update' as const, list }))
    // A rejected shot comes straight back as an `error`; that is how we tell a
    // pacing rejection apart from a shot that is still being simulated.
    const rejection = waitFor<{ code: string }>(shooter, 'error', remaining).then((p) => ({
      kind: 'error' as const,
      code: p.code
    }))
    shooter.emit('shot:play', { matchId, input })
    const result = await Promise.race([update, rejection])
    if (result.kind === 'update') {
      // The shooter's own playback is over the moment it holds the result, which is
      // exactly when the browser client releases the room's hold. Both seats were sent
      // the same update, so the token off any one of them is the current one.
      ackShot(shooter, matchId, result.list[0]?.playback?.token)
      return result.list
    }
    // Every one of these means the same thing to a client: nothing was played, try
    // again later. The server is holding the table for a replay, and the two guards
    // that answer for a shot sent too early or too often are pacing answers, not
    // judgements on the shot. Retrying is what a real client does, so the harness
    // retries and backs off, rather than treating them as a failed shot.
    if (!PACE_REJECTIONS.has(result.code)) {
      throw new Error(`shot:play rejected on ${matchId}: ${result.code}`)
    }
    if (attempt >= 40) throw new Error(`table never settled on ${matchId}`)
    // Back off rather than polling flat out. The server is holding the table on
    // purpose and a replay at the slower playback rate can run for seconds, so a
    // fixed 100ms poll spends the whole of that hammering the socket. The duplicate
    // window is a few seconds wide, so the backoff has to outlast it to get through.
    await new Promise((r) => setTimeout(r, Math.min(100 + attempt * 50, 600)))
  }
}

async function joinMatchUntilAcked(socket: Socket, matchId: string, event: string, shortMs = 1200, tries = 12): Promise<any> {
  let lastError: Error | null = null
  for (let i = 0; i < tries; i++) {
    const pending = waitFor<any>(socket, event, shortMs)
    socket.emit('match:join', { matchId })
    try {
      return await pending
    } catch (error) {
      lastError = error as Error
    }
  }
  throw lastError ?? new Error(`join:${event} still unacknowledged after retries`)
}

async function getWallet(token: string): Promise<{ balance: number; locked: number; total: number }> {
  const res = await api('/api/wallet', { token })
  if (!res.json?.ok) throw new Error(`wallet failed: ${JSON.stringify(res.json)}`)
  return res.json.data
}

async function waitForStatus(token: string, path: string, expected: string, timeoutMs = 6000): Promise<Record<string, any> | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await api(path, { token })
    const status = res.json?.data?.status
    if (status === expected) return res.json!.data
    await new Promise((r) => setTimeout(r, 200))
  }
  return null
}

async function main(): Promise<void> {
  console.log('== 1. auth guards + tiers ==')
  let res = await api('/api/auth/status')
  check('unauth status blocked', res.status === 401)

  res = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'player@snooker.test', password: 'admin123' }
  })
  check('seed player login ok', res.status === 200 && res.json?.ok, res.json)

  const playerToken = res.json!.data.token
  res = await api('/api/matches/tiers', { token: playerToken })
  check('tiers count 3', res.status === 200 && Array.isArray(res.json?.data) && res.json.data.length === 3, res.json)
  const tierIds = res.json?.data.map((t: { id: string }) => t.id)
  check('tier ids', Array.isArray(tierIds) && tierIds.join(',') === 'TIER_1,TIER_5,TIER_10', tierIds)
  const tier1 = res.json?.data.find((t: { id: string }) => t.id === 'TIER_1')
  check('tier1 = 100 CR = $1', tier1?.credits === 100 && tier1?.usd === 1, tier1)

  console.log('== 2. register + wallets ==')
  const suffix = `${Date.now() % 100000}_${Math.random().toString(36).slice(2, 8)}`
  const alice = await register(suffix, 'a')
  const bob = await register(suffix, 'b')
  check('distinct users', alice.id !== bob.id)

  let wal = await getWallet(alice.token)
  check('alice starts 1000/0/1000', wal.balance === 1000 && wal.locked === 0 && wal.total === 1000, wal)

  console.log('== 3. create $1 match locks stake ==')
  res = await api('/api/matches', {
    method: 'POST',
    token: alice.token,
    body: { stakeTier: 'TIER_1', format: 'BO3' }
  })
  check('create match ok', res.status === 200 && res.json?.ok, res.json)
  const matchId = res.json!.data.id as string
  check('match waiting', res.json!.data.status === 'WAITING_FOR_PLAYER', res.json)

  res = await api('/api/matches', { method: 'POST', token: alice.token, body: { stakeTier: 'TIER_99', format: 'BO1' } })
  check('invalid tier rejected', res.status === 400, res.json)

  wal = await getWallet(alice.token)
  check('alice after create 900/100/1000', wal.balance === 900 && wal.locked === 100 && wal.total === 1000, wal)

  res = await api('/api/matches/lobby', { token: alice.token })
  check('lobby contains match', Array.isArray(res.json?.data) && res.json.data.some((m: { id: string }) => m.id === matchId), res.json)

  res = await api(`/api/matches/${matchId}`, { token: alice.token })
  check('match meta', res.json?.data?.stakeTier === 'TIER_1' && Number(res.json?.data?.stakePerPlayer) === 100 && res.json?.data?.matchType === 'ONE_V_ONE', res.json)

  console.log('== 4. join locks opponent stake ==')
  res = await api('/api/matches/join', { method: 'POST', token: bob.token, body: { matchId } })
  check('bob join ok', res.status === 200 && res.json?.data?.status === 'MATCH_STARTED', res.json)

  wal = await getWallet(bob.token)
  check('bob after join 900/100/1000', wal.balance === 900 && wal.locked === 100 && wal.total === 1000, wal)

  res = await api('/api/matches/join', { method: 'POST', token: bob.token, body: { matchId } })
  check('double join rejected', res.status === 400, res.json)

  console.log('== 5. socket realtime flow ==')
  const sa = connectSocket(alice.token)
  const sb = connectSocket(bob.token)
  const aJoined = waitFor<{ seat: number }>(sa, 'match:joined')
  const bJoined = waitFor<{ seat: number }>(sb, 'match:joined')
  const aStart = waitFor<{ frameIndex: number; snapshot: any }>(sa, 'match:start')
  const bStart = waitFor<{ frameIndex: number; snapshot: any }>(sb, 'match:start')
  sa.emit('match:join', { matchId })
  sb.emit('match:join', { matchId })
  const ja = await aJoined
  const jb = await bJoined
  check('alice seat 0', ja.seat === 0, ja)
  check('bob seat 1', jb.seat === 1, jb)
  const as = await aStart
  const bs = await bStart
  check('both got match:start', as !== undefined && bs !== undefined)
  check('frameIndex 1', as.frameIndex === 1 && bs.frameIndex === 1, as)
  check('snapshot 22 balls', as.snapshot.balls.length === 22, as.snapshot.balls.length)

  const initialCue = as.snapshot.balls[0]
  const turnSeat = as.snapshot.turnIndex
  let au: any
  let bu: any
  try {
    ;[au, bu] = await playShotLikeAClient(
      matchId,
      turnSeat === 0 ? sa : sb,
      [sa, sb],
      { aimAngle: 0.45, power: 0.75, spin: { x: 0, y: 0 } }
    )
    check('alice game:update', true)
    check('bob game:update', true)
  } catch (e) {
    check('alice game:update', false, (e as Error).message)
    check('bob game:update', false, (e as Error).message)
  }
  if (au && bu) {
    const cue = au.frame.balls[0]
    const moved = (cue && (Math.abs(cue.x - initialCue.x) > 0.001 || Math.abs(cue.y - initialCue.y) > 0.001)) || bu.events.length > 0
    check('shot moved cue ball (both broadcasts)', moved, { initialCue, after: cue })
    check('events array present', Array.isArray(au.events) || Array.isArray(bu.events), { au, bu })
  }

  console.log('== 6. concede settlement (socket path) ==')
  const aEnd = waitFor<any>(sa, 'match:end')
  const bEnd = waitFor<any>(sb, 'match:end')
  sa.emit('concede', { matchId })
  const endA = await aEnd
  const endB = await bEnd
  check('match:end broadcast', endA.winnerSeat === 1 && endB.winnerSeat === 1, { endA, endB })

  const settled = await waitForStatus(alice.token, `/api/matches/${matchId}`, 'PRIZE_SETTLED')
  check('socket concede settled match', !!settled, settled)

  const walA = await getWallet(alice.token)
  const walB = await getWallet(bob.token)
  check('alice settled 900/0/900', walA.balance === 900 && walA.locked === 0 && walA.total === 900, walA)
  check('bob settled 1080/0/1080', walB.balance === 1080 && walB.locked === 0 && walB.total === 1080, walB)

  res = await api(`/api/matches/${matchId}`, { token: alice.token })
  check('match PRIZE_SETTLED', res.json?.data?.status === 'PRIZE_SETTLED', res.json)
  check('winner alice? no - bob', res.json?.data?.winnerId === bob.id, res.json)
  check('resultJson prize 180', Number(res.json?.data?.resultJson?.prize) === 180, res.json?.data?.resultJson)

  res = await api('/api/matches/history', { token: alice.token })
  check('history shows match', Array.isArray(res.json?.data) && res.json.data.some((m: { id: string }) => m.id === matchId), res.json)

  res = await api('/api/wallet/transactions', { token: bob.token })
  const prizeTx = res.json?.data?.find((t: { type: string }) => t.type === 'PRIZE')
  check('bob has PRIZE tx 180', !!prizeTx && Number(prizeTx.amount) === 180, prizeTx)

  sa.disconnect()
  sb.disconnect()

  console.log('== 6b. REST concede settle path ==')
  res = await api('/api/matches', { method: 'POST', token: alice.token, body: { stakeTier: 'TIER_1', format: 'BO1' } })
  check('second match created', res.status === 200 && res.json?.ok, res.json)
  const match2 = res.json!.data.id as string
  res = await api('/api/matches/join', { method: 'POST', token: bob.token, body: { matchId: match2 } })
  check('second match joined', res.status === 200 && res.json?.ok, res.json)
  res = await api(`/api/matches/${match2}`, { token: alice.token })
  check('second match started', res.json?.data?.status === 'MATCH_STARTED', res.json)
  res = await api('/api/matches/concede', { method: 'POST', token: alice.token, body: { matchId: match2 } })
  check('REST concede accepted', res.status === 200 && res.json?.ok, res.json)
  const walA2 = await getWallet(alice.token)
  const walB2 = await getWallet(bob.token)
  check('REST concede settled alice 800', walA2.balance === 800 && walA2.locked === 0, walA2)
  check('REST concede settled bob 1160', walB2.balance === 1160 && walB2.locked === 0, walB2)

  console.log('== 7. bots can never play real tables ==')
  const botId = await getBotUserId()
  const botToken = signToken({ id: botId, username: 'Robot', role: 'BOT', status: 'BOT' })
  res = await api('/api/matches', { method: 'POST', token: botToken, body: { stakeTier: 'TIER_1', format: 'BO1' } })
  check('bot create 1v1 blocked', res.status === 401 || res.status === 403, res.json)
  res = await api('/api/matches/join', { method: 'POST', token: botToken, body: { matchId } })
  check('bot join 1v1 blocked', res.status === 401 || res.status === 403, res.json)
  res = await api('/api/practice/start', { method: 'POST', token: botToken, body: { aiLevel: 'MEDIUM' } })
  check('bot practice blocked', res.status === 401 || res.status === 403, res.json)
  res = await api('/api/auth/login', { method: 'POST', body: { email: 'bot@snooker.internal', password: 'admin123' } })
  check('bot cannot login', res.status === 401 || res.status === 403, res.json)

  let rejectedAtService = false
  try {
    await createOneVsOneMatch(botId, 'TIER_1', 'BO1')
  } catch (e) {
    rejectedAtService = e instanceof MatchError
  }
  check('service-level assertNotBot on create', rejectedAtService)

  console.log('== 8. practice: 3/day when zero balance ==')
  const zeroWallet = await prisma.wallet.findUnique({ where: { userId: alice.id }, select: { available: true, locked: true } })
  const zeroAmount = Number(zeroWallet?.available ?? 0)
  if (zeroAmount > 0) {
    await runInTransaction(async (tx) => {
      await ledger.debitAvailable(tx, { userId: alice.id, amount: zeroAmount, type: 'TEST_FREE_PRACTICE_ZERO' })
    })
  }
  wal = await getWallet(alice.token)
  check('alice zeroed', wal.balance === 0, wal)

  let practiceIds: string[] = []
  for (let i = 1; i <= 3; i++) {
    res = await api('/api/practice/start', { method: 'POST', token: alice.token, body: { aiLevel: 'MEDIUM' } })
    const ok = res.status === 200 && res.json?.ok
    check(`free practice #${i}`, ok, res.json)
    if (ok) practiceIds.push(res.json!.data.id as string)
  }
  res = await api('/api/practice/start', { method: 'POST', token: alice.token, body: { aiLevel: 'MEDIUM' } })
  check('4th practice blocked (limit)', res.status === 400 && String(res.json?.error).includes('free practice limit'), res.json)
  wal = await getWallet(alice.token)
  check('practice never touched wallet', wal.balance === 0 && wal.locked === 0, wal)
  res = await api('/api/practice/history', { token: alice.token })
  check('practice history has 3', Array.isArray(res.json?.data) && res.json.data.length === 3, res.json?.data?.length)

  await runInTransaction(async (tx) => {
    await ledger.creditAvailable(tx, { userId: alice.id, amount: 1000, type: 'TEST_FREE_PRACTICE_RESTORE' })
  })
  res = await api('/api/practice/start', { method: 'POST', token: alice.token, body: { aiLevel: 'EASY' } })
  check('unlimited practice with balance', res.status === 200 && res.json?.ok, res.json)

  console.log('== 9. practice socket vs robot ==')
  const practiceId = res.json!.data.id as string
  const sp = connectSocket(alice.token)
  const pJoined = waitFor<{ seat: number }>(sp, 'match:joined')
  const pStart = waitFor<any>(sp, 'match:start')
  sp.emit('match:join', { matchId: practiceId })
  const pj = await pJoined
  check('practice seat 0', pj.seat === 0, pj)
  await pStart
  let pUpdates = 0
  const [firstUpd] = await playShotLikeAClient(
    practiceId,
    sp,
    [sp],
    { aimAngle: 0.3, power: 0.7, spin: { x: 0, y: 0 } }
  )
  pUpdates++
  check('alice shot produced game:update', Array.isArray(firstUpd.events), firstUpd)
  let robotMoved = false
  try {
    const second = await watchShotLikeAClient(sp, practiceId, 8000)
    pUpdates++
    robotMoved = Array.isArray(second.events)
  } catch {
    robotMoved = false
  }
  check('robot shot produced second game:update', robotMoved && pUpdates >= 2)
  sp.disconnect()
  res = await api('/api/practice/resign', { method: 'POST', token: alice.token, body: { matchId: practiceId } })
  check('practice resign ok', res.status === 200 && res.json?.ok, res.json)

  console.log('== 10. tournament join guard + flow ==')
  res = await api('/api/tournaments', { method: 'POST', token: alice.token, body: { name: 'E2E Cup' } })
  check('create tournament', res.status === 200 && res.json?.ok, res.json)
  const tournamentId = res.json!.data.id as string
  res = await api('/api/tournaments/join', { method: 'POST', token: alice.token, body: { tournamentId } })
  check('alice joins tournament', res.status === 200 && res.json?.ok, res.json)
  res = await api('/api/tournaments/join', { method: 'POST', token: bob.token, body: { tournamentId } })
  check('bob joins tournament', res.status === 200 && res.json?.ok, res.json)
  res = await api(`/api/tournaments/${tournamentId}`, { token: alice.token })
  check('tournament has 2 players', Array.isArray(res.json?.data?.players) && res.json.data.players.length === 2, res.json?.data?.players)
  res = await api('/api/tournaments/open', { token: alice.token })
  check('open tournaments lists it', Array.isArray(res.json?.data) && res.json.data.some((t: { id: string }) => t.id === tournamentId), res.json)

  let rejectedTournamentJoin = false
  try {
    await joinTournament(tournamentId, botId)
  } catch (e) {
    rejectedTournamentJoin = e instanceof MatchError
  }
  check('service-level bot tournament join blocked', rejectedTournamentJoin)

  const t = await createTournament('Bot Guard Cup')
  let botBlockedTournament = false
  try {
    await joinTournament(t.id, botId)
  } catch (e) {
    botBlockedTournament = e instanceof MatchError
  }
  check('fresh tournament bot join blocked in service', botBlockedTournament)

  console.log('== 11. natural finish: BO3 plays to frame end, no concedes ==')
  res = await api('/api/matches', { method: 'POST', token: alice.token, body: { stakeTier: 'TIER_1', format: 'BO3' } })
  check('natural match created', res.status === 200 && res.json?.ok, res.json)
  const natMatchId = res.json!.data.id as string
  res = await api('/api/matches/join', { method: 'POST', token: bob.token, body: { matchId: natMatchId } })
  check('natural match joined', res.status === 200 && res.json?.ok, res.json)

  const sa2 = connectSocket(alice.token)
  const sb2 = connectSocket(bob.token)
  const naJoined = waitFor<{ seat: number }>(sa2, 'match:joined')
  const nbJoined = waitFor<{ seat: number }>(sb2, 'match:joined')
  const naStart = waitFor<any>(sa2, 'match:start')
  const nbStart = waitFor<any>(sb2, 'match:start')
  sa2.emit('match:join', { matchId: natMatchId })
  sb2.emit('match:join', { matchId: natMatchId })
  await naJoined
  await nbJoined
  const natStart = await naStart
  await nbStart
  check('natural match started frame 1', natStart.frameIndex === 1 && natStart.snapshot.balls.length === 22, natStart)

  let shadow = frameFromSnapshot(natStart.snapshot as FrameSnapshot)
  let strokeSeq = 0
  let frameStartEvents = 0
  let lastFrameIndex = 1
  let totalStrokes = 0
  let frameWins: number[] | null = null

  const MAX_SIM_STROKES = 1600
  while (totalStrokes < MAX_SIM_STROKES && frameWins === null) {
    const seat = shadow.turnIndex
    const move = computeBotShot(shadow, 'HARD', `nat-${lastFrameIndex}-${strokeSeq}`)
    const [uA, uB] = await playShotLikeAClient(natMatchId, seat === 0 ? sa2 : sb2, [sa2, sb2], move.shot)
    strokeSeq++
    totalStrokes++
    if (uA.frame && uB.frame && (uA.frame.turnIndex !== uB.frame.turnIndex || uA.frame.scores.player0 !== uB.frame.scores.player0 || uA.frame.scores.player1 !== uB.frame.scores.player1)) {
      check('broadcast frames are twins', false, { uA: uA.frame, uB: uB.frame })
    }
    const frame = uA.frame ?? uB.frame
    const events = (uA.events as { type: string }[]) ?? (uB.events as { type: string }[])
    const frameEnded = frame.phase === 'FRAME_END' || events.some((e) => e.type === 'FRAME_END')
    if (frameEnded) {
      const next = await waitAny<any>(sa2, ['frame:start', 'match:end'], 20000)
      if (next.event === 'frame:start') {
        frameStartEvents++
        lastFrameIndex = (next.payload as any).frameIndex
        shadow = frameFromSnapshot((next.payload as any).snapshot as FrameSnapshot)
      } else {
        frameWins = (next.payload as any).framesWon as number[]
      }
    } else {
      shadow = frameFromSnapshot(frame as FrameSnapshot)
    }
  }
  if (frameWins === null) {
    check('natural match reached a decision in time', false, { totalStrokes })
    sa2.emit('concede', { matchId: natMatchId })
  } else {
    check('natural match finished on frames', frameWins[0] + frameWins[1] === 2 || frameWins[0] + frameWins[1] === 3, frameWins)
    const winnerIndex = frameWins[0] === 2 ? 0 : 1
    const loserIndex = winnerIndex === 0 ? 1 : 0
    check('BO3 winner reached 2 frames', frameWins[winnerIndex] === 2, frameWins)
    check('all frames played', lastFrameIndex === frameStartEvents + 1, { lastFrameIndex, frameStartEvents })

    const winWalletBefore = await getWallet(winnerIndex === 0 ? alice.token : bob.token)
    const loseWalletBefore = await getWallet(loserIndex === 0 ? alice.token : bob.token)
    const winPre = winWalletBefore.total
    const losePre = loseWalletBefore.total
    const resolved = await waitForStatus(winnerIndex === 0 ? alice.token : bob.token, `/api/matches/${natMatchId}`, 'PRIZE_SETTLED', 12000)
    check('natural match settled', !!resolved, resolved)
    const winWallet = await getWallet(winnerIndex === 0 ? alice.token : bob.token)
    const loseWallet = await getWallet(loserIndex === 0 ? alice.token : bob.token)
    check('winner paid 80 net', winWallet.total === winPre + 80 && winWallet.locked === 0, { winWallet, winPre })
    check('loser paid 100 stake', loseWallet.total === losePre - 100 && loseWallet.locked === 0, { loseWallet, losePre })
    res = await api(`/api/matches/${natMatchId}`, { token: alice.token })
    check('natural match result prize 180', Number(res.json?.data?.resultJson?.prize) === 180, res.json?.data?.resultJson)
  }
  sa2.disconnect()
  sb2.disconnect()

  console.log('== 12. tournament drain: 8 joins -> all rounds -> champion ==')
  const tourPlayers: Array<{ id: string; token: string; username: string }> = []
  for (let i = 0; i < 8; i++) tourPlayers.push(await register(suffix, `t${i}`))
  const tokensById = new Map(tourPlayers.map((p) => [p.id, p.token]))

  res = await api('/api/tournaments', { method: 'POST', token: tourPlayers[0].token, body: { name: 'Drain Cup' } })
  check('tournament created', res.status === 200 && res.json?.ok, res.json)
  const drainTournamentId = res.json!.data.id as string

  for (let i = 0; i < 8; i++) {
    const r = await api('/api/tournaments/join', { method: 'POST', token: tourPlayers[i].token, body: { tournamentId: drainTournamentId } })
    check(`player ${i + 1} joins`, r.status === 200 && r.json?.ok, r.json)
  }

  res = await api(`/api/tournaments/${drainTournamentId}`, { token: tourPlayers[0].token })
  const startTourn = res.json!.data
  check('tournament IN_PROGRESS after 8 joins', startTourn.status === 'IN_PROGRESS', startTourn.status)
  const qfMatches = (startTourn.matches as any[]).filter((m) => m.round === 1)
  check('QF bracket has 4 matches', qfMatches.length === 4, qfMatches.length)
  check('each QF has 2 players', qfMatches.every((m) => m.players.length === 2), qfMatches.map((m) => m.players.length))

  const extra9 = await register(suffix, 'x')
  res = await api('/api/tournaments/join', { method: 'POST', token: extra9.token, body: { tournamentId: drainTournamentId } })
  check('9th player join rejected', res.status === 400, res.json)

  async function drainMatchByConcede(matchId: string, tokens: Map<string, string>): Promise<void> {
    const mm = await prisma.match.findUnique({ where: { id: matchId }, include: { players: true } })
    if (!mm || mm.players.length !== 2) throw new Error('bad tournament match')
    const seat0 = mm.players.find((p) => p.seat === 0)!
    const seat1 = mm.players.find((p) => p.seat === 1)!
    const t0 = tokens.get(seat0.userId)!
    const t1 = tokens.get(seat1.userId)!
    const s0 = connectSocket(t0)
    const s1 = connectSocket(t1)
    const j0 = waitFor<{ seat: number }>(s0, 'match:joined')
    const j1 = waitFor<{ seat: number }>(s1, 'match:joined')
    const st0 = waitFor<any>(s0, 'match:start')
    const st1 = waitFor<any>(s1, 'match:start')
    s0.emit('match:join', { matchId })
    s1.emit('match:join', { matchId })
    await Promise.all([j0, j1])
    await Promise.all([st0, st1])
    const e0 = waitFor<any>(s0, 'match:end')
    const e1 = waitFor<any>(s1, 'match:end')
    s1.emit('concede', { matchId })
    const [end0, end1] = await Promise.all([e0, e1])
    check(`drain ${matchId} (seat 0 wins on concede)`, end0.winnerSeat === 0 && end1.winnerSeat === 0, { end0, end1 })
    s0.disconnect()
    s1.disconnect()
    const settled = await waitForStatus(t0, `/api/matches/${matchId}`, 'PRIZE_SETTLED', 8000)
    check(`match ${matchId} settled`, !!settled, settled)
  }

  for (let round = 1; round <= 3; round++) {
    const rr = await api(`/api/tournaments/${drainTournamentId}`, { token: tourPlayers[0].token })
    const roundMatches = (rr.json!.data.matches as any[]).filter((m) => m.round === round && m.status !== 'PRIZE_SETTLED')
    for (const m of roundMatches) {
      await drainMatchByConcede(m.id, tokensById)
    }
  }

  res = await api(`/api/tournaments/${drainTournamentId}`, { token: tourPlayers[0].token })
  const doneTourn = res.json!.data
  check('tournament COMPLETED', doneTourn.status === 'COMPLETED', doneTourn.status)
  check('champion is seed 1 player', doneTourn.championId === tourPlayers[0].id, { championId: doneTourn.championId })
  check('runner-up is seed 3 player', doneTourn.runnerUpId === tourPlayers[2].id, { runnerUpId: doneTourn.runnerUpId })
  check('finishedAt set', !!doneTourn.finishedAt, doneTourn.finishedAt)

  const bracket = doneTourn.resultsJson
  check(
    'QF winners [1,4,3,2]',
    JSON.stringify(bracket.rounds[0].slots.map((s: any) => s.winnerSeed)) === JSON.stringify([1, 4, 3, 2]),
    bracket.rounds[0].slots
  )
  check(
    'SF winners [1,3]',
    JSON.stringify(bracket.rounds[1].slots.map((s: any) => s.winnerSeed)) === JSON.stringify([1, 3]),
    bracket.rounds[1].slots
  )
  check('Final winner = 1', bracket.rounds[2].slots[0].winnerSeed === 1, bracket.rounds[2].slots[0])
  check('all bracket slots have matchId', bracket.rounds.every((r: any) => r.slots.every((s: any) => !!s.matchId)))

  const allTournMatches = doneTourn.matches as any[]
  check('7 tournament matches total', allTournMatches.length === 7, allTournMatches.length)
  check('all 7 matches PRIZE_SETTLED', allTournMatches.every((m) => m.status === 'PRIZE_SETTLED'), allTournMatches.map((m) => m.status))
  const finalMatch = allTournMatches.find((m) => m.round === 3)
  check('final match round 3', finalMatch?.round === 3, finalMatch)
  check('final winner = champion', finalMatch?.winnerId === tourPlayers[0].id, { winnerId: finalMatch?.winnerId })
  check('final resultJson prize 0', finalMatch && Number(finalMatch.resultJson?.prize) === 0, finalMatch?.resultJson)

  const championStatus = doneTourn.players.find((p: any) => p.userId === tourPlayers[0].id)
  const eliminatedCount = doneTourn.players.filter((p: any) => p.status === 'ELIMINATED').length
  check('seed 1 status CHAMPION', championStatus?.status === 'CHAMPION', championStatus)
  check('7 players eliminated', eliminatedCount === 7, eliminatedCount)

  let allFree = true
  for (const p of tourPlayers) {
    const w = await getWallet(p.token)
    if (!(w.balance === 1000 && w.locked === 0 && w.total === 1000)) allFree = false
  }
  check('all 8 players keep 1000 CR (free tournament)', allFree)

  res = await api('/api/tournaments/history', { token: tourPlayers[0].token })
  check('history lists completed tournament', Array.isArray(res.json?.data) && res.json.data.some((t: any) => t.id === drainTournamentId), res.json)

  console.log('== 13. notifications: join, settle, practice, champion, read flow ==')
  res = await api('/api/notifications', { token: alice.token })
  const aliceNotifs = (res.json?.data?.items as any[]) ?? []
  check('alice got match invite when bob joined', aliceNotifs.some((n) => n.kind === 'MATCH_INVITE'), aliceNotifs.map((n) => n.kind))
  check('alice got natural-match result notification', aliceNotifs.some((n) => n.kind === 'MATCH_RESULT'), aliceNotifs.map((n) => n.kind))
  res = await api('/api/notifications', { token: bob.token })
  const bobNotifs = (res.json?.data?.items as any[]) ?? []
  check('bob got natural-match result notification', bobNotifs.some((n) => n.kind === 'MATCH_RESULT'), bobNotifs.map((n) => n.kind))
  res = await api('/api/notifications', { token: tourPlayers[0].token })
  const champNotifs = (res.json?.data?.items as any[]) ?? []
  check(
    'champion got tournament crown notification',
    champNotifs.some((n) => n.kind === 'TOURNAMENT_RESULT' && String(n.body ?? '').includes('Drain Cup')),
    champNotifs.map((n) => n.kind)
  )

  const pracUser = await register(suffix, 'p')
  res = await api('/api/practice/start', { method: 'POST', token: pracUser.token, body: { aiLevel: 'MEDIUM' } })
  check('practice for notification test started', res.status === 200 && res.json?.ok, res.json)
  const notifyPracticeId = res.json!.data.id as string
  const spPrac = connectSocket(pracUser.token)
  const npJoined = waitFor<{ seat: number }>(spPrac, 'match:joined')
  const npStart = waitFor<any>(spPrac, 'match:start')
  spPrac.emit('match:join', { matchId: notifyPracticeId })
  await npJoined
  const npStartData = await npStart
  let pShadow = frameFromSnapshot(npStartData.snapshot as FrameSnapshot)
  let pOver = false
  let pStrokes = 0
  let pEnd = 'stroke-limit'
  while (!pOver && pStrokes < 700) {
    if (pShadow.turnIndex === 0) {
      const move = computeBotShot(pShadow, 'HARD', `prac-notif-${pStrokes}`)
      const [upd] = await playShotLikeAClient(notifyPracticeId, spPrac, [spPrac], move.shot)
      if (upd.frame?.phase === 'FRAME_END') {
        pOver = true
        pEnd = 'frame-end'
      } else pShadow = frameFromSnapshot(upd.frame ?? pShadow)
    } else {
      // The bot's turn: the harness plays no shot, but it still watches the bot's
      // playback and acknowledges it, exactly as the browser client does. Without
      // that the room's hold keeps the bot from ever taking its next shot.
      try {
        const upd = await watchShotLikeAClient(spPrac, notifyPracticeId, 30000)
        if (upd.frame?.phase === 'FRAME_END') {
          pOver = true
          pEnd = 'frame-end'
        } else pShadow = frameFromSnapshot(upd.frame ?? pShadow)
      } catch {
        pEnd = 'bot-wait-timeout'
        break
      }
    }
    pStrokes++
  }
  await waitFor<any>(spPrac, 'match:end', 8000).catch(() => undefined)
  spPrac.disconnect()
  let pracChatted = false
  for (let i = 0; i < 20 && !pracChatted; i++) {
    await new Promise((r) => setTimeout(r, 500))
    res = await api('/api/notifications', { token: pracUser.token })
    pracChatted = ((res.json?.data?.items as any[]) ?? []).some((n) => n.kind === 'PRACTICE')
  }
  check('practice completion produced notification', pracChatted, { pEnd, pStrokes })

  res = await api('/api/notifications', { token: alice.token })
  const unreadBefore = res.json?.data?.unread as number | undefined
  check('unread count reported', typeof unreadBefore === 'number' && unreadBefore > 0, unreadBefore)
  res = await api('/api/notifications/read', { method: 'POST', token: alice.token, body: {} })
  check('mark-all-read ok', res.status === 200 && res.json?.ok, res.json)
  res = await api('/api/notifications', { token: alice.token })
  check('unread 0 after mark all', (res.json?.data?.unread as number) === 0, res.json?.data?.unread)

  console.log('== 14. admin panel backend: guard, stats, users, audit ==')
  res = await api('/api/auth/login', { method: 'POST', body: { email: 'admin@snooker.test', password: 'admin123' } })
  check('admin login ok', res.status === 200 && res.json?.ok, res.json)
  const adminToken = res.json!.data.token as string
  res = await api('/api/admin/stats', { token: alice.token })
  check('regular user blocked from admin stats', res.status === 403, res.status)
  res = await api('/api/admin/stats', { token: adminToken })
  const stats = res.json?.data as { users: number; activeMatches: number; completedMatches: number; platformRevenue: number }
  check('admin stats return counters', typeof stats?.users === 'number' && typeof stats?.completedMatches === 'number' && typeof stats?.platformRevenue === 'number', stats)
  res = await api('/api/admin/users', { token: adminToken })
  check('admin users list', Array.isArray(res.json?.data) && (res.json.data as any[]).length > 2, res.json?.data?.length)

  const victim = await register(suffix, 'v')
  res = await api('/api/admin/users', { method: 'PATCH', token: adminToken, body: { userId: victim.id, status: 'BANNED' } })
  check('patch user status to BANNED', res.status === 200 && res.json?.data?.status === 'BANNED', res.json)
  res = await api('/api/admin/users', { token: adminToken })
  const victimRow = (res.json?.data as any[]).find((u) => u.id === victim.id)
  check('banned status persisted in admin list', victimRow?.status === 'BANNED', victimRow?.status)
  res = await api('/api/admin/users', { method: 'PATCH', token: adminToken, body: { userId: victim.id, status: 'ACTIVE', role: 'ADMIN' } })
  check('restore + promote victim to ADMIN', res.status === 200 && res.json?.data?.status === 'ACTIVE' && res.json?.data?.role === 'ADMIN', res.json)

  res = await api('/api/admin/wallet/adjust', { method: 'POST', token: adminToken, body: { userId: victim.id, amount: 25, reason: 'e2e test adjust' } })
  check('wallet adjust ok', res.status === 200 && res.json?.ok, res.json)
  const victimWallet = await getWallet(victim.token)
  check('victim wallet +25 after adjust', victimWallet.total === 1025 && victimWallet.balance === 1025, victimWallet)

  res = await api('/api/admin/matches', { token: adminToken })
  const adminMatches = (res.json?.data as any[]) ?? []
  check('admin matches list non-empty', adminMatches.length > 0, adminMatches.length)
  const candidates = adminMatches.filter((m) => m.status === 'PRIZE_SETTLED').slice(0, 12)
  let replayLen = 0
  for (const m of candidates) {
    const eventsRes = await api(`/api/admin/matches/${m.id}/events`, { token: adminToken })
    const evts = (eventsRes.json?.data as any[]) ?? []
    if (evts.length > 0) {
      replayLen = evts.length
      break
    }
  }
  check('match replay events array non-empty', replayLen > 0, replayLen)

  const settingKey = `e2e_setting_${suffix}`
  res = await api('/api/admin/settings', { method: 'PATCH', token: adminToken, body: { key: settingKey, value: { enabled: true, slots: 4 } } })
  check('settings patch ok', res.status === 200 && res.json?.ok, res.json)
  res = await api('/api/admin/settings', { token: adminToken })
  const settings = res.json?.data as Record<string, any>
  check('patched setting visible', Boolean(settings?.[settingKey]?.enabled), settings?.[settingKey])
  res = await api('/api/admin/actions', { token: adminToken })
  const actions = (res.json?.data as any[]) ?? []
  check('admin actions logged', actions.some((a) => a.action === 'SET_SETTING' && a.targetId === settingKey), actions.map((a) => a.action))
  check(
    'admin actions include user patch + adjust',
    actions.some((a) => a.action === 'UPDATE_USER' && a.targetId === victim.id) && actions.some((a) => a.action === 'WALLET_ADJUST' && a.targetId === victim.id),
    actions.map((a) => a.action)
  )

  console.log('== 15. DB-backed settings: reflect immediately + maintenance gate ==')
  /**
   * Puts the settings the run edits back to the product defaults.
   *
   * This is a list, and a list of the keys the run changes is only as good as its
   * contents: `turnTimeoutSec` was missing from it, so section 17's 600 outlived the
   * run and every later match in this database inherited a ten-minute shot clock. The
   * turn clock showed 570 seconds in play as a result. Any key this run writes has to
   * be reset here or it becomes the default for the next run and the next player.
   */
  const resetSettings = async () => {
    const rows: Array<[string, unknown]> = [
      ['commissionPct', 0.1],
      ['minStake', 100],
      ['maxStake', 1000],
      ['matchFormats', ['BO1', 'BO3', 'BO5']],
      ['reconnectGraceSec', 120],
      ['turnTimeoutSec', DEFAULT_TURN_TIMEOUT_SEC],
      ['maintenanceMode', false]
    ]
    for (const [key, value] of rows) {
      await api('/api/admin/settings', { method: 'PATCH', token: adminToken, body: { key, value } })
    }
  }
  await resetSettings()
  res = await api('/api/admin/settings', { token: adminToken })
  const dbSettings = res.json?.data as Record<string, any>
  check(
    'seeded settings present',
    dbSettings?.commissionPct === 0.1 && dbSettings?.minStake === 100 && dbSettings?.maxStake === 1000 &&
      Array.isArray(dbSettings?.matchFormats) && dbSettings?.maintenanceMode === false,
    dbSettings
  )

  const sv1 = await register(suffix, 'g')
  const sv2 = await register(suffix, 'h')

  res = await api('/api/admin/settings', { method: 'PATCH', token: adminToken, body: { key: 'minStake', value: 150 } })
  check('set minStake 150 ok', res.status === 200 && res.json?.ok, res.json)
  res = await api('/api/matches', { method: 'POST', token: sv1.token, body: { stakeTier: 'TIER_1', format: 'BO3' } })
  check('low tier rejected under minStake 150', res.status === 400 && /minimum stake is 150/.test(res.json?.error ?? ''), res.json)
  res = await api('/api/admin/settings', { method: 'PATCH', token: adminToken, body: { key: 'minStake', value: 100 } })
  check('restore minStake 100', res.status === 200 && res.json?.ok, res.json)

  res = await api('/api/admin/settings', { method: 'PATCH', token: adminToken, body: { key: 'maxStake', value: 500 } })
  check('set maxStake 500 ok', res.status === 200 && res.json?.ok, res.json)
  res = await api('/api/matches', { method: 'POST', token: sv1.token, body: { stakeTier: 'TIER_10', format: 'BO3' } })
  check('high tier rejected under maxStake 500', res.status === 400 && /maximum stake is 500/.test(res.json?.error ?? ''), res.json)
  res = await api('/api/admin/settings', { method: 'PATCH', token: adminToken, body: { key: 'maxStake', value: 1000 } })
  check('restore maxStake 1000', res.status === 200 && res.json?.ok, res.json)

  res = await api('/api/admin/settings', { method: 'PATCH', token: adminToken, body: { key: 'commissionPct', value: 0.2 } })
  check('set commissionPct 0.2 ok', res.status === 200 && res.json?.ok, res.json)
  res = await api('/api/matches', { method: 'POST', token: sv1.token, body: { stakeTier: 'TIER_1', format: 'BO3' } })
  check('match created under commission 0.2', res.status === 200 && res.json?.ok, res.json)
  const commissionMatchId = res.json!.data.id as string
  res = await api('/api/admin/matches', { token: adminToken })
  const foundMatch = (res.json?.data as any[]).find((m) => m.id === commissionMatchId)
  check('created match stores platformFeePct 0.2 immediately', Number(foundMatch?.platformFeePct) === 0.2, foundMatch?.platformFeePct)
  res = await api('/api/matches/join', { method: 'POST', token: sv2.token, body: { matchId: commissionMatchId } })
  check('join for settle ok', res.status === 200 && res.json?.ok, res.json)
  res = await api('/api/matches/concede', { method: 'POST', token: sv1.token, body: { matchId: commissionMatchId } })
  check('settle ok', res.status === 200 && res.json?.ok, res.json)
  res = await api('/api/admin/settings', { method: 'PATCH', token: adminToken, body: { key: 'commissionPct', value: 0.1 } })
  check('restore commissionPct 0.1', res.status === 200 && res.json?.ok, res.json)

  res = await api('/api/admin/settings', { method: 'PATCH', token: adminToken, body: { key: 'matchFormats', value: ['BO1', 'BO3'] } })
  check('set matchFormats [BO1,BO3] ok', res.status === 200 && res.json?.ok, res.json)
  res = await api('/api/matches', { method: 'POST', token: sv1.token, body: { stakeTier: 'TIER_1', format: 'BO5' } })
  check('BO5 rejected when disabled', res.status === 400 && res.json?.error?.includes('format BO5 is not enabled'), res.json)
  res = await api('/api/matches', { method: 'POST', token: sv1.token, body: { stakeTier: 'TIER_1', format: 'BO3' } })
  check('BO3 accepted when enabled', res.status === 200 && res.json?.ok, res.json)
  const formatMatchId = res.json!.data.id as string
  res = await api('/api/matches/join', { method: 'POST', token: sv2.token, body: { matchId: formatMatchId } })
  check('join format test match ok', res.status === 200 && res.json?.ok, res.json)
  res = await api('/api/matches/concede', { method: 'POST', token: sv1.token, body: { matchId: formatMatchId } })
  check('settle format test match ok', res.status === 200 && res.json?.ok, res.json)
  res = await api('/api/admin/settings', { method: 'PATCH', token: adminToken, body: { key: 'matchFormats', value: ['BO1', 'BO3', 'BO5'] } })
  check('restore matchFormats', res.status === 200 && res.json?.ok, res.json)

  res = await api('/api/admin/settings', { method: 'PATCH', token: adminToken, body: { key: 'maintenanceMode', value: true } })
  check('enable maintenanceMode', res.status === 200 && res.json?.ok, res.json)
  res = await api('/api/settings/public')
  check('public maintenance status true', res.status === 200 && res.json?.data?.maintenanceMode === true, res.json)
  res = await api('/api/admin/stats', { token: adminToken })
  check('admin stats work during maintenance', res.status === 200, res.status)
  res = await api('/api/auth/login', { method: 'POST', body: { email: 'player@snooker.test', password: 'admin123' } })
  check('player login blocked during maintenance', res.status === 503, res.status)
  res = await api('/api/practice/start', { method: 'POST', token: alice.token, body: {} })
  check('practice blocked during maintenance', res.status === 503, res.status)
  const maintSock = connectSocket(sv2.token)
  const maintErr = await new Promise<string>((resolve) => {
    const t = setTimeout(() => resolve('timeout'), 6000)
    maintSock.once('connect_error', (e: Error) => {
      clearTimeout(t)
      resolve(e.message)
    })
  })
  maintSock.disconnect()
  check('socket rejected during maintenance', maintErr === 'maintenance', maintErr)
  res = await api('/api/auth/login', { method: 'POST', body: { email: 'admin@snooker.test', password: 'admin123' } })
  check('admin login allowed during maintenance', res.status === 200 && res.json?.ok, res.status)
  res = await api('/api/admin/settings', { method: 'PATCH', token: adminToken, body: { key: 'maintenanceMode', value: false } })
  check('disable maintenanceMode', res.status === 200 && res.json?.ok, res.json)
  res = await api('/api/settings/public')
  check('public maintenance status false', res.status === 200 && res.json?.data?.maintenanceMode === false, res.json)
  res = await api('/api/auth/login', { method: 'POST', body: { email: 'player@snooker.test', password: 'admin123' } })
  check('player login restored', res.status === 200 && res.json?.ok, res.status)

  console.log('== 16. reconnect & disconnect policy ==')
  await resetSettings()

  const reCreate = await api('/api/matches', { method: 'POST', token: sv1.token, body: { stakeTier: 'TIER_1', format: 'BO3' } })
  check('reconnect match created', reCreate.status === 200 && reCreate.json?.ok, reCreate.json)
  const reId = reCreate.json!.data.id as string
  const reJoinRes = await api('/api/matches/join', { method: 'POST', token: sv2.token, body: { matchId: reId } })
  check('reconnect match joined', reJoinRes.status === 200 && reJoinRes.json?.ok, reJoinRes.json)

  const sr1 = connectSocket(sv1.token)
  const sr2 = connectSocket(sv2.token)
  const reJ1 = waitFor<{ seat: number }>(sr1, 'match:joined')
  const reJ2 = waitFor<{ seat: number }>(sr2, 'match:joined')
  const reS1 = waitFor<any>(sr1, 'match:start')
  const reS2 = waitFor<any>(sr2, 'match:start')
  sr1.emit('match:join', { matchId: reId })
  sr2.emit('match:join', { matchId: reId })
  await reJ1
  await reJ2
  const reStartData = await reS1
  await reS2
  check('reconnect match started', reStartData.frameIndex === 1 && reStartData.snapshot.balls.length === 22, reStartData)

  let reShadow = frameFromSnapshot(reStartData.snapshot as FrameSnapshot)
  let reStrokes = 0
  let reScenario = false
  let missedSeqList: number[] = []
  while (reStrokes < 120 && !reScenario) {
    const seatTurn = reShadow.turnIndex
    if (seatTurn === 1) {
      reScenario = true
      const gone = waitFor<any>(sr2, 'opponent:disconnected', 10000)
      sr1.disconnect()
      const goneData = await gone
      check('opponent notified of seat disconnect', goneData.seat === 0, goneData)
      const goneMove = computeBotShot(reShadow, 'HARD', `reconn-gone-${reStrokes}`)
      // Seat 0 is disconnected here, so only the connected seat is waited on.
      const [goneUpd] = await playShotLikeAClient(reId, sr2, [sr2], goneMove.shot)
      missedSeqList = ((goneUpd.events ?? []) as Array<{ seq: number }>).map((e) => e.seq)
      check('turn played while opponent absent', missedSeqList.length > 0, missedSeqList)
      reShadow = frameFromSnapshot(goneUpd.frame ?? reShadow)

      const backNotice = waitFor<any>(sr2, 'opponent:reconnected', 20000)
      sr1.connect()
      await new Promise<void>((resolveBack) => {
        sr1.once('connect', () => resolveBack())
      })
      const rjData = await joinMatchUntilAcked(sr1, reId, 'match:joined', 1500, 16)
      check('reconnected at original seat', rjData.seat === 0, rjData)
      let replayData: any
      for (let attempt = 0; attempt < 12; attempt++) {
        const replayWait = waitFor<any>(sr1, 'match:replay', 1500)
        sr1.emit('match:join', { matchId: reId })
        try {
          replayData = await replayWait
          break
        } catch {
          replayData = undefined
        }
      }
      if (!replayData) throw new Error('timeout waiting for match:replay')
      const replaySeqs = ((replayData.events ?? []) as Array<{ seq: number }>).map((e) => e.seq)
      check(
        'reconnect replays missed events by seq',
        missedSeqList.length > 0 && missedSeqList.every((s) => replaySeqs.includes(s)),
        { replaySeqs, missedSeqList }
      )
      const backData = await backNotice
      check('opponent told player reconnected', backData.seat === 0, backData)
    } else {
      const move = computeBotShot(reShadow, 'HARD', `reconn-${reStrokes}`)
      const [u1, u2] = await playShotLikeAClient(reId, sr1, [sr1, sr2], move.shot)
      const frame = u1.frame ?? u2.frame
      const events = (u1.events ?? []) as Array<{ type: string }>
      const frameEnded = frame.phase === 'FRAME_END' || events.some((e) => e.type === 'FRAME_END')
      if (frameEnded) {
        const next = await waitAny<any>(sr1, ['frame:start', 'match:end'], 15000)
        if (next.event === 'match:end') break
        reShadow = frameFromSnapshot((next.payload as any).snapshot as FrameSnapshot)
      } else {
        reShadow = frameFromSnapshot(frame as FrameSnapshot)
      }
    }
    reStrokes++
  }
  check('reconnect scenario exercised', reScenario, reScenario)
  const reAfter = await api(`/api/matches/${reId}`, { token: sv1.token })
  check(
    'brief disconnect did not settle the match',
    ['MATCH_STARTED', 'MATCH_IN_PROGRESS'].includes(reAfter.json?.data?.status as string),
    reAfter.json?.data?.status
  )
  sr1.disconnect()
  sr2.disconnect()

  const ab1 = await register(suffix, 'ab1')
  const ab2 = await register(suffix, 'ab2')
  res = await api('/api/admin/settings', { method: 'PATCH', token: adminToken, body: { key: 'reconnectGraceSec', value: 2 } })
  check('grace sec set to 2', res.status === 200 && res.json?.ok, res.json)
  const ab1Before = (await getWallet(ab1.token)).total
  const ab2Before = (await getWallet(ab2.token)).total
  const abCreate = await api('/api/matches', { method: 'POST', token: ab1.token, body: { stakeTier: 'TIER_1', format: 'BO3' } })
  check('abandon match created', abCreate.status === 200 && abCreate.json?.ok, abCreate.json)
  const abId = abCreate.json!.data.id as string
  const abJoinRes = await api('/api/matches/join', { method: 'POST', token: ab2.token, body: { matchId: abId } })
  check('abandon match joined', abJoinRes.status === 200 && abJoinRes.json?.ok, abJoinRes.json)
  const sa1 = connectSocket(ab1.token)
  const sab2 = connectSocket(ab2.token)
  const abJ1 = waitFor<{ seat: number }>(sa1, 'match:joined')
  const abJ2 = waitFor<{ seat: number }>(sab2, 'match:joined')
  const abS1 = waitFor<any>(sa1, 'match:start')
  const abS2 = waitFor<any>(sab2, 'match:start')
  sa1.emit('match:join', { matchId: abId })
  sab2.emit('match:join', { matchId: abId })
  await abJ1
  await abJ2
  await abS1
  await abS2
  const abGone = waitFor<any>(sab2, 'opponent:disconnected', 10000)
  sa1.disconnect()
  const abGoneData = await abGone
  check('abandon: opponent notified', abGoneData.seat === 0, abGoneData)
  const abEnd = waitFor<any>(sab2, 'match:end', 15000)
  const abEndData = await abEnd
  check('abandon: connected player wins', abEndData.winnerSeat === 1 && abEndData.reason === 'abandon', abEndData)
  const abSettled = await waitForStatus(ab2.token, `/api/matches/${abId}`, 'PRIZE_SETTLED', 15000)
  check('abandon: match settled', !!abSettled, abSettled?.status)
  const ab1Wallet = await getWallet(ab1.token)
  const ab2Wallet = await getWallet(ab2.token)
  check('abandon: loser forfeits stake', ab1Wallet.total === ab1Before - 100 && ab1Wallet.locked === 0, { ab1Before, total: ab1Wallet.total })
  check('abandon: winner paid prize', ab2Wallet.total === ab2Before + 80 && ab2Wallet.locked === 0, { ab2Before, total: ab2Wallet.total })
  const abRejoin = waitFor<any>(sa1, 'match:end', 12000)
  await new Promise<void>((resolveBack) => {
    sa1.once('connect', () => resolveBack())
    sa1.connect()
  })
  sa1.emit('match:join', { matchId: abId })
  const abRejoinData = await abRejoin
  check('abandoned player sees result on rejoin', abRejoinData.reason === 'abandon' && abRejoinData.winnerSeat === 1, abRejoinData)
  sa1.disconnect()
  sab2.disconnect()

  const rf1 = await register(suffix, 'rf1')
  const rf2 = await register(suffix, 'rf2')
  res = await api('/api/admin/settings', { method: 'PATCH', token: adminToken, body: { key: 'reconnectGraceSec', value: 2 } })
  check('grace sec set to 2 for refund', res.status === 200 && res.json?.ok, res.json)
  const rf1Before = (await getWallet(rf1.token)).total
  const rf2Before = (await getWallet(rf2.token)).total
  const rfCreate = await api('/api/matches', { method: 'POST', token: rf1.token, body: { stakeTier: 'TIER_1', format: 'BO3' } })
  check('refund match created', rfCreate.status === 200 && rfCreate.json?.ok, rfCreate.json)
  const rfId = rfCreate.json!.data.id as string
  const rfJoinRes = await api('/api/matches/join', { method: 'POST', token: rf2.token, body: { matchId: rfId } })
  check('refund match joined', rfJoinRes.status === 200 && rfJoinRes.json?.ok, rfJoinRes.json)
  const srf1 = connectSocket(rf1.token)
  const srf2 = connectSocket(rf2.token)
  const rfJ1 = waitFor<{ seat: number }>(srf1, 'match:joined')
  const rfJ2 = waitFor<{ seat: number }>(srf2, 'match:joined')
  const rfS1 = waitFor<any>(srf1, 'match:start')
  const rfS2 = waitFor<any>(srf2, 'match:start')
  srf1.emit('match:join', { matchId: rfId })
  srf2.emit('match:join', { matchId: rfId })
  await rfJ1
  await rfJ2
  await rfS1
  await rfS2
  srf1.disconnect()
  srf2.disconnect()
  const rfRefunded = await waitForStatus(rf1.token, `/api/matches/${rfId}`, 'REFUNDED', 15000)
  check('both disconnected match refunded', !!rfRefunded, rfRefunded?.status)
  const rf1Wallet = await getWallet(rf1.token)
  const rf2Wallet = await getWallet(rf2.token)
  check(
    'refund restores both stakes',
    rf1Wallet.total === rf1Before && rf2Wallet.total === rf2Before && rf1Wallet.locked === 0 && rf2Wallet.locked === 0,
    { rf1Before, rf1: rf1Wallet, rf2Before, rf2: rf2Wallet }
  )

  console.log('== 17. turn timeouts + input hardening ==')
  const s17 = `${Date.now() % 100000}_${Math.random().toString(36).slice(2, 8)}`
  res = await api('/api/admin/settings', { method: 'PATCH', token: adminToken, body: { key: 'reconnectGraceSec', value: 600 } })
  check('long grace set for timeout test', res.status === 200 && res.json?.ok, res.json)
  res = await api('/api/admin/settings', { method: 'PATCH', token: adminToken, body: { key: 'turnTimeoutSec', value: 2 } })
  check('turn timeout set to 2s', res.status === 200 && res.json?.ok, res.json)

  const tt1 = await register(s17, 'tt1')
  const tt2 = await register(s17, 'tt2')
  const ttCreate = await api('/api/matches', { method: 'POST', token: tt1.token, body: { stakeTier: 'TIER_1', format: 'BO3' } })
  check('timeout match created', ttCreate.status === 200 && ttCreate.json?.ok, ttCreate.json)
  const ttId = ttCreate.json!.data.id as string
  const ttJoin = await api('/api/matches/join', { method: 'POST', token: tt2.token, body: { matchId: ttId } })
  check('timeout match joined', ttJoin.status === 200 && ttJoin.json?.ok, ttJoin.json)
  const stt1 = connectSocket(tt1.token)
  const stt2 = connectSocket(tt2.token)
  const ttJ1 = waitFor<{ seat: number }>(stt1, 'match:joined')
  const ttJ2 = waitFor<{ seat: number }>(stt2, 'match:joined')
  const ttS1 = waitFor<any>(stt1, 'match:start')
  const ttS2 = waitFor<any>(stt2, 'match:start')
  stt1.emit('match:join', { matchId: ttId })
  stt2.emit('match:join', { matchId: ttId })
  await ttJ1
  await ttJ2
  const ttStart = await ttS1
  await ttS2
  check('timeout match started', ttStart.frameIndex === 1 && ttStart.snapshot.balls.length === 22, ttStart)
  const firstSeat = ttStart.snapshot.turnIndex as number
  const oppSeat = firstSeat === 0 ? 1 : 0
  const tUp1 = waitFor<any>(stt1, 'game:update', 10000)
  const tUp2 = waitFor<any>(stt2, 'game:update', 10000)
  const fu1 = await tUp1
  const fu2 = await tUp2
  const all17 = [...(fu1.events ?? []), ...(fu2.events ?? [])]
  const tfoul = all17.find((e: any) => e.type === 'FOUL' && e.data?.reason === 'turn timeout') as any
  const tturn = all17.find((e: any) => e.type === 'TURN_CHANGE') as any
  check('timeout foul: penalty 4 charged to the shooter', !!tfoul && tfoul.data.penalty === 4 && tfoul.data.bySeat === firstSeat, tfoul ?? all17)
  check('timeout foul switched the visit', tturn?.data?.turnSeat === oppSeat, tturn ?? all17)
  const tScores = (fu1?.frame?.scores ?? fu2?.frame?.scores) as { player0: number; player1: number } | undefined
  check('opponent awarded 4 points', tScores ? (oppSeat === 0 ? tScores.player0 : tScores.player1) === 4 : false, tScores)
  stt1.disconnect()
  stt2.disconnect()

  res = await api('/api/admin/settings', { method: 'PATCH', token: adminToken, body: { key: 'turnTimeoutSec', value: 600 } })
  check('turn timeout raised to 600s', res.status === 200 && res.json?.ok, res.json)

  const tt3 = await register(s17, 'tt3')
  const tt4 = await register(s17, 'tt4')
  const thCreate = await api('/api/matches', { method: 'POST', token: tt3.token, body: { stakeTier: 'TIER_1', format: 'BO3' } })
  check('hardening match created', thCreate.status === 200 && thCreate.json?.ok, thCreate.json)
  const thId = thCreate.json!.data.id as string
  const thJoin = await api('/api/matches/join', { method: 'POST', token: tt4.token, body: { matchId: thId } })
  check('hardening match joined', thJoin.status === 200 && thJoin.json?.ok, thJoin.json)
  const sth1 = connectSocket(tt3.token)
  const sth2 = connectSocket(tt4.token)
  const thJ1 = waitFor<any>(sth1, 'match:joined')
  const thJ2 = waitFor<any>(sth2, 'match:joined')
  const thS1 = waitFor<any>(sth1, 'match:start')
  const thS2 = waitFor<any>(sth2, 'match:start')
  sth1.emit('match:join', { matchId: thId })
  sth2.emit('match:join', { matchId: thId })
  await thJ1
  await thJ2
  const thStart = await thS1
  await thS2
  const floodShooter = thStart.snapshot.turnIndex === 0 ? sth1 : sth2

  const shotFeedback = (s: Socket, matchId: string, input: unknown, windowMs = 5000): Promise<string> =>
    new Promise((resolve) => {
      let done = false
      const finish = (v: string) => {
        if (done) return
        done = true
        s.off('error', onErr)
        s.off('game:update', onUpd)
        resolve(v)
      }
      const onErr = (d: { code?: string }) => finish(d?.code ?? 'unknown')
      const onUpd = (update: any) => {
        // The shot was really taken, so the client that played it acknowledges the
        // playback and releases the room's hold, echoing the token it was sent.
        ackShot(s, matchId, update?.playback?.token)
        finish('accepted')
      }
      s.on('error', onErr)
      s.on('game:update', onUpd)
      setTimeout(() => finish('timeout'), windowMs)
      s.emit('shot:play', { matchId, input })
    })

  const vIn = { aimAngle: 0.5, power: 0.5, spin: { x: 0, y: 0 }, timestamp: Date.now() }
  const dup1 = await shotFeedback(floodShooter, thId, { ...vIn })
  const dup2 = await shotFeedback(floodShooter, thId, { ...vIn })
  check('first valid attempt accepted', dup1 === 'accepted', dup1)
  check('identical re-input rejected as replay', dup2 === 'duplicate_shot', dup2)

  const badTs = await shotFeedback(floodShooter, thId, { ...vIn, timestamp: Date.now() + 1_000_000 })
  check('pre-dated / future client timestamp rejected', badTs === 'bad_timestamp', badTs)
  const badPower = await shotFeedback(floodShooter, thId, { ...vIn, power: 2 })
  check('over-power shot rejected', badPower === 'bad_power', badPower)
  const badSpin = await shotFeedback(floodShooter, thId, { ...vIn, spin: 'english' })
  check('malformed spin rejected', badSpin === 'bad_spin', badSpin)
  const badCue = await shotFeedback(floodShooter, thId, { ...vIn, cuePos: { x: 'off-table', y: 0 } })
  check('malformed cue position rejected', badCue === 'bad_cue_pos', badCue)

  let floodRateLimited = 0
  const floodDone = new Promise<void>((resolve) => {
    const onErr = (d: { code?: string }) => {
      if (d?.code === 'rate_limited') floodRateLimited++
    }
    sth1.on('error', onErr)
    setTimeout(() => {
      sth1.off('error', onErr)
      resolve()
    }, 4000)
  })
  for (let i = 0; i < 120; i++) {
    sth1.emit('shot:play', { matchId: thId, input: { aimAngle: 0.5, power: 0.5, spin: { x: 0, y: 0 }, timestamp: Date.now() } })
  }
  await floodDone
  check('shot flood produced rate_limited responses', floodRateLimited >= 80, floodRateLimited)

  await new Promise((r) => setTimeout(r, 2000))
  const backA = await shotFeedback(sth1, thId, { ...vIn, timestamp: Date.now() })
  const backB = await shotFeedback(sth2, thId, { ...vIn, timestamp: Date.now() })
  check('valid shot accepted after throttle backoff', backA === 'accepted' || backB === 'accepted', { backA, backB })
  sth1.disconnect()
  sth2.disconnect()

  console.log('== 18. audit: fraud flags, ledger invariance, replay data ==')

  res = await api('/api/admin/settings', { method: 'PATCH', token: adminToken, body: { key: 'turnTimeoutSec', value: 600 } })
  check('single-turn timeout ok', res.status === 200 && res.json?.ok, res.json)

  const auAb = await register(suffix, '1')
  res = await api('/api/practice/start', { method: 'POST', token: auAb.token, body: { aiLevel: 'EASY' } })
  const auditMatchId = res.json?.data?.id as string | undefined
  check('abuse practice match created', res.status === 200 && res.json?.ok && !!auditMatchId, res.json)

  const fp = typeof auditMatchId === 'string' ? connectSocket(auAb.token) : null
  if (fp && auditMatchId) {
    const fpJoined = waitFor<any>(fp, 'match:joined')
    const fpStart = waitFor<any>(fp, 'match:start')
    fp.emit('match:join', { matchId: auditMatchId })
    await fpJoined
    await fpStart
  }

  const auditFeedback = (s: Socket, matchId: string, input: unknown, windowMs = 5000): Promise<string> =>
    new Promise((resolve) => {
      let done = false
      const finish = (v: string) => {
        if (done) return
        done = true
        s.off('error', onErr)
        s.off('game:update', onUpd)
        resolve(v)
      }
      const onErr = (d: { code?: string }) => finish(d?.code ?? 'unknown')
      const onUpd = (update: any) => {
        // The shot was really taken, so the client that played it acknowledges the
        // playback and releases the room's hold, echoing the token it was sent.
        ackShot(s, matchId, update?.playback?.token)
        finish('accepted')
      }
      s.on('error', onErr)
      s.on('game:update', onUpd)
      setTimeout(() => finish('timeout'), windowMs)
      s.emit('shot:play', { matchId, input })
    })

  if (fp && auditMatchId) {
    const aV = { aimAngle: 0.5, power: 0.5, spin: { x: 0, y: 0 }, timestamp: Date.now() }
    const aDup1 = await auditFeedback(fp, auditMatchId, { ...aV })
    check('audit first shot accepted', aDup1 === 'accepted', aDup1)
    const aDup2 = await auditFeedback(fp, auditMatchId, { ...aV })
    const aDup3 = await auditFeedback(fp, auditMatchId, { ...aV })
    const aDup4 = await auditFeedback(fp, auditMatchId, { ...aV })
    check('replay rejections cross threshold', [aDup2, aDup3, aDup4].every((v) => v === 'duplicate_shot'), [aDup2, aDup3, aDup4])

    const aTs1 = await auditFeedback(fp, auditMatchId, { ...aV, aimAngle: 0.51, timestamp: Date.now() + 1_000_000 })
    const aTs2 = await auditFeedback(fp, auditMatchId, { ...aV, aimAngle: 0.52, timestamp: Date.now() + 1_000_000 })
    const aTs3 = await auditFeedback(fp, auditMatchId, { ...aV, aimAngle: 0.53, timestamp: Date.now() + 1_000_000 })
    check('future-timestamp rejections cross threshold', [aTs1, aTs2, aTs3].every((v) => v === 'bad_timestamp'), [aTs1, aTs2, aTs3])

    let auditRateLimited = 0
    const auditFloodDone = new Promise<void>((resolve) => {
      const onErr = (d: { code?: string }) => {
        if (d?.code === 'rate_limited') auditRateLimited++
      }
      fp.on('error', onErr)
      setTimeout(() => {
        fp.off('error', onErr)
        resolve()
      }, 4000)
    })
    for (let i = 0; i < 100; i++) {
      fp.emit('shot:play', {
        matchId: auditMatchId,
        input: { aimAngle: 0.6 + (i % 3) * 0.01, power: 0.5, spin: { x: 0, y: 0 }, timestamp: Date.now() }
      })
    }
    await auditFloodDone
    check('audit flood crossed rate-limit threshold', auditRateLimited >= 8, auditRateLimited)

    await new Promise((r) => setTimeout(r, 1500))
    const flagsRes = await api('/api/admin/fraud', { token: adminToken })
    const ownedFlags = (Array.isArray(flagsRes.json?.data) ? flagsRes.json.data : []) as Array<{ id: string; username: string | null; kind: string; confidence: number; reason: string | null }>
    const mine = ownedFlags.filter((f) => f.username === auAb.username)
    check('fraud list exposes owner username', mine.length > 0, mine.length)
    check('SHOT_REPLAY flag recorded', mine.some((f) => f.kind === 'SHOT_REPLAY'), mine.map((f) => f.kind))
    check('SHOT_FLOOD flag recorded', mine.some((f) => f.kind === 'SHOT_FLOOD'), mine.map((f) => f.kind))
    check('CLOCK_SKEW flag recorded', mine.some((f) => f.kind === 'CLOCK_SKEW'), mine.map((f) => f.kind))
    check('flags carry confidence', mine.every((f) => f.confidence >= 30), mine.slice(0, 2))

    const abuseGuard = await api('/api/admin/fraud', { token: auAb.token })
    check('non-admin cannot read fraud flags', abuseGuard.status === 401 || abuseGuard.status === 403, abuseGuard.status)

    const eventsRes = await api(`/api/admin/matches/${auditMatchId}/events`, { token: adminToken })
    const auditEvents = (Array.isArray(eventsRes.json?.data) ? eventsRes.json.data : []) as Array<{ seq: number; type: string; data: unknown }>
    const shotRows = auditEvents.filter((e) => e.type === 'SHOT')
    const monotonic = auditEvents.every((e, i, arr) => i === 0 || e.seq > arr[i - 1].seq)
    check('admin match events replayed from db', auditEvents.length > 0 && shotRows.length >= 1, { total: auditEvents.length, shots: shotRows.length })
    check('match event seq strictly increasing', monotonic, auditEvents.slice(0, 2))

    const invariRes = await api('/api/admin/ledger/invariance', { token: adminToken })
    const invari = (invariRes.json?.data ?? { ok: false, checked: 0, violations: [] }) as { ok: boolean; checked: number; violations: Array<{ userId: string }> }
    check('ledger invariant holds after audit', invari.ok === true && invari.checked > 0 && invari.violations.length === 0, { ok: invari.ok, checked: invari.checked, violations: invari.violations.length })

    res = await api('/api/practice/resign', { method: 'POST', token: auAb.token, body: { matchId: auditMatchId } })
    check('audit practice resigned', res.status === 200 && res.json?.ok, res.json)
    fp.disconnect()
  }

  await resetSettings()
  // The run ends by putting the settings back, so it is checked that it actually did.
  // A key the run edits but forgets to restore is invisible in a passing run and shows
  // up later as somebody else's bug: this is the assertion that turns that into a
  // failure here, where it belongs.
  res = await api('/api/admin/settings', { token: adminToken })
  const endSettings = res.json?.data as Record<string, any> | undefined
  check(
    'turn timings are back to the product defaults after the run',
    endSettings?.turnTimeoutSec === DEFAULT_TURN_TIMEOUT_SEC && endSettings?.reconnectGraceSec === 120,
    { turnTimeoutSec: endSettings?.turnTimeoutSec, reconnectGraceSec: endSettings?.reconnectGraceSec }
  )
}

main()
  .catch((error) => {
    console.error('E2E crashed', error)
    failures++
  })
  .finally(async () => {
    console.log('')
    console.log(`RESULT: ${passed} passed, ${failures} failed`)
    try {
      await prisma.$disconnect()
    } catch {
      // Best effort: the run is over and the process is about to exit either way.
    }
    // The exit is forced deliberately. A crashed run used to hang instead of
    // returning, because the open socket connections and the timers behind waits that
    // were abandoned mid-race keep the event loop alive indefinitely, and
    // `process.exitCode` alone never interrupts that. Ending the process here means a
    // failure is always reported promptly, and a clean run never lingers either.
    process.exit(failures > 0 ? 1 : 0)
  })
