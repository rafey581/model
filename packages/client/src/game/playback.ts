import { BALL_IDS, BALL_RADIUS, SHOT_PLAYBACK_SPEED, SIDE_SPIN_FRICTION, TIP_SPIN_RATIO, type ShotPlayback } from '@snooker/shared'

/**
 * Shot playback speed. Shared with the server, which needs the same number to know
 * how long a client's replay will run before it lets the next shot go.
 */
export { SHOT_PLAYBACK_SPEED }

interface BallSample {
  t: number
  x: number
  y: number
  /** How the ball's surface turns over the cloth (mm/s) and its side spin (-1..1), when the server sent them. */
  rx?: number
  ry?: number
  side?: number
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
  /** How it is turning now, read off its samples; null before it has any, or when none were sent. */
  turn: BallTurn | null
}

/**
 * How a ball is turning at an instant, for drawing it: its surface's velocity over the
 * cloth in table millimetres per second (its velocity when it rolls, short of it while it
 * skids, against it under back spin) and its side spin as a rate about the vertical,
 * radians per second, positive turning the way right-hand side does.
 */
export interface BallTurn {
  rollX: number
  rollY: number
  sideRate: number
}

export interface PlaybackBall {
  id: number
  x: number
  y: number
  potted: boolean
  /** How it is turning, when the replay knows; absent, it is drawn as rolling. */
  turn?: BallTurn
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
  /**
   * The cue ball's pace off the tip, mm/s, read off its first two samples. Side spin is
   * sent as a share of the most a tip can put on (-1..1), and turned into a real rate
   * about the vertical against this: the same 5/2 x offset the engine gives top and back.
   */
  private readonly strikeSpeed: number

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
        y: ball.y,
        turn: null
      }
      this.tracks.push(track)
      this.byId.set(ball.id, track)
    }

    for (const [id, t] of this.potTimes) {
      const track = this.byId.get(id)
      if (track) track.potTime = t
    }

    for (const keyframe of playback.keyframes) {
      for (const entry of keyframe.balls) {
        const track = this.byId.get(entry[0])
        if (!track) continue
        const sample: BallSample = { t: keyframe.t, x: entry[1], y: entry[2] }
        if (entry.length >= 6) {
          sample.rx = entry[3]
          sample.ry = entry[4]
          sample.side = (entry[5] ?? 0) / 1000
        }
        track.samples.push(sample)
      }
    }

    const cue = this.byId.get(BALL_IDS.CUE)?.samples
    let strike = 0
    if (cue && cue.length >= 2) {
      const span = cue[1]!.t - cue[0]!.t
      if (span > 0) strike = Math.hypot(cue[1]!.x - cue[0]!.x, cue[1]!.y - cue[0]!.y) / span
    }
    this.strikeSpeed = strike
  }

  get finished(): boolean {
    return this.done
  }

  /** How far into the shot the replay is, in simulated seconds. For the sound effects. */
  get time(): number {
    return this.clock
  }

  /** Advances the replay clock and returns where every ball is now. */
  advance(dtSeconds: number): PlaybackBall[] {
    if (!this.done) {
      this.clock = Math.min(this.duration, this.clock + Math.max(0, dtSeconds) * this.speed)
      if (this.clock >= this.duration) this.done = true
    }
    for (const track of this.tracks) this.sample(track)
    return this.tracks.map((track) => {
      const ball: PlaybackBall = { id: track.id, x: track.x, y: track.y, potted: this.isPotted(track) }
      if (track.turn) ball.turn = track.turn
      return ball
    })
  }

  /** The rate a side spin of `share` (-1..1) turns the ball at, radians per second. */
  private sideRate(share: number): number {
    return (share * TIP_SPIN_RATIO * this.strikeSpeed) / BALL_RADIUS
  }

  /**
   * How a ball is turning between two samples (or at one), when the server sent it. Past
   * its last sample a ball has stopped travelling, but side spin can still be turning it
   * on the spot: that wears off on the cloth's clock, the engine's own rate.
   */
  private turnAt(a: BallSample, b: BallSample | undefined, f: number): BallTurn | null {
    if (a.rx === undefined || a.ry === undefined || a.side === undefined) return null
    if (!b || b.rx === undefined || b.ry === undefined || b.side === undefined) {
      const since = Math.max(0, this.clock - a.t)
      return { rollX: a.rx, rollY: a.ry, sideRate: this.sideRate(a.side * Math.exp(-SIDE_SPIN_FRICTION * since)) }
    }
    return {
      rollX: a.rx + (b.rx - a.rx) * f,
      rollY: a.ry + (b.ry - a.ry) * f,
      sideRate: this.sideRate(a.side + (b.side - a.side) * f)
    }
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
      track.turn = this.turnAt(final, undefined, 0)
      return
    }

    let cursor = track.cursor
    // A new shot resets the clock, so a stale cursor has to rewind.
    if (cursor > 0 && samples[cursor]!.t > this.clock) cursor = 0
    while (cursor + 1 < samples.length && samples[cursor + 1]!.t <= this.clock) cursor++
    track.cursor = cursor

    const current = samples[cursor]!
    const next = samples[cursor + 1]
    // Before its first sample the ball has not been touched yet: it is not turning.
    if (this.clock < current.t) {
      track.turn = null
    }
    if (!next) {
      track.x = current.x
      track.y = current.y
      if (this.clock >= current.t) track.turn = this.turnAt(current, undefined, 0)
      return
    }
    const span = next.t - current.t
    // Two samples sharing a timestamp have no gap to interpolate across.
    const f = span > 0 ? Math.min(1, Math.max(0, (this.clock - current.t) / span)) : 0
    track.x = current.x + (next.x - current.x) * f
    track.y = current.y + (next.y - current.y) * f
    if (this.clock >= current.t) track.turn = this.turnAt(current, next, f)
  }
}
