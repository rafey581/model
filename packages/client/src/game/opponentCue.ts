import * as THREE from 'three'
import { BALL_RADIUS, TABLE_LENGTH, TABLE_WIDTH } from '@snooker/shared'
import { VENUE_CONFIG, type VenueConfig } from './venueConfig.js'
import { CUE_TIP_Y, buildCueStick } from './cueStick.js'

/**
 * The opponent's cue, and how hard they are about to hit it.
 *
 * This is a *presentation* of a shot that has already been decided. The bot picks its aim
 * and power on the server, the shot is simulated there, and the result comes back to the
 * client as a recording to replay. Nothing here decides anything: the venue is told what
 * the shot was and shows the wind-up for it, so that a potted ball on the replay is not
 * simply the table changing its mind with no explanation.
 *
 * It is worth being blunt about the limit. What the server sends for its own shots is
 * marked persist-only and never broadcast, so there is no message that says "the bot is
 * aiming here at 60%". The only evidence of the shot anywhere in the broadcast is the
 * playback's own opening keyframes, and this reconstructs the aim and power from those —
 * the direction the cue ball leaves in, and how fast. That is a faithful read of a
 * recorded shot, not the bot's private intent, and it will be a few millimetres out from
 * the cue that actually struck the ball.
 *
 * The cue is built along local +Z with its tip at the origin, so placing it is a
 * position, a rotation, and a length offset — no trigonometry per part, per frame.
 */

/** Table coordinates to world coordinates, the same two lines `scene3d` uses. */
const worldX = (x: number): number => x - TABLE_LENGTH / 2
const worldZ = (y: number): number => y - TABLE_WIDTH / 2

/** A shot worth showing. Table-space cue ball, radians, 0..1. */
export interface OpponentShot {
  x: number
  y: number
  angle: number
  power: number
}

export interface OpponentCue {
  /** The group, added to the scene. */
  group: THREE.Group
  /** Starts a wind-up. `shot` is in table coordinates. */
  show(shot: OpponentShot): void
  /** Advances the wind-up. `dt` in seconds. */
  step(dt: number): void
  /** True while a wind-up is on screen. */
  active(): boolean
  /** True from the cue coming up to the moment it strikes: lining up and drawing back. */
  winding(): boolean
  /** The power the cue is showing right now, 0..1: it fills as the cue lines up, then holds. */
  power(): number
  /**
   * Dresses the cue for the spectator view: drawn `thickness` times as thick so it reads
   * from high above, at its own length, and without the bar beside it — from up there the
   * power is shown by a meter at the edge of the screen instead. `thickness` 1 puts it back.
   * `aimSeconds` is how long it lines up for while dressed this way.
   */
  setSpectator(on: boolean, thickness: number, aimSeconds: number): void
  /** Seconds from the cue coming up to the moment it strikes, as it is dressed now. */
  preRoll(): number
  /**
   * Stands the cue at the cue ball before any shot is known: the opponent at the table,
   * feathering, from the moment their visit starts. `angle` is only where the cue rests —
   * the shot's own line is not known yet, and when it arrives through `show` the cue
   * swings round to it rather than jumping. Does nothing while a shot is being played.
   */
  address(x: number, y: number, angle: number): void
  /** Takes an addressing cue away. Leaves a shot that is being played alone. */
  stopAddressing(): void
  /** Takes it down immediately, for a frame that ended or a match that did. */
  hide(): void
  dispose(): void
}

type Phase = 'idle' | 'address' | 'turn' | 'aim' | 'backswing' | 'strike' | 'follow'

/** How long the cue takes to walk in when the opponent comes to the table, in seconds. */
const ADDRESS_ARRIVE_SECONDS = 0.45
/** How far back it starts that walk from, in millimetres. */
const ADDRESS_ARRIVE_MM = 420
/** The feathering while addressing: how far the tip strokes back, and how often. */
const ADDRESS_FEATHER_MM = 38
const ADDRESS_FEATHER_HZ = 0.75
/** How long the cue takes to swing from where it was resting onto the shot's line. */
const TURN_SECONDS = 0.5

export function buildOpponentCue(config: VenueConfig = VENUE_CONFIG): OpponentCue {
  const cfg = config.cue
  const group = new THREE.Group()
  group.name = 'opponent-cue'
  group.visible = false

  /* --- the stick --------------------------------------------------- */

  // The same cue the player holds, from the same builder. That one stands along +Y with
  // its tip uppermost; this group wants it lying down its own +Z with the tip at the
  // origin and the butt running back toward the shooter, so it is tipped over and slid
  // along by the height of its tip.
  const cueStick = buildCueStick()
  cueStick.group.rotation.x = -Math.PI / 2
  cueStick.group.position.z = CUE_TIP_Y
  const stick = new THREE.Group()
  stick.add(cueStick.group)
  group.add(stick)

  /* --- the power bar ----------------------------------------------- */

  // Unlit on purpose: this is an instrument overlay, not a thing in the room, and a
  // lambert-shaded bar across the table reads as much dimmer at the far end than the
  // player's own rail does.
  const trackMat = new THREE.MeshBasicMaterial({ color: 0x10151b, transparent: true, opacity: 0.72 })
  const fillMat = new THREE.MeshBasicMaterial({ color: 0x7ec35a, transparent: true, opacity: 0.95 })
  const track = new THREE.Mesh(new THREE.BoxGeometry(cfg.barWidthMm, cfg.barHeightMm, cfg.barLengthMm), trackMat)
  const fill = new THREE.Mesh(new THREE.BoxGeometry(cfg.barWidthMm * 0.82, cfg.barHeightMm * 1.25, 1), fillMat)
  const bar = new THREE.Group()
  bar.add(track, fill)
  group.add(bar)

  // The ramp, sampled once, so the fill's colour is a lookup rather than a lerp chain
  // every frame.
  const ramp = cfg.barColors.map((hex) => new THREE.Color(hex))

  /** The ramp colour at `t`, 0..1. */
  const rampAt = (t: number, out: THREE.Color): THREE.Color => {
    const scaled = Math.min(0.999, Math.max(0, t)) * (ramp.length - 1)
    const i = Math.floor(scaled)
    return out.copy(ramp[i] as THREE.Color).lerp(ramp[Math.min(ramp.length - 1, i + 1)] as THREE.Color, scaled - i)
  }

  /* --- the wind-up -------------------------------------------------- */

  const ease = (t: number): number => t * t * (3 - 2 * t)
  const lift = cfg.liftMm

  let phase: Phase = 'idle'
  let clock = 0
  let shot: OpponentShot | null = null
  /** Along the shot line, from the ball's surface. Positive is behind the ball. */
  let gap = 0
  /** The power last handed to `place`, which is the one on show. */
  let shown = 0
  /** True while the cue is dressed for the spectator view. */
  let spectating = false
  /** How long the cue lines up for: the venue's own beat, or the spectator view's longer one. */
  let aimSeconds = cfg.aimSeconds
  /** The heading the cue is swinging from and to, while it turns onto a shot's line. */
  let turnFrom = 0
  let turnBy = 0
  const fillColour = new THREE.Color()
  const powerOf = (): number => Math.min(1, Math.max(0, shot?.power ?? 0))

  /**
   * Places the cue for a gap and a power.
   *
   * One function for all four phases, because the only thing that differs between lining
   * up, drawing back and striking is the number it is handed.
   */
  const place = (atGap: number, power: number): void => {
    if (!shot) return
    shown = power
    const dirX = Math.cos(shot.angle)
    const dirZ = Math.sin(shot.angle)
    const back = BALL_RADIUS + atGap
    group.position.set(worldX(shot.x) - dirX * back, BALL_RADIUS, worldZ(shot.y) - dirZ * back)
    // A little rise at the butt while the bot is still lining up, flattening as it goes.
    stick.rotation.x = -lift * 0.001 * (1 - power * 0.35)
    // The stick is built butt-along-+Z, so +Z has to point back from the ball, away from
    // the shot. Outside the spectator view it is left pointing the way it always has,
    // which is forwards along the shot line; from above that reads as a cue lying across
    // the cloth in front of the ball, so the spectator view turns it round.
    group.rotation.y = spectating ? Math.atan2(-dirX, -dirZ) : Math.atan2(dirX, dirZ)

    // The bar stands off the stick on the shooter's right, laid along the shot line with
    // its near end at the butt and its far end reaching past the ball. Local space, not
    // world: the bar is a child of the cue, and the cue has already been told where the
    // shot is going.
    bar.position.set(cfg.barOffsetMm, lift * 0.5, cfg.lengthMm * 0.45)
    track.visible = true
    fill.visible = power > 0.01
    fill.scale.z = Math.max(1, cfg.barLengthMm * power)
    // Scaled about its own centre, so the bar grows from the middle outwards. Anchoring it
    // to one end instead needs a second offset per frame and looks identical.
    fill.position.z = cfg.barLengthMm * 0.5 - (cfg.barLengthMm * power) / 2
    fillMat.color.copy(rampAt(power, fillColour))
  }

  return {
    group,
    show(next: OpponentShot): void {
      const power = Math.min(1, Math.max(0, next.power))
      gap = cfg.restGapMm
      group.visible = true
      if (phase === 'address' && shot) {
        // Already at the table: swing from where the cue is resting onto the shot's line,
        // the short way round, and only then line up.
        turnFrom = shot.angle
        let by = (next.angle - turnFrom) % (Math.PI * 2)
        if (by > Math.PI) by -= Math.PI * 2
        if (by <= -Math.PI) by += Math.PI * 2
        turnBy = by
        shot = { ...next, angle: turnFrom, power }
        phase = 'turn'
        clock = 0
        place(gap, 0)
        return
      }
      shot = { ...next, power }
      phase = 'aim'
      clock = 0
      place(gap, shot.power)
    },
    address(x: number, y: number, angle: number): void {
      if (phase !== 'idle' && phase !== 'address') return
      if (phase === 'address' && shot && shot.x === x && shot.y === y) return
      const arriving = phase === 'idle'
      shot = { x, y, angle, power: 0 }
      phase = 'address'
      if (arriving) clock = 0
      group.visible = true
      place(cfg.restGapMm + (arriving ? ADDRESS_ARRIVE_MM : 0), 0)
    },
    stopAddressing(): void {
      if (phase !== 'address') return
      phase = 'idle'
      shot = null
      group.visible = false
    },
    step(dt: number): void {
      if (phase === 'idle' || !shot) return
      clock += dt
      const power = powerOf()
      if (phase === 'address') {
        // Walks in from behind, then feathers: short strokes back from the ball and up to
        // it again, which is what somebody standing over a shot looks like.
        const arrive = 1 - ease(Math.min(1, clock / ADDRESS_ARRIVE_SECONDS))
        const settled = Math.max(0, clock - ADDRESS_ARRIVE_SECONDS)
        const feather = (1 - Math.cos(settled * Math.PI * 2 * ADDRESS_FEATHER_HZ)) * 0.5 * ADDRESS_FEATHER_MM
        place(cfg.restGapMm + arrive * ADDRESS_ARRIVE_MM + feather, 0)
        return
      }
      if (phase === 'turn') {
        const t = Math.min(1, clock / TURN_SECONDS)
        shot.angle = turnFrom + turnBy * ease(t)
        place(gap, 0)
        if (t >= 1) {
          phase = 'aim'
          clock = 0
        }
        return
      }
      if (phase === 'aim') {
        // Lining up: the cue comes up to the ball as the power bar fills.
        const t = Math.min(1, clock / Math.max(0.01, aimSeconds))
        place(gap, power * ease(t))
        if (t >= 1) {
          phase = 'backswing'
          clock = 0
        }
        return
      }
      if (phase === 'backswing') {
        const t = Math.min(1, clock / Math.max(0.01, cfg.backswingSeconds))
        place(cfg.restGapMm + (cfg.drawBackMm * power) * ease(t), power)
        if (t >= 1) {
          phase = 'strike'
          clock = 0
        }
        return
      }
      if (phase === 'strike') {
        // Through the ball and a little past it: the tip ends up inside the cue ball's
        // radius, which is what a strike looks like from the side.
        const t = Math.min(1, clock / Math.max(0.01, cfg.strikeSeconds))
        const from = cfg.restGapMm + cfg.drawBackMm * power
        place(from - (from + BALL_RADIUS * 0.6) * ease(t), power)
        if (t >= 1) {
          phase = 'follow'
          clock = 0
        }
        return
      }
      const t = Math.min(1, clock / Math.max(0.01, cfg.followThroughSeconds))
      // Follow-through, then the cue leaves with the shot. The bar goes with it: the number
      // on it has been read by then, and a bar left floating over a moving table is a
      // question the viewer has to answer.
      place(-BALL_RADIUS * 0.6 - cfg.lengthMm * 0.12 * t, power * (1 - t))
      if (t >= 1) {
        phase = 'idle'
        shot = null
        group.visible = false
      }
    },
    active(): boolean {
      return phase !== 'idle'
    },
    winding(): boolean {
      return phase === 'aim' || phase === 'backswing'
    },
    power(): number {
      return phase === 'idle' ? 0 : shown
    },
    preRoll(): number {
      // A cue that is already addressing has to turn onto the line first.
      return (phase === 'address' ? TURN_SECONDS : 0) + aimSeconds + cfg.backswingSeconds + cfg.strikeSeconds
    },
    setSpectator(on: boolean, thickness: number, spectatorAimSeconds: number): void {
      // The stick lies along its own Z, so X and Y are its thickness and Z its length.
      spectating = on
      aimSeconds = on ? spectatorAimSeconds : cfg.aimSeconds
      const k = on ? thickness : 1
      stick.scale.set(k, k, 1)
      bar.visible = !on
    },
    hide(): void {
      phase = 'idle'
      shot = null
      group.visible = false
    },
    dispose(): void {
      for (const child of [track, fill]) {
        child.geometry.dispose()
        child.parent?.remove(child)
      }
      cueStick.dispose()
      group.remove(stick, bar)
      trackMat.dispose()
      fillMat.dispose()
    }
  }
}