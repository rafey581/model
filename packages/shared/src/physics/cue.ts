import { BALL_RADIUS, MAX_CUE_SPEED } from '../constants.js'
import type { ShotInput, SimShot } from '../events.js'
import type { BallState } from '../state.js'
import { clamp } from '../vec.js'

/**
 * Applies the cue strike to the cue ball. Power maps linearly onto launch speed
 * and spin is clamped to the -1..1 range the physics layer expects.
 *
 * angularVel is seeded from tip offset × launch speed / radius: max topspin
 * starts near natural roll, stun starts sliding (ω ≈ 0).
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
  // Tip offset × power → initial rotation. spinY > 0 (topspin) matches forward roll.
  ball.angularVel = spinY * (speed / BALL_RADIUS)
}
