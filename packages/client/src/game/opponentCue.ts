import * as THREE from 'three'
import { BALL_RADIUS, TABLE_LENGTH, TABLE_WIDTH } from '@snooker/shared'
import { VENUE_CONFIG, type VenueConfig } from './venueConfig.js'

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
  /** Takes it down immediately, for a frame that ended or a match that did. */
  hide(): void
  dispose(): void
}

type Phase = 'idle' | 'aim' | 'backswing' | 'strike' | 'follow'

export function buildOpponentCue(config: VenueConfig = VENUE_CONFIG): OpponentCue {
  const cfg = config.cue
  const group = new THREE.Group()
  group.name = 'opponent-cue'
  group.visible = false

  /* --- the stick --------------------------------------------------- */

  const shaftMat = new THREE.MeshStandardMaterial({ color: 0xd6b27a, roughness: 0.42, metalness: 0 })
  const buttMat = new THREE.MeshStandardMaterial({ color: 0x4a2c1a, roughness: 0.38, metalness: 0 })
  const brassMat = new THREE.MeshStandardMaterial({ color: 0xd8b15c, roughness: 0.28, metalness: 0.85 })
  const tipMat = new THREE.MeshStandardMaterial({ color: 0x4a86c8, roughness: 0.95, metalness: 0 })

  // Cylinders are built along +Y and laid down the group's +Z, so the tip sits at the
  // origin and the butt runs back toward the shooter.
  const layDown = (geo: THREE.BufferGeometry, from: number, to: number): THREE.Mesh => {
    geo.rotateX(Math.PI / 2)
    geo.translate(0, 0, (from + to) / 2)
    const mesh = new THREE.Mesh(geo, shaftMat)
    mesh.castShadow = false
    return mesh
  }

  const shaftLen = cfg.lengthMm * 0.72
  const buttLen = cfg.lengthMm * 0.24
  const shaft = layDown(new THREE.CylinderGeometry(6, 9.5, shaftLen, 12), 0, shaftLen)
  const butt = layDown(new THREE.CylinderGeometry(9.5, 12.5, buttLen, 12), shaftLen, shaftLen + buttLen)
  butt.material = buttMat
  const ferrule = layDown(new THREE.CylinderGeometry(5.4, 5.6, 30, 10), 0, 30)
  ferrule.material = brassMat
  const tip = layDown(new THREE.CylinderGeometry(5.2, 5.4, 14, 10), 0, 14)
  tip.material = tipMat
  const stick = new THREE.Group()
  stick.add(shaft, butt, ferrule, tip)
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
    const dirX = Math.cos(shot.angle)
    const dirZ = Math.sin(shot.angle)
    const back = BALL_RADIUS + atGap
    group.position.set(worldX(shot.x) - dirX * back, BALL_RADIUS, worldZ(shot.y) - dirZ * back)
    // A little rise at the butt while the bot is still lining up, flattening as it goes.
    stick.rotation.x = -lift * 0.001 * (1 - power * 0.35)
    group.rotation.y = Math.atan2(dirX, dirZ)

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
      shot = { ...next, power: Math.min(1, Math.max(0, next.power)) }
      phase = 'aim'
      clock = 0
      gap = cfg.restGapMm
      group.visible = true
      place(gap, shot.power)
    },
    step(dt: number): void {
      if (phase === 'idle' || !shot) return
      clock += dt
      const power = powerOf()
      if (phase === 'aim') {
        // Lining up: the cue comes up to the ball as the power bar fills.
        const t = Math.min(1, clock / Math.max(0.01, cfg.aimSeconds))
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
    hide(): void {
      phase = 'idle'
      shot = null
      group.visible = false
    },
    dispose(): void {
      for (const child of [shaft, butt, ferrule, tip, track, fill]) {
        child.geometry.dispose()
        child.parent?.remove(child)
      }
      group.remove(stick, bar)
      shaftMat.dispose()
      buttMat.dispose()
      brassMat.dispose()
      tipMat.dispose()
      trackMat.dispose()
      fillMat.dispose()
    }
  }
}