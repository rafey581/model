import { BALL_IDS, TOTAL_REDS, BAULK_LINE_X, D_RADIUS, TABLE_LENGTH, TABLE_WIDTH, BALL_DIAMETER, POCKET_RADIUS_CORNER, POCKET_RADIUS_MIDDLE } from '../constants.js'
import { buildInitialBalls } from '../state.js'
import type { BallState } from '../state.js'
import type { Vec2 } from '../vec.js'
import { vec } from '../vec.js'

export function cueStartPosition(): Vec2 {
  return vec(BAULK_LINE_X - D_RADIUS * 0.5, TABLE_WIDTH / 2)
}

export function colourSpotPosition(colorId: number): Vec2 {
  switch (colorId) {
    case BALL_IDS.YELLOW:
      return vec(BAULK_LINE_X, TABLE_WIDTH / 2 + D_RADIUS * 0.9)
    case BALL_IDS.GREEN:
      return vec(BAULK_LINE_X, TABLE_WIDTH / 2 - D_RADIUS * 0.9)
    case BALL_IDS.BROWN:
      return vec(BAULK_LINE_X, TABLE_WIDTH / 2)
    case BALL_IDS.BLUE:
      return vec(TABLE_LENGTH / 2, TABLE_WIDTH / 2)
    case BALL_IDS.PINK:
      return vec(TABLE_LENGTH * 0.75, TABLE_WIDTH / 2)
    case BALL_IDS.BLACK:
      return vec(TABLE_LENGTH - 324, TABLE_WIDTH / 2)
    default:
      return vec(TABLE_LENGTH / 2, TABLE_WIDTH / 2)
  }
}

export function redSpotPosition(index: number): Vec2 {
  const pinkX = TABLE_LENGTH * 0.75
  let placed = 0
  for (let row = 0; row < 6 && placed < TOTAL_REDS; row++) {
    const count = row + 1
    for (let c = 0; c < count && placed < TOTAL_REDS; c++) {
      if (placed === index) {
        const x = pinkX + BALL_DIAMETER + row * BALL_DIAMETER * Math.cos(Math.PI / 6)
        const y = TABLE_WIDTH / 2 + (c - (count - 1) / 2) * BALL_DIAMETER
        return vec(x, y)
      }
      placed++
    }
  }
  return vec(pinkX + BALL_DIAMETER, TABLE_WIDTH / 2)
}

export function ballSpotPosition(id: number): Vec2 {
  if (id === BALL_IDS.CUE) return cueStartPosition()
  if (id >= BALL_IDS.RED_MIN && id <= BALL_IDS.RED_MAX) return redSpotPosition(id - BALL_IDS.RED_MIN)
  return colourSpotPosition(id)
}

export function layoutTableBalls(): BallState[] {
  const balls = buildInitialBalls()
  placeBall(balls, BALL_IDS.CUE, cueStartPosition().x, cueStartPosition().y)
  for (const colorId of [BALL_IDS.YELLOW, BALL_IDS.GREEN, BALL_IDS.BROWN, BALL_IDS.BLUE, BALL_IDS.PINK, BALL_IDS.BLACK]) {
    const spot = colourSpotPosition(colorId)
    placeBall(balls, colorId, spot.x, spot.y)
  }

  let redIndex = BALL_IDS.RED_MIN
  for (let i = 0; i < TOTAL_REDS; i++) {
    const spot = redSpotPosition(i)
    placeBall(balls, redIndex, spot.x, spot.y)
    redIndex++
  }
  return balls
}

function placeBall(balls: BallState[], id: number, x: number, y: number): void {
  const ball = balls.find((b) => b.id === id)
  if (!ball) return
  ball.pos.x = x
  ball.pos.y = y
}

export interface Pocket {
  x: number
  y: number
  radius: number
  name: string
  kind: 'corner' | 'middle'
}

export function pocketPositions(): Pocket[] {
  const mid = TABLE_LENGTH / 2
  return [
    { x: 0, y: 0, radius: POCKET_RADIUS_CORNER, name: 'tl', kind: 'corner' },
    { x: mid, y: 0, radius: POCKET_RADIUS_MIDDLE, name: 'tm', kind: 'middle' },
    { x: TABLE_LENGTH, y: 0, radius: POCKET_RADIUS_CORNER, name: 'tr', kind: 'corner' },
    { x: 0, y: TABLE_WIDTH, radius: POCKET_RADIUS_CORNER, name: 'bl', kind: 'corner' },
    { x: mid, y: TABLE_WIDTH, radius: POCKET_RADIUS_MIDDLE, name: 'bm', kind: 'middle' },
    { x: TABLE_LENGTH, y: TABLE_WIDTH, radius: POCKET_RADIUS_CORNER, name: 'br', kind: 'corner' }
  ]
}