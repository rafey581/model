export interface Vec2 {
  x: number
  y: number
}

export const vec = (x = 0, y = 0): Vec2 => ({ x, y })

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y })

export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y })

export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s })

export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y

export const length = (a: Vec2): number => Math.sqrt(a.x * a.x + a.y * a.y)

export const dist = (a: Vec2, b: Vec2): number => length(sub(a, b))

export const normalize = (a: Vec2): Vec2 => {
  const len = length(a)
  if (len === 0) return vec(0, 0)
  return scale(a, 1 / len)
}

export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t
})

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))