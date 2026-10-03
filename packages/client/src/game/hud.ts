import { BALL_IDS, COLOR_NAMES, COLOR_ORDER, COLOR_VALUES, TOTAL_REDS } from '@snooker/shared'
import { ballColorHex } from './palette.js'
import { createAvatarSlot, updateAvatarSubject } from './avatar.js'
import type { AvatarSlot } from './avatar.js'
import {
  clampPowerLoose,
  easePower,
  powerAdjust,
  powerFromSliderValue,
  powerPercent,
  sliderValueFromPower
} from './power.js'
import { POWER_FINE_STEP } from './power.js'
import {
  pointerToSpin,
  snapToCentre,
  spinAdjust as spinAdjustLocal,
  spinToPixels,
  spinChanged,
  spinCentre,
  type SpinPoint
} from './spinDial.js'

/**
 * The one switch behind the centre of the top bar.
 *
 * The prize and the frames score are money and match state, so they belong on a real
 * table and nowhere else. Practice against the robot has neither, and showing a prize
 * there would be a lie about what the session is worth. The per-match half of that
 * decision is `HudInput.showMatchResult`, which the caller derives from the match
 * type; this constant is the switch to flip if the centre should read differently
 * (a stake instead of a prize, say), without hunting through the markup.
 */
export const SHOW_MATCH_RESULT_IN_HUD = true

/**
 * Whether the points in the frame in progress are on the bar.
 *
 * Deliberately a second switch rather than a corollary of the one above. The prize is
 * what the match is worth and the frames score is its result; a practice session has
 * neither, and showing either there would be a lie about what the session is. The points
 * in the frame are a third thing: the game being played. Hiding them from the one mode
 * where somebody is most likely to be working out how a frame scores is hiding the
 * number they came to watch.
 *
 * So the two decisions are made separately. This constant is the one to flip for a mode
 * that wants a scoreless bar.
 */
export const SHOW_FRAME_SCORES_IN_HUD = true

/**
 * The class on the avatar frame of whoever is at the table.
 *
 * Phase H2's turn timer draws into this same frame, so it is exported as a named
 * hook rather than written inline: the timer needs a stable, addressable element to
 * hang its ring on, and the highlight is what that ring will sit inside.
 */
export const TURN_ACTIVE_CLASS = 'is-turn'

/** The structural slice of a frame snapshot the HUD reads. */
export interface HudSnapshot {
  turnIndex: number
  ballOn: string
  scores: { player0: number; player1: number }
  breakScore: number
  remainingReds: number
  balls: Array<{ id: number; potted: boolean }>
  cueInHand?: boolean
  /**
   * Whether the in-hand is still subject to the D. The D is a break-off restriction,
   * so a mid-frame in-hand is free anywhere on the table and the banner has to say so
   * rather than send the player to the wrong end of the table. Absent reads as
   * unrestricted, which is the safer of the two to guess.
   */
  cueInHandInD?: boolean
}

export interface HudSide {
  name: string
  isBot: boolean
  /** A real profile picture when one exists. Nothing supplies one yet. */
  avatarUrl: string | null
  /** Points in the frame in progress, or null when they are not being shown. */
  points: number | null
  /** True when it is this player's visit. */
  active: boolean
}

export interface HudBallChip {
  id: number
  name: string
  value: number
  /** Still physically on the table. */
  onTable: boolean
  /** The ball the rules say is on. */
  on: boolean
}

export interface HudState {
  you: HudSide
  opponent: HudSide
  prize: string | null
  frames: string | null
  /** Frame number, format and break: the quiet line under the centre of the bar. */
  frameLabel: string
  breakLabel: string | null
  ballOnLabel: string
  /**
   * The points the ball on is worth, when one ball is named: 1 for the reds, the
   * colour's own value otherwise. Null when any colour is on (the value varies)
   * or nothing is named yet, and in both of those cases the badge is hidden.
   */
  ballOnValue: number | null
  /** Hex for the badge's dot, when a single ball is named. */
  ballOnDot: string | null
  /**
   * The cue ball is in hand and has to be placed. This used to be drawn on
   * the 2D canvas only, which meant the 3D table never said it.
   */
  cueInHand: boolean
  /** True while the D still constrains that placement, i.e. the break-off. */
  cueInHandInD: boolean
  /** True when the reds are the ball on, which is what highlights the red dots. */
  redsOn: boolean
  reds: { total: number; remaining: number; onTable: boolean[] }
  colours: HudBallChip[]
}

export interface HudInput {
  snapshot: HudSnapshot | null
  you: { name: string; isBot: boolean; avatarUrl?: string | null }
  opponent: { name: string; isBot: boolean; avatarUrl?: string | null }
  /** Which seat this client is sitting in; undefined until the server says so. */
  mySeat: number | undefined
  showMatchResult: boolean
  prizeCredits: number
  framesWon: [number, number]
  frameIndex: number
  format: string
  /** Practice sessions are labelled as such and never show a prize. */
  practice: boolean
}

function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8
}

/**
 * What the winner is paid, worked out the way the server works it out.
 *
 * Mirrors `settleMatch` in the server's match service: pool is both stakes, the fee
 * is a fraction of the pool, and the prize is what is left. Kept as arithmetic rather
 * than read back from the database so the top bar can show the money on the table
 * from the moment the match is created, which is long before there is a result to
 * read one from.
 */
export function computePrizeCredits(stakePerPlayer: number, commissionPct: number): number {
  const pool = round8(stakePerPlayer * 2)
  const fee = round8(pool * commissionPct)
  return round8(pool - fee)
}

export function formatCredits(value: number): string {
  const rounded = round8(value)
  const text = Number.isInteger(rounded) ? String(rounded) : String(rounded.toFixed(2))
  return `${text} CR`
}

/**
 * The wording for the ball on, in one place.
 *
 * This used to exist twice: once in the app shell and once in the 2D renderer, which
 * is how the two halves of the same screen came to phrase it differently. There is
 * one answer now and the canvas no longer has an opinion.
 */
export function describeBallOn(ballOn: string | undefined): string {
  if (!ballOn || ballOn === 'RED') return 'Ball on: red'
  if (ballOn === 'ANY_COLOUR') return 'Ball on: any colour'
  const match = /colour:(\d+)/.exec(ballOn)
  if (match) return `Ball on: ${COLOR_NAMES[Number(match[1])] ?? 'colour'}`
  return 'Ball on: colour'
}

function colourOn(ballOn: string | undefined): number | null {
  const match = /colour:(\d+)/.exec(ballOn ?? '')
  return match ? Number(match[1]) : null
}

/**
 * Turns a frame snapshot into everything the HUD draws.
 *
 * Pure and renderer-agnostic on purpose: the 3D scene and the 2D fallback both run
 * through this, and the unit tests read it without a DOM. Nothing here reaches for
 * the page, so the HUD cannot come to disagree with the frame state it was handed.
 */
export function deriveHudState(input: HudInput): HudState {
  const snapshot = input.snapshot
  const seat = input.mySeat
  /*
   * Every score in a snapshot is keyed by seat, the same way `turnIndex` is: seat 0's
   * points are `scores.player0`, whoever happens to be sitting there. So the scores are
   * read by seat and the sides are decided by where this client is sitting, rather than
   * the other way round ΓÇö otherwise a client in seat 1 is shown the other player's score
   * under their own name, and the score readout exists to make exactly that impossible.
   */
  const pointsForSeat = (s: number): number | null => (s === 0 ? snapshot?.scores.player0 : snapshot?.scores.player1) ?? null
  const points = (side: 'you' | 'opponent'): number | null =>
    seat === undefined || !snapshot ? null : pointsForSeat(side === 'you' ? seat : 1 - seat)
  const turn: 'you' | 'opponent' | null =
    snapshot && seat !== undefined ? (snapshot.turnIndex === seat ? 'you' : 'opponent') : null

  const showResult = SHOW_MATCH_RESULT_IN_HUD && input.showMatchResult && !input.practice
  /*
   * The points are not gated on the money. They ride the second switch and nothing else,
   * so what a player can see in practice is what they can see in a staked match: the
   * frame's own score. Whether there is a snapshot to read and a seat to read it against
   * is already handled by `points`, which is what keeps the bar from showing a blank
   * before the table has said anything.
   */
  const showScores = SHOW_FRAME_SCORES_IN_HUD
  // The frames score is seat-keyed for the same reason, and it sits directly under the
  // readout, so it reads left to right in the same order: this player, then the other.
  const framesWon =
    seat === undefined ? input.framesWon : seat === 0 ? input.framesWon : [input.framesWon[1], input.framesWon[0]]

  const pottedRed = new Set<number>()
  for (const ball of snapshot?.balls ?? []) {
    if (ball.potted && ball.id >= BALL_IDS.RED_MIN && ball.id <= BALL_IDS.RED_MAX) pottedRed.add(ball.id)
  }

  const anyColour = snapshot?.ballOn === 'ANY_COLOUR'
  const onColour = colourOn(snapshot?.ballOn)

  const colours: HudBallChip[] = COLOR_ORDER.map((id) => {
    const ball = snapshot?.balls.find((b) => b.id === id)
    // A ball that has not arrived in a snapshot yet is treated as still on the table
    // rather than wrongly dimmed, so the strip is never briefly pessimistic.
    const onTable = ball ? !ball.potted : true
    return {
      id,
      name: COLOR_NAMES[id] ?? 'colour',
      value: COLOR_VALUES[id] ?? 0,
      onTable,
      on: onTable && (anyColour || onColour === id)
    }
  })

  return {
    you: {
      name: input.you.name,
      isBot: input.you.isBot,
      avatarUrl: input.you.avatarUrl ?? null,
      points: showScores ? points('you') : null,
      active: turn === 'you'
    },
    opponent: {
      name: input.opponent.name,
      isBot: input.opponent.isBot,
      avatarUrl: input.opponent.avatarUrl ?? null,
      points: showScores ? points('opponent') : null,
      active: turn === 'opponent'
    },
    prize: showResult && input.prizeCredits > 0 ? formatCredits(input.prizeCredits) : null,
    frames: showResult ? `${framesWon[0]} : ${framesWon[1]}` : null,
    frameLabel: input.practice
      ? `Practice ┬╖ frame ${input.frameIndex}`
      : `Frame ${input.frameIndex} ┬╖ ${input.format}`,
    breakLabel: snapshot && snapshot.breakScore > 0 ? `Break ${snapshot.breakScore}` : null,
    ballOnLabel: describeBallOn(snapshot?.ballOn),
    ballOnValue: onColour !== null ? (COLOR_VALUES[onColour] ?? null) : (snapshot?.ballOn ?? 'RED') === 'RED' ? 1 : null,
    ballOnDot:
      onColour !== null
        ? ballColorHex(onColour)
        : (snapshot?.ballOn ?? 'RED') === 'RED'
          ? ballColorHex(BALL_IDS.RED_MIN)
          : null,
    cueInHand: Boolean(snapshot?.cueInHand),
    cueInHandInD: Boolean(snapshot?.cueInHandInD),
    redsOn: (snapshot?.ballOn ?? 'RED') === 'RED',
    reds: {
      total: TOTAL_REDS,
      remaining: snapshot?.remainingReds ?? TOTAL_REDS,
      onTable: Array.from({ length: TOTAL_REDS }, (_, i) => !pottedRed.has(BALL_IDS.RED_MIN + i))
    },
    colours
  }
}

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

/** Writes text only when it would actually change, so an update costs no layout. */
function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value
}

function setFlag(node: HTMLElement, className: string, on: boolean): void {
  if (node.classList.contains(className) !== on) node.classList.toggle(className, on)
}

/**
 * Writes a score and flashes it when the number actually moved.
 *
 * Built on setText so an unchanged score costs nothing, and so the flash is driven
 * by the change rather than by the update ΓÇö a score that is re-sent every frame
 * because the opponent is thinking must not strobe once a second. The class has to
 * be removed and re-added to restart the keyframe, hence the reflow-forcing read.
 */
function setScore(node: HTMLElement, value: string): void {
  if (node.textContent === value) return
  node.textContent = value
  // Clearing the score is not a scoring event ΓÇö the node is about to be hidden
  // anyway, and flashing an empty box reads as a glitch rather than an achievement.
  if (value === '') return
  node.classList.remove('tick-up')
  // Reading layout is what makes the browser treat the re-add as a fresh animation.
  void node.offsetWidth
  node.classList.add('tick-up')
}

/** Hides an element without taking it out of the document, so it can come back. */
function setHidden(node: HTMLElement, hidden: boolean): void {
  if (node.hidden !== hidden) node.hidden = hidden
}

/**
 * An avatar frame, drawn and then given the turn highlight on top.
 *
 * The picture itself comes from `avatar.ts`, shared with the screens outside a match;
 * only the turn flag is the HUD's, because only the HUD knows whose visit it is.
 */
function updateAvatar(slot: AvatarSlot, side: HudSide): void {
  updateAvatarSubject(slot, side)
  setFlag(slot.frame, TURN_ACTIVE_CLASS, side.active)
  if (slot.frame.dataset.turn !== (side.active ? '1' : '0')) {
    slot.frame.dataset.turn = side.active ? '1' : '0'
  }
}

export interface Hud {
  root: HTMLElement
  /** Mounted inside the table frame: the power rail, which overlays the table. */
  overlayRoot: HTMLElement
  /** The spin dial, mounted inside the table frame on the side opposite the rail. */
  spinDialRoot: HTMLElement
  update: (state: HudState) => void
  /** Raises a short-lived centre-screen banner for a key match event. */
  flashEvent: (text: string, tone: 'good' | 'bad' | 'info') => void
  /** Driven per frame by the cue controller, not by update(). */
  setPower: (power: number) => void
  /**
   * Enable or disable the slider. Off while it is not this player's visit or while
   * balls are moving, which is exactly the window `isVisitPlayable` describes.
   */
  setPowerEnabled: (enabled: boolean) => void
  /** Connects the slider's output to whoever owns the real power value. */
  setPowerSink: (sink: (power: number) => void) => void
  /** Told when a slider drag starts and stops, so the controller can be locked out of power writes for the gesture. */
  setPowerDragListener: (listener: ((dragging: boolean) => void) | null) => void
  /**
   * Shows a spin value on the dial, whatever wrote it: the drag, the arrow keys,
   * a reset. The dial is a view of the one spin value, never a second one.
   */
  setSpin: (spin: SpinPoint) => void
  /**
   * Registers where the dial hands its value, the counterpart to `setSpin`. The
   * caller connects the two ends to the same underlying aim, which is what keeps
   * the widget and the arrow keys in step without either knowing the other.
   */
  setSpinSink: (sink: (spin: SpinPoint) => void) => void
  /**
   * The avatar frame of whoever is at the table, or null when nobody is. Phase H2's
   * turn timer hangs off this rather than re-finding it in the document.
   */
  turnFrame: () => HTMLElement | null
}

function sideNodes(nameId: string, pointsId: string): { name: HTMLElement; points: HTMLElement } {
  const name = el('div', 'hud-name')
  name.id = nameId
  const points = el('div', 'hud-points')
  points.id = pointsId
  return { name, points }
}

/**
 * The one HUD, used by both renderers.
 *
 * It is HTML laid over the canvas rather than anything drawn into it, which is what
 * makes the 3D scene and the 2D fallback show the same match: neither renderer knows
 * this component exists. It is also why it must not be rebuilt on a frame ΓÇö the
 * nodes are created once here and every later write is diffed against what is
 * already there.
 */
export function createHud(): Hud {
  const root = el('div', 'hud')
  root.id = 'hud'

  const top = el('div', 'hud-top')
  top.id = 'hud-top'

  const youAvatar = createAvatarSlot({ frameId: 'hud-frame-you', turnKey: 'you' })
  const oppAvatar = createAvatarSlot({ frameId: 'hud-frame-opp', turnKey: 'opponent' })
  const youNames = sideNodes('hud-you', 'hud-points-you')
  const oppNames = sideNodes('hud-opp', 'hud-points-opp')

  const left = el('div', 'hud-side hud-left')
  left.append(youNames.name)
  const right = el('div', 'hud-side hud-right')
  right.append(oppNames.name)

  /**
   * The score readout, in the centre of the bar.
   *
   * Avatar, that player's frame points, a rule, the other player's frame points, their
   * avatar ΓÇö the shape of a scoreline rather than a pair of numbers in opposite corners.
   * The avatars sit inside it rather than at the ends of the bar because the points they
   * belong to are what is being read, and a number next to a face is a scoreline. The
   * turn highlight rides on the avatar frame, so whoever is at the table is still found
   * by the same class on the same element, and the shot clock still hangs inside it.
   */
  const score = el('div', 'hud-score')
  score.id = 'hud-score'
  const sep = el('span', 'hud-score-sep')
  // Decoration: the two numbers are already separated by being on either side of it,
  // so a screen reader is not told about a rule that carries no meaning.
  sep.setAttribute('aria-hidden', 'true')
  score.append(youAvatar.frame, youNames.points, sep, oppNames.points, oppAvatar.frame)

  const centre = el('div', 'hud-centre')
  const prize = el('div', 'hud-prize')
  prize.id = 'hud-prize'
  const frames = el('div', 'hud-frames')
  frames.id = 'hud-frames'
  const frameLabel = el('div', 'hud-frame-label')
  frameLabel.id = 'hud-frame-label'
  const inHand = el('div', 'hud-inhand')
  inHand.id = 'hud-inhand'
  inHand.hidden = true
  centre.append(score, prize, frames, frameLabel, inHand)

  top.append(left, centre, right)

  // Announced rather than shown: the green frame already says whose turn it is, so
  // putting "YOUR TURN" on screen as well would be the same fact twice. A screen
  // reader still needs telling, and this is where it hears it.
  const live = el('div', 'sr-only')
  live.id = 'hud-turn'
  live.setAttribute('role', 'status')
  live.setAttribute('aria-live', 'polite')

  const strip = el('div', 'hud-balls')
  strip.id = 'hud-balls'
  const reds = el('div', 'hud-reds')
  const redDots = el('div', 'hud-red-dots')
  for (let i = 0; i < TOTAL_REDS; i++) {
    const dot = el('span', 'hud-red-dot')
    redDots.appendChild(dot)
  }
  const redCount = el('span', 'hud-red-count')
  redCount.id = 'hud-reds-count'
  reds.append(redDots, redCount)

  const ballOn = el('div', 'hud-ball-on')
  ballOn.id = 'hud-ball-on'
  const ballOnText = el('span', 'hud-ball-on-text')
  // The badge: what the ball on is worth. A red reads +1, a colour its own
  // value, so the shot's stake is on the strip and not only in the rules.
  const ballOnValue = el('span', 'hud-ball-on-value')
  ballOnValue.id = 'hud-ball-on-value'
  ballOnValue.hidden = true
  const brk = el('span', 'hud-break')
  brk.id = 'hud-break'
  ballOn.append(ballOnText, ballOnValue, brk)

  // Center-screen event banners: fouls, pots, ball in hand. Built once, reused;
  // each flash appends a short-lived child that animates itself in and out.
  const eventLayer = el('div', 'event-banner-layer')
  eventLayer.id = 'event-banner-layer'

  const colours = el('div', 'hud-colours')
  for (const id of COLOR_ORDER) {
    const chip = el('span', 'hud-ball')
    chip.dataset.ball = String(id)
    chip.style.setProperty('--ball', ballColorHex(id))
    chip.title = `${COLOR_NAMES[id] ?? 'colour'} ΓÇö ${COLOR_VALUES[id] ?? 0}`
    colours.appendChild(chip)
  }

  strip.append(reds, ballOn, colours)

  /**
   * The power rail, laid over the side of the table.
   *
   * It is a separate root rather than another row of the bar, because it has to sit
   * over the cloth: a control the player's eye is on while they aim should be beside
   * the balls the power is being applied to, not somewhere above them. The caller
   * mounts this inside the table frame.
   *
   * It carries no input of its own: the cue controller owns the value and the rail
   * only shows it, which is why it is transparent to the pointer and can never
   * swallow an aim.
   */
  const overlay = el('div', 'hud-overlay')
  const rail = el('div', 'power-rail')
  rail.id = 'power-rail'
  rail.setAttribute('role', 'group')
  rail.setAttribute('aria-label', 'Shot power')

  /**
   * The accessible slider, laid over the track.
   *
   * The visible rail is aria-hidden, so the semantics live on this element: it takes
   * focus, speaks the range, and answers the keyboard. It precedes the track in the
   * DOM so the stylesheet can draw the focus ring on the track behind it, and it
   * ignores the pointer ΓÇö the track below is the hit target ΓÇö so a click and a key
   * press are two ways into the same value rather than two controls.
   */
  const slider = el('div', 'power-slider')
  slider.id = 'power-slider'
  slider.tabIndex = 0
  slider.setAttribute('role', 'slider')
  slider.setAttribute('aria-label', 'Shot power')
  slider.setAttribute('aria-valuemin', '0')
  slider.setAttribute('aria-valuemax', '100')
  slider.setAttribute('aria-valuenow', '0')
  slider.setAttribute('aria-valuetext', '0%')
  slider.setAttribute('aria-orientation', 'vertical')

  const railValue = el('div', 'power-rail-value')
  railValue.id = 'power-rail-value'
  railValue.textContent = '0%'
  const railTrack = el('div', 'power-rail-track')
  railTrack.setAttribute('aria-hidden', 'true')
  const railFill = el('div', 'power-rail-fill')
  railFill.id = 'power-rail-fill'
  const railHandle = el('div', 'power-rail-handle')
  railHandle.id = 'power-rail-handle'
  railTrack.append(railFill, railHandle)
  rail.append(slider, railValue, railTrack)
  // Mounted here, once, into the overlay the game view attaches inside the table
  // frame. This line is the difference between a slider that exists and one that is
  // on the screen: the rail was built complete but never actually hung anywhere, so
  // the table rendered with nothing over its right edge.
  overlay.appendChild(rail)

  let sliderEnabled = true
  let railDragging = false
  /** True while the slider itself is driving the value, so the cue controller's own eased reset does not fight it. */
  let sliderDriving = false
  /** Told when a slider gesture begins and ends, so the caller can lock the cue controller out of power writes. */
  let powerDragListener: ((dragging: boolean) => void) | null = null

  function railValueFromPointer(event: PointerEvent): number {
    const rect = railTrack.getBoundingClientRect()
    if (rect.height <= 0) return 0
    const travel = (rect.bottom - event.clientY) / rect.height
    return Math.min(1, Math.max(0, travel))
  }

  /** The cue controller owns the value; this is the write-only wire to it, set by the caller. */
  let aimPowerSetter: (power: number) => void = () => {}
  /**
   * Registers where the slider hands its value.
   *
   * The HUD cannot import the cue controller ΓÇö the dependency points the other way,
   * controller ΓåÆ HUD for display ΓÇö so the caller connects the two here at mount.
   */
  function setPowerSink(sink: (power: number) => void): void {
    aimPowerSetter = sink
  }

  function setAria(percent: number, text: string): void {
    slider.setAttribute('aria-valuenow', String(percent))
    slider.setAttribute('aria-valuetext', text)
  }

  function applySliderValue(value: number): void {
    const power = powerFromSliderValue(value)
    aimPowerSetter(power)
    renderRail(power)
    const text = `${powerPercent(power)}%`
    railValue.textContent = text
    setAria(powerPercent(power), text)
  }

  const onRailPointerDown = (event: PointerEvent): void => {
    if (!sliderEnabled) return
    event.preventDefault()
    railDragging = true
    sliderDriving = true
    // The lock is taken before the first write, so the value this press sets cannot
    // be fought by the controller's charge or its eased reset for the whole gesture.
    powerDragListener?.(true)
    stopSliderReset()
    // Capture is locked at pointerdown on the track itself, so every later move and
    // the release arrive here even when the cursor swings off the rail across the
    // table ΓÇö the handle follows the pointer one-to-one with no jumping. The drag
    // also locks the cue controller's power writes for the gesture (via the caller),
    // so nothing can decay the value underneath the finger.
    railTrack.setPointerCapture(event.pointerId)
    applySliderValue(railValueFromPointer(event))
  }
  const endRailDrag = (event: PointerEvent): void => {
    if (!railDragging) return
    railDragging = false
    sliderDriving = false
    powerDragListener?.(false)
    // The displayed value and the eased one are the same number from here on, so the
    // next controller-driven update eases from where the handle actually is rather
    // than from wherever the charge animation had got to.
    railShown = lastRailPower
    if (railTrack.hasPointerCapture(event.pointerId)) railTrack.releasePointerCapture(event.pointerId)
  }
  const onRailPointerUp = endRailDrag
  const onRailPointerMove = (event: PointerEvent): void => {
    if (!railDragging || !sliderEnabled) return
    event.preventDefault()
    applySliderValue(railValueFromPointer(event))
  }
  railTrack.addEventListener('pointerdown', onRailPointerDown)
  railTrack.addEventListener('pointermove', onRailPointerMove)
  railTrack.addEventListener('pointerup', onRailPointerUp)
  railTrack.addEventListener('pointercancel', onRailPointerUp)
  // Safety net for a lost or failed capture: with capture working, the track handler
  // has already ended the drag and this returns early; without it, a release outside
  // the track would never be seen here and the drag ΓÇö and with it the power lock ΓÇö
  // would stick on until the next turn.
  window.addEventListener('pointerup', endRailDrag)
  window.addEventListener('pointercancel', endRailDrag)

  /**
   * The spin dial: a cue ball face-on in the bottom-left of the table frame, the
   * power rail's opposite side. One circle, one crosshair, one dot; the dot's
   * distance from centre is the strike offset, its direction the spin's blend of
   * follow/draw and side. It is a view of ΓÇö and a second way into ΓÇö the same spin
   * value the arrow keys already set, never a second value.
   */
  const spinDial = el('div', 'spin-dial')
  spinDial.id = 'spin-dial'
  spinDial.setAttribute('role', 'application')
  spinDial.setAttribute('aria-label', 'Spin control ΓÇö drag the dot off centre; up topspin, down backspin, left and right side')
  spinDial.tabIndex = 0

  const dialBall = el('div', 'spin-dial-ball')
  dialBall.setAttribute('aria-hidden', 'true')
  const dialDot = el('div', 'spin-dial-dot')
  dialDot.id = 'spin-dial-dot'
  dialDot.setAttribute('aria-hidden', 'true')
  dialBall.appendChild(dialDot)
  spinDial.appendChild(dialBall)

  /** The dot's travel radius in CSS pixels, read from the drawn ball's box. */
  const dialRadius = (): number => dialBall.clientWidth / 2

  /** The last spin this dial rendered, so a drag can diff instead of reflowing every move. */
  let dialShown: SpinPoint = spinCentre()
  /** True while the dial itself is driving the value, so inbound setSpin calls skip the DOM write. */
  let dialDriving = false
  /** The write-only wire to the underlying aim, connected by the caller at mount. */
  let spinSink: (spin: SpinPoint) => void = () => {}

  function renderDial(spin: SpinPoint): void {
    const r = dialRadius()
    const px = spinToPixels(spin, r)
    dialDot.style.transform = `translate(calc(-50% + ${px.x}px), calc(-50% + ${px.y}px))`
    dialDot.style.opacity = spin.x === 0 && spin.y === 0 ? '0.55' : '1'
    dialShown = { x: spin.x, y: spin.y }
  }

  const onDialPointerDown = (event: PointerEvent): void => {
    event.preventDefault()
    dialDriving = true
    spinDial.setPointerCapture(event.pointerId)
    const rect = dialBall.getBoundingClientRect()
    const next = snapToCentre(
      pointerToSpin(event.clientX, event.clientY, rect.left + rect.width / 2, rect.top + rect.height / 2, dialRadius())
    )
    if (spinChanged(dialShown, next)) {
      renderDial(next)
      spinSink(next)
    }
  }
  const onDialPointerMove = (event: PointerEvent): void => {
    if (!dialDriving) return
    event.preventDefault()
    const rect = dialBall.getBoundingClientRect()
    const next = pointerToSpin(
      event.clientX,
      event.clientY,
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
      dialRadius()
    )
    if (spinChanged(dialShown, next)) {
      renderDial(next)
      spinSink(next)
    }
  }
  const endDialDrag = (event: PointerEvent): void => {
    if (!dialDriving) return
    dialDriving = false
    if (spinDial.hasPointerCapture(event.pointerId)) spinDial.releasePointerCapture(event.pointerId)
  }
  spinDial.addEventListener('pointerdown', onDialPointerDown)
  spinDial.addEventListener('pointermove', onDialPointerMove)
  spinDial.addEventListener('pointerup', endDialDrag)
  spinDial.addEventListener('pointercancel', endDialDrag)
  // Keyboard nudges on the same axes the arrow keys use one level up, for a
  // dial that has focus: W/S vertical, left/right side, Home back to centre.
  const onDialKeyDown = (event: KeyboardEvent): void => {
    let next: SpinPoint | null = null
    if (event.key === 'ArrowLeft' || event.key === 'a') next = spinAdjustLocal(dialShown, 'x', -1, POWER_FINE_STEP)
    else if (event.key === 'ArrowRight' || event.key === 'd') next = spinAdjustLocal(dialShown, 'x', 1, POWER_FINE_STEP)
    else if (event.key === 'ArrowUp' || event.key === 'w') next = spinAdjustLocal(dialShown, 'y', 1, POWER_FINE_STEP)
    else if (event.key === 'ArrowDown' || event.key === 's') next = spinAdjustLocal(dialShown, 'y', -1, POWER_FINE_STEP)
    else if (event.key === 'Home' || event.key === 'Escape') next = spinCentre()
    else return
    event.preventDefault()
    event.stopPropagation()
    renderDial(next)
    spinSink(next)
  }
  spinDial.addEventListener('keydown', onDialKeyDown)

  const onSliderKeyDown = (event: KeyboardEvent): void => {
    if (!sliderEnabled) return
    let delta = 0
    if (event.key === 'ArrowUp') delta = POWER_FINE_STEP
    else if (event.key === 'ArrowDown') delta = -POWER_FINE_STEP
    else if (event.key === 'PageUp') delta = 0.2
    else if (event.key === 'PageDown') delta = -0.2
    else if (event.key === 'Home') {
      event.preventDefault()
      applySliderValue(0)
      return
    } else if (event.key === 'End') {
      event.preventDefault()
      applySliderValue(1)
      return
    } else return
    event.preventDefault()
    // The arrows belong to the slider while it holds focus, and must not also turn
    // the spin control, which listens for the same keys one level up.
    event.stopPropagation()
    applySliderValue(powerAdjust(lastRailPower, delta))
  }
  slider.addEventListener('keydown', onSliderKeyDown)

  /** The last power this module rendered, so a new render can diff against it. */
  let lastRailPower = 0

  function renderRail(power: number): void {
    const clamped = clampPowerLoose(power)
    const value = sliderValueFromPower(clamped)
    lastRailPower = clamped
    if (railFill.style.transform !== `scaleY(${clamped})`) railFill.style.transform = `scaleY(${clamped})`
    if (railHandle.style.bottom !== `${value * 100}%`) railHandle.style.bottom = `${value * 100}%`
    setFlag(rail, 'is-charging', clamped > 0.001)
  }

  let sliderResetFrame = 0
  function stopSliderReset(): void {
    if (!sliderResetFrame) return
    cancelAnimationFrame(sliderResetFrame)
    sliderResetFrame = 0
  }

  root.append(top, strip, live, eventLayer)
  // The dial rides the game overlay like the power rail does, so it sits over
  // the cloth it applies to; the caller mounts the overlay inside the frame.
  overlay.appendChild(spinDial)

  // The eased percentage the bar shows, so a jittery raw value does not make the
  // number flicker. Owned by the rail rather than by update(), which is called on
  // state changes and would otherwise have to be called every frame to animate.
  let railShown = 0

  const redDotNodes = [...redDots.children] as HTMLElement[]
  const colourNodes = new Map<number, HTMLElement>()
  for (const chip of [...colours.children] as HTMLElement[]) {
    colourNodes.set(Number(chip.dataset.ball), chip)
  }

  return {
    root,
    overlayRoot: overlay,
    spinDialRoot: spinDial,
    update: (state: HudState) => {
      updateAvatar(youAvatar, state.you)
      updateAvatar(oppAvatar, state.opponent)
      setText(youNames.name, state.you.name)
      setText(oppNames.name, state.opponent.name)
      setScore(youNames.points, state.you.points === null ? '' : String(state.you.points))
      setScore(oppNames.points, state.opponent.points === null ? '' : String(state.opponent.points))
      setHidden(youNames.points, state.you.points === null)
      setHidden(oppNames.points, state.opponent.points === null)

      setText(prize, state.prize ?? '')
      setHidden(prize, state.prize === null)
      setText(frames, state.frames ?? '')
      setHidden(frames, state.frames === null)
      setText(frameLabel, state.frameLabel)
      setHidden(inHand, !state.cueInHand)
      setText(inHand, state.cueInHandInD ? 'Ball in hand ΓÇö place the cue in the D' : 'Ball in hand ΓÇö place the cue anywhere on the table')
      setText(ballOnText, state.ballOnLabel)
      setText(brk, state.breakLabel ?? '')
      setHidden(brk, state.breakLabel === null)
      if (state.ballOnValue !== null && state.ballOnDot !== null) {
        setText(ballOnValue, `+${state.ballOnValue}`)
        ballOnValue.style.setProperty('--badge-dot', state.ballOnDot)
        setHidden(ballOnValue, false)
      } else {
        setHidden(ballOnValue, true)
      }

      setText(redCount, `${state.reds.remaining}`)
      redCount.title = `${state.reds.remaining} of ${state.reds.total} reds left`
      for (let i = 0; i < redDotNodes.length; i++) {
        setFlag(redDotNodes[i]!, 'is-potted', state.reds.onTable[i] === false)
      }
      setFlag(strip, 'reds-on', state.redsOn)
      for (const chip of state.colours) {
        const node = colourNodes.get(chip.id)
        if (!node) continue
        setFlag(node, 'is-potted', !chip.onTable)
        setFlag(node, 'is-on', chip.on)
      }

      const turnText = state.you.active ? 'Your turn' : state.opponent.active ? `${state.opponent.name} to play` : ''
      if (live.textContent !== turnText) live.textContent = turnText
    },
    /**
     * Shows the power the cue controller is about to send.
     *
     * Separate from update() and driven by the caller on its own animation frame,
     * because power changes every frame while a shot is being charged and this must
     * not turn the event-driven HUD into a per-frame one.
     */
    setPower: (power: number) => {
      // While the slider itself is being dragged, it is the authority on what is
      // shown: the controller's eased charge would otherwise drag the handle back
      // down mid-gesture. Any other power change (charging, wheel, keys) is adopted.
      if (sliderDriving) return
      railShown = easePower(railShown, power)
      if (Math.abs(power - railShown) < 0.002) railShown = power
      const percent = powerPercent(railShown)
      const text = `${percent}%`
      if (railValue.textContent !== text) railValue.textContent = text
      renderRail(railShown)
      setAria(percent, text)
    },
    setPowerEnabled: (enabled: boolean) => {
      if (sliderEnabled === enabled) return
      sliderEnabled = enabled
      setFlag(rail, 'is-disabled', !enabled)
      slider.setAttribute('aria-disabled', enabled ? 'false' : 'true')
      if (!enabled) {
        // A turn ending or a shot firing mid-drag has to end the gesture outright ΓÇö
        // including handing power writes back to the controller ΓÇö or the lock would
        // outlive the drag and leave the cue stuck on a number nobody is setting.
        railDragging = false
        sliderDriving = false
        powerDragListener?.(false)
        stopSliderReset()
      }
    },
    setPowerSink: (sink) => {
      setPowerSink(sink)
    },
    setPowerDragListener: (listener) => {
      powerDragListener = listener
    },
    setSpin: (spin) => {
      // While the dial itself is being dragged it is the authority on what is
      // shown; every other writer (arrow keys, reset) is adopted.
      if (dialDriving) return
      if (spinChanged(dialShown, spin)) renderDial(spin)
    },
    setSpinSink: (sink) => {
      spinSink = sink
    },
    /**
     * Raises a centre-screen banner for a key event and retires it itself.
     *
     * Fires are idempotent from the caller's point of view: each call makes a new
     * banner, the layer caps itself at three so a burst of events cannot stack a
     * wall of text, and every banner removes its own node when the exit animation
     * has finished.
     */
    flashEvent: (text: string, tone: 'good' | 'bad' | 'info') => {
      while (eventLayer.children.length >= 3) eventLayer.firstElementChild?.remove()
      const banner = el('div', `event-banner tone-${tone}`)
      banner.setAttribute('role', 'status')
      const label = el('span', 'event-banner-text')
      label.textContent = text
      banner.appendChild(label)
      eventLayer.appendChild(banner)
      // Two frames in before the enter class, so the initial styles are committed
      // and the transition actually runs rather than snapping to the end state.
      requestAnimationFrame(() => {
        banner.classList.add('is-in')
        window.setTimeout(() => {
          banner.classList.remove('is-in')
          banner.classList.add('is-out')
          window.setTimeout(() => banner.remove(), 450)
        }, 1500)
      })
    },
    turnFrame: () => {
      if (youAvatar.frame.classList.contains(TURN_ACTIVE_CLASS)) return youAvatar.frame
      if (oppAvatar.frame.classList.contains(TURN_ACTIVE_CLASS)) return oppAvatar.frame
      return null
    }
  }
}
