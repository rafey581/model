import { BALL_RADIUS, BALL_RESTITUTION, CUSHION_TANGENTIAL_DAMP } from '../constants.js'
import type { Vec2 } from '../vec.js'

/**
 * Reflects velocity off a cushion running vertically (left/right rails).
 * Only the normal component is reversed and damped by `restitution`; the
 * tangential component is scaled by `tangentialDamp`, which is what makes a
 * ball lose energy along the rail instead of skating on forever.
 */
export function reflectCushionX(vel: Vec2, restitution: number, tangentialDamp = CUSHION_TANGENTIAL_DAMP): Vec2 {
  return { x: -vel.x * restitution, y: vel.y * tangentialDamp }
}

/** Mirror of {@link reflectCushionX} for the horizontal (top/bottom) rails. */
export function reflectCushionY(vel: Vec2, restitution: number, tangentialDamp = CUSHION_TANGENTIAL_DAMP): Vec2 {
  return { x: vel.x * tangentialDamp, y: -vel.y * restitution }
}
