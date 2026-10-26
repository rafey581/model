import {
  applyCuePlacement,
  applyStroke,
  BALL_IDS,
  createFrame,
  frameSnapshot,
  type FrameSnapshot,
  type FrameState,
  type ShotPlayback
} from '@snooker/shared'

/** A practice frame that never touches the server or the socket. */
export const LOCAL_MATCH_ID = 'local-practice'

export interface LocalStroke {
  frame: FrameSnapshot
  playback?: ShotPlayback
  events: Array<{ type: string; data: unknown }>
}

export function freshLocalFrame(): FrameState {
  return createFrame(0)
}

export function strokeLocal(
  frame: FrameState,
  seat: number,
  shot: { aimAngle: number; power: number; spin?: { x: number; y: number } }
): LocalStroke {
  const outcome = applyStroke(
    frame,
    seat,
    {
      aimAngle: shot.aimAngle,
      power: Math.min(1, Math.max(0, shot.power)),
      spin: { x: shot.spin?.x ?? 0, y: shot.spin?.y ?? 0 }
    },
    { playback: { rate: 30 } }
  )
  const events: LocalStroke['events'] = []
  for (const id of outcome.sim.pottedIds) events.push({ type: 'BALL_POTTED', data: { ballId: id, bySeat: seat } })
  if (outcome.resolution.foul) {
    events.push({
      type: 'FOUL',
      data: { penalty: outcome.resolution.foulValue, reason: outcome.resolution.reason, bySeat: seat }
    })
  }
  if (outcome.frameEnded && outcome.frameWinner !== null) {
    events.push({ type: 'FRAME_END', data: { winnerSeat: outcome.frameWinner } })
  }
  const playback: ShotPlayback | undefined = outcome.sim.keyframes?.length
    ? {
        duration: outcome.sim.simSeconds,
        keyframes: outcome.sim.keyframes,
        pots: outcome.sim.pots ?? [],
        contacts: outcome.sim.contacts ?? [],
        token: 1
      }
    : undefined
  return { frame: frameSnapshot(frame), playback, events }
}

export function placeLocalCue(frame: FrameState, cuePos: { x: number; y: number }): { ok: boolean; frame: FrameSnapshot } {
  const placed = applyCuePlacement(frame, cuePos)
  return { ok: placed.ok, frame: frameSnapshot(frame) }
}

/** A calm robot: aim the cue ball at the nearest object ball and play a gentle stroke. */
export function robotShot(frame: FrameState): { aimAngle: number; power: number; spin: { x: number; y: number } } {
  const cue = frame.balls.find((ball) => ball.id === BALL_IDS.CUE && !ball.potted)
  let aimAngle = 0
  if (cue) {
    let bestX = cue.pos.x + 400
    let bestY = cue.pos.y
    let bestD = Infinity
    for (const ball of frame.balls) {
      if (ball.id === BALL_IDS.CUE || ball.potted) continue
      const d = (ball.pos.x - cue.pos.x) ** 2 + (ball.pos.y - cue.pos.y) ** 2
      if (d < bestD) {
        bestD = d
        bestX = ball.pos.x
        bestY = ball.pos.y
      }
    }
    aimAngle = Math.atan2(bestY - cue.pos.y, bestX - cue.pos.x)
  }
  return { aimAngle, power: 0.42, spin: { x: 0, y: 0 } }
}
