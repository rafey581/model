import { MAX_CUE_SPEED } from '../constants.js'
import type { ShotInput, SimShot } from '../events.js'
import type { BallState } from '../state.js'
import { clamp } from '../vec.js'

/**
 * Applies the cue strike to the cue ball. Power maps linearly onto launch speed
 * and spin is clamped to the -1..1 range the physics layer expects.
 */
export function applyShot(ball: BallState, shot: SimShot | ShotInput): void {
  const power = clamp(shot.power, 0, 1)
  const speed = power * MAX_CUE_SPEED
  const aimX = Math.cos(shot.aimAngle)
  const aimY = Math.sin(shot.aimAngle)
  ball.vel.x = aimX * speed
  ball.vel.y = aimY * speed
  ball.spin.x = clamp(shot.spin.x ?? 0, -1, 1)
  ball.spin.y = clamp(shot.spin.y ?? 0, -1, 1)
}
