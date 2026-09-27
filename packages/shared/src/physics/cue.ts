import { MAX_CUE_SPEED, FOLLOW_IMPULSE, DRAW_IMPULSE, SIDE_SPIN_IMPULSE } from '../constants.js'
import type { ShotInput, SimShot } from '../events.js'
import type { BallState } from '../state.js'
import type { Vec2 } from '../vec.js'
import { clamp } from '../vec.js'

export interface CueStatus {
  ball: BallState
  initialVel: Vec2
  appliedFollowDraw: number
  appliedSide: number
}

export function applyShot(ball: BallState, shot: SimShot | ShotInput): CueStatus {
  const power = clamp(shot.power, 0, 1)
  const speed = power * MAX_CUE_SPEED
  const aimX = Math.cos(shot.aimAngle)
  const aimY = Math.sin(shot.aimAngle)
  const spinX = clamp(shot.spin.x ?? 0, -1, 1)
  const spinY = clamp(shot.spin.y ?? 0, -1, 1)
  ball.vel.x = aimX * speed
  ball.vel.y = aimY * speed
  ball.spin.x = spinX
  ball.spin.y = spinY
  return {
    ball,
    initialVel: { x: aimX * speed, y: aimY * speed },
    appliedFollowDraw: spinY > 0 ? spinY * FOLLOW_IMPULSE * speed : spinY < 0 ? spinY * DRAW_IMPULSE * speed : 0,
    appliedSide: spinX * SIDE_SPIN_IMPULSE * speed
  }
}