import { BALL_RADIUS, MAX_CUE_SPEED, TIP_SPIN_RATIO } from '../constants.js'
import type { ShotInput, SimShot } from '../events.js'
import type { BallState } from '../state.js'
import { clamp } from '../vec.js'

/**
 * Applies the cue strike to the cue ball. Power maps linearly onto launch speed
 * and spin is clamped to the -1..1 range the physics layer expects.
 *
 * angularVel is seeded from the tip offset: struck in the centre the ball leaves with
 * no rotation and skids, struck at full top or bottom it leaves turning at
 * `TIP_SPIN_RATIO` times its own pace, forwards or backwards.
 */
export function applyShot(ball: BallState, shot: SimShot | ShotInput): void {
  const power = clamp(shot.power, 0, 1)
  const speed = power * MAX_CUE_SPEED
  const aimX = Math.cos(shot.aimAngle)
  const aimY = Math.sin(shot.aimAngle)
  ball.vel.x = aimX * speed
  ball.vel.y = aimY * speed
  const spinX = clamp(shot.spin.x ?? 0, -1, 1)
  const spinY = clamp(shot.spin.y ?? 0, -1, 1)
  ball.spin.x = spinX
  ball.spin.y = spinY
  // Tip offset × pace → initial rotation. spinY > 0 (top spin) turns the way it travels.
  ball.angularVel = spinY * TIP_SPIN_RATIO * (speed / BALL_RADIUS)
}
