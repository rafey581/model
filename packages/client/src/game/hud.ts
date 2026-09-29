import { BALL_IDS, COLOR_NAMES, COLOR_ORDER, COLOR_VALUES, TOTAL_REDS } from '@snooker/shared'
import { ballColorHex } from './palette.js'

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
   * The cue ball is in hand and has to be placed in the D. This used to be drawn on
   * the 2D canvas only, which meant the 3D table never said it.
   */
  cueInHand: boolean
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
  const points = (index: number): number | null =>
    seat === undefined || !snapshot ? null : index === 0 ? snapshot.scores.player0 : snapshot.scores.player1
  const turn: 'you' | 'opponent' | null =
    snapshot && seat !== undefined ? (snapshot.turnIndex === seat ? 'you' : 'opponent') : null

  const showResult = SHOW_MATCH_RESULT_IN_HUD && input.showMatchResult && !input.practice

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
      points: showResult ? points(0) : null,
      active: turn === 'you'
    },
    opponent: {
      name: input.opponent.name,
      isBot: input.opponent.isBot,
      avatarUrl: input.opponent.avatarUrl ?? null,
      points: showResult ? points(1) : null,
      active: turn === 'opponent'
    },
    prize: showResult && input.prizeCredits > 0 ? formatCredits(input.prizeCredits) : null,
    frames: showResult ? `${input.framesWon[0]} : ${input.framesWon[1]}` : null,
    frameLabel: input.practice
      ? `Practice · frame ${input.frameIndex}`
      : `Frame ${input.frameIndex} · ${input.format}`,
    breakLabel: snapshot && snapshot.breakScore > 0 ? `Break ${snapshot.breakScore}` : null,
    ballOnLabel: describeBallOn(snapshot?.ballOn),
    cueInHand: Boolean(snapshot?.cueInHand),
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

/** Hides an element without taking it out of the document, so it can come back. */
function setHidden(node: HTMLElement, hidden: boolean): void {
  if (node.hidden !== hidden) node.hidden = hidden
}

/**
 * A stable colour per name, so two players on the same table never look like the
 * same avatar. Derived from the name rather than stored, which keeps the HUD free of
 * any per-user state it would have to keep in step with the server.
 */
function hueFor(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360
  return hash
}

const ROBOT_SVG =
  '<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">' +
  '<path d="M16 2.5a1.4 1.4 0 0 1 1.4 1.4v3.2h-2.8V3.9A1.4 1.4 0 0 1 16 2.5Z" fill="#9fd8f2"/>' +
  '<rect x="3.5" y="7.5" width="25" height="18" rx="5" fill="#9fd8f2"/>' +
  '<circle cx="11" cy="15" r="2.6" fill="#14181f"/><circle cx="21" cy="15" r="2.6" fill="#14181f"/>' +
  '<rect x="10" y="20.5" width="12" height="2.4" rx="1.2" fill="#14181f"/>' +
  '</svg>'

interface AvatarSlot {
  frame: HTMLElement
  image: HTMLImageElement
  glyph: HTMLElement
  lastUrl: string | null
  lastMode: '' | 'bot' | 'letter'
  lastInitial: string
  lastHue: number
}

/**
 * An avatar, built once.
 *
 * The real profile picture is a slot rather than a feature: if a caller ever supplies
 * a URL the image is used and the generated default steps aside. Until then the
 * default is a letter for a human and a robot for the bot, both drawn here so the
 * HUD needs no image files.
 */
function createAvatar(frameId: string, turnKey: 'you' | 'opponent'): AvatarSlot {
  const frame = el('div', 'hud-frame')
  frame.id = frameId
  frame.dataset.hudTurnFrame = turnKey

  const image = document.createElement('img')
  image.className = 'hud-avatar-img'
  image.alt = ''
  image.hidden = true

  const glyph = el('div', 'hud-avatar-glyph')
  frame.append(image, glyph)

  return {
    frame,
    image,
    glyph,
    lastUrl: null,
    lastMode: '',
    lastInitial: '',
    lastHue: -1
  }
}

function updateAvatar(slot: AvatarSlot, side: HudSide): void {
  const url = side.avatarUrl
  setHidden(slot.image, !url)
  setHidden(slot.glyph, Boolean(url))
  if (url) {
    if (slot.lastUrl !== url) {
      slot.image.src = url
      slot.lastUrl = url
    }
  } else {
    if (slot.lastUrl !== null) {
      slot.image.removeAttribute('src')
      slot.lastUrl = null
    }
    const mode = side.isBot ? 'bot' : 'letter'
    if (slot.lastMode !== mode) {
      if (mode === 'bot') slot.glyph.innerHTML = ROBOT_SVG
      else slot.glyph.textContent = ''
      slot.lastMode = mode
    }
    if (mode === 'letter') {
      const initial = (side.name.trim()[0] ?? '?').toUpperCase()
      if (slot.lastInitial !== initial) {
        slot.glyph.textContent = initial
        slot.lastInitial = initial
      }
      const hue = hueFor(side.name)
      if (slot.lastHue !== hue) {
        slot.glyph.style.setProperty('--avatar-hue', String(hue))
        slot.lastHue = hue
      }
    }
  }
  setFlag(slot.frame, TURN_ACTIVE_CLASS, side.active)
  if (slot.frame.dataset.turn !== (side.active ? '1' : '0')) {
    slot.frame.dataset.turn = side.active ? '1' : '0'
  }
}

export interface Hud {
  root: HTMLElement
  update: (state: HudState) => void
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
 * this component exists. It is also why it must not be rebuilt on a frame — the
 * nodes are created once here and every later write is diffed against what is
 * already there.
 */
export function createHud(): Hud {
  const root = el('div', 'hud')
  root.id = 'hud'

  const top = el('div', 'hud-top')
  top.id = 'hud-top'

  const youAvatar = createAvatar('hud-frame-you', 'you')
  const oppAvatar = createAvatar('hud-frame-opp', 'opponent')
  const youNames = sideNodes('hud-you', 'hud-points-you')
  const oppNames = sideNodes('hud-opp', 'hud-points-opp')

  const left = el('div', 'hud-side hud-left')
  left.append(youAvatar.frame, youNames.name, youNames.points)
  const right = el('div', 'hud-side hud-right')
  right.append(oppNames.name, oppNames.points, oppAvatar.frame)

  const centre = el('div', 'hud-centre')
  const prize = el('div', 'hud-prize')
  prize.id = 'hud-prize'
  const frames = el('div', 'hud-frames')
  frames.id = 'hud-frames'
  const frameLabel = el('div', 'hud-frame-label')
  frameLabel.id = 'hud-frame-label'
  const inHand = el('div', 'hud-inhand')
  inHand.textContent = 'Ball in hand — place the cue in the D'
  inHand.id = 'hud-inhand'
  inHand.hidden = true
  centre.append(prize, frames, frameLabel, inHand)

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
  const brk = el('span', 'hud-break')
  brk.id = 'hud-break'
  ballOn.append(ballOnText, brk)

  const colours = el('div', 'hud-colours')
  for (const id of COLOR_ORDER) {
    const chip = el('span', 'hud-ball')
    chip.dataset.ball = String(id)
    chip.style.setProperty('--ball', ballColorHex(id))
    chip.title = `${COLOR_NAMES[id] ?? 'colour'} — ${COLOR_VALUES[id] ?? 0}`
    colours.appendChild(chip)
  }

  strip.append(reds, ballOn, colours)
  root.append(top, strip, live)

  const redDotNodes = [...redDots.children] as HTMLElement[]
  const colourNodes = new Map<number, HTMLElement>()
  for (const chip of [...colours.children] as HTMLElement[]) {
    colourNodes.set(Number(chip.dataset.ball), chip)
  }

  return {
    root,
    update: (state: HudState) => {
      updateAvatar(youAvatar, state.you)
      updateAvatar(oppAvatar, state.opponent)
      setText(youNames.name, state.you.name)
      setText(oppNames.name, state.opponent.name)
      setText(youNames.points, state.you.points === null ? '' : String(state.you.points))
      setText(oppNames.points, state.opponent.points === null ? '' : String(state.opponent.points))
      setHidden(youNames.points, state.you.points === null)
      setHidden(oppNames.points, state.opponent.points === null)

      setText(prize, state.prize ?? '')
      setHidden(prize, state.prize === null)
      setText(frames, state.frames ?? '')
      setHidden(frames, state.frames === null)
      setText(frameLabel, state.frameLabel)
      setHidden(inHand, !state.cueInHand)
      setText(ballOnText, state.ballOnLabel)
      setText(brk, state.breakLabel ?? '')
      setHidden(brk, state.breakLabel === null)

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
    turnFrame: () => {
      if (youAvatar.frame.classList.contains(TURN_ACTIVE_CLASS)) return youAvatar.frame
      if (oppAvatar.frame.classList.contains(TURN_ACTIVE_CLASS)) return oppAvatar.frame
      return null
    }
  }
}
