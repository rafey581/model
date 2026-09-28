import { BALL_IDS, BAULK_LINE_X, COLOR_ORDER, COLOR_VALUES, D_RADIUS, TABLE_WIDTH, TOTAL_REDS } from '../constants.js'
import { layoutTableBalls } from '../physics/layout.js'
import { simulateStroke } from '../physics/world.js'
import type { SimOptions } from '../physics/world.js'
import type { SimKeyframe, SimResult, SimShot } from '../events.js'
import { buildInitialBalls, type FrameState, type MatchState } from '../state.js'
import { vec } from '../vec.js'
import { applyResolution, resolveStroke, respotBall, lowestRemainingColour, isColourId, isRedId } from './snooker.js'
import type { StrokeResolution } from './snooker.js'

export function createFrame(breakIndex = 0): FrameState {
  const colorsRemaining = new Set<number>(COLOR_ORDER)
  return {
    balls: layoutTableBalls(),
    turnIndex: breakIndex,
    ballOn: 'RED',
    phase: 'PLAYING',
    scores: { player0: 0, player1: 0 },
    breakScore: 0,
    pottedOrder: [],
    remainingReds: TOTAL_REDS,
    colorsRemaining,
    cueInHand: true
  }
}

export interface StrokeOutcome {
  resolution: StrokeResolution
  sim: SimResult
  frameEnded: boolean
  frameWinner: number | null
  pottedRedsCount: number
}

export function applyStroke(
  frame: FrameState,
  shooterIndex: number,
  shot: SimShot & { cuePos?: { x: number; y: number } },
  simOptions: SimOptions = {}
): StrokeOutcome {
  placeCueIfInHand(frame, shot)
  const sim = simulateStroke(frame.balls, shot, simOptions)
  frame.balls = sim.balls
  const redsBefore = frame.remainingReds
  const pottedRedsCount = sim.pottedIds.filter((id) => isRedId(id)).length
  const resolution = resolveStroke(frame, shooterIndex, sim.pottedIds, sim.cuePotted, sim.firstContactId)
  frame.remainingReds = redsBefore - (resolution.foul ? 0 : pottedRedsCount)
  for (const id of sim.pottedIds) {
    // The cue ball is not an object ball, so it does not join the frame's running
    // list of potted balls. It is still marked potted below and then respotted.
    if (id !== BALL_IDS.CUE && !frame.pottedOrder.includes(id)) frame.pottedOrder.push(id)
    const ball = frame.balls.find((b) => b.id === id)
    if (ball) ball.potted = true
  }
  applyResolution(frame, resolution, frame.remainingReds)
  if (sim.cuePotted) respotBall(frame, BALL_IDS.CUE)
  frame.cueInHand = sim.cuePotted
  const end = maybeEndFrame(frame)
  alignPlaybackWithFrame(sim, frame)
  return { resolution, sim, frameEnded: end.frameEnded, frameWinner: end.frameWinner, pottedRedsCount }
}

/**
 * Anchors the replay to the real end state.
 *
 * Keyframes are sampled while the simulation runs, but the rules layer then
 * moves balls around afterwards: a colour potted out of turn is respotted, a
 * potted cue ball goes back in hand, and a tied final black is re-racked. Any of
 * those relocations happen after sampling, so the last keyframe describes a
 * table position the game is no longer in, and the client snaps the ball across
 * the table on the final frame.
 *
 * Appending the authoritative positions as one final keyframe makes the replay
 * finish exactly on the state the rules settled on, whatever moved. It costs one
 * small keyframe per shot and keeps the invariant local to the code that can
 * break it.
 */
function alignPlaybackWithFrame(sim: SimResult, frame: FrameState): void {
  const keyframes = sim.keyframes
  if (!keyframes || keyframes.length === 0) return

  const settled: SimKeyframe['balls'] = []
  for (const ball of frame.balls) {
    if (ball.potted) continue
    settled.push([ball.id, Math.round(ball.pos.x), Math.round(ball.pos.y)])
  }

  const last = keyframes[keyframes.length - 1]!
  if (sim.simSeconds > last.t) {
    keyframes.push({ t: sim.simSeconds, balls: settled })
    return
  }
  // The shot ended on its own final sample, so fold these into it rather than
  // emitting two keyframes with the same timestamp.
  for (const [id, x, y] of settled) {
    const at = last.balls.findIndex(([ballId]) => ballId === id)
    if (at >= 0) last.balls[at] = [id, x, y]
    else last.balls.push([id, x, y])
  }
}

function placeCueIfInHand(frame: FrameState, shot: { cuePos?: { x: number; y: number } }): void {
  if (!frame.cueInHand || !shot.cuePos) return
  const cue = frame.balls.find((b) => b.isCue)
  if (!cue) return
  const dx = shot.cuePos.x - BAULK_LINE_X
  const dy = shot.cuePos.y - TABLE_WIDTH / 2
  const inD = shot.cuePos.x <= BAULK_LINE_X && dx * dx + dy * dy <= D_RADIUS * D_RADIUS
  if (!inD) return
  cue.pos.x = shot.cuePos.x
  cue.pos.y = shot.cuePos.y
  cue.vel = { x: 0, y: 0 }
  cue.spin = { x: 0, y: 0 }
}

/**
 * Decides whether the frame is over.
 *
 * A frame does not end when the last ball happens to be potted and left off the
 * table. It ends as soon as one player leads by more than the value of everything
 * still on the table, because at that point the trailing player can no longer catch
 * them however long the frame runs. That is what stops a tied frame on the final
 * black from being traded back and forth for ever: the potter of that black leads by
 * seven with nothing left to win, and the frame is over.
 *
 * With the scores level and the frame still live, the black decides it, so it goes
 * back on its spot ready to be played for the frame.
 */
export function maybeEndFrame(frame: FrameState): { frameEnded: boolean; frameWinner: number | null } {
  if (frame.remainingReds !== 0) {
    return { frameEnded: false, frameWinner: null }
  }

  let remaining = 0
  for (const id of frame.colorsRemaining) {
    remaining += COLOR_VALUES[id] ?? 0
  }

  const lead0 = frame.scores.player0 - frame.scores.player1
  if (lead0 > remaining) {
    frame.phase = 'FRAME_END'
    return { frameEnded: true, frameWinner: 0 }
  }
  if (-lead0 > remaining) {
    frame.phase = 'FRAME_END'
    return { frameEnded: true, frameWinner: 1 }
  }

  if (frame.scores.player0 === frame.scores.player1 && !frame.colorsRemaining.has(BALL_IDS.BLACK)) {
    // Level scores, the frame still live, and no black left to play: the black
    // decides it, so it goes back on its spot. Guarded on the black actually being
    // off the table, otherwise this would hijack the ball on partway through the
    // sequence whenever the scores happened to be level.
    respotBall(frame, BALL_IDS.BLACK)
    frame.colorsRemaining.add(BALL_IDS.BLACK)
    frame.ballOn = { colour: BALL_IDS.BLACK }
    frame.phase = 'PLAYING'
  }
  return { frameEnded: false, frameWinner: null }
}

export function framesToWin(format: string): number {
  switch (format) {
    case 'BO1':
      return 1
    case 'BO3':
      return 2
    case 'BO5':
      return 3
    default:
      return 1
  }
}

export function createMatch(matchId: string, matchType: string, format: string): MatchState {
  return {
    matchId,
    matchType,
    format,
    frameIndex: 0,
    framesWon: [0, 0],
    currentFrame: createFrame(0)
  }
}

export function newFrameForMatch(match: MatchState, breakIndex: number): FrameState {
  match.frameIndex += 1
  match.currentFrame = createFrame(breakIndex)
  return match.currentFrame
}

export function applyFrameWinner(match: MatchState, frameWinner: number, endReason?: string): boolean {
  const winner = frameWinner === 1 ? (1 as const) : (0 as const)
  match.framesWon[winner] += 1
  match.currentFrame = undefined
  const target = framesToWin(match.format)
  return match.framesWon[winner] >= target
}

export function matchWinnerIndex(match: MatchState): number {
  const target = framesToWin(match.format)
  if (match.framesWon[0] >= target) return 0
  if (match.framesWon[1] >= target) return 1
  return -1
}

export function concedeWinner(match: MatchState, concedingIndex: number): number {
  return concedingIndex === 0 ? 1 : 0
}

export interface BallSnapshot {
  id: number
  x: number
  y: number
  potted: boolean
}

export interface FrameSnapshot {
  turnIndex: number
  ballOn: string
  scores: { player0: number; player1: number }
  breakScore: number
  remainingReds: number
  balls: BallSnapshot[]
  phase: FrameState['phase']
  pottedOrder: number[]
  colorsRemaining: number[]
  cueInHand: boolean
  winnerIndex?: number
}

export function frameSnapshot(frame: FrameState): FrameSnapshot {
  return {
    turnIndex: frame.turnIndex,
    ballOn: typeof frame.ballOn === 'string' ? frame.ballOn : `colour:${frame.ballOn.colour}`,
    scores: { ...frame.scores },
    breakScore: frame.breakScore,
    remainingReds: frame.remainingReds,
    balls: frame.balls.map((b) => ({ id: b.id, x: b.pos.x, y: b.pos.y, potted: b.potted })),
    phase: frame.phase,
    pottedOrder: [...frame.pottedOrder],
    colorsRemaining: [...frame.colorsRemaining],
    cueInHand: frame.cueInHand,
    winnerIndex: frame.winnerIndex
  }
}

export function frameFromSnapshot(snapshot: FrameSnapshot): FrameState {
  const byId = new Map(buildInitialBalls().map((b) => [b.id, b] as const))
  const balls = snapshot.balls.map((b) => {
    const meta = byId.get(b.id) ?? { value: 0, isCue: false, isRed: false, isColor: false, colorName: undefined }
    return {
      ...meta,
      id: b.id,
      pos: vec(b.x, b.y),
      vel: vec(0, 0),
      spin: vec(0, 0),
      potted: b.potted
    }
  })
  return {
    balls,
    turnIndex: snapshot.turnIndex,
    ballOn: snapshot.ballOn === 'RED' ? 'RED' : snapshot.ballOn === 'ANY_COLOUR' ? 'ANY_COLOUR' : { colour: Number(snapshot.ballOn.split(':')[1]) },
    phase: snapshot.phase,
    scores: { ...snapshot.scores },
    breakScore: snapshot.breakScore,
    pottedOrder: [...snapshot.pottedOrder],
    remainingReds: snapshot.remainingReds,
    colorsRemaining: new Set(snapshot.colorsRemaining),
    cueInHand: snapshot.cueInHand,
    winnerIndex: snapshot.winnerIndex ?? undefined
  }
}