import { BALL_IDS, BALL_DIAMETER, COLOR_VALUES, COLOR_ORDER, RED_VALUE } from '../constants.js'
import { ballSpotPosition } from '../physics/layout.js'
import type { BallOn, FrameScore, FrameState } from '../state.js'
import type { Vec2 } from '../vec.js'
import { vec } from '../vec.js'

export interface StrokeResolution {
  shooterIndex: number
  points: number
  foul: boolean
  foulValue: number
  turnSwitches: boolean
  nextBallOn: BallOn
  respotIds: number[]
  frameEnded: boolean
  frameWinner?: number
  reason?: string
}

export function resolveStroke(frame: FrameState, shooterIndex: number, pottedIds: number[], cuePotted: boolean, firstContactId: number | null): StrokeResolution {
  const ballOn = frame.ballOn
  const requiredColorId = requiredColourId(ballOn, frame)
  const pottedReds = pottedIds.filter(isRedId).length
  const pottedColours = pottedIds.filter(isColourId)
  const legalContact = firstContactId !== null && isLegalContact(firstContactId, ballOn, requiredColorId)

  let foul = false
  let points = 0
  let respotIds: number[] = []
  let foulValue = 0

  if (cuePotted) {
    foul = true
  } else if (!legalContact) {
    foul = true
  } else if (ballOn === 'RED') {
    if (pottedColours.length > 0) {
      foul = true
    } else if (pottedReds > 0) {
      points += pottedReds * RED_VALUE
    }
  } else {
    if (pottedReds > 0) {
      foul = true
    } else if (pottedColours.length === 1 && legalContact) {
      // After a red the striker nominates a colour of their own choice, so any
      // colour they may legally hit scores at its own value. Requiring the lowest
      // remaining colour would have called a perfectly good pot of the black a
      // foul for missing the ball on, and scored it at the yellow's value.
      points += COLOR_VALUES[pottedColours[0]!] ?? 0
    } else if (pottedColours.length > 0) {
      foul = true
    }
  }

  if (foul) {
    foulValue = computeFoulValue(ballOn, requiredColorId, pottedIds)
    respotIds = pottedIds.filter((id) => id !== BALL_IDS.CUE)
  }

  const resolution: StrokeResolution = {
    shooterIndex,
    points,
    foul,
    foulValue,
    turnSwitches: foul || points === 0,
    nextBallOn: ballOn,
    respotIds,
    frameEnded: false
  }

  if (foul) {
    resolution.nextBallOn = nextBallOnAfterVisit(frame)
    resolution.reason = foulReason(cuePotted, legalContact, ballOn, pottedReds, pottedColours)
    return resolution
  }

  resolution.reason = points > 0 ? 'scored' : 'no-ball-potted'

  const redsAfter = frame.remainingReds - pottedReds
  if (ballOn === 'RED') {
    resolution.nextBallOn = pottedReds > 0 ? 'ANY_COLOUR' : nextBallOnAfterVisit(frame)
  } else {
    if (points > 0) {
      const colorPotted = pottedColours.includes(requiredColorId)
      if (redsAfter > 0) {
        respotIds = pottedColours
        resolution.nextBallOn = 'RED'
      } else {
        resolution.nextBallOn = { colour: nextColouringUpColour(frame, requiredColorId, colorPotted) }
      }
    } else {
      resolution.nextBallOn = nextBallOnAfterVisit(frame)
    }
  }
  resolution.respotIds = respotIds

  return resolution
}

export function applyResolution(frame: FrameState, resolution: StrokeResolution, remainingRedsBefore: number): void {
  frame.remainingReds = remainingRedsBefore
  if (resolution.points > 0) {
    if (resolution.shooterIndex === 0) frame.scores.player0 += resolution.points
    else frame.scores.player1 += resolution.points
    frame.breakScore += resolution.points
  }
  if (resolution.foul) {
    const opponent = resolution.shooterIndex === 0 ? 1 : 0
    if (opponent === 0) frame.scores.player0 += resolution.foulValue
    else frame.scores.player1 += resolution.foulValue
    frame.breakScore = 0
  }
  for (const id of resolution.respotIds) {
    if (isColourId(id)) frame.colorsRemaining.add(id)
    respotBall(frame, id)
  }
  if (resolution.turnSwitches) {
    frame.turnIndex = resolution.shooterIndex === 0 ? 1 : 0
    frame.breakScore = 0
  }
  frame.ballOn = resolution.nextBallOn
  frame.phase = frame.remainingReds === 0 && frame.colorsRemaining.size > 0 ? 'COLOURING_UP' : 'PLAYING'
}

export function applyTimeoutFoul(frame: FrameState, shooterIndex: number, reason: string): { foulValue: number; reason: string } {
  const requiredColorId = requiredColourId(frame.ballOn, frame)
  const onValue = frame.ballOn === 'RED' ? RED_VALUE : requiredColorId >= 0 ? (COLOR_VALUES[requiredColorId] ?? RED_VALUE) : RED_VALUE
  const foulValue = Math.max(4, onValue)
  const opponent = shooterIndex === 0 ? 1 : 0
  if (opponent === 0) frame.scores.player0 += foulValue
  else frame.scores.player1 += foulValue
  frame.breakScore = 0
  frame.turnIndex = opponent
  frame.ballOn = nextBallOnAfterVisit(frame)
  frame.phase = frame.remainingReds === 0 && frame.colorsRemaining.size > 0 ? 'COLOURING_UP' : 'PLAYING'
  return { foulValue, reason }
}

export function respotBall(frame: FrameState, id: number): void {
  const ball = frame.balls.find((b) => b.id === id)
  if (!ball) return
  const base = ballSpotPosition(id)
  let pos = base
  if (isOccupied(frame, id, base)) {
    const step = BALL_DIAMETER * 1.1
    const offsets: ReadonlyArray<readonly [number, number]> = [
      [0, step],
      [-step, 0],
      [0, -step],
      [step, 0],
      [0, step * 2],
      [step, step],
      [-step, step]
    ]
    for (const [dx, dy] of offsets) {
      const candidate = vec(base.x + dx, base.y + dy)
      if (!isOccupied(frame, id, candidate)) {
        pos = candidate
        break
      }
    }
  }
  ball.pos.x = pos.x
  ball.pos.y = pos.y
  ball.potted = false
  ball.vel = vec(0, 0)
  ball.spin = vec(0, 0)
}

function isOccupied(frame: FrameState, selfId: number, position: Vec2): boolean {
  for (const ball of frame.balls) {
    if (ball.id === selfId || ball.potted) continue
    const dx = ball.pos.x - position.x
    const dy = ball.pos.y - position.y
    if (dx * dx + dy * dy < BALL_DIAMETER * BALL_DIAMETER) return true
  }
  return false
}

function nextBallOnAfterVisit(frame: FrameState): BallOn {
  if (frame.remainingReds > 0) return 'RED'
  return { colour: lowestRemainingColour(frame) }
}

function nextColouringUpColour(frame: FrameState, pottedColorId: number, wasPotted: boolean): number {
  if (wasPotted && frame.remainingReds === 0) {
    frame.colorsRemaining.delete(pottedColorId)
  }
  return lowestRemainingColour(frame)
}

export function lowestRemainingColour(frame: FrameState): number {
  for (const colorId of COLOR_ORDER) {
    if (frame.colorsRemaining.has(colorId)) return colorId
  }
  return BALL_IDS.BLACK
}

function requiredColourId(ballOn: BallOn, frame: FrameState): number {
  if (ballOn === 'RED') return -1
  if (ballOn === 'ANY_COLOUR') return lowestRemainingColour(frame)
  return ballOn.colour
}

function isLegalContact(ballId: number, ballOn: BallOn, requiredColorId: number): boolean {
  if (ballOn === 'RED') return isRedId(ballId)
  // After a red the ball on is "a colour of the striker's choice", so any colour
  // that is still on the table may be struck first and counts as a legal contact.
  // Demanding one particular colour turned every legal colour-after-a-red shot
  // into a "no legal contact" foul.
  if (ballOn === 'ANY_COLOUR') return isColourId(ballId)
  return ballId === requiredColorId
}

function computeFoulValue(ballOn: BallOn, requiredColorId: number, pottedIds: number[]): number {
  const onValue = ballOn === 'RED' ? RED_VALUE : COLOR_VALUES[requiredColorId] ?? RED_VALUE
  let worst = onValue
  for (const id of pottedIds) {
    const value = COLOR_VALUES[id] ?? 0
    if (value > worst) worst = value
  }
  return Math.max(4, worst)
}

function foulReason(cuePotted: boolean, legalContact: boolean, ballOn: BallOn, pottedReds: number, pottedColours: number[]): string {
  if (cuePotted) return 'cue ball potted'
  if (!legalContact) return 'no legal contact'
  if (pottedReds > 0 && ballOn !== 'RED' || pottedColours.length > 0 && ballOn === 'RED' && pottedReds === 0) return 'wrong ball potted'
  return 'foul'
}

export function bounds<T extends FrameScore>(score: FrameScore): { pointsOnTable: number } {
  return { pointsOnTable: score.player0 + score.player1 }
}

export const isRedId = (id: number): boolean => id >= BALL_IDS.RED_MIN && id <= BALL_IDS.RED_MAX
export const isColourId = (id: number): boolean => Object.prototype.hasOwnProperty.call(COLOR_VALUES, id)