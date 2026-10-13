export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function seededRandom(seed: string): () => number {
  let h = 1779033703
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return mulberry32(h >>> 0)
}

export function range(min: number, max: number, rng: () => number): number {
  return min + rng() * (max - min)
}

export function pick<T>(items: readonly T[], rng: () => number): T {
  const index = Math.floor(rng() * items.length)
  return items[index] as T
}