import './styles.css'
import { api, connectSocket, getSocket, makeToast } from './game/network.js'
import { drawTable, resetTableAnimation } from './game/renderer.js'
import { Scene3D } from './game/scene3d.js'
import type { FrameSnapshotData } from './game/renderer.js'
import { createCueController } from './game/input.js'
import type { CueController } from './game/input.js'
import { createHud, computePrizeCredits, describeBallOn, deriveHudState } from './game/hud.js'
import type { Hud } from './game/hud.js'
import { frameForHud } from './game/hudFrame.js'
import { fitTableBox } from './game/layout.js'
import { createShotTimer } from './game/shotTimerView.js'
import type { TurnTiming } from './game/shotTimer.js'
import type { ShotInput, ShotPlayback } from '@snooker/shared'
import { STAKE_TIERS, COLOR_VALUES } from '@snooker/shared'
import type { Socket } from 'socket.io-client'
import { playCushion, playFoul, playFrameEnd, playMatchEnd, playPot, setSoundMuted, isSoundMuted, unlockAudio } from './game/audio.js'
import { ShotPlayer } from './game/playback.js'
import type { PlaybackBall } from './game/playback.js'
import { placementAimAngle, placementShot } from './game/placement.js'
/** Radians of camera orbit per pixel of right-drag: a full-width drag sweeps half a turn. */
const CAMERA_ORBIT_PER_PIXEL = Math.PI / 900

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
/**
 * Which of the two views the player has asked for. The camera follows this rather than
 * being told where to go, so the choice survives every shot: watching a shot put the camera
 * on the balls, and when the balls stop it comes back to whatever was asked for here.
 */
let cameraMode: 'AIM' | 'TOP_DOWN' = 'AIM'
let cameraToggleEl: HTMLButtonElement | null = null
/**
 * The view the player chose themselves, remembered while ball-in-hand placement
 * holds the camera overhead. When the placement ends the toggle is restored to
 * this, so an automatic detour never steals the player's setting.
 */
let prePlacementCamera: 'AIM' | 'TOP_DOWN' | null = null
/** True on the previous loop pass while a placement was live, so the end of one is detectable. */
let placementWasActive = false
/** Where the pointer last sat on the cloth during placement, in table millimetres. */
let placementTarget: { x: number; y: number } | null = null
/** Whether the ghost is currently sitting on a legal spot. */
let placementLegal = false
/** Table point a placement click was accepted at, so one click commits exactly one ball. */
let placementPendingCommit: { x: number; y: number } | null = null
/** Set when the placement click has been sent; cleared when the server's snapshot shows the cue down. */
let placementCommitInFlight = false
/** The last pointer position over the canvas, in client pixels, for the placement ghost. */
let lastPointerCanvas: { clientX: number; clientY: number } | null = null
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
/** The box the table is fitted into; everything else on the page takes its space first. */
let tableStageEl: HTMLElement | null = null
let netOverlayEl: HTMLElement | null = null
/** The one HUD overlay. Null whenever the game screen is not on the page. */
let hud: Hud | null = null
/**
 * The shot clock, drawn into whichever turn frame the HUD is currently showing.
 *
 * One instance for the life of the page, because a clock is driven by deadlines from
 * the server rather than by the game screen: it survives the screen being torn down and
 * rebuilt around a game, and a deadline that arrived while no table was on the page is
 * still the deadline when one comes back.
 */
const shotTimer = createShotTimer({ turnFrame: () => hud?.turnFrame() ?? null })
/**
 * The frame the HUD is currently describing.
 *
 * Scores, turn and ball on are held at the frame a replay started from until that replay
 * ends, because the server's snapshot carries the shot's result before the animation that
 * shows it has run. `frameForHud` owns that rule; this is simply where the answer is kept
 * between calls.
 */
let hudFrame: FrameSnapshotData | null = null
/** Sticky dismissal of the controls hint, so it does not come back mid-frame. */
let hintDismissed = false
/** What the table is worth, read once from the match rather than recomputed. */
let matchPrizeCredits = 0
/**
 * The ceiling for the canvas backing store's device pixel ratio. 1.5 keeps a
 * high-DPI screen sharper than plain 1× while capping the fragment load that 4K
 * panels (DPR 2+) would otherwise put on a weak GPU; the adaptive ladder below
 * steps between 1 and this, and never above it.
 */
let dprCap = 1.5
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

/**
 * The two-view toggle.
 *
 * The glyph shows the view the button switches *to*, which is the more useful of the two
 * readings while you are looking at the other one. The mark is a lens ring with a diagram
 * inside it: from behind the cue ball, a ball on a horizon with the cue above it; from
 * overhead, the table's own rectangle with its centre line.
 */
function cameraSvg(mode: 'AIM' | 'TOP_DOWN'): string {
  const ink = 'currentColor'
  const diagram =
    mode === 'AIM'
      ? '<circle cx="10" cy="11.9" r="2.1" fill="' +
        ink +
        '"/>' +
        '<path d="M3.4 15.5h13.2" stroke="' +
        ink +
        '" stroke-width="1.3" stroke-linecap="round"/>' +
        '<path d="M10 4.1v3.9" stroke="' +
        ink +
        '" stroke-width="1.3" stroke-linecap="round"/>'
      : '<rect x="4.1" y="6.2" width="11.8" height="7.6" rx="1.5" fill="none" stroke="' +
        ink +
        '" stroke-width="1.3"/>' +
        '<path d="M10 6.2v7.6" stroke="' +
        ink +
        '" stroke-width="1.3"/>' +
        '<circle cx="7" cy="9.4" r="1.4" fill="' +
        ink +
        '"/>'
  return (
    '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">' +
    '<circle cx="10" cy="10" r="8.4" fill="none" stroke="' +
    ink +
    '" stroke-width="1.3"/>' +
    diagram +
    '</svg>'
  )
}

function buildCameraToggle(): HTMLButtonElement {
  const btn = el('button', 'camera-toggle') as HTMLButtonElement
  btn.type = 'button'
  btn.onclick = () => {
    setCameraMode(cameraMode === 'AIM' ? 'TOP_DOWN' : 'AIM')
  }
  setCameraMode(cameraMode)
  cameraToggleEl = btn
  return btn
}

function setCameraMode(mode: 'AIM' | 'TOP_DOWN'): void {
  cameraMode = mode
  const btn = cameraToggleEl
  if (!btn) return
  const switchingTo = mode === 'AIM' ? 'behind the cue ball' : 'overhead'
  btn.innerHTML = cameraSvg(mode)
  btn.title = `Camera: ${mode === 'AIM' ? 'behind the cue ball' : 'overhead'} — switch to ${switchingTo}`
  btn.setAttribute('aria-label', btn.title)
  btn.setAttribute('aria-pressed', mode === 'TOP_DOWN' ? 'true' : 'false')
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

/**
 * Feeds the HUD overlay from the authoritative frame state.
 *
 * Called on state changes only — a snapshot landing, a frame changing hands, the
 * replay finishing — and never from the render loop. The component diffs every write
 * before it makes it, so a call that changes nothing costs nothing.
 */
function updateHud(): void {
  if (!hud) return
  // While a replay is on screen the HUD keeps describing the frame that replay started
  // from, so nothing it shows gives the shot away before it has been watched.
  hudFrame = frameForHud({ replayRunning: shotPlayer !== null, shown: hudFrame, authoritative: frame })
  hud.update(
    deriveHudState({
      snapshot: hudFrame,
      you: { name: currentUser?.username ?? 'You', isBot: false },
      opponent: { name: opponentName(), isBot: activeMatchIsPractice },
      mySeat,
      showMatchResult: matchPrizeCredits > 0,
      prizeCredits: matchPrizeCredits,
      framesWon,
      frameIndex,
      format: matchFormat,
      practice: activeMatchIsPractice
    })
  )
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
      stakePerPlayer?: number | string
      platformFeePct?: number | string
      players?: Array<{ id: string; userId: string; seat: number; user: { id: string; username: string } }>
    }>(`/matches/${matchId}`)
    matchFormat = data.format ?? matchFormat
    players = data.players ?? []
    // The match row carries the stake and the fee the prize was settled from, so the
    // top bar can show what the table is worth from the first frame. Prisma hands
    // decimals back as strings, hence the Number on both. A zero stake is a practice
    // match, which is what gates the prize on and off without a second flag.
    const stake = Number(data.stakePerPlayer ?? 0)
    const feePct = Number(data.platformFeePct ?? 0)
    matchPrizeCredits = stake > 0 ? computePrizeCredits(stake, feePct) : 0
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
  // The game screen is the only full-height page; every other screen is a scrolling
  // column, so the class is reset here rather than left behind by the last render.
  app.className = 'app-root'
  document.body.classList.remove('game-mode')
  hud = null
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

/**
 * Fits the table to the space the layout has left over and sizes the canvas to match.
 *
 * Measured off the stage rather than the window, so the HUD and the controls can take
 * their space first and the page still ends up exactly one screen tall. The fitting
 * itself is in game/layout.ts, where it can be tested without a page.
 */
function applyCanvasSize(): void {
  const canvas = rgCanvas
  const stage = tableStageEl
  if (!canvas || !stage) return
  const { width, height } = fitTableBox(stage.clientWidth, stage.clientHeight)
  if (width <= 0 || height <= 0) return
  const frame = canvas.parentElement
  if (frame instanceof HTMLElement) {
    frame.style.width = `${width}px`
    frame.style.height = `${height}px`
  }
  const dpr = Math.min(dprCap, window.devicePixelRatio || 1)
  const w = Math.max(320, Math.floor(width * dpr))
  const h = Math.max(180, Math.floor(height * dpr))
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
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
  app.className = 'app-root app-game'
  document.body.classList.add('game-mode')
  app.appendChild(header())
  const page = el('div', 'game-page')

  // The HUD is mounted once and then only updated. Both renderers read from the same
  // component, which is what stops the 3D and 2D halves of the screen disagreeing.
  hud = createHud()
  page.appendChild(hud.root)

  const stage = el('div', 'table-stage')
  const tableFrame = el('div', 'table-frame')
  const canvas = el('canvas') as HTMLCanvasElement
  canvas.id = 'game-canvas'
  canvas.setAttribute('role', 'img')
  canvas.setAttribute('aria-label', 'Snooker table — aim with pointer or touch, arrows for spin, Space to shoot')
  rgCanvas = canvas
  tableStageEl = stage
  tableFrame.appendChild(canvas)
  // Placement guidance sits under the table and speaks only while it has
  // something to say — a D restriction, a crowded spot — then goes quiet.
  const placementHint = el('div', 'placement-hint')
  placementHint.id = 'placement-hint'
  placementHint.hidden = true
  placementHint.setAttribute('role', 'status')
  page.appendChild(placementHint)
  placementHintEl = placementHint
  // The pointer is followed so the ghost can track it; the click that commits a
  // placement is captured once, here, and the normal aim gestures are untouched
  // because placement only ever consumes the event when it is actually placing.
  canvas.addEventListener('pointermove', (e) => {
    lastPointerCanvas = { clientX: e.clientX, clientY: e.clientY }
  })
  canvas.addEventListener('pointerdown', (e) => {
    lastPointerCanvas = { clientX: e.clientX, clientY: e.clientY }
    if (!isPlacing() || placementCommitInFlight) return
    const rect = canvas.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * canvas.width
    const py = ((e.clientY - rect.top) / rect.height) * canvas.height
    const tablePoint = scene3d?.screenToTable(px, py) ?? null
    if (!tablePoint) return
    placementPendingCommit = { x: tablePoint.x, y: tablePoint.y }
    e.preventDefault()
  })
  const overlay = el('div', 'net-overlay')
  overlay.appendChild(el('p', undefined, 'Connection lost — reconnecting…'))
  tableFrame.appendChild(overlay)
  netOverlayEl = overlay
  updateNetOverlay()
  // The view toggle sits on the frame rather than in the page flow, top left, clear of the
  // power rail on the right and the score above.
  tableFrame.appendChild(buildCameraToggle())
  const oppHolder = el('div')
  oppHolder.id = 'opp-holder'
  tableFrame.appendChild(oppHolder)
  // The power rail overlays the table, so it mounts into the frame rather than into
  // the page flow: it must not take vertical space from the table it sits over.
  tableFrame.appendChild(hud.overlayRoot)
  stage.appendChild(tableFrame)
  page.appendChild(stage)

  const bar = el('div', 'controls-bar')
  if (!hintDismissed) {
    const hint = el('div', 'controls-hint')
    hint.appendChild(
      el('span', undefined, 'Aim: mouse or touch · Power: drag the slider, hold to charge, or ↑/↓ to trim · Spin: ←/→ side, W/S top-bottom · Shoot: release or Space')
    )
    const dismiss = el('button', 'hint-close', '×')
    dismiss.title = 'Hide these controls for this session'
    dismiss.setAttribute('aria-label', 'Hide the controls hint')
    dismiss.onclick = () => {
      hintDismissed = true
      hint.remove()
    }
    hint.appendChild(dismiss)
    bar.appendChild(hint)
  }
  page.appendChild(bar)

  const spinLabel = el('div', 'spin-label', 'Spin: 0.0 / 0.0')
  bar.appendChild(spinLabel)

  // The three session buttons, in one quiet cluster in the corner rather than the
  // full-width bar they used to be: they are needed occasionally, not per shot.
  const actions = el('div', 'control-actions')
  const soundBtn = el('button', 'ghost small', isSoundMuted() ? 'Sound: off' : 'Sound: on')
  soundBtn.onclick = () => {
    const next = !isSoundMuted()
    setSoundMuted(next)
    soundBtn.textContent = next ? 'Sound: off' : 'Sound: on'
  }
  const concedeBtn = el('button', 'ghost small', activeMatchIsPractice ? 'Finish' : 'Concede')
  concedeBtn.onclick = () => {
    if (activeMatchIsPractice) void finishPractice()
    else askConcede()
  }
  const leaveBtn = el('button', 'ghost small', 'Leave')
  leaveBtn.onclick = () => leaveToLobby()
  actions.append(soundBtn, concedeBtn, leaveBtn)
  bar.appendChild(actions)

  app.appendChild(page)
  applyCanvasSize()
  gameResizeObserver?.disconnect()
  gameResizeObserver = new ResizeObserver(() => applyCanvasSize())
  gameResizeObserver.observe(stage)
  dprCap = 1.5
  frameEma = 0
  slowFrames = 0

  scene3d?.dispose()
  scene3d = Scene3D.create(canvas, canvas.width, canvas.height)

  updateHud()
  updateOpponentGone()

  cueController?.destroy()
  cueController = createCueController({
    canvas,
    cuePosition: { x: 300, y: 800 },
    // The 3D scene answers pointer questions by casting through the camera it is drawing
    // with, so the aim means the same thing from behind the cue ball as from overhead. Asked
    // for per gesture rather than captured once, because the camera is still easing towards
    // its next position while the player is aiming — and because a graphics error can take
    // the 3D scene away mid-game, leaving the flat renderer to answer instead.
    view: () =>
      scene3d
        ? {
            screenToTable: (px, py) => scene3d?.screenToTable(px, py) ?? null,
            tableToScreen: (x, y) => scene3d?.tableToScreen(x, y) ?? null,
            ballRadiusPx: (x, y, radius) => scene3d?.ballRadiusPx(x, y, radius) ?? 0
          }
        : undefined,
    // The only gesture that turns the camera between shots: a deliberate right- or
    // middle-button drag. Hovering the pointer over the table never rotates anything —
    // it aims the cue, and the camera stands exactly where the last shot left it.
    onOrbit: (pixels) => scene3d?.orbitBy(pixels * CAMERA_ORBIT_PER_PIXEL),
    // The visit is only playable when the table has settled, which is the same
    // condition that draws the cue. Firing while a shot is still animating used to
    // be accepted by the server and cut the animation dead.
    enabled: () => isVisitPlayable(),
    onChange: (aim) => {
      hud?.setPower(aim.power)
      // The dial mirrors whatever wrote the spin — arrows, its own drag, a reset —
      // because both controls are views of this one pair of numbers.
      hud?.setSpin({ x: aim.spinX, y: aim.spinY })
      spinLabel.textContent = `Spin: ${aim.spinX.toFixed(1)} / ${aim.spinY.toFixed(1)}`
    },
    onShoot: (shot: Omit<ShotInput, 'timestamp'>) => {
      getSocket().emit('shot:play', { matchId: activeMatchId, input: { ...shot, timestamp: Date.now() } })
      // The shot is on its way, so the bar empties for the next one. Eased inside the
      // controller, and it keeps animating on its own frames rather than being driven
      // by a state change that has already happened.
      cueController?.resetPower()
    }
  })
  // The slider is the other way into the same power value: dragging it writes the
  // number the controller will send, and the cue stick follows on the next frame it
  // renders, so the pull-back tracks the handle.
  hud?.setPowerSink((power) => {
    if (cueController) cueController.aim.power = power
  })
  // While the slider is mid-drag it owns the power: the controller is locked out of
  // writing it, so neither the charge gesture, the wheel, the fine keys nor the eased
  // after-shot reset can drag the handle back down underneath the player's finger.
  hud?.setPowerDragListener((dragging) => {
    if (!cueController) return
    if (dragging) cueController.lockPower()
    else cueController.unlockPower()
  })
  // The spin dial is the other way into the same spin pair the arrow keys set:
  // dragging the dot writes straight into the controller's aim, and the controller's
  // onChange loops the value back to the dial (skipped while the dial drives), so
  // both controls and the readout stay one value apart from the physics.
  hud?.setSpinSink((spin) => {
    if (!cueController) return
    cueController.aim.spinX = spin.x
    cueController.aim.spinY = spin.y
    // The controller does not fire onChange for direct writes, so the readout and
    // the dial's own dot are refreshed here; the dial skips this while driving.
    hud?.setSpin({ x: spin.x, y: spin.y })
    spinLabel.textContent = `Spin: ${spin.x.toFixed(1)} / ${spin.y.toFixed(1)}`
  })
  hud?.setPower(0)
}

interface GameUpdatePayload {
  frame: FrameSnapshotData
  events?: Array<{ type: string; data: unknown }>
  playback?: ShotPlayback
  turn?: TurnTiming
}

/**
 * Adopts whatever the server last said about the turn clock.
 *
 * Called from every message that describes the table, including the ones that carry no
 * deadline, so that a clock the server has stopped is taken down rather than left
 * counting on a view of a turn that is over. It is deliberately tolerant of a missing
 * field: a message with no timing attached means no clock, not a crash.
 *
 * Messages are also guarded against arriving out of order — a queued `frame:start`
 * landing after a fresher `turn:clock` would otherwise rewind a clock that had already
 * been set. The server's own send time is the arbiter: an older message says nothing
 * about the clock that a newer one has not already said.
 */
let lastTimingStamp = -1
function applyTurnTiming(turn: TurnTiming | null | undefined): void {
  if (turn && turn.serverNow < lastTimingStamp) return
  if (turn) lastTimingStamp = turn.serverNow
  shotTimer.set(turn ?? null)
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
 * Returns spin to centre, the dial with it.
 *
 * A fresh visit starts with no spin applied, exactly as it starts with an empty
 * power bar: leftover english from a previous shot is a value the player is no
 * longer setting, and the one place it would still be visible — the dial's dot —
 * would be lying about what the next shot will do. Fired wherever the visit's
 * power is reset, so both between-shot controls move together.
 */
function resetSpin(): void {
  if (!cueController) return
  cueController.aim.spinX = 0
  cueController.aim.spinY = 0
  hud?.setSpin({ x: 0, y: 0 })
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
  const wasMyTurn = myTurn
  myTurn = mySeat !== undefined && data.frame.turnIndex === mySeat
  // Every new visit starts with no power charged. Firing already empties the bar, so
  // this only fires on the visits that never involved a shot from here: the turn coming
  // back after the opponent's, a timeout foul, a reconnect. Without it, a half-charged
  // cue survived the whole of somebody else's visit and handed it back still charged,
  // which is not a state a player asked for and one click of the mouse away from a
  // full-power shot. Keyed on the change rather than on every update, so a player who
  // has already set their power keeps it for the rest of the visit.
  if (myTurn && !wasMyTurn) {
    cueController?.resetPower()
    resetSpin()
  }
  // Ball in hand is a rule moment, not a chat line: when the cue comes to hand on
  // this client's visit it is announced centre-screen, once per change of state.
  if (data.frame.cueInHand && previous?.cueInHand !== true && myTurn) {
    hud?.flashEvent('BALL IN HAND', 'info')
  }
  // The clock is read here, alongside the score and the turn. A message carrying a
  // shot is the moment the timer freezes: the balls are moving, so no turn is being
  // timed, and the ring holds where it was rather than counting through an animation.
  // Any other table message adopts the timing it carries — a fresh 30 when the table
  // has settled on the same visit or a new one, nothing when the server has stopped
  // the clock outright.
  if (data.playback) shotTimer.freeze()
  else applyTurnTiming(data.turn)

  // What the shot turned out to be is reported when the balls have stopped moving, not
  // when the snapshot saying so arrives. That covers the verdict's sound and its message,
  // and the score with it: a snapshot carries the outcome the instant it lands, so a
  // scoreboard that read it there would name the pot, the foul or the won frame while
  // the ball responsible was still on its way to the pocket.
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
        // The penalty is announced big and once: the value the server charged,
        // 4 to 7, is the headline.
        hud?.flashEvent(`FOUL -${d.penalty}`, 'bad')
      }
      if (verdictDeferred) deferredVerdict.push(show)
      else show()
    } else if (ev.type === 'FRAME_END') {
      const d = ev.data as { winnerSeat: number }
      const show = (): void => {
        // The frames score moves with the verdict, not with the snapshot. It is the
        // loudest spoiler in the game — a frame won is a frame won, and there is no
        // reading of an updated frame tally that is not the answer — so it waits with
        // the bell and the announcement. The HUD picks it up on the refresh that ends
        // the replay.
        framesWon = d.winnerSeat === 0 ? [framesWon[0] + 1, framesWon[1]] : [framesWon[0], framesWon[1] + 1]
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
  // The centre-screen banner carries the score the pot is worth, so the moment
  // lands as a number as well as a sound: reds one each, colours their own value.
  const points = ids.reduce((sum, id) => sum + (id >= 1 && id <= 15 ? 1 : (COLOR_VALUES[id] ?? 0)), 0)
  const label = ids.map(ballName).join(', ').toUpperCase()
  hud?.flashEvent(`POTTED ${label} +${points}`, 'good')
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

  socket.on('match:joined', (data: { matchId: string; seat: number; snapshot: FrameSnapshotData | null; turn?: TurnTiming }) => {
    mySeat = data.seat
    // A join is the server's authoritative word on the table, so anything in flight
    // is abandoned rather than finished: after a reconnect there is no replay left
    // to watch and the settled state is the truth. The turn clock comes with it,
    // because a client that has just come back has no deadline of its own to draw.
    abandonPlayback()
    // The turn timing is passed into the update rather than set alongside it, because
    // the update is what applies a clock and a message with no timing attached means
    // no clock. Setting it first and then applying the snapshot would take the clock
    // straight back down again.
    if (data.snapshot) applyGameUpdate({ frame: data.snapshot, turn: data.turn })
    else applyTurnTiming(data.turn)
    const opp = opponentName()
    toast(`Playing vs ${opp} (seat ${data.seat + 1})`)
    updateHud()
  })
  socket.on('match:start', (data: { snapshot: FrameSnapshotData; frameIndex: number; turn?: TurnTiming }) => {
    frameIndex = data.frameIndex
    // A new match replaces the table outright, so any replay in flight is void.
    abandonPlayback()
    frame = data.snapshot
    myTurn = mySeat !== undefined && data.snapshot.turnIndex === mySeat
    // Whatever was charged on the previous match's table is not this match's business.
    if (myTurn) {
      cueController?.resetPower()
      resetSpin()
    }
    applyTurnTiming(data.turn)
    toast('Match started!')
    updateHud()
  })
  socket.on('frame:start', (data: { frameIndex: number; snapshot: FrameSnapshotData; turn?: TurnTiming }) => {
    frameIndex = data.frameIndex
    // The frame change usually lands straight after the shot that won it, while that
    // shot is still animating, so it queues behind the replay rather than cutting it
    // off. Only the announcement is immediate. The turn timing rides along: it is
    // adopted when the update applies, which is after the replay, when the new frame's
    // table is actually shown.
    handleGameUpdate({ frame: data.snapshot, turn: data.turn })
    toast(`Frame ${data.frameIndex} starting`)
  })
  socket.on('game:update', (data: GameUpdatePayload) => handleGameUpdate(data))
  // The clock's own channel. The room also changes its clock between table broadcasts
  // — a fresh turn the moment a replay is released, a stop when the striker goes away
  // — and those moments carry no frame of their own, so they are announced here and
  // adopted like any other timing.
  socket.on('turn:clock', (data: { turn?: TurnTiming }) => {
    applyTurnTiming(data.turn ?? null)
  })
  socket.on('match:end', (data: { winnerSeat: number; reason?: string; framesWon?: [number, number] }) => {
    if (data.framesWon) framesWon = data.framesWon
    if (activeMatchIsPractice) framesWon = [0, 0]
    myTurn = false
    // The match is over, so the room has thrown its clock away and this message carries
    // none. Without this the last deadline a client was given would keep draining behind
    // the end-of-match screen, counting towards a foul that can no longer happen.
    applyTurnTiming(null)
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

/**
 * Whether this client is mid-placement: my visit, the cue ball in hand, and the
 * table settled. The frame's `cueInHandInD` says which restriction is in force —
 * the D only at break-off, anywhere mid-frame — and the whole presentation flow
 * (camera, D overlay, ghost) keys off this one question.
 */
function isPlacing(): boolean {
  return isVisitPlayable() && frame?.cueInHand === true
}

/**
 * Runs the ball-in-hand placement experience for one frame: the automatic
 * overhead camera, the D-only or whole-table indication, the ghost cue ball and
 * the click-to-place commit.
 *
 * The camera rule is the one piece of opinion here: entering placement forces
 * TOP_DOWN (full-table visibility for choosing a spot), and when placement ends —
 * the server's snapshot showing the cue ball down — the camera eases back to
 * whatever the player had before. The player's own toggle still works during
 * placement: it rewrites `cameraMode`, which this override remembers and honours
 * the moment the placement clears.
 */
function stepPlacement(canvas: HTMLCanvasElement): void {
  const placing = isPlacing()
  const inD = frame?.cueInHandInD === true

  if (placing && !placementWasActive) {
    // Entering placement: take the camera overhead automatically, remembering
    // what the player had chosen so it can be handed back afterwards.
    prePlacementCamera = cameraMode
    setCameraMode('TOP_DOWN')
    placementTarget = null
    placementLegal = false
    placementPendingCommit = null
    // A placement that was already sent (a fast double-click, say) must not be
    // forgotten just because the placement state flickered; the in-flight flag
    // is only cleared by the server showing the ball placed.
    if (!placementCommitInFlight) {
      scene3d?.setPlacementMode(true, inD)
    } else {
      scene3d?.setPlacementMode(false, false)
    }
  } else if (placing && placementWasActive) {
    // Staying in placement: the D flag can change between frames (a snapshot
    // arriving late), so the overlays follow it live.
    if (!placementCommitInFlight) scene3d?.setPlacementMode(true, inD)
  } else if (!placing && placementWasActive) {
    // Placement over: the cue ball is down (or the visit moved on). Ease the
    // camera back to the player's own choice — the normal post-shot return.
    scene3d?.setPlacementMode(false, false)
    setCameraMode(prePlacementCamera ?? 'AIM')
    prePlacementCamera = null
    placementTarget = null
    placementPendingCommit = null
    placementCommitInFlight = false
  }
  placementWasActive = placing && !placementCommitInFlight

  if (placing && !placementCommitInFlight) {
    // Track the pointer as the ghost's target. The pointer position is read
    // through the live camera each frame, so the view easing toward overhead
    // does not freeze the ghost at a stale spot.
    if (lastPointerCanvas) {
      const rect = canvas.getBoundingClientRect()
      const px = ((lastPointerCanvas.clientX - rect.left) / rect.width) * canvas.width
      const py = ((lastPointerCanvas.clientY - rect.top) / rect.height) * canvas.height
      const tablePoint = scene3d?.screenToTable(px, py) ?? null
      if (tablePoint) {
        placementTarget = { x: tablePoint.x, y: tablePoint.y }
        const snapshotBalls = frame?.balls ?? []
        const status = scene3d?.updatePlacementGhost(placementTarget, inD, snapshotBalls)
        placementLegal = status?.ok ?? false
        if (status?.reason) {
          const label =
            status.reason === 'outside-D'
              ? 'The cue must be placed inside the D at the break-off'
              : status.reason === 'in-pocket'
                ? 'Too close to a pocket'
                : status.reason === 'crowded'
                  ? 'Not enough room — a ball is in the way'
                  : 'Place the cue on the table'
          hintPlacement(label)
        } else {
          hintPlacement(null)
        }
      } else {
        scene3d?.hidePlacementGhost()
        placementLegal = false
      }
    }
  }

  // A click that was accepted fires the placement stroke exactly once. The shot
  // carries `cuePos`, which is all the server needs to put the ball down and let
  // the frame continue; everything else is the same shape a real shot has.
  if (placementPendingCommit && placementLegal && !placementCommitInFlight && activeMatchId) {
    const pos = placementPendingCommit
    placementPendingCommit = null
    placementCommitInFlight = true
    scene3d?.setPlacementMode(false, false)
    const shot = placementShot(pos, placementAimAngle(pos), cueController?.aim.power ?? 0)
    getSocket().emit('shot:play', { matchId: activeMatchId, input: { ...shot, timestamp: Date.now() } })
    toast('Cue ball placed', 'info')
    hintPlacement(null)
  }
  // If the commit was lost — the server rejected the spot, say — the snapshot
  // still says cueInHand and the placement state machine starts over cleanly.
  if (placementCommitInFlight && frame?.cueInHand && isVisitPlayable() && !shotInFlight) {
    placementCommitInFlight = false
  }
}

/**
 * A one-line helper message under the table while placing, shown only while it
 * says something. Null clears it. Kept separate from toasts because a placement
 * hint is continuous guidance, not an event.
 */
let placementHintEl: HTMLElement | null = null
function hintPlacement(text: string | null): void {
  if (!placementHintEl) return
  if (text === null) {
    placementHintEl.hidden = true
  } else {
    placementHintEl.hidden = false
    if (placementHintEl.textContent !== text) placementHintEl.textContent = text
  }
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
          dprCap = 1
          slowFrames = 0
          applyCanvasSize()
          toast('Lowered graphics quality for smoother play', 'info')
        }
        if (frameEma < 14 && dprCap < 1.5 && now - lastDprUpAt > 20000) {
          lastDprUpAt = now
          dprCap = 1.5
          applyCanvasSize()
        }
      }
      // While a shot replays, the table shows sampled simulation positions; the
      // authoritative snapshot above still drives the HUD and turn state.
      const shown = stepShotPlayback(frame, fdt / 1000)
      const cue = shown.balls.find((b) => b.id === 0 && !b.potted)
      if (cue) cueController?.setCuePosition(cue.x, cue.y)
      // Ball-in-hand placement runs before the camera is set, because it is one
      // of the things that decides what the camera should be doing this frame.
      stepPlacement(canvas)
      // Aiming is only offered once the table has genuinely settled: no shot still
      // animating, and nothing waiting behind it. Without this the cue stick and the
      // aim guide were drawn while the balls were still moving. The power slider is
      // enabled by exactly the same condition: it is this player's visit and the
      // balls have stopped.
      const canAim = isVisitPlayable()
      hud?.setPowerEnabled(canAim)
      const renderOptions = {
        aim: cueController?.aim,
        youSeat: mySeat,
        immediate: shotPlayer !== null,
        canAim
      }
      if (scene3d) {
        // The view the player picked, and whether the balls are moving. A shot overrides
        // the view for as long as it lasts, then hands it back.
        scene3d.setCameraMode(cameraMode)
        scene3d.setTracking(shotPlayer !== null)
        if (cameraToggleEl) cameraToggleEl.hidden = false
        scene3d.update(shown, renderOptions)
        scene3d.render()
      } else {
        // The fallback renderer draws one fixed view, so there is nothing to switch
        // between and the button would be offering a choice that does not exist.
        if (cameraToggleEl) cameraToggleEl.hidden = true
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
  // The replay is over, so the balls on the table are now the balls the strip is
  // allowed to describe. This is the one moment the strip catches up, and it is why
  // it trails the score by one shot instead of jumping ahead of the animation.
  updateHud()
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