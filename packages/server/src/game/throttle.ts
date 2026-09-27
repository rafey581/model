const MAX_TIMESTAMP_DRIFT_MS = 15000
const DUPLICATE_WINDOW_MS = 3000
const SPIN_LIMIT = 1.5

import type { ShotInputDto } from './room.js'

interface Bucket {
  tokens: number
  at: number
}

class BucketLimiter {
  private buckets = new Map<string, Bucket>()
  constructor(private capacity: number, private refillPerSec: number) {}

  take(key: string): boolean {
    const now = Date.now()
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: now }
    const elapsed = Math.max(0, now - bucket.at) / 1000
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerSec)
    bucket.at = now
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket)
      return false
    }
    bucket.tokens -= 1
    this.buckets.set(key, bucket)
    return true
  }
}

function fingerprint(input: ShotInputDto): string {
  const s = input.spin ?? { x: 0, y: 0 }
  const c = input.cuePos
  const cp = c ? `,${c.x},${c.y}` : ''
  return `${input.aimAngle},${input.power},${s.x},${s.y}${cp}`
}

type ShotEnforcementResult = { ok: true } | { ok: false; reason: string }

export class ShotEnforcement {
  private perSocket = new BucketLimiter(6, 3)
  private perUser = new BucketLimiter(12, 6)
  private lastAccepted = new Map<string, { sig: string; at: number }>()

  take(socketId: string, userId: string): boolean {
    return this.perSocket.take(socketId) && this.perUser.take(userId)
  }

  validate(input: unknown): ShotEnforcementResult {
    if (typeof input !== 'object' || input === null) return { ok: false, reason: 'bad_input' }
    const shot = input as { aimAngle?: unknown; power?: unknown; spin?: unknown; timestamp?: unknown; cuePos?: unknown }

    if (typeof shot.aimAngle !== 'number' || !Number.isFinite(shot.aimAngle)) return { ok: false, reason: 'bad_aim_angle' }

    if (typeof shot.power !== 'number' || !Number.isFinite(shot.power) || shot.power < 0 || shot.power > 1) {
      return { ok: false, reason: 'bad_power' }
    }

    if (typeof shot.spin !== 'object' || shot.spin === null) return { ok: false, reason: 'bad_spin' }
    const spin = shot.spin as { x?: unknown; y?: unknown }
    if (typeof spin.x !== 'number' || typeof spin.y !== 'number' || !Number.isFinite(spin.x) || !Number.isFinite(spin.y)) {
      return { ok: false, reason: 'bad_spin' }
    }
    if (Math.abs(spin.x) > SPIN_LIMIT || Math.abs(spin.y) > SPIN_LIMIT) return { ok: false, reason: 'bad_spin' }

    if (shot.timestamp !== undefined) {
      if (typeof shot.timestamp !== 'number' || !Number.isFinite(shot.timestamp)) return { ok: false, reason: 'bad_timestamp' }
      if (shot.timestamp > 0 && Math.abs(Date.now() - shot.timestamp) > MAX_TIMESTAMP_DRIFT_MS) {
        return { ok: false, reason: 'bad_timestamp' }
      }
    }

    if (shot.cuePos !== undefined) {
      if (typeof shot.cuePos !== 'object' || shot.cuePos === null) return { ok: false, reason: 'bad_cue_pos' }
      const pos = shot.cuePos as { x?: unknown; y?: unknown }
      if (typeof pos.x !== 'number' || typeof pos.y !== 'number' || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
        return { ok: false, reason: 'bad_cue_pos' }
      }
    }

    return { ok: true }
  }

  isReplay(socketId: string, input: unknown): boolean {
    if (typeof input !== 'object' || input === null) return false
    const sig = fingerprint(input as ShotInputDto)
    const last = this.lastAccepted.get(socketId)
    if (!last) return false
    return last.sig === sig && Date.now() - last.at <= DUPLICATE_WINDOW_MS
  }

  recordAccepted(socketId: string, input: unknown): void {
    if (typeof input !== 'object' || input === null) return
    this.lastAccepted.set(socketId, { sig: fingerprint(input as ShotInputDto), at: Date.now() })
  }
}