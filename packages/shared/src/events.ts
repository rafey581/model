export interface ShotInput {
  aimAngle: number
  power: number
  spin: Vec2
  timestamp: number
  cuePos?: Vec2
}

export interface SimShot {
  aimAngle: number
  power: number
  spin: Vec2
}

export type SimEventType = 'BALL_HIT' | 'CUSHION' | 'POTTED' | 'CUE_POTTED'

export interface SimEvent {
  type: SimEventType
  tick: number
  ballId: number
  otherBallId?: number
}

export interface SimResult {
  balls: BallState[]
  events: SimEvent[]
  firstContactId: number | null
  cuePotted: boolean
  pottedIds: number[]
  settled: boolean
  ticksUsed: number
}

export type GameUpdate =
  | { type: 'SHOT'; seq: number; shot: ShotInput; byIndex: number }
  | { type: 'BALL_POTTED'; seq: number; ballId: number; byIndex: number }
  | { type: 'FOUL'; seq: number; penalty: number; reason: string; byIndex: number }
  | { type: 'TURN_CHANGE'; seq: number; turnIndex: number }
  | { type: 'FRAME_END'; seq: number; winnerIndex: number; scores: { player0: number; player1: number } }
  | { type: 'MATCH_END'; seq: number; winnerIndex: number; reason: string }

import type { BallState } from './state.js'
import type { Vec2 } from './vec.js'