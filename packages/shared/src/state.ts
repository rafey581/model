import { BALL_IDS, COLOR_ORDER, COLOR_VALUES, TOTAL_REDS, normalizeRedCount } from './constants.js'
import { vec } from './vec.js'
import type { Vec2 } from './vec.js'

export interface BallState {
  id: number
  value: number
  isCue: boolean
  isRed: boolean
  isColor: boolean
  pos: Vec2
  vel: Vec2
  /** Tip offset: x = sidespin (−1..1), y = topspin/backspin (−1..1). */
  spin: Vec2
  /** Angular speed about the vertical plane of travel (rad/s, mm-based). */
  angularVel: number
  potted: boolean
  colorName?: string
}

/** Every ball of a frame racked with `reds` reds (ids 1..reds); the colours are always all six. */
export function buildInitialBalls(reds: number = TOTAL_REDS): BallState[] {
  const balls: BallState[] = []
  balls.push(makeBall(BALL_IDS.CUE, 0, true, false, false))
  const lastRed = BALL_IDS.RED_MIN + normalizeRedCount(reds) - 1
  for (let i = BALL_IDS.RED_MIN; i <= lastRed; i++) {
    balls.push(makeBall(i, 1, false, true, false))
  }
  for (const colorId of COLOR_ORDER) {
    const name = colorNameOf(colorId)
    balls.push(makeBall(colorId, COLOR_VALUES[colorId] ?? 0, false, false, true, name))
  }
  return balls
}

function makeBall(
  id: number,
  value: number,
  isCue: boolean,
  isRed: boolean,
  isColor: boolean,
  colorName?: string
): BallState {
  return {
    id,
    value,
    isCue,
    isRed,
    isColor,
    pos: vec(0, 0),
    vel: vec(0, 0),
    spin: vec(0, 0),
    angularVel: 0,
    potted: false,
    colorName
  }
}

export function colorNameOf(colorId: number): string | undefined {
  switch (colorId) {
    case BALL_IDS.YELLOW:
      return 'yellow'
    case BALL_IDS.GREEN:
      return 'green'
    case BALL_IDS.BROWN:
      return 'brown'
    case BALL_IDS.BLUE:
      return 'blue'
    case BALL_IDS.PINK:
      return 'pink'
    case BALL_IDS.BLACK:
      return 'black'
    default:
      return undefined
  }
}

export interface FrameScore {
  player0: number
  player1: number
}

export type BallOn = 'RED' | 'ANY_COLOUR' | { colour: number }

export type FramePhase = 'PLAYING' | 'COLOURING_UP' | 'FRAME_END'

export interface FrameState {
  balls: BallState[]
  turnIndex: number
  ballOn: BallOn
  phase: FramePhase
  scores: FrameScore
  breakScore: number
  pottedOrder: number[]
  remainingReds: number
  /** Reds the frame was racked with (6, 10 or the full 15). */
  totalReds: number
  colorsRemaining: Set<number>
  cueInHand: boolean
  /**
   * Whether the cue ball in hand may only be placed inside the D.
   *
   * The D is a break-off restriction and nothing else. It is true for the opening
   * stroke of a frame and false for every later in-hand — a cue potted mid-frame, an
   * in-off, any other foul — because in real snooker the incoming player may then spot
   * the cue ball anywhere on the table. Carried on the frame rather than inferred from
   * the score, because "has anything been played yet" is the only thing that decides it.
   */
  cueInHandInD: boolean
  winnerIndex?: number
  /**
   * After a foul, the player it was committed against chooses: play on from the position,
   * or have the offender play again from it (WPBSA rules, section 3). Set by the foul,
   * cleared by the choice or by the next stroke. Absent or null: no choice is pending.
   */
  foulChoice?: FoulChoice | null
}

/** Who fouled, and who now chooses whether to play on or make them play again. */
export interface FoulChoice {
  offender: number
  chooser: number
  /**
   * The table as it stood before the foul. When the chooser makes the offender play again,
   * every ball goes back here first, so the offender replays the shot they fouled rather
   * than playing on from the mess it left. The penalty points stand.
   */
  restore?: FoulRestore
}

/** A copy of the parts of a frame a foul can change, taken just before the stroke. */
export interface FoulRestore {
  balls: BallState[]
  ballOn: BallOn
  colorsRemaining: number[]
  remainingReds: number
  cueInHand: boolean
  cueInHandInD: boolean
}

export interface MatchState {
  matchId: string
  matchType: string
  format: string
  /** Reds every frame of this match is racked with (see redsForStake). */
  reds: number
  frameIndex: number
  framesWon: [number, number]
  currentFrame?: FrameState
}

export const TOTAL_COLORS = COLOR_ORDER.length

export const sumRedsValue = (remaining: number): number => remaining * 1

export function cloneBall(b: BallState): BallState {
  return {
    ...b,
    pos: vec(b.pos.x, b.pos.y),
    vel: vec(b.vel.x, b.vel.y),
    spin: vec(b.spin.x, b.spin.y),
    angularVel: b.angularVel ?? 0
  }
}

export type { Vec2 } from './vec.js'