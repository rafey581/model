import './styles.css'
import { api, clearStoredToken, connectSocket, disconnectSocket, FAST_TIMEOUT_MS, getSocket, makeToast, readStoredToken, storeToken } from './game/network.js'
import { openSupportChat, refreshSupportChat } from './support.js'
import { drawTable, resetTableAnimation } from './game/renderer.js'
import { Scene3D } from './game/scene3d.js'
import { preloadTableModel } from './game/tableModel.js'
import type { FrameSnapshotData } from './game/renderer.js'
import { createCueController } from './game/input.js'
import type { CueController } from './game/input.js'
import { createHud, computePrizeCredits, describeBallOn, deriveHudState } from './game/hud.js'
import type { Hud } from './game/hud.js'
import { frameForHud } from './game/hudFrame.js'
import { createShotTimer } from './game/shotTimerView.js'
import type { TurnTiming } from './game/shotTimer.js'
import type { FrameState, ShotInput, ShotPlayback } from '@snooker/shared'
import { APP_TITLE, applyFoulChoice, COLOR_VALUES, cueStartPosition, frameSnapshot, MATCH_CHAT_MAX_LOG, MATCH_CHAT_PHRASES, matchChatPhraseText, STAKE_TIERS, xpForMatch } from '@snooker/shared'
import type { MatchFormat, PracticeAiLevel } from '@snooker/shared'
import { createAvatarBadge } from './game/avatar.js'
import {
  DEFAULT_DIFFICULTY,
  DIFFICULTIES,
  HOME_BAR,
  HOME_CARDS,
  barDestination,
  cardDestination,
  comingSoonMessage
} from './lobbyModel.js'
import type { AppScreen } from './lobbyModel.js'
import {
  USE_NEW_LOBBY,
  USE_LOADING_SCREEN,
  mountGamingLobby,
  showMatchLoading,
  ensureLobbyBgReady
} from './lobby/index.js'
import type { LobbyBridge, LobbySession, LoadPhase } from './lobby/index.js'
import type { Socket } from 'socket.io-client'
import { playCushion, playFoul, playFrameEnd, playMatchEnd, playPot, setSoundMuted, isSoundMuted, unlockAudio } from './game/audio.js'
import { armMusic, setMusicDucked } from './game/music.js'
import { isUnreachable, type SessionUser } from './session.js'
import { USE_NEW_SFX } from './lobby/flag.js'
import { emitSfx } from './sfx/sfxEvents.js'
import { replaySfx } from './sfx/replayAdapter.js'
import { SHOT_PLAYBACK_SPEED } from './game/playback.js'
import { installHudMenu, releaseLandscape, requestLandscape, type HudMenu } from './game/hudMenu.js'
import { ShotPlayer } from './game/playback.js'
import type { PlaybackBall } from './game/playback.js'
import { rateShot, type Highlight } from './game/highlight.js'
import { playRecapWipe } from './game/recapWipe.js'
import { fillBalance } from './lobby/casino.js'
import { xpBar } from './lobby/progress.js'
import type { LobbyProgress } from './lobby/types.js'
import { renderAuthScreen, setAuthOfflineNotice } from './auth.js'
import { getDeviceId } from './deviceId.js'
import { askForDateOfBirthIfMissing } from './dobPrompt.js'
import { receiveAnnouncement, resetAnnouncements, setAnnouncements, showNextAnnouncement, type Announcement } from './announcements.js'
import {
  confirmPlacement,
  initialPlacementFlow,
  rejectPlacement,
  placementAllowsGhostInput,
  placementAllowsGameplayInput,
  placementIsOver,
  stepPlacementFlow
} from './game/placement.js'
import { PLAYER_CAMERA_MODES, PLACEMENT_TRANSITION_SECONDS, type PlayerCameraMode } from './game/camera.js'
import { createRenderScaler } from './game/renderScale.js'
import { predictShot } from './game/predictShot.js'
import { createPerfOverlay } from './game/perfOverlay.js'
import './tournaments.css'
import { hasWeakGpu } from './game/qualityConfig.js'
import { createCueHandle, type CueHandle } from './game/cueHandle.js'
import { placementStatus, D_CENTRE, D_ZONE_RADIUS } from './game/placement.js'
import { qualityConfig, qualityPreference } from './game/qualityConfig.js'
/** Radians of camera orbit per pixel of right-drag: a full-width drag sweeps half a turn. */
const CAMERA_ORBIT_PER_PIXEL = Math.PI / 900

/**
 * How long the camera takes to fly into the overhead placement view and back out of it,
 * in seconds.
 *
 * A named constant rather than a literal at each call site, because the two flights have
 * to take the same time: a camera that goes up quickly and comes back slowly reads as two
 * different events rather than one flow being entered and left. `clampPlacementTransitionSeconds`
 * keeps it inside the 0.5-1.0s window whatever it is set to, so no value here can ask for
 * a cut.
 */
const PLACEMENT_CAMERA_SECONDS = PLACEMENT_TRANSITION_SECONDS

const app = document.querySelector<HTMLDivElement>('#app')!
const toast = makeToast(document.body)

/** Lobby cash HUD: balance in real USDT, no coin/gem metaphor. */
function formatCash(amount: number | string): string {
  const n = typeof amount === 'number' ? amount : Number(amount)
  const value = Math.max(0, Number.isFinite(n) ? n : 0)
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2)
  return `${text} USDT`
}

let token = readStoredToken()
/**
 * True while a saved sign-in is being checked at start-up. The screen shows a neutral
 * loading card meanwhile: drawing the sign-in form first and swapping it for the lobby a
 * moment later read as being logged out and back in again.
 */
let checkingSession = token !== ''
let currentUser: SessionUser | null = null
let wallet = { balance: 0, locked: 0 }
let tiers: TierData[] = []
let activeTierId: string | null = null

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

/**
 * A live invitation to play, pushed by the server. `stakeLabel` is server-side so
 * the popup and the lobby agree on how a tier is written.
 */
interface ChallengeDto {
  id: string
  challengerId: string
  challengerUsername: string
  kind: 'PUBLIC' | 'FRIEND'
  targetUserId: string | null
  targetUsername: string | null
  stakeTier: string
  stakePerPlayer: number
  stakeLabel: string
  /** OPEN or MASTER. Older servers omit it; the tier id is the fallback. */
  table?: 'OPEN' | 'MASTER'
  format: string
  expiresAt: string
  /** True for an invite born from the rematch button, so the popup can say so. */
  rematch?: boolean
}

/** Invitations other players have sent me and I have not answered. */
let incomingChallenges: ChallengeDto[] = []
/** The table I opened and am waiting on someone to accept (null when I am not waiting). */
let pendingChallenge: ChallengeDto | null = null
let challengeLayerEl: HTMLElement | null = null
let challengeBusy = false

/**
 * In-match quick chat. The menu and the log are drawn inside the HUD by
 * `renderGame`; these references are what the socket listener and the toolbar
 * share so every phrase falls into the same box.
 */
let chatMenuEl: HTMLElement | null = null
let chatLogEl: HTMLElement | null = null

let activeMatchId: string | null = null
/**
 * Which of the screens behind a card or a bar icon is on.
 *
 * A screen rather than a URL: the app is one page and every one of these is a re-render,
 * so the id only has to survive long enough to choose the branch in `render`. A match or
 * a tournament still wins over it, because those are states rather than screens — you
 * leave whichever screen you were on to go and play, and you come back to it.
 */
let activeScreen: AppScreen = 'home'
/** The difficulty the setup screen opens on, kept so a trip to the lobby does not reset it. */
let practiceDifficulty: PracticeAiLevel = DEFAULT_DIFFICULTY

let mySeat: number | undefined
let frame: FrameSnapshotData | null = null
let cueController: CueController | null = null
let scene3d: Scene3D | null = null
/** One-shot build progress for the loading screen; cleared after Scene3D.create. */
let pendingSceneBuildProgress: ((fraction: number) => void) | undefined
/**
 * Which of the views the player has asked for. The camera follows this rather than
 * being told where to go, so the choice survives every shot: watching a shot put the camera
 * on the balls, and when the balls stop it comes back to whatever was asked for here.
 */
let cameraMode: PlayerCameraMode = 'AIM'
let cameraToggleEl: HTMLButtonElement | null = null
/** The match screen's menu and pause curtain, rebuilt with each match's HUD. */
let hudMenu: HudMenu | null = null
/**
 * Where the cue-ball placement flow currently stands: idle, flying the camera up to the
 * overhead placement view, placing, or flying back to the gameplay view.
 *
 * This is the single source of truth for the whole flow. The camera moves, the overlays
 * show and the input locks all read off the phase, so none of them can be right about
 * what the flow is doing while another is wrong.
 */
let placementFlow = initialPlacementFlow()
/** Where the pointer last sat on the cloth during placement, in table millimetres. */
let placementTarget: { x: number; y: number } | null = null
/** Whether the ghost is currently sitting on a legal spot. */
let placementLegal = false
/** Table point a placement click was accepted at, so one click commits exactly one ball. */
let placementPendingCommit: { x: number; y: number } | null = null
/** Set when the placement click has been sent; cleared when the server's snapshot shows the cue down. */
let placementCommitInFlight = false
/**
 * Whether the server is holding the strike clock for a placement this client has put down
 * but not yet finished.
 *
 * The hold is released by a separate `placement:done`, sent when the camera lands back at
 * the gameplay view. Set when the ball goes down, cleared once that message is on its way.
 * It exists so the release is sent exactly once, and so it is never sent for a placement
 * that was rejected - the server holds through a rejection for the retry, and releasing
 * early would leave the retry to be played on a running clock.
 */
let placementResumePending = false
/** Set once this placement has told the server the clock is to be held; reset per placement. */
let placementDeclared = false
/** The last pointer position over the canvas, in client pixels, for the placement ghost. */
let lastPointerCanvas: { clientX: number; clientY: number } | null = null
let myTurn = false
/** Non-null while a streamed shot is replaying; drives what the table shows. */
let shotPlayer: ShotPlayer | null = null
/**
 * The player's own shot, played on this device from the instant it is struck (see
 * game/predictShot.ts), until the server's recording of it arrives and takes over from
 * exactly where this one has got to. Null when no shot of mine is waiting on the server.
 */
let predictedShot: {
  player: ShotPlayer
  playback: ShotPlayback
  startBalls: FrameSnapshotData['balls']
  /** Seconds of the stroke still to go before the ball is struck. */
  preRoll: number
  /** When it was struck, for the backstop below. */
  startedAt: number
} | null = null
/**
 * How long past its own end a predicted shot waits for the server before it is dropped.
 * Only a lost connection gets here; the reconnect brings the true table with it.
 */
const PREDICTED_SHOT_BACKSTOP_MS = 12_000
/** The last shot played in this match and where the balls stood before it, for the end-of-match recap. */
let lastShotRecap: { playback: ShotPlayback; start: PlaybackBall[] } | null = null
/** Non-null while the recap of the final shot is on the table. Picture only. */
let recapPlayer: ShotPlayer | null = null
let recapStart: PlaybackBall[] = []
/** Seconds the recap stands on its first frame before it moves, and on its last before it ends. */
let recapHold = 0
let recapDone: (() => void) | null = null
const FINAL_SHOT_HOLD_SECONDS = 1.1
/**
 * A hard shot just potted, waiting for its own replay to finish before it is shown again
 * (see `highlight.ts`). Picture only, like the final-shot recap it shares a player with.
 */
let pendingHighlight: { highlight: Highlight; playback: ShotPlayback; start: PlaybackBall[] } | null = null
/** How long a highlight stands still before and after it plays: shorter than the final shot's. */
const HIGHLIGHT_HOLD_SECONDS = 0.5
/** The longest a highlight may hold the table, however long the shot itself was. */
const HIGHLIGHT_MAX_MS = 9000
/** Ends the highlight on screen and reports its shot done; null when none is playing. */
let skipHighlight: (() => void) | null = null
/** The recap runs slower than the shot did, so it can be read. */
const FINAL_SHOT_SPEED = 0.6
/** The emblem on the result screen. */
const END_TROPHY_SVG =
  '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M20 10h24v14a12 12 0 0 1-24 0z" fill="currentColor" fill-opacity="0.18"/>' +
  '<path d="M20 14h-8v4a8 8 0 0 0 8 8M44 14h8v4a8 8 0 0 1-8 8"/>' +
  '<path d="M32 36v10M22 54h20M26 46h12v8H26z"/></svg>'
/**
 * Seconds left before the replay in `shotPlayer` starts to move.
 *
 * Only ever non-zero for an opponent's shot, and only for as long as their cue takes to
 * wind up: the replay is held on its first frame while the cue comes up and strikes, then
 * runs exactly as it always did. Everything that waits on the replay — the pot sounds, the
 * verdict, the score, the acknowledgement to the server — waits with it, so what is heard
 * and read is what is being seen.
 */
let shotPreRoll = 0
/** Where the balls stood before the shot being held, which is what is drawn while it waits. */
let shotStartBalls: FrameSnapshotData['balls'] | null = null
/**
 * A shot update that arrived while another shot was still animating. It waits here
 * until the current replay finishes rather than replacing it, so every shot is
 * played out in full and no two shots' worth of movement are ever applied in one
 * jump.
 */
/**
 * Shots that arrived while one was still on screen, oldest first. Every one is played in
 * turn: keeping only the latest (as this once did) skipped the shot in between, so the
 * next replay started from a table a shot out of date and balls appeared, vanished or
 * jumped on the opponent's screen.
 */
const queuedUpdates: GameUpdatePayload[] = []
/**
 * False from a shot's arrival until the server says the table is free again (the fresh
 * turn clock it sends when it releases the shot). The server now waits for every player
 * at the table to finish watching, so this phone finishing its own replay is not enough:
 * firing before the other phone has caught up would only be refused. RELEASE_WAIT_MS is a
 * safety net in case that message is lost.
 */
let tableReleased = true
let releaseWaitTimer: number | null = null
const RELEASE_WAIT_MS = 12_000
function markTableReleased(): void {
  tableReleased = true
  if (releaseWaitTimer !== null) window.clearTimeout(releaseWaitTimer)
  releaseWaitTimer = null
}
/**
 * True from the moment a shot's animation starts until the server has been told it
 * has finished. The server holds its next shot back for exactly this window, so
 * this is what keeps the table and the animation in step.
 */
let shotInFlight = false
/** Pots whose sound was deferred until the replay reached the drop. */
let deferredPots: number[] = []
/** Whether the held pots came from a foul stroke, which scores them for nobody. */
let deferredPotsFoul = false
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
/**
 * The mounted gaming lobby, so the next render can tear it down before drawing.
 *
 * The lobby holds document-level listeners (escape, fullscreen, resize); dropping its
 * DOM without `destroy()` would leave one set behind per home ↔ tournaments round trip.
 */
let lobbySession: LobbySession | null = null
/** Lifetime XP as last read from the server; the end screen waits for it to move. */
let lastKnownTotalXp: number | null = null
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
 * The ceiling for the canvas backing store's device pixel ratio.
 *
 * Two of them, because the right answer is a function of the screen rather than of the
 * code: a phone has far fewer pixels to shade than a desktop at the same CSS size, so a
 * DPR-3 phone rendering a full-bleed table at 3x is shading three times what a laptop is
 * for the same picture. `DPR_CAP_DESKTOP` is sharp enough that a 2x panel is drawn at its
 * native density and no denser, and `DPR_CAP_MOBILE` is the fallback for a small screen.
 *
 * `dprCeiling` is the most this screen is ever drawn at. Where the game actually sits
 * under it is the adaptive scale's business (see `renderScaler`): it turns the resolution
 * down when the frame rate is being missed and back up when there is room, and the
 * quality tier's own `renderScale` is the top of its range.
 */
const DPR_CAP_DESKTOP = 2
const DPR_CAP_MOBILE = 2
/**
 * The same ceiling on the High level, for a phone.
 *
 * A phone screen has two and a half or three real pixels to every one the page counts,
 * so a picture drawn at one and a half is being stretched to nearly twice its size to
 * fill the glass, and that is what soft edges and visible steps on a ball are. With the
 * light on the table, the balls and the room painted instead of computed, a pixel costs
 * a fraction of what it did, and High can afford to draw many more of them.
 */
const DPR_CAP_MOBILE_HIGH = 2.25
/**
 * How much larger than the screen High draws on a machine that cannot afford edge
 * smoothing, on a screen with no spare pixels of its own.
 *
 * Built-in graphics get High without the smoothing pass, which leaves every edge stepped.
 * Drawing a quarter larger and letting the browser shrink the picture to fit softens those
 * steps for a fraction of what the smoothing pass cost. It is the first thing given back
 * if frames run long: the floor High may be turned down to is at or just above the
 * screen's own resolution, never below it.
 */
const HIGH_SUPERSAMPLE = 1.25
/** Below this on either axis the screen is treated as a phone rather than a desktop. */
const DPR_MOBILE_MAX_EDGE = 820
/**
 * The fewest backing pixels per CSS pixel the scene is ever drawn at.
 *
 * Under this the table stops reading as soft and starts reading as broken, and a steady
 * frame rate is no longer worth what it costs.
 */
const MIN_PIXEL_RATIO = 0.85
/**
 * The same floor on a phone, which is higher. A phone's screen has two to three real pixels
 * to each one the page counts, so the desktop floor there is a third of the screen's own
 * sharpness: the cloth, the cushions and the balls go soft, which is the part a player is
 * looking at. A phone gives up its room and its crowd first (see `renderScaler`) and keeps
 * the table at least this sharp.
 */
const MIN_PIXEL_RATIO_PHONE = 1.3
/**
 * The most frames a second the game draws. A phone with a 120Hz screen would otherwise draw
 * twice as many frames as a snooker table needs, run hot, and then slow itself down, which
 * is the lag a player feels a few minutes into a match.
 */
const MAX_FPS = 60
/** How early, in milliseconds, a frame may come and still be drawn, so a 60Hz screen is never halved. */
const FRAME_EARLY_MS = 2
/** The least of its full resolution the High level is ever drawn at, as a fraction. */
const HIGH_MIN_RENDER_SCALE = 0.82
/** Where the scale a match settled on is kept, so the next one starts there. */
const RENDER_SCALE_STORAGE_KEY = 'snooker.renderScale.v2'
/** Set when a match had to put the surroundings on their cheaper finish, so the next starts there. */
const ENVIRONMENT_LOW_STORAGE_KEY = 'snooker.environmentLow'

let dprCeiling = DPR_CAP_DESKTOP
let lastFrameTime = 0
/**
 * The order things are given up in when frames are short: the arena and the table's legs
 * go to a cheaper finish first, and only if that is not enough is resolution cut — so the
 * balls and the top of the table, which is what a player is looking at, stay sharp for as
 * long as the machine allows.
 */
const renderScaler = createRenderScaler({
  cheapen: () => {
    if (scene3d?.lowerEnvironmentDetail()) {
      try {
        localStorage.setItem(ENVIRONMENT_LOW_STORAGE_KEY, '1')
      } catch {
        // Storage refused. The next match finds out again in its first couple of seconds.
      }
      return true
    }
    // The room is already on its cheaper finish (every match starts there): the stands and
    // the crowd go next, still before a single pixel of the table is given up.
    if (scene3d?.lowerSurroundingDetail()) return true
    return false
  }
})
/** When the next frame is due, so the game draws at most MAX_FPS a second. */
let nextFrameAt = 0
/** Set once the player has been told the resolution was lowered, so it is said once a match. */
let renderScaleAnnounced = false
/**
 * Whether this match adjusts its own detail and resolution to hold the frame rate.
 *
 * True only when Settings is on Auto. A player who picked a level by name gets exactly that
 * level for the whole match: nothing is lowered behind their back, and nothing raised.
 */
let adaptiveQuality = true

/** Backing pixels per CSS pixel at full scale: the screen's density under the ceiling and the tier's cap. */
function fullPixelRatio(): number {
  const device = window.devicePixelRatio || 1
  const tier = qualityConfig()
  const high = tier.name === 'high'
  const tierCap = tier.name === 'low' ? 1 : tier.name === 'medium' ? 1.5 : dprCeiling
  const oversize = high && device <= 1.25 && hasWeakGpu() ? HIGH_SUPERSAMPLE : 1
  return Math.min(dprCeiling, tierCap, device) * tier.renderScale * oversize
}

function storedRenderScale(): number {
  try {
    const stored = Number(localStorage.getItem(RENDER_SCALE_STORAGE_KEY))
    return stored > 0 && stored <= 1 ? stored : 1
  } catch {
    return 1
  }
}

function storeRenderScale(scale: number): void {
  try {
    localStorage.setItem(RENDER_SCALE_STORAGE_KEY, scale.toFixed(3))
  } catch {
    // Storage refused. The scale is found again within a second or two of the next match.
  }
}

/** The ratio ceiling for the screen in front of us, recomputed on every match. */
function dprCeilingForScreen(): number {
  const phone = Math.min(window.innerWidth, window.innerHeight) <= DPR_MOBILE_MAX_EDGE
  if (!phone) return DPR_CAP_DESKTOP
  return qualityConfig().name === 'high' ? DPR_CAP_MOBILE_HIGH : DPR_CAP_MOBILE
}

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

/**
 * The gold corner brackets around the identity badge.
 *
 * Four angles and nothing else. The frame they belong to is drawn by the corners rather
 * than by a ring, because a ring reads as an outline of whatever it happens to be
 * holding, whereas four corners read as a mount: the eye joins them across the middle and
 * the portrait is left with a lip to sit behind. The stroke is one gradient in the page's
 * gold, run diagonally, so the bracket nearest the brand is the brightest and the one
 * opposite it is the deepest — the frame is lit rather than filled.
 */
function profileBadgeFrameSvg(): string {
  return (
    '<svg class="profile-badge-frame" viewBox="0 0 34 34" width="34" height="34" fill="none" aria-hidden="true">' +
    '<defs>' +
    '<linearGradient id="profile-badge-gold" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="34" y2="34">' +
    '<stop offset="0" stop-color="#ffe6b0"/>' +
    '<stop offset="0.45" stop-color="#ffb02e"/>' +
    '<stop offset="1" stop-color="#b87613"/>' +
    '</linearGradient>' +
    '</defs>' +
    '<path d="M2.5 10.5V5.5A3 3 0 0 1 5.5 2.5h5M23.5 2.5h5a3 3 0 0 1 3 3v5M31.5 23.5v5a3 3 0 0 1-3 3h-5M10.5 31.5h-5a3 3 0 0 1-3-3v-5" ' +
    'stroke="url(#profile-badge-gold)" stroke-width="1.6" stroke-linecap="round"/>' +
    '</svg>'
  )
}

/**
 * Lobby Header HUD: brand + single $ cash balance + slim profile menu.
 * Match screens keep their own overlay; this bar is for lobby / setup only.
 */
function header(_options: { home?: boolean } = {}): HTMLElement {
  const head = el('header', 'lobby-header')

  const brand = el('a', 'brand') as HTMLAnchorElement
  brand.href = '#'
  // The header is a logo, not a route. Handing it a real href and letting the click
  // through would drop the player out of a match with a page reload.
  brand.onclick = (e) => e.preventDefault()
  const logoIcon = el('span', 'brand-logo')
  logoIcon.innerHTML =
    '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="#c9a84c"/><circle cx="12" cy="12" r="7" fill="#0a0a0f"/><circle cx="9.5" cy="9.5" r="2.5" fill="#e8c872"/></svg>'
  brand.append(logoIcon, el('span', 'brand-name', APP_TITLE))
  head.appendChild(brand)

  const right = el('div', 'row header-actions')
  if (currentUser) {
    // Single cash counter — the balance is real USDT, no coin/gem metaphor.
    const walletChip = el('div', 'wallet-chip cash-hud')
    walletChip.id = 'wallet-chip'
    walletChip.title = 'Account balance'
    walletChip.appendChild(el('span', 'wallet-amount', formatCash(wallet.balance)))
    right.appendChild(walletChip)

    const supportBtn = el('button', 'icon-btn support-btn') as HTMLButtonElement
    supportBtn.type = 'button'
    supportBtn.title = 'Customer Support'
    supportBtn.textContent = '💬'
    supportBtn.onclick = () => openSupportChat()
    right.appendChild(supportBtn)

    right.appendChild(renderBell())

    // Avatar opens a compact menu for account actions so the HUD stays one balance + face.
    const menuWrap = el('div', 'profile-menu')
    const chip = el('button', 'user-chip user-chip-btn') as HTMLButtonElement
    chip.type = 'button'
    chip.setAttribute('aria-haspopup', 'menu')
    chip.setAttribute('aria-expanded', 'false')
    chip.title = currentUser.username
    const badge = el('span', 'profile-badge')
    badge.innerHTML = profileBadgeFrameSvg()
    badge.appendChild(createAvatarBadge({ name: currentUser.username, isBot: false }))
    const conn = el('span', connected ? 'chip-ok' : 'chip-bad', connected ? 'online' : 'reconnecting…')
    conn.id = 'conn-chip'
    conn.setAttribute('role', 'status')
    badge.appendChild(conn)
    chip.appendChild(badge)
    const name = el('span', 'user-name')
    name.appendChild(el('strong', undefined, currentUser.username))
    chip.appendChild(name)

    const dropdown = el('div', 'profile-menu-panel')
    dropdown.setAttribute('role', 'menu')
    dropdown.hidden = true

    const logout = el('button', 'profile-menu-item', 'Logout') as HTMLButtonElement
    logout.type = 'button'
    logout.setAttribute('role', 'menuitem')
    logout.onclick = () => void signOut()
    dropdown.appendChild(logout)

    chip.onclick = (e) => {
      e.stopPropagation()
      const open = dropdown.hidden
      dropdown.hidden = !open
      chip.setAttribute('aria-expanded', String(open))
      if (open) {
        const onDoc = (): void => {
          dropdown.hidden = true
          chip.setAttribute('aria-expanded', 'false')
          document.removeEventListener('click', onDoc)
        }
        Promise.resolve().then(() => document.addEventListener('click', onDoc))
      }
    }

    menuWrap.append(chip, dropdown)
    right.appendChild(menuWrap)
  }
  head.appendChild(right)
  return head
}

/** What each view is called out loud, for the button's own label. */
const CAMERA_VIEW_NAMES: Record<PlayerCameraMode, string> = {
  AIM: 'cue ball',
  BROADCAST: 'broadcast',
  SIDE: 'side',
  CLOSE: 'close-up',
  TOP_DOWN: 'overhead'
}

/**
 * The mark each view draws inside the lens ring.
 *
 * All five at the same 1.3 stroke weight, all taking their colour from `currentColor` so
 * they inherit whatever the glass button is currently wearing:
 *
 *  - AIM is a camera seen from the side — body, lens, and the little viewfinder bump on
 *    top — because that is the view you are in when you are lining a shot up.
 *  - BROADCAST is a screen on a stand: the wide shot the venue is covered from.
 *  - SIDE is a camera in profile on its tripod, which is the camera beside the table.
 *  - CLOSE is a focus reticle, which is what a close camera does: frames one thing tight.
 *  - TOP_DOWN is the table's own footprint with a ball sitting on it.
 */
const CAMERA_DIAGRAMS: Record<PlayerCameraMode, (ink: string) => string> = {
  AIM: (ink) =>
    '<path d="M8.1 7.3V6.1a0.8 0.8 0 0 1 0.8-0.8h2.2a0.8 0.8 0 0 1 0.8 0.8v1.2" fill="none" stroke="' +
    ink +
    '" stroke-width="1.3" stroke-linejoin="round"/>' +
    '<rect x="4.4" y="7.3" width="11.2" height="7.3" rx="1.6" fill="none" stroke="' +
    ink +
    '" stroke-width="1.3"/>' +
    '<circle cx="10" cy="10.95" r="2.25" fill="none" stroke="' +
    ink +
    '" stroke-width="1.3"/>',
  BROADCAST: (ink) =>
    '<rect x="3.6" y="5.2" width="12.8" height="7.8" rx="1.5" fill="none" stroke="' +
    ink +
    '" stroke-width="1.3"/>' +
    '<path d="M8.6 7.6v3.2l2.9-1.6z" fill="' +
    ink +
    '"/>' +
    '<path d="M10 13v2.3" stroke="' +
    ink +
    '" stroke-width="1.3"/>' +
    '<path d="M7.4 15.9h5.2" stroke="' +
    ink +
    '" stroke-width="1.3" stroke-linecap="round"/>',
  SIDE: (ink) =>
    '<rect x="4.4" y="7.4" width="8.4" height="5.6" rx="1.6" fill="none" stroke="' +
    ink +
    '" stroke-width="1.3"/>' +
    '<path d="M12.8 8.9l3-1.4v6.4l-3-1.4" fill="none" stroke="' +
    ink +
    '" stroke-width="1.3" stroke-linejoin="round"/>' +
    '<path d="M8.6 13v2.6" stroke="' +
    ink +
    '" stroke-width="1.3"/>' +
    '<path d="M6.4 16.3l2.2-2.9 2.2 2.9" fill="none" stroke="' +
    ink +
    '" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  CLOSE: (ink) =>
    '<path d="M5.2 7.7V6.2a1 1 0 0 1 1-1h1.6M14.8 7.7V6.2a1 1 0 0 0-1-1h-1.6M5.2 12.3v1.5a1 1 0 0 0 1 1h1.6M14.8 12.3v1.5a1 1 0 0 1-1 1h-1.6" fill="none" stroke="' +
    ink +
    '" stroke-width="1.3" stroke-linecap="round"/>' +
    '<circle cx="10" cy="10" r="2.1" fill="' +
    ink +
    '"/>',
  TOP_DOWN: (ink) =>
    '<rect x="4.1" y="6.2" width="11.8" height="7.6" rx="1.5" fill="none" stroke="' +
    ink +
    '" stroke-width="1.3"/>' +
    '<path d="M10 6.2v7.6" stroke="' +
    ink +
    '" stroke-width="1.3"/>' +
    '<circle cx="7" cy="9.4" r="1.4" fill="' +
    ink +
    '"/>'
}

/**
 * The view toggle's glyph, and which view it is right now.
 *
 * The mark always describes the mode you are currently looking at, not the one the button
 * would switch to: there are more views than a two-state button could carry, so what the
 * button says is "where you are", and pressing it walks on to the next one.
 */
function cameraSvg(mode: PlayerCameraMode): string {
  const ink = 'currentColor'
  const diagram = CAMERA_DIAGRAMS[mode](ink)
  return (
    '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">' +
    '<circle cx="10" cy="10" r="8.4" fill="none" stroke="' +
    ink +
    '" stroke-width="1.3"/>' +
    diagram +
    '</svg>'
  )
}

/**
 * The view toggle: cue ball, broadcast, side, close-up, overhead — and round again.
 *
 * Built as one of the HUD's own round glass buttons rather than as the loose circle it
 * used to be, and mounted by the caller directly under Leave: the two controls a player
 * reaches for between shots sit together in the corner, drawn in the same material as
 * everything else on the edge of the screen.
 *
 * It is not a dead control. It walks the scene through the five views, it is disabled
 * while the balls are moving or a placement is in flight (see the render loop), and the
 * render loop hides it outright when the 2D fallback renderer is drawing, because then
 * there is only one view.
 */
function buildCameraToggle(): HTMLButtonElement {
  const btn = el('button', 'hud-tool hud-glass hud-tool--camera') as HTMLButtonElement
  btn.type = 'button'
  btn.onclick = () => {
    const index = PLAYER_CAMERA_MODES.indexOf(cameraMode)
    const next = PLAYER_CAMERA_MODES[(index + 1) % PLAYER_CAMERA_MODES.length]
    setCameraMode(next ?? 'AIM')
  }
  // Publish the element before asking it to paint itself. `setCameraMode` writes the glyph
  // through `cameraToggleEl` and returns early when that is still null, so setting it after
  // this call left the button built but empty until the player's first click.
  cameraToggleEl = btn
  setCameraMode(cameraMode)
  return btn
}

function setCameraMode(mode: PlayerCameraMode): void {
  cameraMode = mode
  const btn = cameraToggleEl
  if (!btn) return
  btn.innerHTML = cameraSvg(mode)
  // The view's own name in the label, and the state on the element as `data-mode`: five
  // marks pass through this button, so the glyph cannot be what says which one it is on
  // focus, and "pressed" would be a lie about four of the five.
  const name = CAMERA_VIEW_NAMES[mode]
  btn.title = `Camera view: ${name}`
  btn.setAttribute('aria-label', `Camera view: ${name}`)
  btn.setAttribute('data-mode', mode)
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

/** Staff announcements on show; any not yet seen are shown once the lobby is up. */
async function fetchAnnouncements(): Promise<void> {
  const userId = currentUser?.id
  if (!userId) return
  try {
    setAnnouncements(userId, await api<Announcement[]>('/announcements'))
    if (!activeMatchId) showNextAnnouncement()
  } catch {
    // Not worth troubling the player about: they will be fetched on the next open.
  }
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
  usdt: number
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
  // Patch the chip in place rather than waiting for the next render. During a match
  // the balance moves as stakes lock and settle, and the header is not re-rendered
  // for every state update, so without this the number on screen goes stale.
  const amount = document.querySelector<HTMLElement>('#wallet-chip .wallet-amount')
  if (amount) amount.textContent = formatCash(wallet.balance)
  // The lobby's own balance readouts: under the name on a phone, the wallet pill on a desktop.
  for (const node of document.querySelectorAll<HTMLElement>('.cx-profile__balance, .cx-wallet__value')) {
    fillBalance(node, formatCash(wallet.balance))
  }
  for (const node of document.querySelectorAll<HTMLElement>('.gl-profile__wallet')) {
    node.textContent = formatCash(wallet.balance)
  }
}

async function loadTiers(): Promise<void> {
  try {
    tiers = await api<TierData[]>('/matches/tiers')
  } catch {
    tiers = STAKE_TIERS.map((t) => ({ id: t.id, usdt: t.usdt, label: t.label }))
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
  stopOpponentCountdown()
  // The chat chrome belongs to the match being torn down; dropping the references
  // keeps a stray incoming line from appending to a detached element.
  chatMenuEl = null
  chatLogEl = null
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

/**
 * The foul's headline names who the points go to. A foul never costs the striker
 * anything: its value is added to the other player's score, so "-4" read as points
 * lost by the player who fouled, which is not what happens.
 */
function foulHeadline(penalty: number, bySeat: number | undefined): string {
  const receiver = bySeat === undefined ? 'opponent' : seatName(1 - bySeat)
  return `FOUL \u2022 +${penalty} TO ${receiver.toUpperCase()}`
}

/** The rules engine's short reason, said the way a referee would say it. */
const FOUL_REASON_TEXT: Record<string, string> = {
  'cue ball potted': 'Cue ball went into a pocket',
  'no legal contact': 'Cue ball missed every ball',
  'wrong ball first': 'Hit the wrong ball first',
  'wrong ball potted': 'Potted a ball that was not on',
  'turn timeout': 'Shot clock ran out',
  foul: 'Foul stroke'
}

/** Why it was a foul, and why it is worth what it is: 4 at least, more for a higher ball. */
function foulDetail(reason: string | undefined): string {
  const known = reason ? FOUL_REASON_TEXT[reason] : undefined
  const text = known ?? (reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : 'Foul stroke')
  return `${text} \u00b7 penalty is 4, or the highest ball involved`
}

function seatName(seat: number | undefined): string {
  if (seat === undefined) return 'A player'
  return seat === mySeat ? 'You' : opponentName()
}

/**
 * Quick chat: the client sends a phrase id, the server relays it to the room, and
 * every client renders the shared text for that id. Nothing the user types ever
 * exists, so there is no free-text input to police on either side.
 */
function sendChatPhrase(phraseId: string): void {
  if (!activeMatchId || activeMatchIsPractice) return
  getSocket().emit('match:chat', { matchId: activeMatchId, phraseId })
}

function appendMatchChat(sender: string, text: string): void {
  const target = chatLogEl
  if (!target) return
  // The log stays out of the way until there is something to read, then appears
  // and keeps only the most recent lines.
  target.hidden = false
  const msg = el('div', 'match-chat-msg')
  msg.append(el('span', 'match-chat-msg__who', sender), el('span', 'match-chat-msg__text', text))
  target.appendChild(msg)
  while (target.children.length > MATCH_CHAT_MAX_LOG) target.removeChild(target.firstChild!)
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
  hudFrame = frameForHud({ replayRunning: shotPlayer !== null || predictedShot !== null, shown: hudFrame, authoritative: frame })
  hud.update(
    deriveHudState({
      snapshot: hudFrame,
      you: { name: currentUser?.username ?? 'You', isBot: false },
      // The robot gets the same face as the lobby's robot card rather than the letter
      // fallback: a practice opponent you can pick out of the corner of your eye is the
      // whole point of an avatar on a pill this small.
      opponent: {
        name: opponentName(),
        isBot: activeMatchIsPractice,
        avatarUrl: activeMatchIsPractice ? '/bot.png' : null
      },
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

/**
 * When the opponent's connection drops, the room gives them a short time to come back
 * before the match is awarded to the player still here. The banner counts it down, so
 * nobody is left wondering whether the game is stuck.
 */
let opponentReturnBy: number | null = null
let opponentCountdownTimer: number | null = null

function stopOpponentCountdown(): void {
  opponentReturnBy = null
  if (opponentCountdownTimer !== null) window.clearInterval(opponentCountdownTimer)
  opponentCountdownTimer = null
}

function startOpponentCountdown(seconds: number): void {
  stopOpponentCountdown()
  opponentReturnBy = Date.now() + Math.max(1, seconds) * 1000
  opponentCountdownTimer = window.setInterval(updateOpponentGone, 250)
  updateOpponentGone()
}

function updateOpponentGone(): void {
  const holder = document.getElementById('opp-holder')
  holder?.replaceChildren()
  if (!opponentGone || activeMatchIsPractice) return
  if (opponentReturnBy !== null) {
    const left = Math.max(0, Math.ceil((opponentReturnBy - Date.now()) / 1000))
    const banner = el('div', 'opp-gone opp-gone--countdown')
    banner.setAttribute('role', 'status')
    banner.append(
      el('span', 'opp-gone__title', 'Opponent left the match'),
      el('span', 'opp-gone__count', String(left)),
      el('span', 'opp-gone__note', left > 0 ? 'seconds to come back, or you win' : 'Awarding the match to you...')
    )
    holder?.appendChild(banner)
  } else {
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

/** The colours the win screen's confetti is cut from: gold, the table's green, red and white. */
const END_CONFETTI_COLOURS = ['#f3c75a', '#ffe08a', '#2fbf5b', '#e8344e', '#ffffff', '#5fa8ff']
/** How many pieces of confetti, and how many of them are coins. */
const END_CONFETTI_PIECES = 26
const END_CONFETTI_COINS = 8

/** Confetti and gold coins falling through the win screen, each with its own path and pace. */
function endConfetti(): HTMLElement {
  const layer = el('div', 'end-confetti')
  layer.setAttribute('aria-hidden', 'true')
  for (let i = 0; i < END_CONFETTI_PIECES; i++) {
    const piece = document.createElement('i')
    if (i < END_CONFETTI_COINS) piece.className = 'is-coin'
    else piece.style.background = END_CONFETTI_COLOURS[i % END_CONFETTI_COLOURS.length]!
    piece.style.left = `${(Math.random() * 96 + 2).toFixed(1)}%`
    piece.style.setProperty('--delay', `${(Math.random() * 2.4).toFixed(2)}s`)
    piece.style.setProperty('--dur', `${(2.2 + Math.random() * 1.6).toFixed(2)}s`)
    piece.style.setProperty('--drift', `${Math.round((Math.random() - 0.5) * 120)}px`)
    piece.style.setProperty('--spin', `${Math.round(360 + Math.random() * 540) * (Math.random() < 0.5 ? -1 : 1)}deg`)
    layer.appendChild(piece)
  }
  return layer
}

/** Counts a number up from nought to `to` on screen, easing out, after the card has landed. */
function countUp(node: HTMLElement, to: number, delayMs = 550, durationMs = 900): void {
  const target = Math.max(0, Math.round(to))
  let reduce = false
  try {
    reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    // No media queries: count anyway.
  }
  if (reduce || target === 0) {
    node.textContent = String(target)
    return
  }
  const start = performance.now() + delayMs
  const tick = (now: number): void => {
    if (!node.isConnected && now > start) return
    const t = Math.min(1, Math.max(0, (now - start) / durationMs))
    const eased = 1 - Math.pow(1 - t, 3)
    node.textContent = String(Math.round(target * eased))
    if (t < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
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

/**
 * The challenge layer.
 *
 * A pending invitation (somebody else's table) and a waiting table (mine) are
 * global states, not screens, so this layer is appended to the body and floats
 * above whatever the app is showing. Only one card is ever up: my own waiting
 * table takes precedence over an invitation I have not answered, because I cannot
 * accept someone else's table while mine is already on the board.
 */
function renderChallengeLayer(): void {
  if (!challengeLayerEl) {
    challengeLayerEl = el('div', 'challenge-layer')
    challengeLayerEl.id = 'challenge-layer'
    document.body.appendChild(challengeLayerEl)
  }
  challengeLayerEl.replaceChildren()
  // Mid-match the table owns the screen; invitations wait until we are back.
  if (activeMatchId) {
    challengeLayerEl.classList.remove('open')
    return
  }
  if (pendingChallenge) {
    challengeLayerEl.appendChild(findingOverlay(pendingChallenge))
    challengeLayerEl.classList.add('open')
    return
  }
  const next = incomingChallenges[0]
  if (!next) {
    challengeLayerEl.classList.remove('open')
    return
  }
  challengeLayerEl.appendChild(challengePopup(next))
  challengeLayerEl.classList.add('open')
}

function challengeMeta(challenge: ChallengeDto): string {
  const master = challenge.table === 'MASTER' || challenge.stakeTier.startsWith('MASTER_')
  return `${master ? 'Master · ' : ''}${challenge.stakeLabel} · ${challenge.format}`
}

function findingOverlay(challenge: ChallengeDto): HTMLElement {
  const overlay = el('div', 'challenge-overlay')
  const card = el('div', 'challenge-card')
  card.appendChild(el('div', 'challenge-card__eyebrow', 'FINDING AN OPPONENT'))
  card.appendChild(
    el(
      'div',
      'challenge-card__title',
      challenge.kind === 'FRIEND' && challenge.targetUsername
        ? `Invited ${challenge.targetUsername}`
        : 'Waiting for a player to join'
    )
  )
  card.appendChild(el('div', 'challenge-card__meta', challengeMeta(challenge)))
  card.appendChild(el('div', 'challenge-card__spinner'))
  card.appendChild(
    el(
      'p',
      'challenge-card__note',
      challenge.kind === 'FRIEND'
        ? 'Your friend has been invited. This table expires shortly.'
        : 'Everyone online can see this table. It expires shortly.'
    )
  )
  const cancel = el('button', 'challenge-btn challenge-btn--ghost', 'Cancel') as HTMLButtonElement
  cancel.type = 'button'
  cancel.disabled = challengeBusy
  cancel.onclick = () => void cancelPendingChallenge()
  card.appendChild(cancel)
  overlay.appendChild(card)
  return overlay
}

function challengePopup(challenge: ChallengeDto): HTMLElement {
  const overlay = el('div', 'challenge-overlay')
  const card = el('div', 'challenge-card')
  const isRematch = challenge.rematch === true
  card.appendChild(
    el(
      'div',
      'challenge-card__eyebrow',
      isRematch ? 'REMATCH' : challenge.table === 'MASTER' ? 'MASTER MATCH' : challenge.kind === 'FRIEND' ? 'FRIEND INVITE' : 'OPEN TABLE'
    )
  )
  card.appendChild(
    el('div', 'challenge-card__title', isRematch ? `${challenge.challengerUsername} wants a rematch` : `${challenge.challengerUsername} wants to play`)
  )
  card.appendChild(el('div', 'challenge-card__meta', challengeMeta(challenge)))
  card.appendChild(
    el('p', 'challenge-card__note', `Both players stake ${challenge.stakeLabel}; the winner takes the pool.`)
  )
  const row = el('div', 'challenge-card__row')
  const decline = el(
    'button',
    'challenge-btn challenge-btn--ghost',
    challenge.kind === 'FRIEND' ? 'Decline' : 'Not now'
  ) as HTMLButtonElement
  decline.type = 'button'
  decline.disabled = challengeBusy
  decline.onclick = () => void declineChallenge(challenge)
  const accept = el('button', 'challenge-btn challenge-btn--primary', 'Accept') as HTMLButtonElement
  accept.type = 'button'
  accept.disabled = challengeBusy
  accept.onclick = () => {
    requestLandscape()
    void acceptChallenge(challenge)
  }
  row.append(decline, accept)
  card.appendChild(row)
  overlay.appendChild(card)
  return overlay
}

function removeIncomingChallenge(id: string): void {
  incomingChallenges = incomingChallenges.filter((challenge) => challenge.id !== id)
}

function upsertIncomingChallenge(challenge: ChallengeDto): void {
  if (incomingChallenges.some((existing) => existing.id === challenge.id)) return
  incomingChallenges = [...incomingChallenges, challenge]
}

async function fetchIncomingChallenges(): Promise<void> {
  if (!currentUser) return
  try {
    const data = await api<ChallengeDto[]>('/challenges/incoming')
    incomingChallenges = data
    renderChallengeLayer()
  } catch {
    // Best-effort: a missed refresh only means a popup waits for the next event.
  }
}

async function acceptChallenge(challenge: ChallengeDto): Promise<void> {
  if (challengeBusy) return
  challengeBusy = true
  renderChallengeLayer()
  try {
    const data = await api<{ matchId: string }>(`/challenges/${challenge.id}/accept`, { method: 'POST', body: {} })
    removeIncomingChallenge(challenge.id)
    await preloadTableModel()
    enterMatch(data.matchId, false)
  } catch (error) {
    toast((error as Error).message, 'error')
    removeIncomingChallenge(challenge.id)
  } finally {
    challengeBusy = false
    renderChallengeLayer()
  }
}

async function declineChallenge(challenge: ChallengeDto): Promise<void> {
  if (challengeBusy) return
  // A public table is dismissed locally: one player's "not now" must not close it
  // for everybody else. Only a friend invite is declined on the server.
  if (challenge.kind !== 'FRIEND') {
    removeIncomingChallenge(challenge.id)
    renderChallengeLayer()
    return
  }
  challengeBusy = true
  renderChallengeLayer()
  try {
    await api(`/challenges/${challenge.id}/decline`, { method: 'POST', body: {} })
  } catch (error) {
    toast((error as Error).message, 'error')
  } finally {
    challengeBusy = false
    removeIncomingChallenge(challenge.id)
    renderChallengeLayer()
  }
}

async function cancelPendingChallenge(): Promise<void> {
  const challenge = pendingChallenge
  if (!challenge || challengeBusy) return
  challengeBusy = true
  renderChallengeLayer()
  try {
    await api(`/challenges/${challenge.id}/cancel`, { method: 'POST', body: {} })
  } catch (error) {
    toast((error as Error).message, 'error')
  } finally {
    challengeBusy = false
    pendingChallenge = null
    renderChallengeLayer()
  }
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
    // The session is over: back to the home screen rather than to a setup screen
    // offering to start another one the player did not ask for.
    activeScreen = 'home'
    render()
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

function leaveToLobby(): void {
  removeFoulChoiceUi()
  leaveGameState()
  clearTournamentTimer()
  removeOverlay()
  // Home is where every exit from a match lands, whichever screen the match was
  // entered from. A tournament match keeps activeTournamentId set, so render still
  // prefers the bracket over the home screen for that one case.
  activeScreen = 'home'
  render()
  // Invitations that arrived mid-match were withheld; collect the live ones now.
  void fetchIncomingChallenges()
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
    activeScreen = 'home'
    render()
    return
  }
  let data: TournamentData
  try {
    data = await api<TournamentData>(`/tournaments/${activeTournamentId}`)
  } catch (error) {
    wrap.appendChild(el('div', 'muted', (error as Error).message))
    const back = el('button', undefined, 'Back to home')
    back.onclick = () => {
      activeTournamentId = null
      activeScreen = 'home'
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
  const backBtn = el('button', 'ghost', 'Back to home')
  backBtn.onclick = () => {
    activeTournamentId = null
    activeScreen = 'home'
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
    banner.appendChild(el('div', 'meta-line', mine?.status === 'CHAMPION' ? 'This is you — take a bow.' : 'Free tournament · all 8 players started even'))
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
  format: string
  stakeTier: string
  resultJson: { prize?: number } | null
  players: Array<{ id: string; userId: string; seat: number; user: { id: string; username: string } }>
} | null> {
  for (let i = 0; i < 12; i++) {
    try {
      const data = await api<{
        status: string
        format: string
        stakeTier: string
        resultJson: { prize?: number } | null
        players?: Array<{ id: string; userId: string; seat: number; user: { id: string; username: string } }>
      }>(`/matches/${matchId}`)
      if (data && data.status) {
        return { status: data.status, format: data.format, stakeTier: data.stakeTier, resultJson: data.resultJson, players: data.players ?? [] }
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return null
}

async function sendRematch(targetUsername: string, format: string, stakeTier: string): Promise<void> {
  // Drop the result card: the rematch invitation takes its place while it is open.
  removeOverlay()
  try {
    const challenge = await api<ChallengeDto>('/challenges', {
      method: 'POST',
      body: { stakeTier, format, targetUsername, rematch: true }
    })
    pendingChallenge = challenge
    renderChallengeLayer()
    toast(`Rematch invite sent to ${targetUsername}`)
  } catch (error) {
    toast((error as Error).message, 'error')
  }
}

/** How long to wait for a shot still on the table to finish before the match is called. */
const FINAL_SHOT_WAIT_MS = 20_000

/** Resolves when no shot is being replayed and none is waiting, or when the wait runs out. */
function tableSettled(): Promise<void> {
  return new Promise((resolve) => {
    const started = performance.now()
    const check = (): void => {
      if ((shotPlayer === null && predictedShot === null && queuedUpdates.length === 0) || performance.now() - started > FINAL_SHOT_WAIT_MS) resolve()
      else window.setTimeout(check, 100)
    }
    check()
  })
}

/**
 * Shows the shot that ended the match once more, slowed down, before the result.
 *
 * A picture only. The recording of the last shot is played back through the same table
 * and the same cameras the first time used, from the positions it started from, and when
 * it is done the table goes back to where the match left it. Nothing is sent to the
 * server and nothing about the match is read from it: the match is already over and its
 * result is already known by the time this starts.
 */
function playFinalShotRecap(): Promise<void> {
  // A highlight still on the table gives way to the match's last shot, at once: its own
  // sweep out would land in the middle of this one.
  skipHighlight?.()
  const recap = lastShotRecap
  if (!recap || !scene3d || !frame) return Promise.resolve()
  return new Promise((resolve) => {
    let finished = false
    const clear = (): void => {
      recapPlayer = null
      recapDone = null
      scene3d?.planShotCamera(null)
      scene3d?.setRecapCamera(false)
    }
    const done = (): void => {
      if (finished) return
      finished = true
      // Out of the replay the way it came in: the bars sweep across and the table is
      // handed back underneath them. The result waits for the sweep.
      playRecapWipe(() => {
        clear()
        resolve()
      })
    }
    recapDone = done
    // Into the replay under a sweep of bars, with no words: the cut says it is a replay.
    playRecapWipe(() => {
      if (finished) return
      recapStart = recap.start.map((ball) => ({ ...ball }))
      recapPlayer = new ShotPlayer(recap.playback, recap.start.map((ball) => ({ ...ball })))
      recapHold = FINAL_SHOT_HOLD_SECONDS
      scene3d?.planShotCamera(recap.playback, true)
      scene3d?.setRecapCamera(true)
    })
    // Whatever happens to the picture, the result is never held up for long.
    window.setTimeout(done, FINAL_SHOT_WAIT_MS)
  })
}

/**
 * Shows a hard pot once more, slowed down, the moment its replay has finished.
 *
 * The same picture-only player the final-shot recap uses: the recording is played back
 * from the positions it started from, the table goes back to where the shot left it,
 * and only then is the shot reported done, which is what starts the next turn's clock.
 * A tap anywhere skips it, and it never holds the table for long.
 */
function playHighlight(entry: { highlight: Highlight; playback: ShotPlayback; start: PlaybackBall[] }): void {
  if (!scene3d || !frame) {
    finishShot()
    return
  }
  let finished = false
  const matchAtStart = activeMatchId
  const skip = (event: Event): void => {
    // The tap that skips is not also the start of an aim. Off the table (the player has
    // left the match) the tap is left alone and only clears the highlight away.
    if (activeMatchId === matchAtStart) {
      event.preventDefault()
      event.stopPropagation()
    }
    done()
  }
  /** Takes the replay off the table and reports the shot done (to its own match only). */
  const clear = (): void => {
    recapPlayer = null
    recapDone = null
    scene3d?.planShotCamera(null)
    scene3d?.setRecapCamera(false)
    if (activeMatchId === matchAtStart) finishShot()
  }
  /**
   * Ends the highlight. Normally under a sweep of bars, the way it began; `now` clears it on
   * the spot, for a new shot arriving or a new match starting, which cannot wait for one.
   */
  const done = (now = false): void => {
    if (finished) return
    finished = true
    window.clearTimeout(backstop)
    document.removeEventListener('pointerdown', skip, true)
    skipHighlight = null
    if (now) clear()
    else playRecapWipe(clear)
  }
  recapDone = () => done()
  skipHighlight = () => done(true)
  document.addEventListener('pointerdown', skip, true)
  const backstop = window.setTimeout(() => done(), HIGHLIGHT_MAX_MS)
  // Into the replay under a sweep of bars, with no words or banners: the cut itself says
  // this is a replay. The table changes to the shot's first frame while it is covered.
  playRecapWipe(() => {
    if (finished) return
    recapStart = entry.start.map((ball) => ({ ...ball }))
    recapPlayer = new ShotPlayer(entry.playback, entry.start.map((ball) => ({ ...ball })))
    recapHold = HIGHLIGHT_HOLD_SECONDS
    scene3d?.planShotCamera(entry.playback, true)
    scene3d?.setRecapCamera(true)
  })
}

async function finishMatch(winnerSeat: number, reason?: string): Promise<void> {
  const matchId = activeMatchId
  const meta = activeMatchId ? await fetchMatchOutcome(activeMatchId) : null
  // The shot that ended it is watched to the end, and then once more, before the result
  // goes up over the table. A match that was conceded has no such shot.
  await tableSettled()
  if (reason !== 'concede') await playFinalShotRecap()
  // The player may have left while all that was going on.
  if (activeMatchId !== matchId) return

  const iWon = mySeat !== undefined && winnerSeat === mySeat
  const watching = mySeat === undefined
  const myName = currentUser?.username ?? 'You'
  const theirName = activeMatchIsPractice
    ? 'Robot'
    : (meta?.players.find((p) => p.seat !== mySeat)?.user.username ?? opponentName())
  const winnerName = activeMatchIsPractice
    ? iWon
      ? myName
      : 'Robot'
    : (meta?.players.find((p) => p.seat === winnerSeat)?.user.username ?? `Seat ${winnerSeat}`)

  const box = el('div', `card end-screen ${watching ? 'is-neutral' : iWon ? 'is-win' : 'is-loss'}`)
  // Light turning slowly behind the trophy, and for a win, confetti and coins falling.
  const rays = el('div', 'end-rays')
  rays.setAttribute('aria-hidden', 'true')
  box.appendChild(rays)
  if (iWon && !watching) box.appendChild(endConfetti())
  const emblem = el('div', 'end-emblem')
  emblem.setAttribute('aria-hidden', 'true')
  emblem.innerHTML = END_TROPHY_SVG
  box.appendChild(emblem)
  box.appendChild(el('div', 'end-title', watching ? 'MATCH OVER' : iWon ? 'YOU WIN' : 'YOU LOSE'))
  box.appendChild(
    el(
      'div',
      'end-sub',
      reason === 'concede'
        ? `${winnerName} wins by concession`
        : reason === 'abandon'
          ? `${winnerName} wins: the opponent left the match`
          : `${winnerName} wins the match`
    )
  )

  // The last frame's points, mine on the left. The snapshot still holds them: the match
  // ending does not clear the table.
  const scores = frame?.scores
  if (scores && !watching) {
    const mine = mySeat === 0 ? scores.player0 : scores.player1
    const theirs = mySeat === 0 ? scores.player1 : scores.player0
    const board = el('div', 'end-score')
    const side = (name: string, points: number, won: boolean): HTMLElement => {
      const cell = el('div', `end-side${won ? ' is-winner' : ''}`)
      cell.appendChild(el('span', 'end-side-name', name))
      const value = el('span', 'end-side-points', '0')
      cell.appendChild(value)
      countUp(value, points)
      return cell
    }
    board.appendChild(side(myName, mine, iWon))
    board.appendChild(el('span', 'end-score-dash', '\u2013'))
    board.appendChild(side(theirName, theirs, !iWon))
    box.appendChild(board)
    const margin = Math.abs(mine - theirs)
    if (margin > 0) {
      box.appendChild(el('div', 'end-margin', `${iWon ? 'Won' : 'Lost'} the final frame by ${margin} point${margin === 1 ? '' : 's'}`))
    }
  }

  if (activeMatchIsPractice) {
    box.appendChild(el('div', 'muted', 'Practice session \u2014 free play'))
  } else {
    box.appendChild(el('div', 'end-frames', `Frames ${framesWon[0]} \u2013 ${framesWon[1]}`))
    const prize = meta?.resultJson?.prize
    if (typeof prize === 'number' && prize > 0) {
      box.appendChild(el('div', 'end-prize', `Winner receives ${formatCash(prize)}`))
    } else {
      box.appendChild(el('div', 'muted', 'Settlement pending\u2026'))
    }
  }

  const actions = el('div', 'end-actions')
  // A settled one-vs-one (never practice, never a tournament leg) can be played
  // straight back: the button opens a targeted invite to the same opponent at the
  // same stake and format, which they accept like any other table.
  if (!activeMatchIsPractice && !activeTournamentId) {
    const opponent = meta?.players.find((p) => p.seat !== mySeat)?.user.username ?? null
    const format = meta?.format
    const stakeTier = meta?.stakeTier
    if (opponent && format && stakeTier) {
      const rematchBtn = el('button', 'ghost', 'Rematch') as HTMLButtonElement
      rematchBtn.type = 'button'
      rematchBtn.onclick = () => void sendRematch(opponent, format, stakeTier)
      actions.appendChild(rematchBtn)
    }
  }
  if (!watching) box.appendChild(endScreenXp(xpForMatch({ won: iWon, practice: activeMatchIsPractice, reason })))

  const backBtn = el('button', undefined, activeTournamentId ? 'Back to tournament' : 'Back to home')
  backBtn.onclick = () => leaveToLobby()
  actions.appendChild(backBtn)
  box.appendChild(actions)
  showOverlay(box)
}

async function fetchProgress(): Promise<LobbyProgress | null> {
  try {
    const progress = await api<LobbyProgress>('/progress/me')
    lastKnownTotalXp = progress.totalXp
    return progress
  } catch {
    return null
  }
}

/**
 * "+50 XP" and the level bar on the result card. The gain is the shared rule applied
 * to what the client saw; the bar is the server's, read once the settlement has landed
 * (it can trail the match:end message by a moment, so the read is retried briefly).
 */
function endScreenXp(gain: number): HTMLElement {
  const wrap = el('div', 'end-xp')
  const row = el('div', 'end-xp__row')
  const level = el('span', undefined, '')
  row.append(el('span', 'end-xp__gain', `+${gain} XP`), level)
  const bar = xpBar(0)
  wrap.append(row, bar)
  const before = lastKnownTotalXp
  void (async () => {
    let progress: LobbyProgress | null = null
    for (let attempt = 0; attempt < 4; attempt++) {
      progress = await fetchProgress()
      if (!progress || before === null || gain === 0 || progress.totalXp >= before + gain) break
      await new Promise((resolve) => setTimeout(resolve, 700))
    }
    if (!progress || !wrap.isConnected) return
    level.textContent = `Level ${progress.level} · ${progress.rank.name}`
    level.style.color = progress.rank.color
    bar.replaceWith(xpBar(progress.percent))
  })()
  return wrap
}

/**
 * Draws whichever screen the player is on.
 *
 * A match and a tournament bracket are states rather than screens, so they are checked
 * first: you leave a screen to go and play and you come back to it. The full-height
 * shells are decided from the same list, because a screen that is one viewport tall has
 * to be told so before its first child is measured, not after.
 */
function render(): void {
  // The lobby owns document-level listeners, so it is torn down before the page is cleared.
  lobbySession?.destroy()
  lobbySession = null
  app.innerHTML = ''
  hud = null
  document.body.classList.remove('game-mode', 'home-mode', 'practice-mode', 'tour-mode')
  // Out of a match the phone may be held upright again: the lobby is laid out for it.
  if (!activeMatchId) releaseLandscape()
  // The tournaments list and a tournament's bracket are dressed as the tournament hall.
  // A class on the page and nothing else: the screens and what they do are unchanged.
  if (!activeMatchId && (activeTournamentId || activeScreen === 'tournaments')) document.body.classList.add('tour-mode')

  const shell = activeMatchId ? 'app-game' : activeScreen === 'home' ? 'app-home' : activeScreen === 'practice' ? 'app-practice' : null
  app.className = shell ? `app-root ${shell}` : 'app-root'
  if (shell === 'app-home') document.body.classList.add('home-mode')
  if (shell === 'app-practice') document.body.classList.add('practice-mode')

  if (!currentUser && checkingSession) {
    app.className = 'app-root'
    document.body.classList.remove('home-mode', 'practice-mode')
    app.appendChild(bootScreen())
  } else if (!currentUser) {
    // The auth screen centres itself on the viewport, so the transition is applied to
    // the card rather than to a wrapper — the wrapper would be a full-height block
    // and the animation would be invisible behind the card's own entrance.
    app.className = 'app-root'
    document.body.classList.remove('home-mode', 'practice-mode')
    app.appendChild(header())
    renderAuthScreen(app, app, toast)
  } else if (activeMatchId) {
    // No page transition here: the game fits itself to the space the header and HUD
    // leave (applyCanvasSize), and a transformed ancestor would make that measurement
    // wrong for the duration of the animation.
    renderGame()
  } else if (activeTournamentId) {
    app.appendChild(header())
    void renderTournament()
  } else if (USE_NEW_LOBBY && activeScreen !== 'tournaments') {
    // New gaming lobby UI (presentation only). Flip USE_NEW_LOBBY in lobby/flag.ts to restore the old lobby.
    // `tournaments` is the exception: its tile hands back to the existing screen below,
    // which is the same one the old lobby's Tournament card has always opened.
    app.className = 'app-root app-home'
    lobbySession = mountGamingLobby(app, createLobbyBridge())
  } else if (activeScreen === 'home') {
    app.appendChild(header({ home: true }))
    renderHome()
  } else if (activeScreen === 'practice') {
    app.appendChild(header())
    renderPracticeSetup()
  } else {
    app.appendChild(header())
    void renderScreen(activeScreen)
  }

  // The challenge layer floats above whichever screen was just built (or hides
  // itself during a match), so it is rebuilt last, against the fresh state.
  renderChallengeLayer()
  // Back in the lobby: anything announced during the match is shown now.
  if (currentUser && !activeMatchId) showNextAnnouncement()
}

/** The loading card shown while a saved sign-in is checked at start-up. */
function bootScreen(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'boot-screen'
  wrap.setAttribute('role', 'status')
  wrap.setAttribute('aria-live', 'polite')
  const title = document.createElement('div')
  title.className = 'boot-screen__title'
  title.textContent = APP_TITLE
  const spinner = document.createElement('div')
  spinner.className = 'challenge-card__spinner'
  const note = document.createElement('div')
  note.className = 'boot-screen__note'
  note.textContent = 'Signing you in...'
  wrap.append(title, spinner, note)
  return wrap
}

/**
 * Ends the player's session everywhere: the stored token, the server's cookie (or the
 * next load would sign straight back in from it), the socket, and every piece of
 * in-memory state that belonged to the signed-in player. The cookie is cleared before
 * the auth screen is drawn, so a fast reload cannot race it.
 */
async function signOut(): Promise<void> {
  resetAnnouncements()
  token = ''
  clearStoredToken()
  disconnectSocket()
  currentUser = null
  activeMatchId = null
  activeTournamentId = null
  activeScreen = 'home'
  pendingChallenge = null
  incomingChallenges = []
  clearTournamentTimer()
  leaveGameState()
  await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined)
  render()
}

/**
 * Read-only bridge from the new lobby views into existing main.ts handlers and state.
 * Does not change match start, audio, wallet, or API contracts — only exposes them.
 */
function createLobbyBridge(): LobbyBridge {
  const logoSvg =
    '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" fill="#c9a84c"/><circle cx="12" cy="12" r="7" fill="#0a0a0f"/><circle cx="9.5" cy="9.5" r="2.5" fill="#e8c872"/></svg>'
  return {
    appTitle: APP_TITLE,
    username: currentUser?.username ?? 'Player',
    userId: currentUser?.id ?? '',
    // Read live: the lobby is built before the wallet request comes back, and a copy
    // taken here would show the balance from before it did.
    get walletBalance() {
      return wallet.balance
    },
    logoSvg,
    formatCash,
    createAvatar: (name) => createAvatarBadge({ name, isBot: false }),
    getSoundMuted: () => isSoundMuted(),
    setSoundMuted: (muted) => setSoundMuted(muted),
    practiceDifficulty,
    setPracticeDifficulty: (level) => {
      practiceDifficulty = level
    },
    getStakeTiers: () => tiers.map((t) => ({ id: t.id, label: t.label, usdt: t.usdt })),
    getDefaultStakeTierId: () => activeTierId ?? tiers[0]?.id ?? null,
    refreshWallet: async () => {
      await Promise.all([refreshWallet(), loadTiers()])
    },
    fetchProfileStats: async () => {
      try {
        const profile = await api<MyProfile>('/me')
        return profile.stats
      } catch {
        return null
      }
    },
    fetchMatchHistory: async () => {
      try {
        return await api<HistoryMatch[]>('/matches/history')
      } catch {
        return []
      }
    },
    fetchProgress,
    startPractice: async (aiLevel) => {
      practiceDifficulty = aiLevel
      if (!USE_LOADING_SCREEN) {
        const data = await api<{ id: string }>('/practice/start', { method: 'POST', body: { aiLevel } })
        await preloadTableModel()
        enterMatch(data.id, true)
        return
      }
      await startPracticeWithLoadingScreen(aiLevel)
    },
    startOnlineChallenge: async (opts) => {
      // Opening a table is now a challenge: the server broadcasts it to every
      // connected player (or just the friend named), and the challenger waits on
      // the lobby's "finding an opponent" overlay. The match itself is only
      // created — and both stakes only frozen — when somebody accepts.
      const challenge = await api<ChallengeDto>('/challenges', {
        method: 'POST',
        body: {
          stakeTier: opts.stakeTier,
          format: opts.format as MatchFormat,
          targetUsername: opts.targetUsername
        }
      })
      pendingChallenge = challenge
      renderChallengeLayer()
    },
    toast: (message, kind) => toast(message, kind),
    onProfileActivate: () => {
      /* Settings tab is opened by the lobby shell; no separate profile route exists. */
    },
    openTournaments: () => {
      activeScreen = 'tournaments'
      render()
    },
    openSupport: () => openSupportChat(),
    signOut: () => void signOut()
  }
}

/**
 * The home screen.
 *
 * Deliberately synchronous and deliberately empty of requests. Every element here is
 * built from state the app already holds, so the screen is painted complete on the first
 * frame and nothing reflows when something arrives: no skeletons, no reserved heights
 * guessing at content, and no request that can fail halfway and leave a hole. The wallet
 * the tables screen will want is fetched in the background, after the screen is up.
 */
function renderHome(): void {
  void refreshWallet()

  const page = el('div', 'home-page page-enter')

  const title = el('div', 'home-title')
  title.appendChild(el('h1', 'home-wordmark', APP_TITLE))
  title.appendChild(el('div', 'home-tagline', 'Play online snooker'))
  page.appendChild(title)

  const cards = el('div', 'home-cards')
  for (const spec of HOME_CARDS) {
    // Hit box stays fixed; the face lifts. Card chrome is trimmed to emblem + title +
    // one line + one fact + CTA so the home screen reads as a game lobby, not a dashboard.
    const card = el('button', `home-card home-card--${spec.id}`) as HTMLButtonElement
    card.type = 'button'

    const face = el('span', 'home-card-face')
    face.appendChild(el('span', 'home-card-skin'))
    face.appendChild(el('span', 'home-card-grain'))
    face.appendChild(el('span', 'home-card-shine'))
    face.appendChild(el('span', 'home-card-sweep'))
    face.appendChild(el('span', 'home-card-spark'))

    const emblem = el('span', 'home-card-emblem')
    emblem.innerHTML = spec.emblem
    emblem.insertBefore(el('span', 'home-card-emblem-aura'), emblem.firstChild)
    face.appendChild(emblem)

    face.appendChild(el('span', 'home-card-title', spec.label))
    face.appendChild(el('span', 'home-card-desc', spec.blurb))

    const chips = el('span', 'home-card-chips')
    chips.appendChild(el('span', 'home-chip', spec.chips[spec.statusIndex] ?? ''))
    face.appendChild(chips)

    const cta = el('span', 'home-card-cta')
    cta.appendChild(el('span', 'home-card-cta-label', 'Play'))
    face.appendChild(cta)

    card.appendChild(face)
    card.onclick = () => {
      const target = cardDestination(spec.id)
      if (!target) return
      activeScreen = target
      render()
    }
    cards.appendChild(card)
  }
  page.appendChild(cards)
  page.appendChild(homeBar())
  app.appendChild(page)
}

/**
 * The bottom bar: five entries, all of them finished.
 *
 * Leaderboard and Settings go where they have always gone. Shop, Friends and More have
 * no backend in this project, so they answer with a toast naming themselves rather than
 * navigating or asking the server for anything — the entry points are real, the features
 * behind them are not, and the bar does not pretend otherwise.
 */
function homeBar(): HTMLElement {
  const bar = el('nav', 'home-bar glass glass-edge')
  bar.setAttribute('aria-label', 'More screens')
  for (const item of HOME_BAR) {
    const destination = barDestination(item.id)
    const locked = destination === null
    const active = destination !== null && destination === activeScreen
    const btn = el(
      'button',
      `home-bar-item${locked ? ' home-bar-item--locked' : ''}${active ? ' home-bar-item--active' : ''}`
    ) as HTMLButtonElement
    btn.type = 'button'
    if (locked) btn.setAttribute('aria-disabled', 'true')
    if (active) btn.setAttribute('aria-current', 'page')
    const icon = el('span', 'home-bar-icon')
    icon.innerHTML = item.icon
    btn.append(icon, el('span', undefined, item.label))
    btn.onclick = () => {
      if (!destination) {
        toast(comingSoonMessage(item.label))
        return
      }
      activeScreen = destination
      render()
    }
    bar.appendChild(btn)
  }
  return bar
}

/**
 * The screens a card or a bar icon opens.
 *
 * All four were already in the app; what is new is that they each have a screen of their
 * own with a way back, rather than sharing one long scrolling lobby with everything else
 * on it. The builders below are the existing ones, unchanged — the flows they drive are
 * the flows that shipped.
 */
async function renderScreen(screen: AppScreen): Promise<void> {
  const wrap = el('div', 'screen-page page-enter')
  app.appendChild(wrap)
  switch (screen) {
    case 'multiplayer':
      await renderTablesScreen(wrap)
      return
    case 'tournaments':
      await renderTournamentsScreen(wrap)
      return
    case 'leaderboard':
      await renderLeaderboardScreen(wrap)
      return
    case 'settings':
      renderSettingsScreen(wrap)
      return
    default:
      activeScreen = 'home'
      render()
  }
}

/** The title and the way home, shared by every screen below. */
function screenHead(title: string, note?: string): HTMLElement {
  const head = el('div', 'screen-head')
  const titles = el('div')
  titles.appendChild(el('h2', 'screen-title', title))
  if (note) titles.appendChild(el('div', 'muted', note))
  head.appendChild(titles)
  const back = el('button', 'ghost', 'Back to home') as HTMLButtonElement
  back.type = 'button'
  back.onclick = () => {
    activeScreen = 'home'
    render()
  }
  head.appendChild(back)
  return head
}

/**
 * One-to-one tables: the create-a-match card, the tiered list of tables waiting for a
 * second player, and the player's own match history. All of it exactly as it was; the
 * balance now sits with the tier chips, which is the only decision on this screen that
 * belongs to credits.
 */
async function renderTablesScreen(wrap: HTMLElement): Promise<void> {
  wrap.appendChild(screenHead('Multiplayer', 'Join a table by price, or open one and wait for an opponent.'))
  await Promise.all([refreshWallet(), loadTiers()])
  if (!wrap.isConnected) return
  wrap.appendChild(createMatchCard())

  // Tables that are open for a seat. The server only reports matches still waiting
  // for a second player, so this is a "join a waiting table" list rather than a
  // spectator feed — calling it anything else would overstate what is being shown.
  const openSection = el('div', 'lobby-section')
  openSection.appendChild(el('h3', 'lobby-section-title', 'Open Tables'))
  openSection.appendChild(await openTablesStrip())
  if (!wrap.isConnected) return
  wrap.appendChild(openSection)

  wrap.appendChild(await matchHistoryCard())
}

/** The tournament banner and the create/join card: the existing flow, given its own screen. */
async function renderTournamentsScreen(wrap: HTMLElement): Promise<void> {
  wrap.appendChild(screenHead('Tournaments', '8-player single-elimination brackets, seeded by join order.'))
  // Driven by the tournaments that are actually open for a seat, so the headline and
  // the button always agree with each other.
  wrap.appendChild(await featuredTournamentHero())
  if (!wrap.isConnected) return
  wrap.appendChild(createTournamentCard())
}

/** The leaderboard, which has had working logic since the profile phase. */
async function renderLeaderboardScreen(wrap: HTMLElement): Promise<void> {
  wrap.appendChild(screenHead('Leaderboard', 'Ranked on real matches only — practice never counts.'))
  wrap.appendChild(await profileStatsCard())
}

/**
 * Settings.
 *
 * Only what already works: the account as `/api/me` reports it, and the sound toggle,
 * which is the same `audio.ts` mute the in-game button sets. Nothing here is stored
 * anywhere new and nothing here is a placeholder for a feature — if a setting is added
 * later it arrives here with its own logic rather than as a row that does nothing.
 */
function renderSettingsScreen(wrap: HTMLElement): void {
  wrap.appendChild(screenHead('Settings'))

  const account = card('Account')
  const rows = el('div')
  rows.appendChild(el('div', 'muted', 'Loading...'))
  account.appendChild(rows)
  void api<MyProfile>('/me')
    .then((profile) => {
      if (!rows.isConnected) return
      rows.innerHTML = ''
      const name = el('div', 'table-row')
      name.appendChild(el('div', undefined, profile.user.username))
      name.appendChild(el('span', 'badge', currentUser?.role ?? 'PLAYER'))
      rows.appendChild(name)
      const joined = el('div', 'table-row')
      joined.appendChild(el('div', undefined, 'Member since'))
      joined.appendChild(el('div', 'meta', new Date(profile.user.createdAt).toLocaleDateString()))
      rows.appendChild(joined)
      const credits = el('div', 'table-row')
      credits.appendChild(el('div', undefined, 'Balance'))
      credits.appendChild(el('div', 'meta', formatCash(profile.user.wallet.available)))
      rows.appendChild(credits)
    })
    .catch((error: Error) => {
      if (!rows.isConnected) return
      rows.innerHTML = ''
      rows.appendChild(el('div', 'muted', error.message))
    })
  wrap.appendChild(account)

  const sound = card('Sound')
  const row = el('div', 'row')
  const toggle = el('button', 'ghost', isSoundMuted() ? 'Sound: off' : 'Sound: on') as HTMLButtonElement
  toggle.type = 'button'
  toggle.onclick = () => {
    const next = !isSoundMuted()
    setSoundMuted(next)
    toggle.textContent = next ? 'Sound: off' : 'Sound: on'
  }
  row.appendChild(el('span', 'muted', 'Table sounds'))
  row.appendChild(toggle)
  sound.appendChild(row)
  wrap.appendChild(sound)
}

/**
 * The pre-practice setup screen.
 *
 * Reached from the PRACTICE card and doing one job: choose the level, then start the
 * match through the same `POST /practice/start` the old lobby card used, with the same
 * `enterMatch` behind it. Nothing about how a practice match is created, played or
 * settled is touched here - this is a screen in front of an unchanged flow.
 *
 * The setup screen replaces a dropdown that lived inside the lobby grid. A `<select>` is
 * the right control when the level is one field among five and the wrong one when it is
 * the only decision the player came here to make: it hides two of the three options and
 * says nothing about what they mean. Three panes on a glass panel say both, and the
 * description under them is reserved space, so choosing a level never moves the button.
 */
function renderPracticeSetup(): void {
  const page = el('div', 'practice-page page-enter')
  const panel = el('div', 'practice-panel glass glass-edge')

  const back = el('button', 'ghost practice-back', 'Back to home') as HTMLButtonElement
  back.type = 'button'
  back.onclick = () => {
    activeScreen = 'home'
    render()
  }
  panel.appendChild(back)

  const heading = el('div', 'practice-heading')
  heading.appendChild(el('h2', undefined, 'Practice match'))
  panel.appendChild(heading)

  // The matchup, in the two avatars that will actually be at the table: the player's own,
  // drawn by the shared component from their name, and the robot.
  const playerName = currentUser?.username ?? 'You'
  const matchup = el('div', 'practice-matchup')
  const you = el('div', 'practice-side')
  you.appendChild(createAvatarBadge({ name: playerName, isBot: false }))
  you.appendChild(el('div', 'practice-side-name', playerName))
  const bot = el('div', 'practice-side')
  bot.appendChild(createAvatarBadge({ name: 'Robot', isBot: true }))
  bot.appendChild(el('div', 'practice-side-name', 'Robot'))
  matchup.append(you, el('div', 'practice-vs', 'vs'), bot)
  panel.appendChild(matchup)

  panel.appendChild(el('div', 'practice-group-label', 'Robot level'))
  const blurb = el('div', 'difficulty-blurb')
  const group = el('div', 'difficulty-group')
  group.setAttribute('role', 'radiogroup')
  group.setAttribute('aria-label', 'Robot level')

  // One paint function for the selection, so the three buttons and the description under
  // them cannot disagree: it is called once on entry and again on every click.
  const buttons: HTMLButtonElement[] = []
  const paint = (): void => {
    for (const btn of buttons) btn.setAttribute('aria-checked', String(btn.dataset.level === practiceDifficulty))
    const chosen = DIFFICULTIES.find((d) => d.level === practiceDifficulty)
    blurb.textContent = chosen?.blurb ?? ''
  }
  for (const spec of DIFFICULTIES) {
    const btn = el('button', 'difficulty', spec.label) as HTMLButtonElement
    btn.type = 'button'
    btn.dataset.level = spec.level
    btn.setAttribute('role', 'radio')
    btn.onclick = () => {
      practiceDifficulty = spec.level
      paint()
    }
    buttons.push(btn)
    group.appendChild(btn)
  }
  panel.appendChild(group)
  paint()
  panel.appendChild(blurb)

  const actions = el('div', 'practice-actions')
  const play = el('button', 'practice-play', 'Play') as HTMLButtonElement
  play.type = 'button'
  play.onclick = () => {
    // Disabled on the way out so a second click cannot start a second practice match; the
    // failure path puts it back, because nothing has happened yet in that case.
    play.disabled = true
    void api<{ id: string }>('/practice/start', { method: 'POST', body: { aiLevel: practiceDifficulty } })
      .then((data) => enterMatch(data.id, true))
      .catch((error: Error) => {
        play.disabled = false
        toast(error.message, 'error')
      })
  }
  actions.appendChild(play)
  actions.appendChild(el('div', 'practice-note', 'Practice is free and does not count toward your record.'))
  panel.appendChild(actions)

  page.appendChild(panel)
  app.appendChild(page)
}

/**
 * The banner at the top of the lobby.
 *
 * The first cut of this screen hard-coded a headline, a prize pool and a player
 * count, and left the button inert. Every one of those numbers would have been a
 * lie the moment the data changed, so the banner is now built from the tournaments
 * that are genuinely open, and the button joins the tournament it is describing.
 * With nothing open it says so and offers the one action that still works.
 */
async function featuredTournamentHero(): Promise<HTMLElement> {
  const hero = el('div', 'lobby-hero')
  const content = el('div', 'lobby-hero-content')
  const action = el('div', 'lobby-hero-action')

  let open: OpenTournament[] = []
  let mine: OpenTournament[] = []
  try {
    ;[open, mine] = await Promise.all([
      api<OpenTournament[]>('/tournaments/open'),
      api<OpenTournament[]>('/tournaments/mine')
    ])
  } catch {
    // A failed lookup must not take the lobby down with it; the card grid below
    // is still worth showing, so the banner degrades to its empty state.
    open = []
    mine = []
  }

  // The fullest open bracket is the one worth featuring, but a tournament the player
  // has already entered is worth more than a slightly busier one they cannot join.
  const featured = mine[0] ?? [...open].sort((a, b) => (b._count?.players ?? 0) - (a._count?.players ?? 0))[0]

  if (featured) {
    const inIt = mine.some((t) => t.id === featured.id)
    content.appendChild(el('h2', undefined, featured.name))
    const fee = Number(featured.entryFee ?? 0)
    content.appendChild(
      el(
        'p',
        undefined,
        `${featured._count?.players ?? 0}/${featured.size} players signed up · ` +
          `${fee > 0 ? `${formatCash(fee)} entry` : 'free entry'} · ${statusLabel(featured.status)}`
      )
    )

    if (inIt) {
      const viewBtn = el('button', undefined, 'VIEW BRACKET') as HTMLButtonElement
      viewBtn.type = 'button'
      viewBtn.onclick = () => {
        activeTournamentId = featured.id
        render()
      }
      action.appendChild(viewBtn)
    } else {
      const joinBtn = el('button', undefined, 'JOIN NOW') as HTMLButtonElement
      joinBtn.type = 'button'
      joinBtn.onclick = () => {
        // Disable before the request so a double click cannot burn two entries.
        joinBtn.disabled = true
        joinBtn.textContent = 'JOINING…'
        void api<{ joined: boolean }>('/tournaments/join', {
          method: 'POST',
          body: { tournamentId: featured.id }
        })
          .then(() => {
            activeTournamentId = featured.id
            render()
          })
          .catch((error) => {
            joinBtn.disabled = false
            joinBtn.textContent = 'JOIN NOW'
            toast(error.message, 'error')
          })
      }
      action.appendChild(joinBtn)
    }
  } else {
    content.appendChild(el('h2', undefined, 'No tournament open yet'))
    content.appendChild(el('p', undefined, 'Be the first to put a bracket on the board — 8 players, seeded by join order.'))
    const createBtn = el('button', undefined, 'CREATE ONE') as HTMLButtonElement
    createBtn.type = 'button'
    createBtn.onclick = () => {
      createBtn.disabled = true
      void startTournament()
    }
    action.appendChild(createBtn)
  }

  hero.append(content, action)
  return hero
}

/**
 * The tables waiting for a second player.
 *
 * Rendered as a horizontal strip to match the venue look. Each card is joined from
 * here directly, so the strip is a real route into a match and not a status board.
 */
async function openTablesStrip(): Promise<HTMLElement> {
  const strip = el('div', 'live-tables')
  // A skeleton rather than a line of text: the strip is a horizontal row of cards,
  // so the placeholder has the same shape as the thing it stands in for, and the
  // layout does not jump when the real cards replace it.
  for (const variant of ['skeleton-line', 'skeleton-line short', 'skeleton-line tiny']) {
    strip.appendChild(el('div', `skeleton ${variant}`))
  }

  let open: LobbyMatch[] = []
  try {
    open = await api<LobbyMatch[]>('/matches/lobby')
  } catch (error) {
    strip.replaceChildren(el('div', 'muted', (error as Error).message))
    return strip
  }
  strip.replaceChildren()

  if (!open.length) {
    strip.appendChild(el('div', 'muted', 'No tables waiting for an opponent. Start one above to be matched.'))
    return strip
  }

  // A player should not be invited to take a seat at their own table, and their own
  // table is the first thing they would otherwise see in the strip.
  const joinable = open.filter((m) => m.players[0]?.userId !== currentUser?.id)
  const mine = open.filter((m) => m.players[0]?.userId === currentUser?.id)

  for (const match of joinable) {
    strip.appendChild(openTableCard(match, false))
  }
  for (const match of mine) {
    strip.appendChild(openTableCard(match, true))
  }
  return strip
}

function openTableCard(match: LobbyMatch, isMine: boolean): HTMLElement {
  const c = el('div', 'live-table-card')
  const host = match.players[0]?.user.username ?? 'Unknown'
  c.appendChild(el('div', 'table-name', isMine ? 'Your table' : `${host} · ${match.format}`))
  c.appendChild(el('div', 'table-players', isMine ? 'Waiting for an opponent' : 'Open seat'))
  c.appendChild(el('div', 'table-score', formatCash(match.stakePerPlayer)))

  if (isMine) {
    const badge = el('span', 'badge', 'waiting')
    c.appendChild(badge)
  } else {
    const joinBtn = el('button', 'ghost', 'Take seat') as HTMLButtonElement
    joinBtn.type = 'button'
    joinBtn.onclick = () => {
      joinBtn.disabled = true
      void api('/matches/join', { method: 'POST', body: { matchId: match.id } })
        .then(() => enterMatch(match.id, false))
        .catch((error) => {
          joinBtn.disabled = false
          toast(error.message, 'error')
        })
    }
    c.appendChild(joinBtn)
  }
  return c
}

function createMatchCard(): HTMLElement {
  const c = el('div', 'lobby-card')
  const icon = el('div', 'lobby-card-icon', 'ðŸŽ¯')
  c.appendChild(icon)
  c.appendChild(el('h3', undefined, 'Quick Match'))
  c.appendChild(el('p', undefined, 'Jump into a 1v1 match'))
  const tierPicker = el('div', 'tier-picker')
  if (!tiers.length) {
    c.appendChild(el('div', 'muted', 'Tier list unavailable. Try refreshing.'))
    return c
  }
  let createTier = activeTierId ?? tiers[0]!.id

  // The balance, immediately above the tiers it pays for. This is the only place in the
  // new home flow where the number is worth showing: the home screen leads with who you
  // are, and this screen is where USDT is about to be committed to a table.
  const balance = el('div', 'stake-wallet')
  balance.appendChild(el('span', undefined, 'Balance'))
  balance.appendChild(el('strong', undefined, formatCash(wallet.balance)))
  c.appendChild(balance)

  for (const tier of tiers) {
    const chip = el('button', 'tier-chip', `${tier.label}`)
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

/**
 * Creates a tournament, takes the first seat in it and opens the bracket.
 *
 * Shared by the tournament card and the lobby banner's empty state, so the two
 * cannot drift apart — and so the banner does not have to build a whole card (and
 * the tournament list request behind it) just to click one button on it.
 */
function startTournament(): Promise<void> {
  return api<{ id: string }>('/tournaments', { method: 'POST', body: {} })
    .then((data) =>
      api<{ joined: boolean }>('/tournaments/join', { method: 'POST', body: { tournamentId: data.id } }).then(() => data)
    )
    .then((data) => {
      activeTournamentId = data.id
      render()
    })
    .catch((error) => {
      toast(error.message, 'error')
    })
}

function createTournamentCard(): HTMLElement {
  const c = card('8-Player Tournament — free')
  c.appendChild(el('div', 'muted', 'Single-elimination, best-of-3 frames. 8 players, seeded by join order. Winner takes the crown.'))
  const createBtn = el('button', undefined, 'Create Tournament') as HTMLButtonElement
  createBtn.type = 'button'
  createBtn.onclick = () => {
    createBtn.disabled = true
    void startTournament()
  }
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
  refreshBtn.onclick = () => void renderScreen('multiplayer')
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
      section.appendChild(el('div', 'muted', `${formatCash(tier.usdt)} stake per player`))
      if (!matches.length) {
        section.appendChild(el('div', 'muted', 'No tables waiting at this price. Create one above.'))
      } else {
        for (const match of matches) {
          const wait = el('div', 'table-row')
          const host = match.players[0]
          const mine = host !== undefined && host.userId === currentUser?.id
          const info = el('div')
          info.appendChild(el('div', undefined, `${mine ? 'You' : host?.user.username ?? '?'} · ${match.format}`))
          info.appendChild(el('div', 'meta', `${formatCash(match.stakePerPlayer)} · waiting 1/2 · ${timeAgo(match.createdAt)}`))
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

/**
 * VS AI start path with the match loading overlay: real phase progress, GPU warm-up,
 * then handover. An online challenge resolves later (when someone accepts), so it
 * does not share this screen — it enters the match directly from the challenge
 * layer once the table is taken.
 */
async function startPracticeWithLoadingScreen(aiLevel: PracticeAiLevel): Promise<void> {
  const loading = showMatchLoading({ modeLabel: 'VS AI' })
  const perf = new URLSearchParams(location.search).has('perf')
  const phaseMs: Partial<Record<LoadPhase | 'total', number>> = {}
  const runPhase = async (phase: LoadPhase, work: () => Promise<void> | void): Promise<void> => {
    const t0 = performance.now()
    loading.report(phase, 0)
    try {
      await work()
    } catch (err) {
      console.warn(`[match-loading] phase ${phase} failed; continuing`, err)
    }
    loading.report(phase, 1)
    phaseMs[phase] = performance.now() - t0
  }

  const tAll = performance.now()
  try {
    await runPhase('fonts', async () => {
      await Promise.all([document.fonts.ready.catch(() => undefined), ensureLobbyBgReady()])
    })

    // Network must succeed: without a match id there is nothing to warm. Do not swallow.
    loading.report('network', 0)
    const tNet = performance.now()
    let matchId: string
    try {
      const data = await api<{ id: string }>('/practice/start', { method: 'POST', body: { aiLevel } })
      matchId = data.id
      loading.report('network', 1)
      phaseMs.network = performance.now() - tNet
    } catch (err) {
      await loading.finish().catch(() => undefined)
      throw err
    }

    await runPhase('scene', async () => {
      // The Blender table has to be parsed before the scene is built or the scene
      // falls back to the code table. The download itself was kicked off at boot;
      // this only waits for it, and the preload resolves null rather than rejecting,
      // so a missing model costs a fallback and never the match.
      await preloadTableModel()
      pendingSceneBuildProgress = (fraction) => loading.report('scene', fraction)
      enterMatch(matchId, true)
      pendingSceneBuildProgress = undefined
    })

    await runPhase('audio', async () => {
      // If reading the clap file never settles (seen on Android), the frame still starts.
      await Promise.race([warmMatchAudioBuffers(), new Promise((resolve) => setTimeout(resolve, 3000))])
    })

    if (scene3d) {
      const warmPhases: Array<'textures' | 'shaders' | 'bakes' | 'warmup'> = [
        'textures',
        'shaders',
        'bakes',
        'warmup'
      ]
      const seen = new Set<string>()
      const tWarm = performance.now()
      await scene3d.warmUp(
        (phase, fraction) => {
          loading.report(phase, fraction)
          if (fraction >= 1 && !seen.has(phase)) {
            seen.add(phase)
            phaseMs[phase] = performance.now() - tWarm
          }
        },
        { perf }
      )
      for (const p of warmPhases) {
        if (!seen.has(p)) loading.report(p, 1)
      }
    } else {
      for (const p of ['textures', 'shaders', 'bakes', 'warmup'] as const) {
        loading.report(p, 1)
      }
    }

    const before = scene3d?.rendererInfo() ?? { programs: 0, textures: 0 }
    if (perf) {
      phaseMs.total = performance.now() - tAll
      console.info('[perf] match loading phases (ms)', phaseMs)
      console.info('[perf] renderer.info before handover', before)
    }

    await loading.finish()

    if (perf) {
      window.setTimeout(() => {
        const after = scene3d?.rendererInfo() ?? { programs: 0, textures: 0 }
        console.info('[perf] renderer.info 3s after handover', after)
        if (before.programs !== after.programs || before.textures !== after.textures) {
          console.warn('[perf] renderer.info mismatch after handover', { before, after })
        }
      }, 3000)
    }
  } catch (err) {
    console.warn('[match-loading] aborting overlay after error', err)
    await loading.finish().catch(() => undefined)
    throw err
  }
}

/** Prefetch / decode crowd applause and unlock the audio context hooks. */
async function warmMatchAudioBuffers(): Promise<void> {
  unlockAudio()
  try {
    const res = await fetch('/audio/clapping-best.mp4', { cache: 'force-cache' })
    if (!res.ok) return
    const bytes = await res.arrayBuffer()
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = new AC()
    try {
      await ctx.decodeAudioData(bytes.slice(0))
    } finally {
      await ctx.close().catch(() => undefined)
    }
  } catch {
    /* crowd file missing or decode unsupported — skip */
  }
}

function enterMatch(matchId: string, isPractice = false): void {
  activeMatchId = matchId
  // A new match has no last shot yet, and no recap left over from the one before.
  lastShotRecap = null
  pendingHighlight = null
  // A highlight left over from the last match is cleared away without reporting anything.
  skipHighlight?.()
  recapPlayer = null
  recapDone = null
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

function syncMusicDuck(): void {
  setMusicDucked(shotInFlight || shotPlayer !== null || predictedShot !== null || queuedUpdates.length > 0)
}

/**
 * Sizes the canvas to the space the layout has left over.
 *
 * The stage is now the viewport (see `.game-page` / `.table-stage`), so there is nothing
 * to fit the table into: the canvas takes the whole box, at whatever shape the window is.
 * That is safe for both views because the cameras fit themselves to the aspect they are
 * given — `topDownHeight` solves for whichever of length and width binds first — so the
 * overhead view still arrives with the whole table in it, and the aim view gets a wider
 * field of view on a wide window rather than bars down either side.
 *
 * The backing store is the CSS box times the device pixel ratio, capped and scaled (see
 * `fullPixelRatio` and `renderScaler`),
 * and the element's own CSS size stays 100%, so the renderer draws at the device's density
 * without the layout ever being told about it.
 *
 * Measured off the stage rather than the window so the stage's own box is the truth. The
 * ResizeObserver in `renderGame` calls this on every change to that box, which covers a
 * window resize and an orientation change alike: a fixed, inset-0 stage is exactly the
 * viewport, so it changes whenever the viewport does.
 */
function applyCanvasSize(): void {
  const canvas = rgCanvas
  const stage = tableStageEl
  if (!canvas || !stage) return
  const width = Math.floor(stage.clientWidth)
  const height = Math.floor(stage.clientHeight)
  if (width <= 0 || height <= 0) return
  const dpr = fullPixelRatio() * renderScaler.scale
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
  // No app header on this screen. It is a lobby control bar - brand, wallet, bell, sign
  // out - and a match is one full viewport of table, so anything above the cloth is height
  // the table does not get. The things a player needs mid-frame are the icon controls in
  // the HUD's own top-left instead, and leaving is one of them.
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
    if (handleDrag && handleDrag.id === e.pointerId) {
      if (!handleDrag.moved && Math.hypot(e.clientX - handleDrag.startX, e.clientY - handleDrag.startY) > HANDLE_TAP_SLOP_PX) {
        handleDrag.moved = true
      }
      if (handleDrag.moved) dragHandleBall(e.clientX - handleDrag.lastX, e.clientY - handleDrag.lastY)
      handleDrag.lastX = e.clientX
      handleDrag.lastY = e.clientY
      e.preventDefault()
    }
  })
  const endHandleDrag = (e: PointerEvent, cancelled: boolean): void => {
    if (!handleDrag || handleDrag.id !== e.pointerId) return
    const tapped = !handleDrag.moved && !cancelled
    handleDrag = null
    // A tap, not a drag: the ball is put down where it stands. A drag only ever moves it,
    // so the ball stays in hand until the player taps to say this is the spot.
    if (tapped && handlePos && placementAllowsGhostInput(placementFlow) && !placementCommitInFlight) {
      placementPendingCommit = { x: handlePos.x, y: handlePos.y }
    }
    e.preventDefault()
  }
  canvas.addEventListener('pointerup', (e) => endHandleDrag(e, false))
  canvas.addEventListener('pointercancel', (e) => endHandleDrag(e, true))
  canvas.addEventListener('pointerdown', (e) => {
    lastPointerCanvas = { clientX: e.clientX, clientY: e.clientY }
    // Only a placement in the `PLACING` phase accepts a click. During either camera move
    // the click is consumed and dropped, so a player who clicks while the table is still
    // lifting cannot commit a spot from a view that has not finished moving.
    if (!placementAllowsGhostInput(placementFlow) || placementCommitInFlight) return
    if (handlePlacement) {
      // With the handle, a finger on the table either drags the ball with it (it moves as
      // far as the finger does) or, if it lifts without moving, is a tap that puts the ball
      // down where it stands (see endHandleDrag).
      handleDrag = { id: e.pointerId, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false }
      e.preventDefault()
      return
    }
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
  const oppHolder = el('div')
  oppHolder.id = 'opp-holder'
  tableFrame.appendChild(oppHolder)
  // The power rail overlays the table, so it mounts into the frame rather than into
  // the page flow: it must not take vertical space from the table it sits over.
  tableFrame.appendChild(hud.overlayRoot)
  stage.appendChild(tableFrame)
  page.appendChild(stage)

  /**
   * The session tools, icon-only round glass buttons in the HUD's own corners.
   *
   * They are icon-only because they are needed occasionally, not per shot, and the row of
   * words under the table was the one thing on the screen wide enough to change its layout.
   * Each button keeps its label in `title` and `aria-label`, so nothing is lost by dropping
   * the text, and these are the handlers those buttons already had: this changes how they
   * are drawn, not what they do.
   *
   * The mount is a parameter rather than a closure over one slot, because there are two
   * slots now and only the first three of these belong in either of them: leaving and the
   * view toggle in the top-left column, everything else in the top-right group.
   */
  const tool = (mount: HTMLElement, label: string, mark: string) => {
    const btn = el('button', 'hud-tool hud-glass') as HTMLButtonElement
    btn.type = 'button'
    btn.title = label
    btn.setAttribute('aria-label', label)
    btn.innerHTML = mark
    mount.appendChild(btn)
    return btn
  }
  // Inline strokes rather than glyphs: they inherit `currentColor`, so there is no icon font
  // to load and nothing that can flash empty on the first frame of a match.
  const stroke = (body: string) =>
    `<svg class="hud-tool-icon" viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
  const leaveMark = stroke(
    '<path d="M12.5 3.5H7a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h5.5"/><path d="M9.5 10h7m0 0L14 7.5M16.5 10 14 12.5"/>'
  )
  const soundOnMark = stroke(
    '<path d="M4 8.5v3h2.6L10 14.6V5.4L6.6 8.5H4z"/><path d="M12.4 8a3.4 3.4 0 0 1 0 4M14.7 5.8a6.5 6.5 0 0 1 0 8.4"/>'
  )
  const soundOffMark = stroke(
    '<path d="M4 8.5v3h2.6L10 14.6V5.4L6.6 8.5H4z"/><path d="M12.6 8.4l4.2 3.2m0-3.2-4.2 3.2"/>'
  )
  const flagMark = stroke('<path d="M5.5 16.5v-13"/><path d="M5.5 4.5h8.5l-1.6 3.1 1.6 3.1h-8.5z"/>')
  const chatMark = stroke(
    '<path d="M4 4.5h12a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H9.5L5.5 15v-2.5H4a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"/><path d="M7.5 8h5M7.5 10.5h3"/>'
  )
  const expandMark = stroke(
    '<path d="M3.5 7.6V3.5h4.1M16.5 7.6V3.5h-4.1M3.5 12.4v4.1h4.1M16.5 12.4v4.1h-4.1"/>'
  )
  const moreMark = stroke(
    '<circle cx="4.6" cy="10" r="1.35" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="1.35" fill="currentColor" stroke="none"/><circle cx="15.4" cy="10" r="1.35" fill="currentColor" stroke="none"/>'
  )

  const leaveBtn = tool(hud.toolsRoot, 'Leave', leaveMark)
  leaveBtn.onclick = () => leaveToLobby()
  // Directly under Leave, in the same column and the same material: the two controls a
  // player reaches for between shots, and nothing else in that corner.
  hud.toolsRoot.appendChild(buildCameraToggle())
  // Once every button below has been built, they are gathered into the menu and pause is
  // added. Presentation only: the buttons keep the handlers they are given here.
  const menuHud = hud
  hudMenu?.dispose()
  hudMenu = null
  queueMicrotask(() => {
    if (hud === menuHud) hudMenu = installHudMenu(menuHud)
  })

  /**
   * The top-right group: everything that is not leaving.
   *
   * Sound, finish, fullscreen and the controls popover. Four round glass buttons on a wide
   * screen; on a phone they collapse behind one "more" button, which the stylesheet
   * arranges by hiding the group until `hud-more-open` is on the slot — so the collapse is
   * layout rather than a second set of buttons to keep in step.
   */
  const sessionMount = hud.sessionToolsRoot
  const moreBtn = el('button', 'hud-tool hud-glass hud-tool--more') as HTMLButtonElement
  moreBtn.type = 'button'
  moreBtn.title = 'More controls'
  moreBtn.setAttribute('aria-label', 'More controls')
  moreBtn.setAttribute('aria-expanded', 'false')
  moreBtn.innerHTML = moreMark
  moreBtn.onclick = () => {
    const open = sessionMount.classList.toggle('hud-more-open')
    moreBtn.setAttribute('aria-expanded', String(open))
  }
  sessionMount.appendChild(moreBtn)

  const soundBtn = tool(
    sessionMount,
    isSoundMuted() ? 'Sound: off' : 'Sound: on',
    isSoundMuted() ? soundOffMark : soundOnMark
  )
  // `aria-pressed` carries the muted state, so the control reads as a toggle rather than as
  // a button that happens to change its wording.
  soundBtn.setAttribute('aria-pressed', String(isSoundMuted()))
  soundBtn.onclick = () => {
    const next = !isSoundMuted()
    setSoundMuted(next)
    soundBtn.innerHTML = next ? soundOffMark : soundOnMark
    const label = next ? 'Sound: off' : 'Sound: on'
    soundBtn.title = label
    soundBtn.setAttribute('aria-label', label)
    soundBtn.setAttribute('aria-pressed', String(next))
  }

  const concedeBtn = tool(sessionMount, activeMatchIsPractice ? 'Finish' : 'Concede', flagMark)
  concedeBtn.onclick = () => {
    if (activeMatchIsPractice) void finishPractice()
    else askConcede()
  }

  /**
   * Quick chat, for online matches only — practice has nobody to talk to, so the
   * control and its log stay off the table. The menu is the whole input: a grid
   * of fixed phrases, each sent by id, none of them typed.
   */
  if (!activeMatchIsPractice) {
    const chatBtn = tool(sessionMount, 'Chat', chatMark)
    chatBtn.setAttribute('aria-expanded', 'false')
    const chatMenu = el('div', 'hud-pop hud-glass hud-chat')
    chatMenu.id = 'match-chat-menu'
    chatMenu.setAttribute('role', 'group')
    chatMenu.hidden = true
    chatBtn.setAttribute('aria-controls', chatMenu.id)
    chatBtn.onclick = () => {
      chatMenu.hidden = !chatMenu.hidden
      chatBtn.setAttribute('aria-expanded', String(!chatMenu.hidden))
    }
    const grid = el('div', 'hud-chat-grid')
    for (const phrase of MATCH_CHAT_PHRASES) {
      const phraseBtn = el('button', 'hud-chat-phrase', phrase.text) as HTMLButtonElement
      phraseBtn.type = 'button'
      phraseBtn.onclick = () => {
        sendChatPhrase(phrase.id)
        chatMenu.hidden = true
        chatBtn.setAttribute('aria-expanded', 'false')
      }
      grid.appendChild(phraseBtn)
    }
    chatMenu.appendChild(grid)
    sessionMount.append(chatMenu)
    chatMenuEl = chatMenu
  }

  /**
   * Fullscreen, entered only from this click. The API refuses a request that does not come
   * from a gesture, so there is nothing to gain by asking earlier and a shot to lose by
   * interrupting one.
   */
  const fullBtn = tool(sessionMount, 'Fullscreen', expandMark)
  fullBtn.onclick = () => {
    const leaving = document.fullscreenElement !== null
    const change = leaving ? document.exitFullscreen() : document.documentElement.requestFullscreen()
    // A refused request is not worth interrupting a shot over, and the label is corrected
    // once the transition settles rather than guessed at before it does.
    change
      .then(() => {
        const label = leaving ? 'Fullscreen' : 'Leave fullscreen'
        fullBtn.title = label
        fullBtn.setAttribute('aria-label', label)
      })
      .catch(() => {})
  }

  /**
   * The controls, behind a question mark.
   *
   * This line of text used to sit under the table, where it was the widest thing on the
   * screen and the only element that could push a match past one viewport. It is the same
   * words, opened on demand, and the sticky dismissal is unchanged: closing it hides the
   * control for the rest of the session, exactly as the × under the table did.
   */
  if (!hintDismissed) {
    const helpBtn = el('button', 'hud-tool hud-tool--help hud-glass', '?') as HTMLButtonElement
    helpBtn.type = 'button'
    helpBtn.title = 'Controls'
    helpBtn.setAttribute('aria-label', 'Controls')
    helpBtn.setAttribute('aria-expanded', 'false')
    const help = el('div', 'hud-pop hud-glass')
    help.id = 'controls-help'
    help.setAttribute('role', 'group')
    help.hidden = true
    helpBtn.setAttribute('aria-controls', help.id)
    help.append(
      el('p', undefined, 'Aim: move the mouse, or drag a finger left and right'),
      el('p', undefined, 'Turn the view: right-drag, or the same finger drag'),
      el('p', undefined, 'Power: pull the cue in the slider back and let go, or ↑/↓'),
      el('p', undefined, 'Spin: ↑/↓ side, W/S top-bottom'),
      el('p', undefined, 'Shoot: release or Space')
    )
    const closeHelp = el('button', 'hud-pop-close', '×')
    closeHelp.title = 'Hide these controls for this session'
    closeHelp.setAttribute('aria-label', 'Hide the controls hint')
    closeHelp.onclick = () => {
      hintDismissed = true
      helpBtn.remove()
      help.remove()
    }
    help.appendChild(closeHelp)
    helpBtn.onclick = () => {
      help.hidden = !help.hidden
      helpBtn.setAttribute('aria-expanded', String(!help.hidden))
    }
    sessionMount.append(helpBtn, help)
  }

  // The spin readout goes with the dial it describes: the number was the last item in the
  // bar under the table, and the dial is the control it belongs to. The pointer maths reads
  // the ball's own rect and the caption takes no pointer events, so the drag is unchanged.
  const spinLabel = el('div', 'spin-label', 'Spin: 0.0 / 0.0')
  hud.spinDialRoot.appendChild(spinLabel)

  app.appendChild(page)
  // The chat log floats over the table edge and fills from the bottom as lines
  // arrive; it is created here so the module references always point at the live
  // DOM for the current match.
  if (!activeMatchIsPractice) {
    const chatLog = el('div', 'hud-glass match-chat-log')
    chatLog.id = 'match-chat-log'
    chatLog.setAttribute('aria-live', 'polite')
    chatLog.hidden = true
    page.appendChild(chatLog)
    chatLogEl = chatLog
  }
  // The stage is a fixed, inset-0 box, so its content box is the viewport and this
  // observer fires for a window resize and for an orientation change both — including
  // the rotation that changes the shape of the screen from portrait to landscape and so
  // changes the camera's aspect with it.
  applyCanvasSize()
  gameResizeObserver?.disconnect()
  gameResizeObserver = new ResizeObserver(() => applyCanvasSize())
  gameResizeObserver.observe(stage)
  dprCeiling = dprCeilingForScreen()
  // Starts from where the last match on this device settled rather than from the top, so
  // a machine that cannot hold full resolution does not open every match by proving it.
  adaptiveQuality = qualityPreference() === 'auto'
  // How far the resolution may be turned down. On Auto, to the point below which the
  // table stops looking soft and starts looking broken. On High, hardly at all: a player
  // who chose High chose sharpness, and on a phone the Auto floor is a third of the pixels
  // the screen was being given — a picture that visibly falls apart. High gives up a fifth
  // of its resolution at the very most, and past that it keeps the picture.
  const phone = Math.min(window.innerWidth, window.innerHeight) <= DPR_MOBILE_MAX_EDGE
  const autoFloor = Math.min(1, (phone ? MIN_PIXEL_RATIO_PHONE : MIN_PIXEL_RATIO) / fullPixelRatio())
  const scaleFloor = adaptiveQuality ? autoFloor : Math.max(autoFloor, HIGH_MIN_RENDER_SCALE)
  renderScaler.reset(adaptiveQuality ? storedRenderScale() : 1, scaleFloor)
  renderScaleAnnounced = false
  applyCanvasSize()

  scene3d?.dispose()
  const buildOpts = pendingSceneBuildProgress
    ? { onBuildProgress: pendingSceneBuildProgress }
    : undefined
  pendingSceneBuildProgress = undefined
  scene3d = Scene3D.create(canvas, canvas.width, canvas.height, buildOpts)
  try {
    // The surroundings start on their cheaper finish on every level, High included: they
    // are the backdrop, their light is painted into them, and the frame that lighting
    // them in full cost is the frame High could not spare.
    scene3d?.lowerEnvironmentDetail()
  } catch {
    // Storage refused: the scaler will ask for it within a second or two if it is needed.
  }

  // A new scene has no camera move in it and is not holding the overhead placement view,
  // so a placement that was mid-flight against the old one would be describing a camera
  // that no longer exists: waiting for a flight home that the new scene will never start,
  // or picking a ghost through a camera that is sitting at the gameplay view. The flow is
  // reset to nothing and the next snapshot drives it again from the top, which is the only
  // honest starting point.
  placementFlow = initialPlacementFlow()
  placementTarget = null
  placementLegal = false
  placementPendingCommit = null
  placementCommitInFlight = false
  // Nothing is waiting on a resume from the old scene. The server's hold for it is left
  // to its own backstop, which is the only thing that can end a hold whose client is gone.
  placementResumePending = false
  // The declaration is per-placement too. A hold left standing on the old scene would
  // be held against a flow that no longer exists, so the next placement declares itself
  // again from the top.
  placementDeclared = false

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
    onPull: (pixels) => scene3d?.pullViewBy(pixels),
    // The visit is only playable when the table has settled, which is the same
    // condition that draws the cue. Firing while a shot is still animating used to
    // be accepted by the server and cut the animation dead.
    enabled: () => {
      // Input stays refused for the whole of a placement camera move, in either
      // direction. Without this a player could aim mid-flight, and the aim's heading
      // would arrive as the transition lands and yank the camera off its end pose.
      return isInputAllowed()
    },
    onChange: (aim) => {
      sendLiveAim(aim.angle, aim.power)
      hud?.setPower(aim.power)
      // The dial mirrors whatever wrote the spin — arrows, its own drag, a reset —
      // because both controls are views of this one pair of numbers.
      hud?.setSpin({ x: aim.spinX, y: aim.spinY })
      spinLabel.textContent = `Spin: ${aim.spinX.toFixed(1)} / ${aim.spinY.toFixed(1)}`
    },
    onShoot: (shot: Omit<ShotInput, 'timestamp'>) => {
      getSocket().emit('shot:play', { matchId: activeMatchId, input: { ...shot, timestamp: Date.now() } })
      // The cue goes through the ball on the table at once, while the shot is on its way;
      // the replay waits for the tip to reach the ball (see the pre-roll below).
      scene3d?.strikeCue(shot.power)
      // And the balls leave as the tip meets the ball, without waiting for the server.
      predictMyShot(shot)
      // The shot is on its way, so the bar empties for the next one. Eased inside the
      // controller, and it keeps animating on its own frames rather than being driven
      // by a state change that has already happened.
      cueController?.resetPower()
      syncMusicDuck()
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
  // Letting go of the cue in the slider plays the shot, through the same door as a release
  // on the cue ball: the controller sends what it holds, and refuses if the visit is not
  // playable.
  hud?.setPowerShootListener(() => cueController?.shoot())
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
  // Holding the spin control leans the camera in on the cue ball and draws the strike
  // point on it, for as long as it is held. The picture only: spin is set as above.
  hud?.setSpinHoldListener((held) => scene3d?.setSpinFocus(held))
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
  // A highlight gives way at once to the next shot: the replay it is showing has already
  // been watched once, and the new one has not.
  if (shotInFlight && skipHighlight) skipHighlight()
  if (shotInFlight) {
    queuedUpdates.push(data)
    return
  }
  applyGameUpdate(data)
}

/**
 * The visit can be played only once every ball has stopped moving and the server
 * has taken delivery of the previous shot's "finished" acknowledgement.
 *
 * All three conditions matter. `shotPlayer` is the replay that is on screen,
 * `queuedUpdates` are shots still waiting behind it, and `shotInFlight` stays set
 * from the moment a replay starts until the server has confirmed it finished, so
 * it also covers the brief window where the animation has ended but the server is
 * still holding the table. Aiming or firing in that window would hand the server a
 * second shot while the first was still live, which is what produced two shots'
 * worth of movement in a single frame.
 */
function isVisitPlayable(): boolean {
  return (
    myTurn &&
    tableReleased &&
    shotPlayer === null &&
    queuedUpdates.length === 0 &&
    !shotInFlight &&
    predictedShot === null &&
    !myFoulChoicePending()
  )
}

/**
 * My aim, live, for the other player's screen (online matches only): where my cue points
 * and how far back I am pulling. Sent at most ten times a second, with the last position
 * always delivered, so their screen shows me lining up rather than a cue moving by itself.
 */
let liveAimSentAt = 0
let liveAimTimer: number | null = null
let liveAimPending: { angle: number; power: number } | null = null
function sendLiveAim(angle: number, power: number): void {
  if (!activeMatchId || activeMatchIsPractice || !isVisitPlayable()) return
  liveAimPending = { angle, power }
  const flush = (): void => {
    liveAimTimer = null
    if (!liveAimPending || !activeMatchId) return
    getSocket().emit('aim:live', { matchId: activeMatchId, ...liveAimPending })
    liveAimPending = null
    liveAimSentAt = performance.now()
  }
  const wait = LIVE_AIM_INTERVAL_MS - (performance.now() - liveAimSentAt)
  if (wait <= 0) flush()
  else if (liveAimTimer === null) liveAimTimer = window.setTimeout(flush, wait)
}
const LIVE_AIM_INTERVAL_MS = 100

/** Whether a foul was just committed against me and the choice of what happens next is mine. */
function myFoulChoicePending(): boolean {
  const choice = frame?.foulChoice
  return !!choice && mySeat !== undefined && choice.chooser === mySeat
}

/** The foul-choice card and the note shown while the opponent is making theirs. Built once, shown when needed. */
let foulChoiceCard: HTMLElement | null = null
let foulChoiceWaitNote: HTMLElement | null = null
/** Set from the tap until the server's answer arrives, so the choice cannot be sent twice. */
let foulChoiceSent = false

function ensureFoulChoiceUi(): void {
  if (foulChoiceCard) return
  const card = el('div', 'foul-choice')
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-label', 'Foul: your choice')
  card.hidden = true
  const head = el('div', 'foul-choice-head')
  head.appendChild(el('span', 'foul-choice-tag', 'FOUL'))
  head.appendChild(el('span', 'foul-choice-text', 'Your opponent fouled. Play on from here, or put the balls back and make them play it again?'))
  card.appendChild(head)
  const actions = el('div', 'foul-choice-actions')
  const play = el('button', 'foul-choice-play', 'Play on') as HTMLButtonElement
  play.type = 'button'
  const again = el('button', 'ghost foul-choice-again', 'Balls back, they replay') as HTMLButtonElement
  again.type = 'button'
  const send = (playAgain: boolean): void => {
    if (foulChoiceSent || !activeMatchId || !myFoulChoicePending()) return
    foulChoiceSent = true
    play.disabled = true
    again.disabled = true
    getSocket().emit('foul:choice', { matchId: activeMatchId, playAgain })
  }
  play.onclick = () => send(false)
  again.onclick = () => send(true)
  actions.appendChild(play)
  actions.appendChild(again)
  card.appendChild(actions)
  document.body.appendChild(card)
  foulChoiceCard = card
  const wait = el('div', 'foul-choice-wait', 'Opponent is choosing: play on, or put the balls back and make you play again')
  wait.hidden = true
  document.body.appendChild(wait)
  foulChoiceWaitNote = wait
}

/**
 * Shows the foul-choice card to the player fouled against once the shot has been watched
 * through, and a short note to the offender while the opponent decides. Safe every frame.
 */
function syncFoulChoiceUi(): void {
  const choice = activeMatchId ? frame?.foulChoice : null
  const settled = shotPlayer === null && predictedShot === null && queuedUpdates.length === 0 && !shotInFlight && recapPlayer === null
  const mine = !!choice && mySeat !== undefined && choice.chooser === mySeat && settled
  const theirs = !!choice && mySeat !== undefined && choice.offender === mySeat && settled && !activeMatchIsPractice
  if (!choice) foulChoiceSent = false
  if (!mine && !theirs && !foulChoiceCard) return
  ensureFoulChoiceUi()
  if (foulChoiceCard && foulChoiceCard.hidden === mine) {
    foulChoiceCard.hidden = !mine
    if (mine) {
      for (const button of foulChoiceCard.querySelectorAll('button')) (button as HTMLButtonElement).disabled = foulChoiceSent
    }
  }
  if (foulChoiceWaitNote && foulChoiceWaitNote.hidden === theirs) foulChoiceWaitNote.hidden = !theirs
}

/** Takes the foul-choice card down, for leaving a match. */
function removeFoulChoiceUi(): void {
  foulChoiceCard?.remove()
  foulChoiceWaitNote?.remove()
  foulChoiceCard = null
  foulChoiceWaitNote = null
  foulChoiceSent = false
}

/**
 * Plays my shot on this device the moment it is struck (see game/predictShot.ts). Only
 * for a plain shot from a settled table: with the cue ball in hand, or anything still
 * moving or queued, the server's recording is waited for as before.
 */
function predictMyShot(shot: Omit<ShotInput, 'timestamp'>): void {
  predictedShot = null
  if (!frame || frame.cueInHand || shotPlayer || queuedUpdates.length > 0 || shotInFlight) return
  try {
    const playback = predictShot(frame.balls, { aimAngle: shot.aimAngle, power: shot.power, spin: shot.spin })
    if (!playback) return
    const startBalls = frame.balls
    predictedShot = {
      player: new ShotPlayer(playback, startBalls as PlaybackBall[]),
      playback,
      startBalls,
      preRoll: scene3d?.strikeRemainingSeconds() ?? 0,
      startedAt: performance.now()
    }
    // The sounds and the camera follow this copy from the start; the server's recording
    // of the same shot takes them over without starting them again.
    replaySfx?.shotStarted(playback, startBalls)
    scene3d?.planShotCamera(playback)
  } catch {
    predictedShot = null
  }
}

/** Drops my shot's own copy: the server refused the shot, or never answered. The table goes back to the truth. */
function abandonPredictedShot(): void {
  if (!predictedShot) return
  predictedShot = null
  replaySfx?.shotEnded()
  scene3d?.planShotCamera(null)
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
  predictedShot = null
  replaySfx?.shotEnded()
  shotPreRoll = 0
  shotStartBalls = null
  queuedUpdates.length = 0
  shotInFlight = false
  markTableReleased()
  deferredPots = []
  // Nothing is being watched any more, so there is no shot to acknowledge. Clearing
  // the token stops a later finish from claiming credit for a replay that was
  // dropped, which would release a hold this client never watched through.
  playedToken = undefined
  // A held verdict belongs to a replay that is being thrown away. The authoritative
  // snapshot arrives with its own events, so reporting this one now would be stale.
  deferredVerdict = []
  syncMusicDuck()
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
  if (data.playback) {
    shotTimer.freeze()
    tableReleased = false
  } else {
    applyTurnTiming(data.turn)
  }

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
    // Kept for the recap at the end of the match. A copy: the table goes on from here.
    lastShotRecap = { playback: data.playback, start: (previous.balls as PlaybackBall[]).map((ball) => ({ ...ball })) }
    shotInFlight = true
    const opponentsShot = mySeat !== undefined && previous.turnIndex !== mySeat
    // My own shot has been playing on this device since it was struck. The server's
    // recording is the same shot, so it picks up from exactly where that copy has got to:
    // no restart, no pause. The sounds and the camera were set up by that copy already.
    const adopted = !opponentsShot ? predictedShot : null
    predictedShot = null
    shotStartBalls = previous.balls
    if (adopted) {
      shotPreRoll = Math.max(0, adopted.preRoll)
      const reached = adopted.player.time
      if (reached > 0) shotPlayer.advance(reached / SHOT_PLAYBACK_SPEED)
    } else {
      // The opponent's cue winds up before their replay runs; my own shot's replay waits for
      // the rest of my stroke, so the ball leaves as the tip meets it, never before.
      shotPreRoll = opponentsShot ? (scene3d?.opponentShotPreRoll(data.playback) ?? 0) : (scene3d?.strikeRemainingSeconds() ?? 0)
      // Sound only: tells the effects a replay has been set up. Nothing comes back.
      replaySfx?.shotStarted(data.playback, previous.balls)
      // Picture only: lets the camera know whether a ball is going to drop, and where.
      scene3d?.planShotCamera(data.playback)
    }
  } else if (data.playback) {
    // Playback arrived with no pre-shot snapshot to start from, so there is nothing
    // to animate. Tell the server straight away rather than stalling the visit.
    shotInFlight = true
    finishShot()
  }
  // A running replay gets the verdict only once the balls have finished moving.
  const verdictDeferred = shotPlayer !== null

  const potted: number[] = []
  // A ball potted in a foul stroke scores nothing for the striker, so its banner must
  // not read as points: the foul banner that follows is the whole verdict.
  const strokeFoul = (data.events ?? []).some((ev) => ev.type === 'FOUL')
  for (const ev of data.events ?? []) {
    if (ev.type === 'BALL_POTTED') {
      const d = ev.data as { ballId: number }
      potted.push(d.ballId)
    } else if (ev.type === 'FOUL') {
      const d = ev.data as { penalty: number; reason?: string; bySeat?: number }
      // The buzzer waits with the message. Hearing a foul announced over the sound of
      // balls still rolling tells the striker the outcome before they have watched the
      // shot that caused it.
      const show = (): void => {
        if (USE_NEW_SFX) emitSfx({ type: 'aux', sound: 'foul' })
        else playFoul()
        // Announced once, centre-screen: the penalty is the headline and the reason sits
        // under it. It used to be said twice, here and again as a toast in the corner.
        hud?.flashEvent(foulHeadline(d.penalty, d.bySeat), 'bad', foulDetail(d.reason))
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
        // No note in the corner: the bell, the score and the frame's own end say it.
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
  // A hard pot is shown again once its replay is over. Only a legal stroke that scored,
  // and never the one that ends the frame: that has a recap of its own at the end.
  pendingHighlight = null
  const frameEnded = (data.events ?? []).some((ev) => ev.type === 'FRAME_END')
  if (shotPlayer && lastShotRecap && !strokeFoul && !frameEnded && potted.length) {
    const highlight = rateShot(lastShotRecap.start, lastShotRecap.playback, potted)
    if (highlight) pendingHighlight = { highlight, playback: lastShotRecap.playback, start: lastShotRecap.start }
  }
  if (potted.length) {
    if (shotPlayer) {
      // Hold the pot feedback until the replay actually drops the ball.
      deferredPots = potted
      deferredPotsFoul = strokeFoul
    } else {
      announcePot(potted, strokeFoul)
    }
  }
  updateHud()
  syncMusicDuck()
}

/**
 * The sound and the message for balls dropping, at the moment they drop.
 *
 * Both halves belong together: the click and the pot noise are what the shot
 * sounds like, so hearing them before the ball reaches the pocket gives the
 * result away ahead of the animation that explains it.
 */
function announcePot(ids: number[], foul = false): void {
  if (ids.length === 0) return
  // The procedural effects play the pocket themselves, from the replay, so the old blips
  // stand down rather than sound on top of them. Off, they play exactly as they did.
  if (!USE_NEW_SFX) {
    playCushion()
    playPot(ids.length)
  }
  // Said once, centre-screen, by the banner below; no second note in the corner.
  if (foul) return
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
    // A reconnect may have missed a challenge push; reconcile from the server.
    void fetchIncomingChallenges()
  })
  socket.on('disconnect', () => {
    connected = false
    updateConnChip()
    updateNetOverlay()
  })

  // Live invitations. My own table never echoes back to me; a table that arrives
  // mid-match is withheld (the layer stays down until the match is over).
  socket.on('challenge:new', (challenge: ChallengeDto) => {
    if (!currentUser || challenge.challengerId === currentUser.id) return
    if (activeMatchId) return
    upsertIncomingChallenge(challenge)
    renderChallengeLayer()
  })
  socket.on('challenge:closed', (payload: { challengeId: string; reason?: string }) => {
    const wasPending = pendingChallenge?.id === payload.challengeId
    removeIncomingChallenge(payload.challengeId)
    if (wasPending) {
      const wasRematch = pendingChallenge?.rematch === true
      pendingChallenge = null
      if (payload.reason === 'declined') {
        toast(wasRematch ? 'Your opponent declined the rematch' : 'Your friend declined the invite', 'error')
      } else if (payload.reason === 'expired') toast('Your table expired — nobody joined')
    }
    renderChallengeLayer()
  })
  socket.on('challenge:matched', (payload: { challengeId: string; matchId: string; opponentUsername: string }) => {
    // I opened this table and somebody took it: close the wait and sit down.
    if (pendingChallenge?.id === payload.challengeId) pendingChallenge = null
    removeIncomingChallenge(payload.challengeId)
    renderChallengeLayer()
    void preloadTableModel().then(() => enterMatch(payload.matchId, false))
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
    // No note in the corner: the scoreboard already names both players.
    updateHud()
  })
  socket.on('match:start', (data: { snapshot: FrameSnapshotData; frameIndex: number; turn?: TurnTiming }) => {
    frameIndex = data.frameIndex
    emitSfx({ type: 'frameStart' })
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
    updateHud()
  })
  socket.on('frame:start', (data: { frameIndex: number; snapshot: FrameSnapshotData; turn?: TurnTiming }) => {
    frameIndex = data.frameIndex
    emitSfx({ type: 'frameStart' })
    // The frame change usually lands straight after the shot that won it, while that
    // shot is still animating, so it queues behind the replay rather than cutting it
    // off. Only the announcement is immediate. The turn timing rides along: it is
    // adopted when the update applies, which is after the replay, when the new frame's
    // table is actually shown.
    handleGameUpdate({ frame: data.snapshot, turn: data.turn })
  })
  socket.on('game:update', (data: GameUpdatePayload) => handleGameUpdate(data))
  // The clock's own channel. The room also changes its clock between table broadcasts
  // — a fresh turn the moment a replay is released, a stop when the striker goes away
  // — and those moments carry no frame of their own, so they are announced here and
  // adopted like any other timing.
  socket.on('opponent:aim', (data: { seat: number; angle: number; power: number }) => {
    if (data.seat === mySeat || !Number.isFinite(data.angle) || !Number.isFinite(data.power)) return
    scene3d?.setOpponentLiveAim(data.angle, data.power)
  })
  socket.on('turn:clock', (data: { turn?: TurnTiming }) => {
    applyTurnTiming(data.turn ?? null)
    markTableReleased()
  })
  socket.on('match:end', (data: { winnerSeat: number; reason?: string; framesWon?: [number, number] }) => {
    stopOpponentCountdown()
    opponentGone = false
    updateOpponentGone()
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
  socket.on('opponent:countdown', (data: { seats?: number[]; seconds?: number }) => {
    // Only the player still here is shown it; a seat that is itself counted down is gone.
    if (mySeat === undefined || (data.seats ?? []).includes(mySeat) || activeMatchIsPractice) return
    opponentGone = true
    startOpponentCountdown(Number(data.seconds) || 30)
  })
  socket.on('opponent:reconnected', (data: { seat: number }) => {
    if (data.seat === mySeat) return
    opponentGone = false
    stopOpponentCountdown()
    updateOpponentGone()
    toast('Opponent reconnected')
  })
  socket.on('match:chat', (data: { seat: number; phraseId: string }) => {
    const text = matchChatPhraseText(data.phraseId)
    if (!text) return
    const sender =
      data.seat === mySeat ? 'You' : (players.find((p) => p.seat === data.seat)?.user.username ?? opponentName())
    appendMatchChat(sender, text)
  })
  socket.on(
    'match:replay',
    () => {
      // Events missed while disconnected are not read out in the corner one by one: the
      // table, the score and the turn the snapshot brings back already show where things
      // stand.
    }
  )
  socket.on('error', (data: { code?: string }) => {
    // A choice the server would not take (the table was not quite settled, say) can be
    // made again rather than leaving both buttons dead.
    if (foulChoiceSent && myFoulChoicePending()) foulChoiceSent = false
    // My shot was refused: the copy already rolling on this device was of a shot that
    // never happened, so it is taken back and the table shows the truth again.
    if (predictedShot && !shotPlayer) abandonPredictedShot()
    // A refusal while a placement commit is in flight is the server rejecting the spot.
    // The snapshot then still says the cue ball is in hand, which looks exactly like a
    // commit that is merely slow, so nothing downstream would ever notice the refusal and
    // the flow would sit in `RETURNING` waiting for an acknowledgement that is not coming -
    // leaving the player at a gameplay view with dead controls and a cue ball they still
    // own. Handing the placement back is what turns that dead end into a retry.
    if (placementCommitInFlight) {
      const recovered = rejectPlacement(placementFlow)
      if (recovered !== placementFlow) {
        placementFlow = recovered
        placementCommitInFlight = false
        // Nothing was put down, so there is no flight to finish and no resume owed. The
        // server is still holding the clock for this placement, which is what it should
        // do: the player is about to try again, and the retry is still part of placing.
        placementResumePending = false
        placementTarget = null
        placementLegal = false
        // The camera is halfway back down to the gameplay view. It has to turn around:
        // finishing that flight would land the player at a view they are not allowed to use.
        if (handlePlacement) {
          // Nothing to fly back to: the ball comes off the spot it was refused at and the
          // handle comes back, where it was.
          scene3d?.holdPlacedCue(null)
          scene3d?.setPlacementAnchor(HANDLE_CAMERA_ANCHOR)
        } else {
          scene3d?.beginPlacementCamera(PLACEMENT_CAMERA_SECONDS)
        }
      }
    }
    toast(`Server: ${data.code ?? 'unknown error'}`, 'error')
  })
  socket.on('announcement:new', (a: Announcement) => {
    receiveAnnouncement(a)
    // Never over a match: a line in the corner now, the card back in the lobby.
    if (activeMatchId) toast(`Announcement: ${a.title}`)
    else showNextAnnouncement()
  })
  socket.on('notification:new', (n: NotificationItem) => {
    notifications.unshift(n)
    if (panelOpen) panelEl?.classList.remove('open')
    toast(`${n.title}${n.body && n.body !== n.title ? ' — ' + n.body : ''}`)
    refreshBell()
    if (n.kind === 'LEVEL_UP' || n.kind === 'RANK_UP' || n.kind === 'BADGE_EARNED') void lobbySession?.refreshProgress()
    if (n.kind === 'SUPPORT_REPLY') refreshSupportChat()
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
 * Tells the server that a placement is under way, so the strike clock is held for it.
 *
 * Once per placement, not once per frame. `stepPlacement` runs every animation frame and
 * re-enters `ENTERING` only on the frame the phase changes, but the declaration has to
 * be safe against the other ways in: the confirm path calls it too, so that a
 * confirmation cannot leave the clock running for the flight home. The server treats a
 * repeated `placement:begin` as a no-op rather than re-holding the clock, so a duplicate
 * here costs a message and nothing else.
 *
 * Nothing here changes the flow or the camera. This is a message about time, not about
 * rules: the server holds the clock for a declared placement and releases it when the
 * ball is down or when its own backstop expires, whichever comes first.
 */
function declarePlacement(): void {
  if (placementDeclared || !activeMatchId) return
  placementDeclared = true
  getSocket().emit('placement:begin', { matchId: activeMatchId })
}

/**
 * Runs the ball-in-hand placement experience for one frame.
 *
 * The camera, the overlays and the ghost are all driven off one phase, from
 * `stepPlacementFlow`: entering, placing, returning. The camera flies up to the overhead
 * view on `ENTERING`, the ghost is only live on `PLACING`, and the flight back to the
 * gameplay view happens on `RETURNING` with the cue ball already locked at the confirmed
 * spot. Input is refused in every phase but `PLACING`, which is what stops the player
 * fighting a camera that is still moving.
 *
 * Nothing here decides a rule: the D restriction comes from the snapshot's
 * `cueInHandInD`, and the legality of any given spot comes from `placementStatus`, which
 * mirrors the server's own test. The server still rejects an illegal placement
 * authoritatively.
 */
function stepPlacement(canvas: HTMLCanvasElement): void {
  const placing = isPlacing()
  const inD = frame?.cueInHandInD === true
  const cameraSettled = scene3d?.isPlacementCameraSettled() ?? true
  // The server has taken the placement once the snapshot stops saying the cue ball is in
  // hand. Nothing else clears it, so a rejected spot cannot be mistaken for a placed one.
  const serverAccepted = !frame?.cueInHand

  const previousPhase = placementFlow.phase
  placementFlow = stepPlacementFlow(placementFlow, { placing, cameraSettled, serverAccepted })

  // The camera is moved exactly once per transition, keyed on the phase having just
  // changed into it. Keying on the phase rather than on a frame-by-frame condition is
  // what stops a move being restarted every frame while it is already running.
  if (placementFlow.phase !== previousPhase) {
    if (placementFlow.phase === 'ENTERING') {
      // A fresh placement: nothing is confirmed, the overlays go up, and the camera
      // starts its flight to the overhead view. The D overlay follows `cueInHandInD`,
      // so this is the break-off case and only the D is shaded.
      placementTarget = null
      placementLegal = false
      placementPendingCommit = null
      placementCommitInFlight = false
      scene3d?.setPlacementMode(true, inD)
      if (handlePlacement) {
        // No flight overhead: the ball is placed from the playing view, so the camera is
        // only told where to stand.
        handlePos = null
        scene3d?.setPlacementAnchor(HANDLE_CAMERA_ANCHOR)
      } else {
        scene3d?.beginPlacementCamera(PLACEMENT_CAMERA_SECONDS)
      }
      // Declared as the placement starts rather than when it is confirmed, because the
      // flight to the overhead view is part of placing and not part of aiming. The
      // player should not spend strike-clock seconds watching a camera move.
      declarePlacement()
    } else if (placementFlow.phase === 'RETURNING') {
      // The flight home happens on `RETURNING` whether the placement was confirmed or
      // withdrawn. Gating this on `confirmed` left the camera stranded overhead when a
      // placement was pulled out from under it mid-flight: nothing was sent to the
      // server, the flow went to `RETURNING`, and with no camera move started the view
      // never came back down.
placementTarget = null
    placementLegal = false
    placementPendingCommit = null
    scene3d?.setPlacementMode(false, false)
    hintPlacement(null)
    scene3d?.endPlacementCamera(placementFlow.confirmed, undefined, PLACEMENT_CAMERA_SECONDS)
    }
  }

  // The ghost is live only in `PLACING`, and the D flag can change between frames (a
  // snapshot arriving late), so the overlays follow it live rather than being latched
  // when the placement began. `cueInHandInD` is true only at break-off, so this is the
  // one place the D is shaded; a mid-frame in-hand leaves the whole table unshaded.
  if (handlePlacement) {
    if (placementAllowsGhostInput(placementFlow) && !placementCommitInFlight && scene3d) {
      scene3d.setPlacementMode(true, inD)
      const snapshotBalls = frame?.balls ?? []
      if (!handlePos) handlePos = firstHandleSpot(inD, snapshotBalls)
      placementTarget = handlePos
      placementLegal = scene3d.updatePlacementGhost(handlePos, inD, snapshotBalls).ok
      hintPlacement('Drag to move the cue ball, then tap the table to place it')
      // Away from the break-off the camera goes with the ball, from behind it, so the
      // player sees where they are putting it. At the break-off it stays behind the D.
      if (!inD) scene3d.setPlacementAnchor(handlePos)
      if (!cueHandle) cueHandle = createCueHandle(moveHandleBall)
      const at = scene3d.tableToScreen(handlePos.x, handlePos.y)
      if (at) {
        const rect = canvas.getBoundingClientRect()
        cueHandle.show(rect.left + (at.x / canvas.width) * rect.width, rect.top + (at.y / canvas.height) * rect.height)
      } else {
        cueHandle.hide()
      }
    } else {
      cueHandle?.hide()
    }
  } else if (placementAllowsGhostInput(placementFlow)) {
    scene3d?.setPlacementMode(true, inD)
    // Track the pointer as the ghost's target. The pointer position is read through the
    // live camera each frame, so the camera easing overhead does not freeze the ghost at
    // a stale spot.
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

  // A click that was accepted fires the placement exactly once. It goes out as a
  // `placement:confirm` carrying only the spot, and never as a shot: this used to be
  // sent as a zero-power `shot:play` with a `cuePos`, which the server could not tell
  // apart from a striker who had swung at nothing, so it placed the ball and then ruled
  // on the empty stroke - a foul, four points against, and the visit handed to the
  // opponent. Confirming moves the flow to `RETURNING`, which starts the camera's
  // flight home.
  if (placementPendingCommit && placementLegal && !placementCommitInFlight && activeMatchId) {
    const pos = placementPendingCommit
    const confirmed = confirmPlacement(placementFlow, pos)
    placementPendingCommit = null
    if (confirmed === placementFlow) {
      // Not in `PLACING`, so the click arrived while a camera move was in flight and is
      // discarded rather than starting a second placement on top of the one running.
      placementLegal = false
    } else {
      placementFlow = confirmed
      placementCommitInFlight = true
      scene3d?.setPlacementMode(false, false)
      hintPlacement(null)
      // The confirmed spot is handed to the camera rather than left for it to work out:
      // the snapshot that carries the placed cue ball has not arrived yet, so resolving it
      // there would aim the flight home at wherever the ball used to be.
      scene3d?.endPlacementCamera(confirmed.confirmed, undefined, PLACEMENT_CAMERA_SECONDS)
      if (handlePlacement) {
        // There was no flight to come home from. The ball is drawn where it was put until
        // the server sends it back, and the camera moves round behind it.
        scene3d?.holdPlacedCue(pos)
        scene3d?.setPlacementAnchor(pos)
        cueHandle?.hide()
      }
      // Declared before confirming, so the clock is already held if the confirmation is
      // slow or is lost and has to be retried. Ordering it the other way round would
      // leave a window where the ball is down and the server is still counting.
      declarePlacement()
      getSocket().emit('placement:confirm', { matchId: activeMatchId, cuePos: { x: pos.x, y: pos.y } })
      // The clock stays held from here until the camera is home. This is the flag that
      // sends the release when that happens.
      placementResumePending = true
      emitSfx({ type: 'aux', sound: 'placeTick' })
    }
  }

  // Back to idle: the camera has landed at the gameplay view and the server has taken the
  // placement, so this player's controls are theirs again.
  if (placementIsOver(placementFlow)) {
    scene3d?.setPlacementMode(false, false)
    if (handlePlacement) {
      scene3d?.setPlacementAnchor(null)
      cueHandle?.hide()
      handlePos = null
    }
    placementTarget = null
    placementPendingCommit = null
    placementCommitInFlight = false
    // The ball is down and the camera is home, which is the point at which the player can
    // actually shoot - so this is where the clock starts again. The server has been holding
    // it since the placement began and resumes it from the time that was left then, so
    // nothing the player spent on the camera or on hunting for a spot is charged to them.
    if (placementResumePending && activeMatchId) {
      placementResumePending = false
      getSocket().emit('placement:done', { matchId: activeMatchId })
    }
    // The next placement has to declare itself again. The hold was released once the ball
    // went down and the camera landed, so leaving this set would leave the next
    // placement's clock running while the player hunted for a spot.
    placementDeclared = false
  }
}

/**
 * Whether the player may aim, fire or charge power right now.
 *
 * Three answers have to agree before the controls come back. `isVisitPlayable` is this
 * client's own: whose turn it is, and whether the table has settled. `placementAllowsGameplayInput`
 * is the flow's, and the scene's `isPlacementTransitionBlocking` is the camera's. Dropping
 * the first of those let the controls come back during a replay or on the opponent's turn,
 * because the placement flow is perfectly happy to be `IDLE` the whole time.
 */
function isInputAllowed(): boolean {
  return (
    isVisitPlayable() &&
    placementAllowsGameplayInput(placementFlow) &&
    !(scene3d?.isPlacementTransitionBlocking() ?? false)
  )
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

/**
 * Whether a cue ball in hand is placed with the handle, from the playing view.
 *
 * On a touch screen. The overhead placement view is a mouse's: the ghost follows a pointer
 * that is always somewhere, and a finger is only somewhere while it is down and is in the
 * way when it is. `?handle=1` turns it on anywhere, for trying it without a phone.
 */
const handlePlacement = ((): boolean => {
  try {
    if (new URLSearchParams(window.location.search).get('handle') === '1') return true
    return window.matchMedia('(pointer: coarse)').matches
  } catch {
    return false
  }
})()
/** Where the ball stands at the moment, while it is being placed with the handle. */
let handlePos: { x: number; y: number } | null = null
/** A finger on the table during a handle placement: where it went down and is now, and whether it has moved. */
let handleDrag: { id: number; startX: number; startY: number; lastX: number; lastY: number; moved: boolean } | null = null
/** How far a finger may wander, in CSS pixels, and still count as a tap rather than a drag. */
const HANDLE_TAP_SLOP_PX = 10
let cueHandle: CueHandle | null = null
/** Where the camera stands for a handle placement: at the back of the D, looking down the table. */
const HANDLE_CAMERA_ANCHOR = { x: D_CENTRE.x - D_ZONE_RADIUS, y: D_CENTRE.y }

/** The first legal spot to stand the ball on: in the D, to one side of the brown, or as near as there is room. */
function firstHandleSpot(inD: boolean, balls: Array<{ id: number; x: number; y: number; potted: boolean }>): { x: number; y: number } {
  const r = D_ZONE_RADIUS
  const tries: Array<[number, number]> = [
    [-0.3, 0.45],
    [-0.3, -0.45],
    [-0.55, 0],
    [-0.5, 0.6],
    [-0.5, -0.6],
    [-0.8, 0.2],
    [-0.8, -0.2],
    [-0.15, 0.75],
    [-0.15, -0.75]
  ]
  for (const [fx, fy] of tries) {
    const at = { x: D_CENTRE.x + fx * r, y: D_CENTRE.y + fy * r }
    if (placementStatus(at, inD, balls).ok) return at
  }
  return { x: D_CENTRE.x - 0.3 * r, y: D_CENTRE.y + 0.45 * r }
}

/**
 * The handle has been dragged: the ball is asked to go to this point on the screen.
 *
 * It goes only if the spot is one the server would take. A drag that leaves the D slides
 * along its edge, so the ball follows the finger round the curve and does not stick the
 * moment the finger strays outside.
 */
function moveHandleBall(clientX: number, clientY: number): void {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null
  if (!canvas || !scene3d || !frame || !placementAllowsGhostInput(placementFlow) || placementCommitInFlight) return
  const rect = canvas.getBoundingClientRect()
  const px = ((clientX - rect.left) / rect.width) * canvas.width
  const py = ((clientY - rect.top) / rect.height) * canvas.height
  const point = scene3d.screenToTable(px, py)
  if (!point) return
  moveHandleBallTo(point)
}

/**
 * A finger dragged across the table moved this far on the screen, in CSS pixels: the ball
 * moves as far across the table as that is at the ball, as the camera sees it now.
 *
 * Worked out from the movement rather than from where the finger is, because the camera
 * follows the ball as it goes, and a point under a still finger moves with the camera.
 */
function dragHandleBall(dxClient: number, dyClient: number): void {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null
  if (!canvas || !scene3d || !handlePos || (dxClient === 0 && dyClient === 0)) return
  const rect = canvas.getBoundingClientRect()
  const sx = canvas.width / Math.max(1, rect.width)
  const sy = canvas.height / Math.max(1, rect.height)
  // How the ball's spot moves on the screen for 100mm along each table axis.
  const step = 100
  const at = scene3d.tableToScreen(handlePos.x, handlePos.y)
  const ax = scene3d.tableToScreen(handlePos.x + step, handlePos.y)
  const ay = scene3d.tableToScreen(handlePos.x, handlePos.y + step)
  if (!at || !ax || !ay) return
  const a = (ax.x - at.x) / step
  const c = (ax.y - at.y) / step
  const b = (ay.x - at.x) / step
  const d = (ay.y - at.y) / step
  const det = a * d - b * c
  if (Math.abs(det) < 1e-6) return
  const px = dxClient * sx
  const py = dyClient * sy
  moveHandleBallTo({ x: handlePos.x + (d * px - b * py) / det, y: handlePos.y + (-c * px + a * py) / det })
}

/** Moves the ball in hand to this point on the table, if the spot is one the server would take. */
function moveHandleBallTo(point: { x: number; y: number }): void {
  if (!scene3d || !frame || !placementAllowsGhostInput(placementFlow) || placementCommitInFlight) return
  const inD = frame.cueInHandInD === true
  let at = { x: point.x, y: point.y }
  if (inD) {
    at.x = Math.min(at.x, D_CENTRE.x)
    const dx = at.x - D_CENTRE.x
    const dy = at.y - D_CENTRE.y
    const d = Math.hypot(dx, dy)
    const reach = D_ZONE_RADIUS - 1
    if (d > reach) at = { x: D_CENTRE.x + (dx / d) * reach, y: D_CENTRE.y + (dy / d) * reach }
  }
  if (placementStatus(at, inD, frame.balls).ok) handlePos = at
}

/** The frame-rate readout, when the address asked for one with `?perf=1`. */
const perfOverlay = createPerfOverlay()

function loop(): void {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null
  try {
    const frameNow = performance.now()
    if (canvas && frame && frameNow < nextFrameAt - FRAME_EARLY_MS) {
      // Too soon: a faster screen than the game needs. Wait for the next one.
      requestAnimationFrame(loop)
      return
    }
    // The next frame is due one interval on; after a stall it starts counting afresh.
    nextFrameAt = frameNow - nextFrameAt > 100 ? frameNow + 1000 / MAX_FPS : nextFrameAt + 1000 / MAX_FPS
    if (canvas && frame) {
      const now = performance.now()
      const fdt = Math.min(200, now - lastFrameTime)
      lastFrameTime = now
      // High is watched as well as Auto. A player who picks High is asking for the
      // sharpest picture the machine can hold smoothly, not for a slideshow: if frames run
      // long the resolution gives a little, by the same small steps Auto uses and never
      // below the same floor, and comes back when there is room.
      const watched = adaptiveQuality || qualityConfig().name === 'high'
      if (scene3d && watched && renderScaler.step(fdt, now)) {
        const lowered = renderScaler.scale < 1
        applyCanvasSize()
        if (adaptiveQuality) storeRenderScale(renderScaler.scale)
        // Not announced: a note in the corner mid-match is a distraction, and the
        // change is made so that the player does not notice it.
        if (lowered && !renderScaleAnnounced) renderScaleAnnounced = true
      }
      // While a shot replays, the table shows sampled simulation positions; the
      // authoritative snapshot above still drives the HUD and turn state.
      const shown = stepShotPlayback(frame, fdt / 1000)
      const cue = shown.balls.find((b) => b.id === 0 && !b.potted)
      if (cue) cueController?.setCuePosition(cue.x, cue.y)
      // Ball-in-hand placement runs before the camera is set, because it is one
      // of the things that decides what the camera should be doing this frame.
      stepPlacement(canvas)
      // After a foul: the choice card for the player fouled against, once the shot is over.
      syncFoulChoiceUi()
      // Aiming is only offered once the table has genuinely settled: no shot still
      // animating, and nothing waiting behind it. Without this the cue stick and the
      // aim guide were drawn while the balls were still moving. The power slider is
      // enabled by exactly the same condition: it is this player's visit and the
      // balls have stopped.
      //
      // `isInputAllowed` folds in the placement flow as well, so the cue stick, the aim
      // guide and the power bar all come back on the same frame — and stay away on every
      // frame of a placement camera move.
      // Nobody aims while the final shot is being shown again.
      const recapping = recapPlayer !== null
      const canAim = isInputAllowed() && !recapping
      // A mouse resting over the table is re-read as the aim once the camera is down in the
      // aim view: the camera pans under it, so the spot it is over is not standing still.
      if (canAim && scene3d?.isAimViewSettled()) cueController?.refreshAim()
      hud?.setPowerEnabled(canAim)
      const renderOptions = {
        aim: cueController?.aim,
        youSeat: mySeat,
        immediate: shotPlayer !== null || predictedShot !== null || recapping,
        canAim
      }
      if (scene3d) {
        // The view the player picked, and whether the balls are moving. A shot overrides
        // the view for as long as it lasts, then hands it back.
        scene3d.setCameraMode(cameraMode)
        scene3d.setTracking(shotPlayer !== null || predictedShot !== null || recapping)
        // How fast the replay runs against real time, so the balls turn at the pace they move.
        scene3d.setReplayRate(recapping ? FINAL_SHOT_SPEED * SHOT_PLAYBACK_SPEED : SHOT_PLAYBACK_SPEED)
        // The replay clock, for the pocket camera. Held at the start through the wind-up
        // before an opponent's shot, when the replay has been set up but is not moving.
        scene3d.setShotTime(
          recapPlayer
            ? recapPlayer.time
            : shotPlayer
              ? shotPreRoll > 0
                ? 0
                : shotPlayer.time
              : predictedShot
                ? predictedShot.preRoll > 0
                  ? 0
                  : predictedShot.player.time
                : null
        )
        if (cameraToggleEl) {
          cameraToggleEl.hidden = false
          // The toggle is one of the player's normal controls, so it goes away with the
          // rest of them during a placement. The scene already ignores the mode while the
          // placement view is up, but a button that still reads as live and changes its
          // own label while doing nothing is worse than one that is plainly unavailable.
          cameraToggleEl.disabled = !canAim
        }
        const perfStart = perfOverlay ? performance.now() : 0
        scene3d.update(shown, renderOptions)
        const perfMid = perfOverlay ? performance.now() : 0
        scene3d.render()
        perfOverlay?.frame(fdt, perfMid - perfStart, performance.now() - perfMid, () => {
          const scale = renderScaler.scale < 1 ? `  scale ${renderScaler.scale.toFixed(2)}` : ''
          const room = scene3d?.isEnvironmentDetailLow() ? 'cheap room' : 'full room'
          return `${qualityConfig().name}${adaptiveQuality ? ' (auto)' : ''}  ${canvas.width}x${canvas.height}${scale}  ${room}`
        })
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
  if (!tableReleased && releaseWaitTimer === null) releaseWaitTimer = window.setTimeout(markTableReleased, RELEASE_WAIT_MS)
  syncMusicDuck()
}

/**
 * Advances the replay clock and returns the snapshot to draw this frame.
 */
function stepShotPlayback(target: FrameSnapshotData, dtSeconds: number): FrameSnapshotData {
  if (recapPlayer) {
    // The recap of the final shot. It only ever decides what is drawn: it does not touch
    // the live shot, the queue behind it, the sounds, or anything that is sent anywhere.
    if (recapHold > 0 && !recapPlayer.finished) {
      recapHold -= dtSeconds
      return { ...target, balls: recapStart }
    }
    const balls = recapPlayer.advance(dtSeconds * FINAL_SHOT_SPEED)
    if (recapPlayer.finished) {
      // Stand on where it finished for a moment, then hand the table back.
      recapHold += dtSeconds
      if (recapHold > FINAL_SHOT_HOLD_SECONDS) recapDone?.()
    }
    return { ...target, balls }
  }
  if (!shotPlayer && predictedShot) {
    const mine = predictedShot
    if (mine.preRoll > 0) {
      // The tip is still on its way to the ball.
      mine.preRoll -= dtSeconds
      return { ...target, balls: mine.startBalls }
    }
    const balls = mine.player.advance(dtSeconds)
    replaySfx?.tick(mine.player.time, SHOT_PLAYBACK_SPEED, balls, performance.now())
    // Finished before the server has answered: it stands where it stopped until it does.
    // Only a lost connection keeps it waiting this long; then the truth is put back.
    if (mine.player.finished && performance.now() - mine.startedAt > mine.playback.duration * 1000 + PREDICTED_SHOT_BACKSTOP_MS) {
      abandonPredictedShot()
      return target
    }
    return { ...target, balls }
  }
  if (shotPlayer && shotPreRoll > 0 && shotStartBalls) {
    // The opponent's cue is still winding up: the table stands exactly as it was before
    // the shot, and the replay has not been started.
    shotPreRoll -= dtSeconds
    return { ...target, balls: shotStartBalls }
  }
  if (shotPlayer) {
    const balls = shotPlayer.advance(dtSeconds)
    // Sound only: where the replay has got to, so the effects follow the picture.
    replaySfx?.tick(shotPlayer.time, SHOT_PLAYBACK_SPEED, balls, performance.now())
    if (deferredPots.length) {
      const due = shotPlayer.takeDuePots()
      if (due.length) {
        const ids = deferredPots.filter((id) => due.includes(id))
        announcePot(ids, deferredPotsFoul)
        deferredPots = deferredPots.filter((id) => !due.includes(id))
      }
    }
    if (!shotPlayer.finished) {
      return { ...target, balls }
    }
    // A pot whose timestamp never arrived would otherwise be silently dropped.
    if (deferredPots.length) {
      announcePot(deferredPots, deferredPotsFoul)
    }
    // The balls have stopped moving, so the shot's verdict can be reported now.
    if (deferredVerdict.length) {
      const verdicts = deferredVerdict
      deferredVerdict = []
      for (const show of verdicts) show()
    }
    shotPlayer = null
    deferredPots = []
    replaySfx?.shotEnded()
    // A highlight plays before the shot is reported done, so the room holds the next
    // turn's clock while it is on screen. Not when another shot is already waiting.
    const highlight = pendingHighlight
    pendingHighlight = null
    if (highlight && queuedUpdates.length === 0) playHighlight(highlight)
    else finishShot()
  }

  // This shot is done, so the table shows its settled state and any shot that was
  // held up starts animating now.
  if (queuedUpdates.length > 0) {
    const next = queuedUpdates.shift()!
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
    ? 'Maintenance mode is ON - players are blocked. Turn it off in the admin app (Settings).'
    : 'The platform is briefly under maintenance. Please check back soon.'
  el.appendChild(p)
  document.body.appendChild(el)
  maintenanceEl = el
}

async function init(): Promise<void> {
  document.title = APP_TITLE
  // Start the table model download now, in parallel with the auth/lobby boot. The
  // online path has no loading screen to await it in, so `tableModelIfReady()` has
  // to be able to answer by the time a scene is built; a cached, warmed download is
  // what makes that true.
  void preloadTableModel()
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
    armMusic()
    document.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
  }
  document.addEventListener('pointerdown', unlock)
  window.addEventListener('keydown', unlock)
  let booted = false
  const finishBoot = (): void => {
    if (!booted) {
      booted = true
      requestAnimationFrame(loop)
      void refreshMaintenance()
      window.setInterval(refreshMaintenance, 10000)
    }
    render()
  }

  // Paint sign-in before any network call. A phone cannot reach 10.0.2.2, and a
  // fetch with no timeout used to sit on the empty gradient forever.
  finishBoot()

  const startSession = (user: SessionUser, sessionToken: string): void => {
    token = sessionToken
    storeToken(sessionToken)
    currentUser = user
    handleSocketEvents(connectSocket(sessionToken))
    void fetchNotifications()
    void fetchIncomingChallenges()
    void fetchAnnouncements()
    void askForDateOfBirthIfMissing(() => activeMatchId !== null, (message, kind) => toast(message, kind))
  }
  // A stored token is checked before anything uses it; a stale one is dropped and a
  // still-valid session cookie is exchanged for a fresh one. When the server cannot be
  // reached at all, the stored token is kept (a network blip must not sign anyone
  // out) and the sign-in card says the server is offline.
  let unreachable = false
  if (token) {
    try {
      const deviceId = await getDeviceId()
      const data = await api<{ authenticated: boolean; user?: SessionUser }>(`/auth/status?deviceId=${encodeURIComponent(deviceId)}`, {
        timeoutMs: FAST_TIMEOUT_MS
      })
      if (data.authenticated && data.user) startSession(data.user, token)
      else throw new Error('stale session')
    } catch (error) {
      if (isUnreachable(error)) unreachable = true
      else {
        token = ''
        clearStoredToken()
      }
    }
  }
  if (!currentUser && !unreachable) {
    try {
      const data = await api<{ user: SessionUser; token: string }>('/auth/session', { timeoutMs: FAST_TIMEOUT_MS })
      startSession(data.user, data.token)
    } catch (error) {
      // No session at all is the ordinary case; only an unreachable server is news.
      if (isUnreachable(error)) unreachable = true
    }
  }
  if (!currentUser && unreachable) setAuthOfflineNotice(true)
  checkingSession = false
  finishBoot()
}

// Debug only: opened with ?tabledebug, the page reports how its drawn table compares
// with the server's (see Scene3D.debugTableCheck). Nothing is exposed otherwise.
if (new URLSearchParams(window.location.search).has('tabledebug')) {
  ;(window as unknown as { __tableCheck: () => unknown }).__tableCheck = () => ({
    matchId: activeMatchId,
    seat: mySeat,
    settled: shotPlayer === null && predictedShot === null && queuedUpdates.length === 0 && !shotInFlight,
    turn: frame?.turnIndex ?? null,
    balls: frame?.balls ?? [],
    frame,
    issues: frame && scene3d ? scene3d.debugTableCheck(frame.balls) : ['no table']
  })
}

void init()
