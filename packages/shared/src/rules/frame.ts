import { BALL_DIAMETER, BALL_IDS, BALL_RADIUS, BAULK_LINE_X, COLOR_ORDER, COLOR_VALUES, D_RADIUS, TABLE_LENGTH, TABLE_WIDTH, TOTAL_REDS, normalizeRedCount } from '../constants.js'
import { layoutTableBalls, pocketPositions } from '../physics/layout.js'
import { simulateStroke } from '../physics/world.js'
import type { SimOptions } from '../physics/world.js'
import type { SimKeyframe, SimResult, SimShot } from '../events.js'
import { buildInitialBalls, type FoulChoice, type FoulRestore, type FrameState, type MatchState } from '../state.js'
import { vec, type Vec2 } from '../vec.js'
import { applyResolution, resolveStroke, respotBall, lowestRemainingColour, isColourId, isRedId } from './snooker.js'
import type { StrokeResolution } from './snooker.js'

export function createFrame(breakIndex = 0, reds: number = TOTAL_REDS): FrameState {
  const colorsRemaining = new Set<number>(COLOR_ORDER)
  const totalReds = normalizeRedCount(reds)
  return {
    balls: layoutTableBalls(totalReds),
    turnIndex: breakIndex,
    ballOn: 'RED',
    phase: 'PLAYING',
    scores: { player0: 0, player1: 0 },
    breakScore: 0,
    pottedOrder: [],
    remainingReds: totalReds,
    totalReds,
    colorsRemaining,
    cueInHand: true,
    cueInHandInD: true
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
  // Taken before the cue ball is placed, so a replay after a foul starts with it back in hand.
  const before = restorePoint(frame)
  placeCueIfInHand(frame, shot)
  // A stroke played is the choice made: whoever plays it has chosen to play on.
  frame.foulChoice = null
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
  // Ball in hand is only when the cue ball has left the table. In snooker that ball is
  // played from the D — the break-off and every later in-off alike. A foul that leaves
  // the cue ball on the cloth does not let anyone pick it up and move it.
  frame.cueInHand = sim.cuePotted
  frame.cueInHandInD = frame.cueInHand
  const end = maybeEndFrame(frame)
  // A foul hands the opponent the choice of playing on or making the offender play again.
  if (resolution.foul && !end.frameEnded && frame.turnIndex !== shooterIndex) {
    frame.foulChoice = { offender: shooterIndex, chooser: frame.turnIndex, restore: before }
  }
  alignPlaybackWithFrame(sim, frame)
  return { resolution, sim, frameEnded: end.frameEnded, frameWinner: end.frameWinner, pottedRedsCount }
}

function restorePoint(frame: FrameState): FoulRestore {
  return {
    balls: frame.balls.map(copyBall),
    ballOn: typeof frame.ballOn === 'object' ? { ...frame.ballOn } : frame.ballOn,
    colorsRemaining: [...frame.colorsRemaining],
    remainingReds: frame.remainingReds,
    cueInHand: frame.cueInHand,
    cueInHandInD: frame.cueInHandInD
  }
}

function copyBall<T extends { pos: Vec2; vel: Vec2; spin: Vec2 }>(ball: T): T {
  return { ...ball, pos: { ...ball.pos }, vel: { ...ball.vel }, spin: { ...ball.spin } }
}

/**
 * The player a foul was committed against makes their choice. `playAgain` puts every ball
 * back where it was before the foul and gives the offender the same shot again (the
 * penalty points stand); otherwise the chooser plays on from the position as it is. Either
 * way it is a fresh visit.
 *
 * Returns false, changing nothing, when there is no choice pending or this is not the
 * player whose choice it is.
 */
export function applyFoulChoice(frame: FrameState, chooser: number, playAgain: boolean): boolean {
  const choice = frame.foulChoice
  if (!choice || choice.chooser !== chooser) return false
  frame.foulChoice = null
  if (playAgain) {
    frame.turnIndex = choice.offender
    frame.breakScore = 0
    const restore = choice.restore
    if (restore) {
      frame.balls = restore.balls.map(copyBall)
      frame.ballOn = typeof restore.ballOn === 'object' ? { ...restore.ballOn } : restore.ballOn
      frame.colorsRemaining = new Set(restore.colorsRemaining)
      frame.remainingReds = restore.remainingReds
      frame.cueInHand = restore.cueInHand
      // An in-hand that is put back is played from the D, including one saved by an
      // older build that had cleared the flag.
      frame.cueInHandInD = restore.cueInHand
      frame.phase = frame.remainingReds === 0 && frame.colorsRemaining.size > 0 ? 'COLOURING_UP' : 'PLAYING'
    }
  }
  return true
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

/**
 * Where the striker's cue ball may be put down, or null if they may not put it there.
 *
 * Ball in hand is always the D. That is the break-off, and it is also every later
 * in-hand: the cue ball potted or otherwise off the table. A foul that leaves the cue
 * ball on the cloth is not ball in hand — the incoming player plays it from where it
 * lies. There is no placement "anywhere on the table" in snooker.
 *
 * Inside the D it still has to be placeable: on the cloth, clear of the pockets, and
 * not sitting inside another ball. Those bounds are checked before the D so a spot
 * that fails them is refused for that reason, not described as merely outside the D.
 */
function resolveCuePlacement(frame: FrameState, cuePos: { x: number; y: number }): Vec2 | null {
  if (!Number.isFinite(cuePos.x) || !Number.isFinite(cuePos.y)) return null
  if (!isOnTable(cuePos)) return null
  if (isInsideAPocket(cuePos)) return null
  if (isCrowded(frame, cuePos)) return null
  if (!isInsideD(cuePos)) return null
  return vec(cuePos.x, cuePos.y)
}

/** Whether the cue ball in hand may be put down at `pos`, by the same rules a placement is judged by. */
export function canPlaceCueBall(frame: FrameState, pos: { x: number; y: number }): boolean {
  return frame.cueInHand && resolveCuePlacement(frame, pos) !== null
}

function isInsideD(pos: { x: number; y: number }): boolean {
  const dx = pos.x - BAULK_LINE_X
  const dy = pos.y - TABLE_WIDTH / 2
  return pos.x <= BAULK_LINE_X && dx * dx + dy * dy <= D_RADIUS * D_RADIUS
}

/** Why a placement was refused, in the words the client can act on. */
export type CuePlacementRefusal = 'not-in-hand' | 'off-table' | 'in-pocket' | 'crowded' | 'outside-D' | 'bad-input'

export interface CuePlacementOutcome {
  ok: boolean
  /** The spot as it was accepted, or null when it was refused. */
  placed: Vec2 | null
  reason: CuePlacementRefusal | null
  /**
   * True when the ball was already down and nothing had to be done.
   *
   * A placement confirmation that arrives twice - a retried socket message, a client
   * that reloaded mid-flight - must land on the state the first one produced, not on a
   * second placement that moves the ball again. Reporting that case separately lets the
   * caller treat it as success without pretending it placed something.
   */
  alreadyPlaced: boolean
}

/**
 * Puts the cue ball down where the striker chose, and stops there.
 *
 * Placing a ball is not a stroke. It used to be carried on the back of one - the client
 * sent the spot as the `cuePos` of a shot and the server placed the ball and then
 * simulated the stroke as well - which quietly made every placement a shot the player
 * never aimed. Because the placement path sends no power, that stroke moved nothing,
 * made no contact, and the rules layer resolved it exactly as it resolves a striker who
 * failed to hit anything: a foul, the penalty added to the opponent, and the visit handed
 * away. The player had done everything asked of them and still lost four points and the
 * turn, and the next thing they saw was the opponent playing.
 *
 * So this places the ball and changes nothing else. No simulation, no `resolveStroke`,
 * no foul, no points, no turn change, no playback: the visit is still the striker's and
 * the shot they take next is the one they actually aim. Every rule about *where* the ball
 * may go is unchanged and still comes from {@link resolveCuePlacement}, so this widens
 * nothing and relaxes nothing.
 *
 * Idempotent, because a confirmation that arrives twice has to land on the same table.
 */
export function applyCuePlacement(frame: FrameState, cuePos: { x: number; y: number }): CuePlacementOutcome {
  const fail = (reason: CuePlacementRefusal): CuePlacementOutcome => ({
    ok: false,
    placed: null,
    reason,
    alreadyPlaced: false
  })
  if (!frame.cueInHand) {
    // The ball is already down. Nothing to do, and nothing that could move it again.
    return { ok: true, placed: null, reason: null, alreadyPlaced: true }
  }
  const cue = frame.balls.find((b) => b.isCue)
  if (!cue) return fail('not-in-hand')
  if (!Number.isFinite(cuePos?.x) || !Number.isFinite(cuePos?.y)) return fail('bad-input')

  const pos = resolveCuePlacement(frame, cuePos)
  if (!pos) {
    if (!isOnTable(cuePos)) return fail('off-table')
    if (isInsideAPocket(cuePos)) return fail('in-pocket')
    if (isCrowded(frame, cuePos)) return fail('crowded')
    if (!isInsideD(cuePos)) return fail('outside-D')
    return fail('bad-input')
  }

  cue.pos.x = pos.x
  cue.pos.y = pos.y
  cue.vel = { x: 0, y: 0 }
  cue.spin = { x: 0, y: 0 }
  cue.angularVel = 0
  frame.cueInHand = false
  // The ball is down. The next in-hand, if the cue leaves the table again, is decided
  // by that stroke and is played from the D like this one was.
  frame.cueInHandInD = false
  return { ok: true, placed: { x: pos.x, y: pos.y }, reason: null, alreadyPlaced: false }
}

/** The cue ball has to be wholly on the cloth, not centred on the cushion line. */
function isOnTable(pos: { x: number; y: number }): boolean {
  return (
    pos.x >= BALL_RADIUS &&
    pos.x <= TABLE_LENGTH - BALL_RADIUS &&
    pos.y >= BALL_RADIUS &&
    pos.y <= TABLE_WIDTH - BALL_RADIUS
  )
}

/**
 * A cue ball placed inside a pocket radius would be potted before it could be struck,
 * so it is not a legal spot to put one down.
 */
function isInsideAPocket(pos: { x: number; y: number }): boolean {
  for (const pocket of pocketPositions()) {
    const dx = pos.x - pocket.x
    const dy = pos.y - pocket.y
    if (dx * dx + dy * dy < pocket.radius * pocket.radius) return true
  }
  return false
}

/** No overlapping a ball that is still on the table: centres at least a diameter apart. */
function isCrowded(frame: FrameState, pos: { x: number; y: number }): boolean {
  for (const ball of frame.balls) {
    if (ball.isCue || ball.potted) continue
    const dx = ball.pos.x - pos.x
    const dy = ball.pos.y - pos.y
    if (dx * dx + dy * dy < BALL_DIAMETER * BALL_DIAMETER) return true
  }
  return false
}

function placeCueIfInHand(frame: FrameState, shot: { cuePos?: { x: number; y: number } }): void {
  if (!frame.cueInHand || !shot.cuePos) return
  const cue = frame.balls.find((b) => b.isCue)
  if (!cue) return
  const pos = resolveCuePlacement(frame, shot.cuePos)
  if (!pos) return
  cue.pos.x = pos.x
  cue.pos.y = pos.y
  cue.vel = { x: 0, y: 0 }
  cue.spin = { x: 0, y: 0 }
  cue.angularVel = 0
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

export function createMatch(matchId: string, matchType: string, format: string, reds: number = TOTAL_REDS): MatchState {
  const count = normalizeRedCount(reds)
  return {
    matchId,
    matchType,
    format,
    reds: count,
    frameIndex: 0,
    framesWon: [0, 0],
    currentFrame: createFrame(0, count)
  }
}

export function newFrameForMatch(match: MatchState, breakIndex: number): FrameState {
  match.frameIndex += 1
  match.currentFrame = createFrame(breakIndex, match.reds)
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
  /** Reds the frame was racked with. Optional: older snapshots meant the full 15. */
  totalReds?: number
  balls: BallSnapshot[]
  phase: FrameState['phase']
  pottedOrder: number[]
  colorsRemaining: number[]
  cueInHand: boolean
  /**
   * True while the cue ball in hand may only be placed in the D. That is every in-hand:
   * the break-off and a cue ball that has left the table. Kept on the snapshot so a
   * client can draw the D without re-deriving the rule. An in-hand snapshot that omits
   * it, or still says otherwise, is read as the D.
   */
  cueInHandInD?: boolean
  winnerIndex?: number
  /** A foul's choice still to be made (see FrameState.foulChoice); absent when there is none. */
  foulChoice?: FoulChoice | null
}

export function frameSnapshot(frame: FrameState): FrameSnapshot {
  return {
    turnIndex: frame.turnIndex,
    ballOn: typeof frame.ballOn === 'string' ? frame.ballOn : `colour:${frame.ballOn.colour}`,
    scores: { ...frame.scores },
    breakScore: frame.breakScore,
    remainingReds: frame.remainingReds,
    totalReds: frame.totalReds,
    balls: frame.balls.map((b) => ({ id: b.id, x: b.pos.x, y: b.pos.y, potted: b.potted })),
    phase: frame.phase,
    pottedOrder: [...frame.pottedOrder],
    colorsRemaining: [...frame.colorsRemaining],
    cueInHand: frame.cueInHand,
    cueInHandInD: frame.cueInHandInD,
    winnerIndex: frame.winnerIndex,
    foulChoice: frame.foulChoice ? { ...frame.foulChoice } : null
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
      angularVel: 0,
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
    totalReds: snapshot.totalReds ?? snapshot.balls.filter((b) => isRedId(b.id)).length,
    colorsRemaining: new Set(snapshot.colorsRemaining),
    cueInHand: snapshot.cueInHand,
    cueInHandInD: snapshot.cueInHand,
    foulChoice: snapshot.foulChoice ? { ...snapshot.foulChoice } : null,
    winnerIndex: snapshot.winnerIndex ?? undefined
  }
}