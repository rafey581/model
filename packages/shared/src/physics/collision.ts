import { BALL_RADIUS, BALL_RESTITUTION, BALL_MASS } from '../constants.js'
import type { Vec2 } from '../vec.js'
import { sub, dot, scale, length, add } from '../vec.js'

export function resolveBallBall(aPos: Vec2, aVel: Vec2, bPos: Vec2, bVel: Vec2): { aVel: Vec2; bVel: Vec2; colliding: boolean } {
  const delta = sub(bPos, aPos)
  const dist = length(delta)
  const minDist = BALL_RADIUS * 2
  if (dist === 0 || dist >= minDist) {
    return { aVel, bVel, colliding: false }
  }
  const n = scale(delta, 1 / dist)
  const relVel = sub(bVel, aVel)
  const relSpeedAlongNormal = dot(relVel, n)
  if (relSpeedAlongNormal > 0) {
    return { aVel, bVel, colliding: false }
  }
  const impulse = (-(1 + BALL_RESTITUTION) * relSpeedAlongNormal) / 2
  const impulseVec = scale(n, impulse)
  const newAVel = sub(aVel, impulseVec)
  const newBVel = add(bVel, impulseVec)
  return { aVel: newAVel, bVel: newBVel, colliding: true }
}

export function positionalCorrection(aPos: Vec2, bPos: Vec2): { aPos: Vec2; bPos: Vec2 } {
  const delta = sub(bPos, aPos)
  const dist = length(delta)
  const minDist = BALL_RADIUS * 2
  if (dist === 0 || dist >= minDist) {
    return { aPos, bPos }
  }
  const overlap = minDist - dist
  const n = scale(delta, 1 / dist)
  const correction = scale(n, overlap / 2)
  return { aPos: sub(aPos, correction), bPos: add(bPos, correction) }
}

export function reflectCushionX(vel: Vec2, restitution: number): Vec2 {
  return { x: -vel.x * restitution, y: vel.y }
}

export function reflectCushionY(vel: Vec2, restitution: number): Vec2 {
  return { x: vel.x, y: -vel.y * restitution }
}

export const equalMassFactor = BALL_MASS / (BALL_MASS + BALL_MASS)