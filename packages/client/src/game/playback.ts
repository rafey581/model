import { SHOT_PLAYBACK_SPEED, type ShotPlayback } from '@snooker/shared'

/**
 * Shot playback speed. Shared with the server, which needs the same number to know
 * how long a client's replay will run before it lets the next shot go.
 */
export { SHOT_PLAYBACK_SPEED }

interface BallSample {
  t: number
  x: number
  y: number
}

interface BallTrack {
  id: number
  /** Potted before this shot started: stays hidden for the whole replay. */
  wasPotted: boolean
  /** Simulated second the ball dropped, or null if it was never potted. */
  potTime: number | null
  samples: BallSample[]
  /** Index of the last sample at or before the clock, so lookups stay linear. */
  cursor: number
  x: number
  y: number
}

export interface PlaybackBall {
  id: number
  x: number
  y: number
  potted: boolean
}

/**
 * Replays a streamed shot against the client's render loop.
 *
 * The authoritative snapshot is still applied the instant the update arrives —
 * this only decides what the table *looks* like while the shot plays out, so
 * the HUD, turn indicator and rules state never wait on animation.
 */
export class ShotPlayer {
  private readonly tracks: BallTrack[] = []
  private readonly byId = new Map<number, BallTrack>()
  private readonly potTimes: Array<[number, number]>
  private readonly duration: number
  private clock = 0
  private nextPot = 0
  private done = false

  constructor(playback: ShotPlayback, startBalls: PlaybackBall[], private readonly speed = SHOT_PLAYBACK_SPEED) {
    this.duration = Math.max(0, playback.duration)
    this.potTimes = [...(playback.pots ?? [])].sort((a, b) => a[1] - b[1])

    for (const ball of startBalls) {
      const track: BallTrack = {
        id: ball.id,
        wasPotted: ball.potted,
        potTime: null,
        samples: [],
        cursor: 0,
        x: ball.x,
        y: ball.y
      }
      this.tracks.push(track)
      this.byId.set(ball.id, track)
    }

    for (const [id, t] of this.potTimes) {
      const track = this.byId.get(id)
      if (track) track.potTime = t
    }

    for (const keyframe of playback.keyframes) {
      for (const [id, x, y] of keyframe.balls) {
        const track = this.byId.get(id)
        if (!track) continue
        track.samples.push({ t: keyframe.t, x, y })
      }
    }
  }

  get finished(): boolean {
    return this.done
  }

  /** Advances the replay clock and returns where every ball is now. */
  advance(dtSeconds: number): PlaybackBall[] {
    if (!this.done) {
      this.clock = Math.min(this.duration, this.clock + Math.max(0, dtSeconds) * this.speed)
      if (this.clock >= this.duration) this.done = true
    }
    for (const track of this.tracks) this.sample(track)
    return this.tracks.map((track) => ({
      id: track.id,
      x: track.x,
      y: track.y,
      potted: this.isPotted(track)
    }))
  }

  /**
   * A ball is potted from the instant it drops, not from the end of the replay,
   * so the sink animation and the pot sound land together. A ball the rules then
   * respotted is re-racked onto its spot when the replay ends, exactly as it is
   * re-spotted in a real frame.
   */
  private isPotted(track: BallTrack): boolean {
    if (track.wasPotted) return true
    return track.potTime !== null && this.clock >= track.potTime
  }

  /**
   * Ball ids potted since the last call, so the pot sound lands with the ball
   * dropping rather than with the update arriving.
   */
  takeDuePots(): number[] {
    const due: number[] = []
    while (this.nextPot < this.potTimes.length && this.potTimes[this.nextPot]![1] <= this.clock) {
      due.push(this.potTimes[this.nextPot]![0])
      this.nextPot++
    }
    return due
  }

  private sample(track: BallTrack): void {
    const samples = track.samples
    if (samples.length === 0) return

    // The last keyframe *is* the end of the shot, so once the clock is home
    // every ball is at its final sample. Without this a keyframe that rounds a
    // hair past the duration would be left just out of reach and the ball would
    // sit mid-flight, a visible jump when the authoritative snapshot takes over.
    if (this.clock >= this.duration) {
      const final = samples[samples.length - 1]!
      track.cursor = samples.length - 1
      track.x = final.x
      track.y = final.y
      return
    }

    let cursor = track.cursor
    // A new shot resets the clock, so a stale cursor has to rewind.
    if (cursor > 0 && samples[cursor]!.t > this.clock) cursor = 0
    while (cursor + 1 < samples.length && samples[cursor + 1]!.t <= this.clock) cursor++
    track.cursor = cursor

    const current = samples[cursor]!
    const next = samples[cursor + 1]
    if (!next) {
      track.x = current.x
      track.y = current.y
      return
    }
    const span = next.t - current.t
    // Two samples sharing a timestamp have no gap to interpolate across.
    const f = span > 0 ? Math.min(1, Math.max(0, (this.clock - current.t) / span)) : 0
    track.x = current.x + (next.x - current.x) * f
    track.y = current.y + (next.y - current.y) * f
  }
}
