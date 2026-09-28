import './styles.css'
import { api, connectSocket, getSocket, makeToast } from './game/network.js'
import { drawTable, resetTableAnimation } from './game/renderer.js'
import { Scene3D } from './game/scene3d.js'
import type { FrameSnapshotData } from './game/renderer.js'
import { createCueController } from './game/input.js'
import type { CueController } from './game/input.js'
import type { ShotInput, ShotPlayback } from '@snooker/shared'
import { STAKE_TIERS } from '@snooker/shared'
import type { Socket } from 'socket.io-client'
import { playCushion, playFoul, playFrameEnd, playMatchEnd, playPot, setSoundMuted, isSoundMuted, unlockAudio } from './game/audio.js'
import { ShotPlayer } from './game/playback.js'
import type { PlaybackBall } from './game/playback.js'

const app = document.querySelector<HTMLDivElement>('#app')!
const toast = makeToast(document.body)

let token = localStorage.getItem('token') ?? ''
let currentUser: { id: string; username: string; role: string; status: string } | null = null
let wallet = { balance: 0, locked: 0 }
let tiers: TierData[] = []
let activeTierId: string | null = null
let adminOpen = false

interface NotificationItem {
  id: string
  kind: string
  title: string
  body: string | null
  read: boolean
  createdAt: string
}

let notifications: NotificationItem[] = []
let panelOpen = false
let bellEl: HTMLElement | null = null
let badgeEl: HTMLElement | null = null
let panelEl: HTMLElement | null = null

let activeMatchId: string | null = null
let mySeat: number | undefined
let frame: FrameSnapshotData | null = null
let cueController: CueController | null = null
let scene3d: Scene3D | null = null
let myTurn = false
/** Non-null while a streamed shot is replaying; drives what the table shows. */
let shotPlayer: ShotPlayer | null = null
/**
 * A shot update that arrived while another shot was still animating. It waits here
 * until the current replay finishes rather than replacing it, so every shot is
 * played out in full and no two shots' worth of movement are ever applied in one
 * jump.
 */
let queuedUpdate: GameUpdatePayload | null = null
/**
 * True from the moment a shot's animation starts until the server has been told it
 * has finished. The server holds its next shot back for exactly this window, so
 * this is what keeps the table and the animation in step.
 */
let shotInFlight = false
/** Pots whose sound was deferred until the replay reached the drop. */
let deferredPots: number[] = []
/**
 * The shot's verdict (foul or frame win) held back until the replay reaches the end of
 * the shot. A verdict describes what the cue ball did, so announcing it while the balls
 * are still rolling reports a foul before the striker has even reached the contact.
 */
let deferredVerdict: Array<() => void> = []
/** The token of the replay currently on screen, returned with the `shot:done`. */
let playedToken: number | undefined
let players: Array<{ id: string; userId: string; seat: number; user: { id: string; username: string } }> = []
let matchFormat = 'BO3'
let framesWon: [number, number] = [0, 0]
let frameIndex = 1
let connected = true
let activeMatchIsPractice = false
let activeTournamentId: string | null = null
let tournamentTimer: number | undefined
let maintenanceMode = false
let maintenanceEl: HTMLElement | null = null
let opponentGone = false
let gameResizeObserver: ResizeObserver | null = null
let rgCanvas: HTMLCanvasElement | null = null
let netOverlayEl: HTMLElement | null = null
let dprCap = 2
let frameEma = 0
let lastFrameTime = 0
let slowFrames = 0
let lastDprUpAt = 0

const BALL_NAMES: Record<number, string> = {
  16: 'yellow',
  17: 'green',
  18: 'brown',
  19: 'blue',
  20: 'pink',
  21: 'black'
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function header(): HTMLElement {
  const head = el('header')
  head.appendChild(el('h1', undefined, 'Snooker Arena'))
  const right = el('div', 'row')
  if (currentUser) {
    right.appendChild(el('span', 'user-chip', `${currentUser.username} · ${wallet.balance} CR (${wallet.locked} locked)`))
    const conn = el('span', connected ? 'chip-ok' : 'chip-bad', connected ? 'online' : 'reconnecting…')
    conn.id = 'conn-chip'
    conn.setAttribute('role', 'status')
    right.appendChild(conn)
    right.appendChild(renderBell())
    if (currentUser.role === 'ADMIN' || currentUser.role === 'SUPERADMIN') {
      const adminBtn = el('button', 'ghost', 'Admin')
      adminBtn.onclick = () => {
        adminOpen = !adminOpen
        activeMatchId = null
        activeTournamentId = null
        clearTournamentTimer()
        leaveGameState()
        render()
      }
      right.appendChild(adminBtn)
    }
    const logout = el('button', 'ghost', 'Logout')
    logout.onclick = () => {
      token = ''
      localStorage.removeItem('token')
      currentUser = null
      activeMatchId = null
      activeTournamentId = null
      adminOpen = false
      clearTournamentTimer()
      leaveGameState()
      render()
    }
    right.appendChild(logout)
  }
  head.appendChild(right)
  return head
}

function bellSvg(): string {
  return '<svg class="bell-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 1.5A3 3 0 0 0 5 4.5v1.1c0 .6-.2 1.2-.6 1.6l-.8.9a1.3 1.3 0 0 0 .9 2.2h7a1.3 1.3 0 0 0 .9-2.2l-.8-.9c-.4-.4-.6-1-.6-1.6V4.5A3 3 0 0 0 8 1.5Z"/><path d="M6.5 12a1.5 1.5 0 0 0 3 0h-3Z"/></svg>'
}

function renderBell(): HTMLElement {
  const wrap = el('div', 'bell-wrap')
  const bell = el('button', 'bell')
  bell.innerHTML = bellSvg()
  const badge = el('span', 'bell-badge', '')
  badge.id = 'bell-badge'
  badgeEl = badge
  bell.appendChild(badge)
  bell.onclick = (e) => {
    e.stopPropagation()
    panelOpen = !panelOpen
    if (panelOpen) refreshNotificationPanel()
    panelEl?.classList.toggle('open', panelOpen)
  }
  const panel = el('div', 'notif-panel')
  panel.id = 'notif-panel'
  panel.onclick = (e) => e.stopPropagation()
  panelEl = panel
  bellEl = wrap
  wrap.append(bell, panel)
  refreshBell()
  return wrap
}

function refreshBell(): void {
  if (!bellEl || !badgeEl) return
  const unread = notifications.filter((n) => !n.read).length
  badgeEl.textContent = unread > 0 ? String(unread) : ''
  badgeEl.hidden = unread === 0
  if (panelOpen) refreshNotificationPanel()
}

function refreshNotificationPanel(): void {
  if (!panelEl) return
  panelEl.innerHTML = ''
  const head = el('div', 'notif-head')
  head.appendChild(el('span', 'notif-title', 'Notifications'))
  const unread = notifications.filter((n) => !n.read).length
  head.appendChild(el('span', 'muted', unread > 0 ? `${unread} unread` : 'all caught up'))
  panelEl.appendChild(head)
  if (unread > 0) {
    const markAll = el('button', 'ghost', 'Mark all read')
    markAll.onclick = () => void markAllRead()
    panelEl.appendChild(markAll)
  }
  if (notifications.length === 0) {
    panelEl.appendChild(el('div', 'muted notif-empty', 'No notifications yet.'))
    return
  }
  const list = el('div', 'notif-list')
  for (const n of notifications.slice(0, 30)) {
    const item = el('button', n.read ? 'notif-item' : 'notif-item unread')
    item.onclick = () => void markOneRead(n.id)
    const title = el('div', 'notif-item-title', n.title)
    if (n.kind) title.classList.add(`kind-${n.kind.toLowerCase()}`)
    item.appendChild(title)
    if (n.body && n.body !== n.title) item.appendChild(el('div', 'muted notif-body', n.body))
    item.appendChild(el('div', 'muted notif-time', timeAgo(n.createdAt)))
    list.appendChild(item)
  }
  panelEl.appendChild(list)
}

async function fetchNotifications(): Promise<void> {
  try {
    const data = await api<{ items: NotificationItem[]; unread: number }>('/notifications')
    notifications = data.items
    refreshBell()
  } catch {
    notifications = []
  }
}

async function markOneRead(id: string): Promise<void> {
  try {
    await api<{ updated: number }>('/notifications/read', { method: 'POST', body: { ids: [id] } })
    const target = notifications.find((n) => n.id === id)
    if (target) target.read = true
    refreshBell()
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

async function markAllRead(): Promise<void> {
  const unread = notifications.filter((n) => !n.read)
  if (unread.length === 0) return
  try {
    await api<{ updated: number }>('/notifications/read', { method: 'POST', body: { ids: unread.map((n) => n.id) } })
    for (const n of notifications) n.read = true
    refreshBell()
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

document.addEventListener('click', () => {
  if (panelOpen) {
    panelOpen = false
    panelEl?.classList.remove('open')
  }
})

function card(title?: string): HTMLElement {
  const c = el('div', 'card')
  if (title) c.appendChild(el('h3', undefined, title))
  return c
}

interface TierData {
  id: string
  usd: number
  credits: number
  label: string
}

interface LobbyMatch {
  id: string
  stakeTier: string | null
  stakePerPlayer: string
  format: string
  createdAt: string
  players: Array<{
    userId: string
    user: { id: string; username: string }
  }>
}

interface MyProfile {
  user: {
    id: string
    username: string
    createdAt: string
    profile: { countryCode: string | null; avatarUrl: string | null; bio: string | null } | null
    wallet: { available: number }
  }
  stats: { matches: number; wins: number; losses: number; winRate: number; highestBreak: number }
}

interface LeaderboardRow {
  rank: number
  userId: string
  username: string
  matches: number
  wins: number
  losses: number
  winRate: number
  highestBreak: number
}

interface LeaderboardData {
  rows: LeaderboardRow[]
  me: LeaderboardRow | null
}

interface HistoryMatch {
  id: string
  format: string
  finishedAt: string | null
  winnerId: string | null
  stakePerPlayer: string
  players: Array<{ userId: string; user: { id: string; username: string } }>
}

interface OpenTournament {
  id: string
  name: string
  status: string
  size: number
  entryFee?: number | string
  createdAt: string
  _count: { players: number }
}

interface TournamentPlayer {
  id: string
  userId: string
  seed: number
  status: string | null
  user: { id: string; username: string }
}

interface TournamentMatch {
  id: string
  round: number | null
  status: string
  players: Array<{ id: string; userId: string; seat: number; user: { id: string; username: string } }>
}

interface BracketSlotData {
  seeds: number[]
  matchId?: string | null
  winnerSeed?: number | null
}

interface TournamentData {
  id: string
  name: string
  status: string
  entryFee: number | string
  size: number
  format: string
  championId: string | null
  runnerUpId: string | null
  finishedAt: string | null
  resultsJson: { rounds: Array<{ slots: BracketSlotData[] }> } | null
  players: TournamentPlayer[]
  matches: TournamentMatch[]
}

interface HistoryTournament {
  id: string
  name: string
  finishedAt: string | null
  _count: { players: number }
  players?: Array<{ user: { username: string } }>
}

async function refreshWallet(): Promise<void> {
  try {
    wallet = await api<{ balance: number; locked: number }>('/wallet')
  } catch {
    wallet = { balance: 0, locked: 0 }
  }
}

async function loadTiers(): Promise<void> {
  try {
    tiers = await api<TierData[]>('/matches/tiers')
  } catch {
    tiers = STAKE_TIERS.map((t) => ({ id: t.id, usd: t.usd, credits: t.credits, label: t.label }))
  }
  if (!tiers.length) return
  if (!activeTierId || !tiers.some((t) => t.id === activeTierId)) {
    activeTierId = tiers[0]!.id
  }
}

function leaveGameState(): void {
  activeMatchId = null
  frame = null
  mySeat = undefined
  // Any replay still queued belonged to the match being left, and the drawn ball
  // positions belonged to its table, so both are dropped here.
  abandonPlayback()
  resetTableAnimation()
  framesWon = [0, 0]
  frameIndex = 1
  players = []
  activeMatchIsPractice = false
  opponentGone = false
  scene3d?.dispose()
  scene3d = null
  cueController?.destroy()
  cueController = null
}

function opponentName(): string {
  if (activeMatchIsPractice) return 'Robot'
  const opp = players.find((p) => p.seat === 1 - (mySeat ?? 0))
  return opp?.user.username ?? 'Opponent'
}

function ballOnName(ballOn: string): string {
  if (ballOn === 'RED') return 'Ball on: RED'
  if (ballOn === 'ANY_COLOUR') return 'Ball on: any colour'
  const m = /colour:(\d+)/.exec(ballOn)
  return m ? `Ball on: ${BALL_NAMES[Number(m[1])] ?? 'colour'}` : 'Ball on: colour'
}

function ballName(id: number): string {
  if (id >= 1 && id <= 15) return 'red'
  return BALL_NAMES[id] ?? `ball ${id}`
}

function seatName(seat: number | undefined): string {
  if (seat === undefined) return 'A player'
  return seat === mySeat ? 'You' : opponentName()
}

function updateConnChip(): void {
  const chip = document.getElementById('conn-chip')
  if (!chip) return
  chip.textContent = connected ? 'online' : 'reconnecting…'
  chip.className = connected ? 'chip-ok' : 'chip-bad'
}

function updateHud(): void {
  const youEl = document.getElementById('hud-you')
  const oppEl = document.getElementById('hud-opp')
  const turnEl = document.getElementById('hud-turn')
  const metaEl = document.getElementById('hud-meta')
  const ballEl = document.getElementById('hud-ball')
  if (youEl) youEl.textContent = currentUser?.username ?? 'You'
  if (oppEl) oppEl.textContent = opponentName()
  if (turnEl) {
    turnEl.textContent = myTurn ? 'YOUR TURN' : 'WAITING'
    turnEl.className = myTurn ? 'turn-name active' : 'turn-name'
  }
  if (metaEl) {
    metaEl.textContent = activeMatchIsPractice
      ? `Frame ${frameIndex} · Practice`
      : `Frame ${frameIndex} · ${matchFormat} · frames ${framesWon[0]}-${framesWon[1]}`
  }
  if (ballEl && frame) {
    ballEl.textContent = `${ballOnName(frame.ballOn)} · ${frame.remainingReds} reds`
  }
}

function updateOpponentGone(): void {
  const holder = document.getElementById('opp-holder')
  holder?.replaceChildren()
  if (opponentGone && !activeMatchIsPractice) {
    holder?.appendChild(el('div', 'opp-gone', 'Opponent disconnected — waiting for them to return'))
  }
}

async function loadMatchMeta(matchId: string): Promise<void> {
  try {
    const data = await api<{
      format?: string
      players?: Array<{ id: string; userId: string; seat: number; user: { id: string; username: string } }>
    }>(`/matches/${matchId}`)
    matchFormat = data.format ?? matchFormat
    players = data.players ?? []
    updateHud()
  } catch {
    void 0
  }
}

function showOverlay(box: HTMLElement): void {
  removeOverlay()
  const overlay = el('div', 'overlay')
  overlay.appendChild(box)
  document.body.appendChild(overlay)
}

function removeOverlay(): void {
  document.body.querySelector('.overlay')?.remove()
}

function confirmAction(title: string, message: string, okLabel: string, onOk: () => void): void {
  const box = card(title)
  box.appendChild(el('div', undefined, message))
  const row = el('div', 'row')
  const okBtn = el('button', 'danger', okLabel)
  okBtn.onclick = () => {
    removeOverlay()
    onOk()
  }
  const cancelBtn = el('button', 'ghost', 'Cancel')
  cancelBtn.onclick = () => removeOverlay()
  row.append(cancelBtn, okBtn)
  box.appendChild(row)
  showOverlay(box)
}

function askConcede(): void {
  if (!activeMatchId) return
  confirmAction('Concede match?', 'Your stake is forfeited to the opponent. Are you sure?', 'Concede', () => {
    getSocket().emit('concede', { matchId: activeMatchId })
  })
}

async function finishPractice(): Promise<void> {
  if (!activeMatchId) return
  try {
    await api('/practice/resign', { method: 'POST', body: { matchId: activeMatchId } })
    toast('Practice ended')
    leaveGameState()
    render()
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

function leaveToLobby(): void {
  leaveGameState()
  clearTournamentTimer()
  removeOverlay()
  render()
}

function clearTournamentTimer(): void {
  if (tournamentTimer !== undefined) {
    clearTimeout(tournamentTimer)
    tournamentTimer = undefined
  }
}

function scheduleTournamentRefresh(): void {
  clearTournamentTimer()
  tournamentTimer = window.setTimeout(() => {
    tournamentTimer = undefined
    if (activeTournamentId && !activeMatchId) void renderTournament()
  }, 2500)
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    DRAFT: 'recruiting',
    OPEN: 'recruiting',
    FULL: 'starting',
    IN_PROGRESS: 'in progress',
    COMPLETED: 'finished'
  }
  return map[status] ?? status.toLowerCase()
}

async function renderTournament(): Promise<void> {
  clearTournamentTimer()
  app.innerHTML = ''
  app.appendChild(header())
  const wrap = el('div')
  app.appendChild(wrap)
  if (!activeTournamentId) {
    void renderLobby()
    return
  }
  let data: TournamentData
  try {
    data = await api<TournamentData>(`/tournaments/${activeTournamentId}`)
  } catch (error) {
    wrap.appendChild(el('div', 'muted', (error as Error).message))
    const back = el('button', undefined, 'Back to lobby')
    back.onclick = () => {
      activeTournamentId = null
      render()
    }
    wrap.appendChild(back)
    return
  }
  if (activeTournamentId !== data.id) return

  const box = el('div', 'card')
  const top = el('div', 'row t-top')
  const title = el('div')
  title.appendChild(el('h3', undefined, data.name))
  title.appendChild(el('div', 'meta-line', `${data.players.length}/${data.size} players · ${statusLabel(data.status)} · BO${data.format.replace('BO', '')}`))
  top.appendChild(title)
  const actions = el('div', 'row')
  const refreshBtn = el('button', 'ghost', 'Refresh')
  refreshBtn.onclick = () => void renderTournament()
  actions.appendChild(refreshBtn)
  const backBtn = el('button', 'ghost', 'Back to lobby')
  backBtn.onclick = () => {
    activeTournamentId = null
    render()
  }
  actions.appendChild(backBtn)
  top.appendChild(actions)
  box.appendChild(top)

  if (data.status === 'OPEN' || data.status === 'DRAFT' || data.status === 'FULL') {
    if (data.players.length >= data.size) {
      box.appendChild(el('div', 'muted', 'Everyone has joined — matches are starting.'))
    } else {
      box.appendChild(el('div', 'muted', `Waiting for ${data.size - data.players.length} more player${data.size - data.players.length === 1 ? '' : 's'} — bracket fills from the top seed down.`))
    }
  }

  if (data.status === 'COMPLETED' && data.championId) {
    const champion = data.players.find((p) => p.userId === data.championId)
    const runnerUp = data.players.find((p) => p.userId === data.runnerUpId)
    const banner = el('div', 'champion-banner')
    banner.appendChild(el('div', 'crown', 'CHAMPION'))
    banner.appendChild(el('div', 'champ-name', champion?.user.username ?? '?'))
    banner.appendChild(el('div', 'meta-line', runnerUp ? `runner-up: ${runnerUp.user.username}` : 'runner-up: —'))
    const mine = data.players.find((p) => p.userId === currentUser?.id)
    banner.appendChild(el('div', 'meta-line', mine?.status === 'CHAMPION' ? 'This is you — take a bow.' : 'Free tournament · all 8 players started on even credits'))
    box.appendChild(banner)
  }

  const labels = ['Quarter-finals', 'Semi-finals', 'Final']
  const rounds = data.resultsJson?.rounds ?? []
  if (rounds.length) {
    const bracket = el('div', 'bracket')
    for (let r = 0; r < rounds.length; r++) {
      const col = el('div', `bracket-round r${r}`)
      col.appendChild(el('div', 'round-label', labels[r] ?? `Round ${r + 1}`))
      for (const slot of rounds[r]!.slots) {
        col.appendChild(bracketNode(slot, data))
      }
      bracket.appendChild(col)
    }
    box.appendChild(bracket)
  }

  const listBox = el('div', 'players-list')
  listBox.appendChild(el('div', 'subhead', 'Players'))
  for (const p of data.players) {
    const rowEl = el('div', 'table-row')
    rowEl.appendChild(el('span', 'badge', `#${p.seed}`))
    const nm = el('div', p.status === 'CHAMPION' ? 'champ-name-sm' : undefined, `${p.user.username}${p.userId === currentUser?.id ? ' (you)' : ''}`)
    rowEl.appendChild(nm)
    rowEl.appendChild(el('span', 'badge', p.status ?? 'ALIVE'))
    listBox.appendChild(rowEl)
  }
  box.appendChild(listBox)

  wrap.appendChild(box)

  if (data.status !== 'COMPLETED') scheduleTournamentRefresh()
}

function bracketNode(slot: BracketSlotData, data: TournamentData): HTMLElement {
  const node = el('div', 'bracket-node')
  const match = slot.matchId ? data.matches.find((m) => m.id === slot.matchId) : undefined
  const winnerSeed = slot.winnerSeed ?? undefined
  const includesMe = match?.players.some((p) => p.userId === currentUser?.id) === true
  const nameFor = (index: number): string => {
    const seed = slot.seeds.length > index ? slot.seeds[index] : undefined
    if (seed !== undefined) {
      const p = data.players.find((pl) => pl.seed === seed)
      return p?.user.username ?? 'TBD'
    }
    const seat = match?.players.find((pl) => pl.seat === index)
    return seat?.user.username ?? 'TBD'
  }
  for (let i = 0; i < 2; i++) {
    const line = el('div', 'b-node-row')
    const seed = slot.seeds.length > i ? slot.seeds[i] : undefined
    const nameEl = el('span', undefined, nameFor(i))
    if (seed !== undefined && seed === winnerSeed) nameEl.classList.add('winner')
    if (seed !== undefined && winnerSeed !== undefined && seed !== winnerSeed) nameEl.classList.add('loser')
    line.appendChild(nameEl)
    const seat = match?.players.find((pl) => pl.seat === i)
    if (seat && seat.userId === currentUser?.id) line.appendChild(el('span', 'you-dot', 'you'))
    node.appendChild(line)
  }
  if (match) {
    const playable = match.status === 'WAITING_FOR_PLAYER' || match.status === 'MATCH_STARTED' || match.status === 'MATCH_IN_PROGRESS'
    if (playable && includesMe && !activeMatchId) {
      const play = el('button', 'ghost mini', match.status === 'WAITING_FOR_PLAYER' ? 'Play' : 'Resume')
      play.onclick = () => enterMatch(match.id, false)
      node.appendChild(play)
    }
  }
  node.title = match ? `${match.status} · round ${match.round ?? '?'}` : ''
  return node
}

async function fetchMatchOutcome(matchId: string): Promise<{
  status: string
  resultJson: { prize?: number } | null
  players: Array<{ id: string; userId: string; seat: number; user: { id: string; username: string } }>
} | null> {
  for (let i = 0; i < 12; i++) {
    try {
      const data = await api<{ status: string; resultJson: { prize?: number } | null; players?: Array<{ id: string; userId: string; seat: number; user: { id: string; username: string } }> }>(`/matches/${matchId}`)
      if (data && data.status) return { status: data.status, resultJson: data.resultJson, players: data.players ?? [] }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

async function finishMatch(winnerSeat: number, reason?: string): Promise<void> {
  const meta = activeMatchId ? await fetchMatchOutcome(activeMatchId) : null
  const winnerName = activeMatchIsPractice
    ? winnerSeat === mySeat
      ? (currentUser?.username ?? 'You')
      : 'Robot'
    : (meta?.players.find((p) => p.seat === winnerSeat)?.user.username ?? `Seat ${winnerSeat}`)
  const box = card('Match finished')
  box.appendChild(el('div', 'end-winner', `${winnerName} wins`))
  if (activeMatchIsPractice) {
    box.appendChild(el('div', 'muted', 'Practice session — no credits involved'))
  } else {
    box.appendChild(el('div', 'muted', `Frames: ${framesWon[0]}-${framesWon[1]}`))
    const prize = meta?.resultJson?.prize
    if (typeof prize === 'number' && prize > 0) {
      box.appendChild(el('div', 'end-prize', `Winner receives ${prize} CR`))
    } else {
      box.appendChild(el('div', 'muted', 'Settlement pending…'))
    }
  }
  if (reason === 'concede') box.appendChild(el('div', 'muted', 'by concession'))
  const backBtn = el('button', undefined, activeTournamentId ? 'Back to tournament' : 'Back to lobby')
  backBtn.onclick = () => leaveToLobby()
  box.appendChild(backBtn)
  showOverlay(box)
}

function render(): void {
  app.innerHTML = ''
  app.appendChild(header())
  if (!currentUser) {
    renderAuth()
  } else if (activeMatchId) {
    renderGame()
  } else if (activeTournamentId) {
    void renderTournament()
  } else if (adminOpen) {
    void mountAdminPanel()
  } else {
    void renderLobby()
  }
}

async function mountAdminPanel(): Promise<void> {
  const { renderAdminPanel } = await import('./admin.js')
  if (!adminOpen || currentUser === null) return
  renderAdminPanel(app, toast)
}

function renderAuth(): void {
  const c = card('Welcome to Snooker Arena')
  const emailInput = el('input') as HTMLInputElement
  emailInput.type = 'email'
  emailInput.placeholder = 'email'
  const userInput = el('input') as HTMLInputElement
  userInput.placeholder = 'username'
  const passInput = el('input') as HTMLInputElement
  passInput.type = 'password'
  passInput.placeholder = 'password (min 6)'
  const registerBtn = el('button', undefined, 'Create Account')
  registerBtn.onclick = () => void register(emailInput.value, userInput.value, passInput.value)
  const loginBtn = el('button', 'ghost', 'Login')
  loginBtn.onclick = () => void login(emailInput.value, passInput.value)
  const row = el('div', 'row')
  row.append(loginBtn, registerBtn)
  c.appendChild(userRow(emailInput, userInput, passInput))
  c.appendChild(row)
  app.appendChild(c)
}

function userRow(email: HTMLInputElement, username: HTMLInputElement, password: HTMLInputElement): HTMLElement {
  const grid = el('div', 'grid')
  const emailLabel = el('label', undefined, 'Email')
  emailLabel.appendChild(email)
  const userLabel = el('label', undefined, 'Username')
  userLabel.appendChild(username)
  const passLabel = el('label', undefined, 'Password')
  passLabel.appendChild(password)
  grid.append(emailLabel, userLabel, passLabel)
  return grid
}

async function register(email: string, username: string, password: string): Promise<void> {
  try {
    const data = await api<{ token: string; user: { id: string; username: string; role: string; status: string } }>('/auth/register', {
      method: 'POST',
      body: { email, username, password }
    })
    token = data.token
    localStorage.setItem('token', token)
    currentUser = data.user
    handleSocketEvents(connectSocket(token))
    toast('Account created. Welcome!')
    void fetchNotifications()
    render()
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

async function login(email: string, password: string): Promise<void> {
  try {
    const data = await api<{ token: string; user: { id: string; username: string; role: string; status: string } }>('/auth/login', {
      method: 'POST',
      body: { email, password }
    })
    token = data.token
    localStorage.setItem('token', token)
    currentUser = data.user
    handleSocketEvents(connectSocket(token))
    toast('Logged in')
    void fetchNotifications()
    render()
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

async function renderLobby(): Promise<void> {
  await Promise.all([refreshWallet(), loadTiers()])
  app.innerHTML = ''
  app.appendChild(header())
  app.appendChild(createMatchCard())
  app.appendChild(await tablesCard())
  app.appendChild(createPracticeCard())
  app.appendChild(createTournamentCard())
  app.appendChild(await matchHistoryCard())
  app.appendChild(await profileStatsCard())
}

function createMatchCard(): HTMLElement {
  const c = card('One-on-One Match')
  c.appendChild(el('div', 'muted', 'Pick a table price and create a match. Your stake locks until a challenger joins.'))
  const tierPicker = el('div', 'tier-picker')
  if (!tiers.length) {
    c.appendChild(el('div', 'muted', 'Tier list unavailable. Try refreshing.'))
    return c
  }
  let createTier = activeTierId ?? tiers[0]!.id
  for (const tier of tiers) {
    const chip = el('button', 'tier-chip', `${tier.label} · ${tier.credits} CR`)
    chip.dataset.tier = tier.id
    if (tier.id === createTier) chip.classList.add('active')
    chip.onclick = () => {
      createTier = tier.id
      for (const btn of tierPicker.querySelectorAll<HTMLButtonElement>('.tier-chip')) {
        btn.classList.toggle('active', btn.dataset.tier === tier.id)
      }
    }
    tierPicker.appendChild(chip)
  }
  const formatSelect = el('select') as HTMLSelectElement
  for (const f of ['BO1', 'BO3', 'BO5']) {
    const option = el('option') as HTMLOptionElement
    option.value = f
    option.textContent = f
    formatSelect.appendChild(option)
  }
  const createBtn = el('button', undefined, 'Create Match')
  createBtn.onclick = () =>
    void api<{ id: string }>('/matches', {
      method: 'POST',
      body: { stakeTier: createTier, format: formatSelect.value }
    })
      .then((data) => enterMatch(data.id, false))
      .catch((error) => toast(error.message, 'error'))
  const row = el('div', 'row')
  const formatLabel = el('label', undefined, 'Format')
  formatLabel.appendChild(formatSelect)
  row.append(formatLabel, createBtn)
  c.appendChild(tierPicker)
  c.appendChild(row)
  return c
}

function createPracticeCard(): HTMLElement {
  const c = card('Practice vs Robot — free')
  c.appendChild(el('div', 'muted', 'No balance? 3 practice matches per day. With balance: unlimited.'))
  const levelSelect = el('select') as HTMLSelectElement
  for (const level of ['EASY', 'MEDIUM', 'HARD']) {
    const option = el('option') as HTMLOptionElement
    option.value = level
    option.textContent = level
    levelSelect.appendChild(option)
  }
  const startBtn = el('button', undefined, 'Start Practice')
  startBtn.onclick = () =>
    void api<{ id: string }>('/practice/start', { method: 'POST', body: { aiLevel: levelSelect.value } })
      .then((data) => enterMatch(data.id, true))
      .catch((error) => toast(error.message, 'error'))
  const row = el('div', 'row')
  const levelLabel = el('label', undefined, 'Robot level')
  levelLabel.appendChild(levelSelect)
  row.append(levelLabel, startBtn)
  c.appendChild(row)
  return c
}

function createTournamentCard(): HTMLElement {
  const c = card('8-Player Tournament — free')
  c.appendChild(el('div', 'muted', 'Single-elimination, best-of-3 frames. 8 players, seeded by join order. Winner takes the crown.'))
  const createBtn = el('button', undefined, 'Create Tournament')
  createBtn.onclick = () =>
    void api<{ id: string }>('/tournaments', { method: 'POST', body: {} })
      .then((data) =>
        api<{ joined: boolean }>('/tournaments/join', { method: 'POST', body: { tournamentId: data.id } }).then(() => data)
      )
      .then((data) => {
        activeTournamentId = data.id
        render()
      })
      .catch((error) => toast(error.message, 'error'))
  c.appendChild(el('div', 'row')).appendChild(createBtn)
  void loadTournamentLists(c)
  return c
}

async function loadTournamentLists(c: HTMLElement): Promise<void> {
  const loading = el('div', 'muted', 'Loading tournaments…')
  c.appendChild(loading)
  let open: OpenTournament[] = []
  let mine: OpenTournament[] = []
  let history: HistoryTournament[] = []
  try {
    ;[open, mine, history] = await Promise.all([
      api<OpenTournament[]>('/tournaments/open'),
      api<OpenTournament[]>('/tournaments/mine'),
      api<HistoryTournament[]>('/tournaments/history')
    ])
  } catch (error) {
    loading.textContent = (error as Error).message
    return
  }
  loading.remove()

  const openHead = el('div', 'subhead', 'Open tournaments')
  c.appendChild(openHead)
  if (!open.length) {
    c.appendChild(el('div', 'muted', 'None. Create one above — first to join takes seed 1.'))
  } else {
    for (const t of open) {
      const inMine = mine.some((m) => m.id === t.id)
      const count = t._count?.players ?? 0
      const rowEl = el('div', 'table-row')
      const info = el('div')
      info.appendChild(el('div', undefined, t.name))
      info.appendChild(el('div', 'meta', `${count}/${t.size ?? 8} players · ${statusLabel(t.status)} · ${timeAgo(t.createdAt)}`))
      rowEl.appendChild(info)
      if (inMine) {
        rowEl.appendChild(el('span', 'badge', 'joined'))
      } else {
        const joinBtn = el('button', undefined, 'Join')
        joinBtn.onclick = () =>
          void api<{ joined: boolean }>('/tournaments/join', { method: 'POST', body: { tournamentId: t.id } })
            .then(() => {
              activeTournamentId = t.id
              render()
            })
            .catch((error) => toast(error.message, 'error'))
        rowEl.appendChild(joinBtn)
      }
      c.appendChild(rowEl)
    }
  }

  const ongoing = mine.filter((m) => m.status === 'IN_PROGRESS' || m.status === 'FULL')
  if (ongoing.length) {
    c.appendChild(el('div', 'subhead', 'Your tournaments'))
    for (const t of ongoing) {
      const rowEl = el('div', 'table-row')
      const info = el('div')
      info.appendChild(el('div', undefined, t.name))
      info.appendChild(el('div', 'meta', `${t._count?.players ?? 8}/${t.size ?? 8} players · ${statusLabel(t.status)}`))
      rowEl.appendChild(info)
      const viewBtn = el('button', 'ghost', 'Bracket')
      viewBtn.onclick = () => {
        activeTournamentId = t.id
        render()
      }
      rowEl.appendChild(viewBtn)
      c.appendChild(rowEl)
    }
  }

  if (history.length) {
    c.appendChild(el('div', 'subhead', 'Past tournaments'))
    for (const t of history.slice(0, 5)) {
      const champion = t.players?.[0]?.user?.username
      const rowEl = el('div', 'table-row')
      const info = el('div')
      info.appendChild(el('div', undefined, `${t.name} — winner: ${champion ?? '?'}`))
      info.appendChild(el('div', 'meta', `${t._count?.players ?? 8} players · ${t.finishedAt ? new Date(t.finishedAt).toLocaleDateString() : ''}`))
      rowEl.appendChild(info)
      const viewBtn = el('button', 'ghost', 'Bracket')
      viewBtn.onclick = () => {
        activeTournamentId = t.id
        render()
      }
      rowEl.appendChild(viewBtn)
      c.appendChild(rowEl)
    }
  }
}

async function tablesCard(): Promise<HTMLElement> {
  const c = card('Tables — pick your price')
  const actions = el('div', 'row')
  const refreshBtn = el('button', 'ghost', 'Refresh tables')
  refreshBtn.onclick = () => void renderLobby()
  actions.appendChild(refreshBtn)
  c.appendChild(actions)
  try {
    const open = await api<LobbyMatch[]>('/matches/lobby')
    if (!tiers.length) {
      c.appendChild(el('div', 'muted', 'Tier list unavailable.'))
      return c
    }
    const counts = new Map<string, number>()
    for (const tier of tiers) {
      counts.set(tier.id, open.filter((m) => m.stakeTier === tier.id).length)
    }
    if (!activeTierId || !tiers.some((t) => t.id === activeTierId)) activeTierId = tiers[0]!.id

    const tabRow = el('div', 'row tabs')
    for (const tier of tiers) {
      const count = counts.get(tier.id) ?? 0
      const tab = el('button', 'tab', `${tier.label}${count ? ` · ${count}` : ''}`)
      tab.dataset.tier = tier.id
      if (tier.id === activeTierId) tab.classList.add('active')
      tab.onclick = () => {
        activeTierId = tier.id
        for (const btn of tabRow.querySelectorAll<HTMLButtonElement>('.tab')) {
          btn.classList.toggle('active', btn.dataset.tier === tier.id)
        }
        for (const section of c.querySelectorAll<HTMLElement>('.tier-section')) {
          section.classList.toggle('hidden', section.dataset.tier !== tier.id)
        }
      }
      tabRow.appendChild(tab)
    }
    c.appendChild(tabRow)

    for (const tier of tiers) {
      const matches = open.filter((m) => m.stakeTier === tier.id)
      const section = el('div', 'tier-section')
      section.dataset.tier = tier.id
      if (tier.id !== activeTierId) section.classList.add('hidden')
      section.appendChild(el('div', 'muted', `${tier.usd} USD · ${tier.credits} CR stake per player`))
      if (!matches.length) {
        section.appendChild(el('div', 'muted', 'No tables waiting at this price. Create one above.'))
      } else {
        for (const match of matches) {
          const wait = el('div', 'table-row')
          const host = match.players[0]
          const mine = host !== undefined && host.userId === currentUser?.id
          const info = el('div')
          info.appendChild(el('div', undefined, `${mine ? 'You' : host?.user.username ?? '?'} · ${match.format}`))
          info.appendChild(el('div', 'meta', `${match.stakePerPlayer} CR · waiting 1/2 · ${timeAgo(match.createdAt)}`))
          wait.appendChild(info)
          if (mine) {
            wait.appendChild(el('span', 'badge', 'waiting for opponent'))
          } else {
            const joinBtn = el('button', undefined, 'Join')
            joinBtn.onclick = () =>
              void api('/matches/join', { method: 'POST', body: { matchId: match.id } })
                .then(() => enterMatch(match.id, false))
                .catch((error) => toast(error.message, 'error'))
            wait.appendChild(joinBtn)
          }
          section.appendChild(wait)
        }
      }
      c.appendChild(section)
    }
  } catch (error) {
    c.appendChild(el('div', 'muted', (error as Error).message))
  }
  return c
}

function timeAgo(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

async function matchHistoryCard(): Promise<HTMLElement> {
  const c = card('History')
  try {
    const history = await api<HistoryMatch[]>('/matches/history')
    if (!history.length) {
      c.appendChild(el('div', 'muted', 'No matches played yet.'))
      return c
    }
    const table = el('table')
    const thead = el('tr')
    for (const thText of ['Match', 'Format', 'Result', 'Opponent', 'When']) thead.appendChild(el('th', undefined, thText))
    table.appendChild(thead)
    for (const match of history) {
      const tr = el('tr')
      tr.appendChild(el('td', undefined, match.id.slice(0, 8)))
      tr.appendChild(el('td', undefined, match.format))
      const mine = match.winnerId !== null && match.winnerId === currentUser?.id
      const badge = el('span', mine ? 'badge' : 'badge foul', mine ? 'W' : 'L')
      tr.appendChild(el('td')).appendChild(badge)
      const opp = match.players.find((p) => p.userId !== currentUser?.id)?.user.username ?? '?'
      tr.appendChild(el('td', undefined, opp))
      tr.appendChild(el('td', undefined, match.finishedAt ? new Date(match.finishedAt).toLocaleString() : 'ongoing'))
      table.appendChild(tr)
    }
    c.appendChild(table)
  } catch {
    c.appendChild(el('div', 'muted', 'No matches played yet.'))
  }
  return c
}

async function profileStatsCard(): Promise<HTMLElement> {
  const c = card('Profile & leaderboard')
  const body = el('div')
  c.appendChild(body)

  try {
    const profile = await api<MyProfile>('/me')
    const s = profile.stats
    const tiles = el('div', 'stat-tiles')
    const items: Array<[string, string]> = [
      ['Matches', `${s.matches}`],
      ['Wins', `${s.wins}`],
      ['Losses', `${s.losses}`],
      ['Win rate', `${s.winRate}%`],
      ['Highest break', `${s.highestBreak}`]
    ]
    for (const [label, value] of items) {
      const tile = el('div', 'stat-tile')
      tile.appendChild(el('div', 'stat-value', value))
      tile.appendChild(el('div', 'stat-label', label))
      tiles.appendChild(tile)
    }
    body.appendChild(tiles)
  } catch {
    body.appendChild(el('div', 'muted', 'Stats unavailable.'))
  }

  const periodRow = el('div', 'row')
  periodRow.appendChild(el('span', 'muted', 'Leaderboard:'))
  const periodSelect = el('select') as HTMLSelectElement
  for (const [value, label] of [
    ['all', 'All time'],
    ['month', 'Last 30 days'],
    ['week', 'Last 7 days']
  ] as const) {
    const option = el('option') as HTMLOptionElement
    option.value = value
    option.textContent = label
    periodSelect.appendChild(option)
  }
  periodRow.appendChild(periodSelect)
  body.appendChild(periodRow)

  const boardBox = el('div')
  body.appendChild(boardBox)

  const renderBoard = (period: string): void => {
    boardBox.innerHTML = ''
    boardBox.appendChild(el('div', 'muted', 'Loading leaderboard…'))
    void api<LeaderboardData>(`/leaderboard?period=${period}`)
      .then((data) => {
        boardBox.innerHTML = ''
        if (!data.rows.length) {
          boardBox.appendChild(el('div', 'muted', 'No ranked matches yet — play a real match to get on the board.'))
          return
        }
        const table = el('table')
        const thead = el('tr')
        for (const thText of ['#', 'Player', 'W-L', 'Win rate', 'High break']) thead.appendChild(el('th', undefined, thText))
        table.appendChild(thead)
        for (const row of data.rows) {
          const tr = el('tr')
          const isMe = row.userId === currentUser?.id
          if (isMe) tr.classList.add('you-row')
          tr.appendChild(el('td', undefined, `${row.rank}`))
          const nameTd = el('td')
          nameTd.appendChild(el('span', undefined, row.username))
          if (isMe) nameTd.appendChild(el('span', 'you-dot', '  you'))
          tr.appendChild(nameTd)
          tr.appendChild(el('td', undefined, `${row.wins}-${row.losses}`))
          tr.appendChild(el('td', undefined, `${row.winRate}%`))
          tr.appendChild(el('td', undefined, `${row.highestBreak}`))
          table.appendChild(tr)
        }
        if (data.me && !data.rows.some((r) => r.userId === data.me!.userId)) {
          const tr = el('tr', 'you-row')
          tr.appendChild(el('td', undefined, `${data.me.rank}`))
          const nameTd = el('td')
          nameTd.appendChild(el('span', undefined, data.me.username))
          nameTd.appendChild(el('span', 'you-dot', '  you'))
          tr.appendChild(nameTd)
          tr.appendChild(el('td', undefined, `${data.me.wins}-${data.me.losses}`))
          tr.appendChild(el('td', undefined, `${data.me.winRate}%`))
          tr.appendChild(el('td', undefined, `${data.me.highestBreak}`))
          table.appendChild(tr)
        }
        boardBox.appendChild(table)
      })
      .catch((error) => {
        boardBox.innerHTML = ''
        boardBox.appendChild(el('div', 'muted', (error as Error).message))
      })
  }

  periodSelect.onchange = () => renderBoard(periodSelect.value)
  renderBoard('all')
  return c
}

function enterMatch(matchId: string, isPractice = false): void {
  activeMatchId = matchId
  activeMatchIsPractice = isPractice
  clearTournamentTimer()
  mySeat = undefined
  frame = null
  framesWon = [0, 0]
  frameIndex = 1
  players = []
  opponentGone = false
  render()
  getSocket().emit('match:join', { matchId })
  void loadMatchMeta(matchId)
}

function applyCanvasSize(): void {
  const canvas = rgCanvas
  if (!canvas) return
  const frame = canvas.parentElement
  if (!frame) return
  const dpr = Math.min(dprCap, window.devicePixelRatio || 1)
  const w = Math.max(320, Math.floor(frame.clientWidth * dpr))
  const h = Math.max(180, Math.floor(w * (640 / 1200)))
  canvas.width = w
  canvas.height = h
  scene3d?.resize(w, h)
}

function updateNetOverlay(): void {
  if (!netOverlayEl) return
  const show = activeMatchId !== null && (!connected || !navigator.onLine)
  netOverlayEl.style.display = show ? 'flex' : 'none'
  const text = netOverlayEl.querySelector('p')
  if (text) {
    text.textContent = !navigator.onLine ? 'You are offline — reconnecting…' : 'Connection lost — reconnecting…'
  }
}

function renderGame(): void {
  app.innerHTML = ''
  app.appendChild(header())
  const container = el('div')

  const strip = el('div', 'match-strip')
  const leftCol = el('div', 'col')
  const youEl = el('div', 'name-you', currentUser?.username ?? 'You')
  youEl.id = 'hud-you'
  leftCol.appendChild(youEl)
  const turnEl = el('div', 'turn-name', myTurn ? 'YOUR TURN' : 'WAITING')
  turnEl.id = 'hud-turn'
  turnEl.setAttribute('aria-live', 'polite')
  turnEl.setAttribute('role', 'status')
  leftCol.appendChild(turnEl)
  strip.appendChild(leftCol)

  const centerCol = el('div', 'col center')
  const metaEl = el('div', 'meta-line')
  metaEl.id = 'hud-meta'
  centerCol.appendChild(metaEl)
  const ballEl = el('div', 'meta-line')
  ballEl.id = 'hud-ball'
  centerCol.appendChild(ballEl)
  strip.appendChild(centerCol)

  const rightCol = el('div', 'col right')
  const oppEl = el('div', 'name-opp', opponentName())
  oppEl.id = 'hud-opp'
  rightCol.appendChild(oppEl)
  strip.appendChild(rightCol)
  container.appendChild(strip)
  updateHud()

  const oppHolder = el('div')
  oppHolder.id = 'opp-holder'
  container.appendChild(oppHolder)

  const tableFrame = el('div', 'table-frame')
  const canvas = el('canvas') as HTMLCanvasElement
  canvas.id = 'game-canvas'
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', 'Snooker table — aim with pointer or touch, arrows for spin, Space to shoot')
  rgCanvas = canvas
  tableFrame.appendChild(canvas)
  const overlay = el('div', 'net-overlay')
  overlay.appendChild(el('p', undefined, 'Connection lost — reconnecting…'))
  tableFrame.appendChild(overlay)
  netOverlayEl = overlay
  updateNetOverlay()
  container.appendChild(tableFrame)
  applyCanvasSize()
  gameResizeObserver?.disconnect()
  gameResizeObserver = new ResizeObserver(() => applyCanvasSize())
  gameResizeObserver.observe(tableFrame)
  dprCap = 2
  frameEma = 0
  slowFrames = 0

  scene3d?.dispose()
  scene3d = Scene3D.create(canvas, canvas.width, canvas.height)

  const powerLabel = el('div', 'power-label', 'Power')
  const powerFill = el('div', 'power-fill')
  const powerBar = el('div', 'power-meter')
  powerBar.appendChild(powerFill)
  const powerGroup = el('div', 'power-group')
  powerGroup.appendChild(powerLabel)
  powerGroup.appendChild(powerBar)
  const spinLabel = el('div', 'spin-label', 'Spin: 0.0 / 0.0')

  const bar = el('div', 'controls-bar')
  bar.appendChild(el('div', 'muted', 'Aim: mouse or touch · Power: press & hold to charge (or drag back) · Spin: arrows · Shoot: release or Space'))
  bar.appendChild(powerGroup)
  bar.appendChild(spinLabel)
  const soundBtn = el('button', 'ghost', isSoundMuted() ? 'Sound: off' : 'Sound: on')
  soundBtn.onclick = () => {
    const next = !isSoundMuted()
    setSoundMuted(next)
    soundBtn.textContent = next ? 'Sound: off' : 'Sound: on'
  }
  bar.appendChild(soundBtn)
  const concedeBtn = el('button', 'danger', activeMatchIsPractice ? 'Finish practice' : 'Concede')
  concedeBtn.onclick = () => {
    if (activeMatchIsPractice) void finishPractice()
    else askConcede()
  }
  bar.appendChild(concedeBtn)
  const leaveBtn = el('button', 'ghost', 'Leave')
  leaveBtn.onclick = () => leaveToLobby()
  bar.appendChild(leaveBtn)
  container.appendChild(bar)
  app.appendChild(container)
  updateOpponentGone()

  cueController?.destroy()
  cueController = createCueController({
    canvas,
    cuePosition: { x: 300, y: 800 },
    // The visit is only playable when the table has settled, which is the same
    // condition that draws the cue. Firing while a shot is still animating used to
    // be accepted by the server and cut the animation dead.
    enabled: () => isVisitPlayable(),
    onChange: (aim) => {
      powerFill.style.width = `${Math.round(aim.power * 100)}%`
      spinLabel.textContent = `Spin: ${aim.spinX.toFixed(1)} / ${aim.spinY.toFixed(1)}`
    },
    onShoot: (shot: Omit<ShotInput, 'timestamp'>) => {
      getSocket().emit('shot:play', { matchId: activeMatchId, input: { ...shot, timestamp: Date.now() } })
    }
  })
  powerFill.style.width = '40%'
}

interface GameUpdatePayload {
  frame: FrameSnapshotData
  events?: Array<{ type: string; data: unknown }>
  playback?: ShotPlayback
}

function handleGameUpdate(data: GameUpdatePayload): void {
  // A shot has to be watched to the end. If another update lands while one is
  // still animating, it waits its turn instead of cutting the replay short, so the
  // balls are never seen to jump by two shots' worth of movement at once.
  // `shotInFlight` is the single "unfinished shot" flag: it stays set from the
  // moment playback starts until the server has been told the shot finished, and
  // it is also set when there is no pre-shot snapshot to animate.
  if (shotInFlight) {
    queuedUpdate = data
    return
  }
  applyGameUpdate(data)
}

/**
 * The visit can be played only once every ball has stopped moving and the server
 * has taken delivery of the previous shot's "finished" acknowledgement.
 *
 * All three conditions matter. `shotPlayer` is the replay that is on screen,
 * `queuedUpdate` is a shot still waiting behind it, and `shotInFlight` stays set
 * from the moment a replay starts until the server has confirmed it finished, so
 * it also covers the brief window where the animation has ended but the server is
 * still holding the table. Aiming or firing in that window would hand the server a
 * second shot while the first was still live, which is what produced two shots'
 * worth of movement in a single frame.
 */
function isVisitPlayable(): boolean {
  return myTurn && shotPlayer === null && queuedUpdate === null && !shotInFlight
}

/**
 * Drops any replay in progress and forgets anything queued behind it. Used when
 * the server replaces the table outright (a new match, or a reconnect) so the
 * authoritative state is adopted immediately rather than after a stale animation.
 */
function abandonPlayback(): void {
  shotPlayer = null
  queuedUpdate = null
  shotInFlight = false
  deferredPots = []
  // Nothing is being watched any more, so there is no shot to acknowledge. Clearing
  // the token stops a later finish from claiming credit for a replay that was
  // dropped, which would release a hold this client never watched through.
  playedToken = undefined
  // A held verdict belongs to a replay that is being thrown away. The authoritative
  // snapshot arrives with its own events, so reporting this one now would be stale.
  deferredVerdict = []
}

function applyGameUpdate(data: GameUpdatePayload): void {
  const previous = frame
  frame = data.frame
  myTurn = mySeat !== undefined && data.frame.turnIndex === mySeat

  // The score, the turn and the ball on are taken from the server's snapshot the
  // instant it arrives, and are deliberately not held back for the replay. They are
  // facts about the frame rather than commentary on the shot, and holding them would
  // mean the scoreboard and the table disagreed with each other for the length of
  // the animation. What does wait is the shot's verdict: the foul buzzer, the pot
  // sounds and the messages, because those describe what the balls just did and are
  // only meaningful once the striker has watched them do it.
  //
  // A streamed shot replays from where the table was before the update landed,
  // so the animation starts from the true pre-shot positions.
  shotPlayer = null
  deferredPots = []
  playedToken = data.playback?.token
  const heldVerdict = deferredVerdict
  deferredVerdict = []
  if (data.playback && data.playback.keyframes.length && previous) {
    shotPlayer = new ShotPlayer(data.playback, previous.balls as PlaybackBall[])
    shotInFlight = true
  } else if (data.playback) {
    // Playback arrived with no pre-shot snapshot to start from, so there is nothing
    // to animate. Tell the server straight away rather than stalling the visit.
    shotInFlight = true
    finishShot()
  }
  // A running replay gets the verdict only once the balls have finished moving.
  const verdictDeferred = shotPlayer !== null

  const potted: number[] = []
  for (const ev of data.events ?? []) {
    if (ev.type === 'BALL_POTTED') {
      const d = ev.data as { ballId: number }
      potted.push(d.ballId)
    } else if (ev.type === 'FOUL') {
      const d = ev.data as { penalty: number; reason?: string }
      // The buzzer waits with the message. Hearing a foul announced over the sound of
      // balls still rolling tells the striker the outcome before they have watched the
      // shot that caused it.
      const show = (): void => {
        playFoul()
        toast(d.reason ? `Foul: ${d.reason} (-${d.penalty})` : `Foul! -${d.penalty}`, 'error')
      }
      if (verdictDeferred) deferredVerdict.push(show)
      else show()
    } else if (ev.type === 'FRAME_END') {
      const d = ev.data as { winnerSeat: number }
      framesWon = d.winnerSeat === 0 ? [framesWon[0] + 1, framesWon[1]] : [framesWon[0], framesWon[1] + 1]
      const show = (): void => {
        playFrameEnd()
        toast(`Frame ${frameIndex} won by ${seatName(d.winnerSeat)}`)
      }
      if (verdictDeferred) deferredVerdict.push(show)
      else show()
    }
  }
  // Verdicts that are not tied to a replay still have to run; a held verdict from an
  // earlier shot can only be here if its replay was replaced, so flush it now.
  if (!verdictDeferred && heldVerdict.length) {
    for (const show of heldVerdict) show()
  }
  if (potted.length) {
    if (shotPlayer) {
      // Hold the pot feedback until the replay actually drops the ball.
      deferredPots = potted
    } else {
      announcePot(potted)
    }
  }
  updateHud()
}

/**
 * The sound and the message for balls dropping, at the moment they drop.
 *
 * Both halves belong together: the click and the pot noise are what the shot
 * sounds like, so hearing them before the ball reaches the pocket gives the
 * result away ahead of the animation that explains it.
 */
function announcePot(ids: number[]): void {
  if (ids.length === 0) return
  playCushion()
  playPot(ids.length)
  toast(`Potted: ${ids.map(ballName).join(', ')}`)
}

function handleSocketEvents(socket: Socket): void {
  socket.on('connect', () => {
    connected = true
    updateConnChip()
    updateNetOverlay()
    if (activeMatchId) socket.emit('match:join', { matchId: activeMatchId })
  })
  socket.on('disconnect', () => {
    connected = false
    updateConnChip()
    updateNetOverlay()
  })

  socket.on('match:joined', (data: { matchId: string; seat: number; snapshot: FrameSnapshotData | null }) => {
    mySeat = data.seat
    // A join is the server's authoritative word on the table, so anything in flight
    // is abandoned rather than finished: after a reconnect there is no replay left
    // to watch and the settled state is the truth.
    abandonPlayback()
    if (data.snapshot) applyGameUpdate({ frame: data.snapshot })
    const opp = opponentName()
    toast(`Playing vs ${opp} (seat ${data.seat + 1})`)
    updateHud()
  })
  socket.on('match:start', (data: { snapshot: FrameSnapshotData; frameIndex: number }) => {
    frameIndex = data.frameIndex
    // A new match replaces the table outright, so any replay in flight is void.
    abandonPlayback()
    frame = data.snapshot
    myTurn = mySeat !== undefined && data.snapshot.turnIndex === mySeat
    toast('Match started!')
    updateHud()
  })
  socket.on('frame:start', (data: { frameIndex: number; snapshot: FrameSnapshotData }) => {
    frameIndex = data.frameIndex
    // The frame change usually lands straight after the shot that won it, while that
    // shot is still animating, so it queues behind the replay rather than cutting it
    // off. Only the announcement is immediate.
    handleGameUpdate({ frame: data.snapshot })
    toast(`Frame ${data.frameIndex} starting`)
  })
  socket.on('game:update', (data: GameUpdatePayload) => handleGameUpdate(data))
  socket.on('match:end', (data: { winnerSeat: number; reason?: string; framesWon?: [number, number] }) => {
    if (data.framesWon) framesWon = data.framesWon
    if (activeMatchIsPractice) framesWon = [0, 0]
    myTurn = false
    playMatchEnd()
    updateHud()
    void finishMatch(data.winnerSeat, data.reason)
  })
  socket.on('opponent:disconnected', (data: { seat: number }) => {
    if (data.seat === mySeat) return
    opponentGone = true
    updateOpponentGone()
    toast('Opponent disconnected — waiting for reconnect')
  })
  socket.on('opponent:reconnected', (data: { seat: number }) => {
    if (data.seat === mySeat) return
    opponentGone = false
    updateOpponentGone()
    toast('Opponent reconnected')
  })
  socket.on(
    'match:replay',
    (data: { events: Array<{ seq: number; type: string; data: unknown }> }) => {
      if (!data.events.length) return
      toast(`Reconnected — missed ${data.events.length} event${data.events.length === 1 ? '' : 's'}`)
      for (const ev of data.events) {
        if (ev.type === 'BALL_POTTED') {
          const d = ev.data as { ballId: number }
          toast(`Missed: potted ${ballName(d.ballId)}`)
        } else if (ev.type === 'FOUL') {
          const d = ev.data as { penalty: number; reason?: string }
          toast(d.reason ? `Missed: foul — ${d.reason} (-${d.penalty})` : `Missed: foul (-${d.penalty})`, 'error')
        } else if (ev.type === 'FRAME_END') {
          const d = ev.data as { winnerSeat: number }
          toast(`Missed: frame won by ${seatName(d.winnerSeat)}`)
        }
      }
    }
  )
  socket.on('error', (data: { code?: string }) => toast(`Server: ${data.code ?? 'unknown error'}`, 'error'))
  socket.on('notification:new', (n: NotificationItem) => {
    notifications.unshift(n)
    if (panelOpen) panelEl?.classList.remove('open')
    toast(`${n.title}${n.body && n.body !== n.title ? ' — ' + n.body : ''}`)
    refreshBell()
  })
}

function loop(): void {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null
  try {
    if (canvas && frame) {
      const now = performance.now()
      const fdt = Math.min(200, now - lastFrameTime)
      lastFrameTime = now
      if (scene3d) {
        frameEma = frameEma === 0 ? fdt : frameEma * 0.92 + fdt * 0.08
        if (frameEma > 28) slowFrames++
        else slowFrames = 0
        if (slowFrames > 90 && dprCap > 1) {
          dprCap = dprCap === 2 ? 1.5 : 1
          slowFrames = 0
          applyCanvasSize()
          toast('Lowered graphics quality for smoother play', 'info')
        }
        if (frameEma < 14 && dprCap < 2 && now - lastDprUpAt > 20000) {
          lastDprUpAt = now
          dprCap = dprCap === 1 ? 1.5 : 2
          applyCanvasSize()
        }
      }
      // While a shot replays, the table shows sampled simulation positions; the
      // authoritative snapshot above still drives the HUD and turn state.
      const shown = stepShotPlayback(frame, fdt / 1000)
      const cue = shown.balls.find((b) => b.id === 0 && !b.potted)
      if (cue) cueController?.setCuePosition(cue.x, cue.y)
      // Aiming is only offered once the table has genuinely settled: no shot still
      // animating, and nothing waiting behind it. Without this the cue stick and the
      // aim guide were drawn while the balls were still moving.
      const canAim = isVisitPlayable()
      const renderOptions = {
        aim: cueController?.aim,
        youSeat: mySeat,
        immediate: shotPlayer !== null,
        canAim
      }
      if (scene3d) {
        scene3d.update(shown, renderOptions)
        scene3d.render()
      } else {
        drawTable(canvas, shown, renderOptions)
      }
    }
  } catch (error) {
    if (scene3d) {
      scene3d?.dispose()
      scene3d = null
      toast('Graphics error — switched to fallback renderer', 'error')
    }
    reportFatalError(error)
  }
  requestAnimationFrame(loop)
}

/**
 * Announces that a shot has finished animating. The server holds its next shot
 * back until it hears this, which is what stops a bot firing a new shot into the
 * middle of the previous one's animation.
 */
function finishShot(): void {
  if (!shotInFlight) return
  shotInFlight = false
  // The token identifies the replay that was just watched, so an acknowledgement that
  // arrives after the server has moved on cannot release a newer hold.
  if (activeMatchId) getSocket().emit('shot:done', { matchId: activeMatchId, token: playedToken })
}

/**
 * Advances the replay clock and returns the snapshot to draw this frame.
 */
function stepShotPlayback(target: FrameSnapshotData, dtSeconds: number): FrameSnapshotData {
  if (shotPlayer) {
    const balls = shotPlayer.advance(dtSeconds)
    if (deferredPots.length) {
      const due = shotPlayer.takeDuePots()
      if (due.length) {
        const ids = deferredPots.filter((id) => due.includes(id))
        announcePot(ids)
        deferredPots = deferredPots.filter((id) => !due.includes(id))
      }
    }
    if (!shotPlayer.finished) {
      return { ...target, balls }
    }
    // A pot whose timestamp never arrived would otherwise be silently dropped.
    if (deferredPots.length) {
      announcePot(deferredPots)
    }
    // The balls have stopped moving, so the shot's verdict can be reported now.
    if (deferredVerdict.length) {
      const verdicts = deferredVerdict
      deferredVerdict = []
      for (const show of verdicts) show()
    }
    shotPlayer = null
    deferredPots = []
    finishShot()
  }

  // This shot is done, so the table shows its settled state and any shot that was
  // held up starts animating now.
  if (queuedUpdate) {
    const next = queuedUpdate
    queuedUpdate = null
    applyGameUpdate(next)
    if (shotPlayer && frame) {
      // The queued shot has a replay of its own, so show its first frame at once
      // instead of pausing for a frame on the finished shot's positions. Advancing
      // by zero cannot finish a shot with any duration left in it, and the queue is
      // already empty, so this recurses at most once more.
      return stepShotPlayback(frame, 0)
    }
  }
  return target
}

function reportFatalError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const chip = document.getElementById('err-chip')
  if (!chip) return
  chip.textContent = message.length > 140 ? message.slice(0, 140) : message
  const prev = Number(chip.dataset.timer)
  if (prev) window.clearTimeout(prev)
  chip.dataset.timer = String(
    window.setTimeout(() => {
      chip.textContent = ''
      delete chip.dataset.timer
    }, 8000)
  )
}

async function refreshMaintenance(): Promise<void> {
  try {
    const data = await api<{ maintenanceMode: boolean }>('/settings/public')
    if (maintenanceMode !== data.maintenanceMode) {
      maintenanceMode = data.maintenanceMode
      renderMaintenance()
    }
  } catch {
    void 0
  }
}

function renderMaintenance(): void {
  maintenanceEl?.remove()
  maintenanceEl = null
  if (!maintenanceMode) return
  const isAdmin = currentUser?.role === 'ADMIN' || currentUser?.role === 'SUPERADMIN'
  const el = document.createElement('div')
  el.className = isAdmin ? 'maintenance-banner' : 'maintenance-overlay'
  const p = document.createElement('p')
  p.textContent = isAdmin
    ? 'Maintenance mode is ON — players are blocked. Turn it off in Admin → Settings.'
    : 'The platform is briefly under maintenance. Please check back soon.'
  el.appendChild(p)
  document.body.appendChild(el)
  maintenanceEl = el
}

async function init(): Promise<void> {
  const chip = document.createElement('div')
  chip.id = 'err-chip'
  chip.className = 'err-chip'
  chip.setAttribute('role', 'status')
  chip.setAttribute('aria-live', 'polite')
  document.body.appendChild(chip)
  window.addEventListener('error', (event) => reportFatalError(event.error ?? event.message))
  window.addEventListener('unhandledrejection', (event) => reportFatalError(event.reason))
  const online = (): void => {
    updateNetOverlay()
    updateConnChip()
  }
  window.addEventListener('online', online)
  window.addEventListener('offline', online)
  const unlock = (): void => {
    unlockAudio()
    document.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
  }
  document.addEventListener('pointerdown', unlock)
  window.addEventListener('keydown', unlock)
  if (token) {
    const socket = connectSocket(token)
    handleSocketEvents(socket)
    try {
      const data = await api<{ user: { id: string; username: string; role: string; status: string } }>('/auth/status')
      currentUser = data.user
      void fetchNotifications()
    } catch {
      token = ''
      localStorage.removeItem('token')
    }
  }
  requestAnimationFrame(loop)
  void refreshMaintenance()
  window.setInterval(refreshMaintenance, 10000)
  render()
}

void init()