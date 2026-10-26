/**
 * Match replay: walk the recorded events and reconstruct the table after each
 * stroke.
 *
 * The engine lives in `@snooker/shared` and is the exact one the game server
 * played with, so a replay is not an approximation - it is the same simulation
 * run forwards. Everything here is pure; the React component that draws the
 * result lives in `components/ReplayTable.tsx`.
 */
import { createFrame, applyStroke } from '@snooker/shared'
import type { FrameState } from '@snooker/shared'
import { BALL_IDS, COLOR_NAMES } from '@snooker/shared'

export interface ReplayEvent {
  seq: number
  type: string
  data: unknown
}

export interface ShotPlayed {
  seq: number
  byIndex: number
  shot: { aimAngle: number; power: number; spin: { x: number; y: number }; timestamp?: number; cuePos?: { x: number; y: number } }
}

export interface FrameSnapshot {
  frame: FrameState
  /** Event sequence this stroke started at, for highlighting the log. */
  startSeq: number
  /** Sequence the stroke ended before (next shot, a frame end, or the end). */
  endSeq: number
  index: number
  total: number
}

/** Every SHOT event with the player and shot it carries. */
export function collectShots(events: ReplayEvent[]): ShotPlayed[] {
  const shots: ShotPlayed[] = []
  for (const event of events) {
    if (event.type !== 'SHOT') continue
    const data = event.data as { shot?: ShotPlayed['shot']; byIndex?: number } | null
    if (!data?.shot) continue
    shots.push({ seq: event.seq, byIndex: data.byIndex ?? 0, shot: data.shot })
  }
  return shots
}

export function ballColor(id: number): string {
  if (id === BALL_IDS.CUE) return '#f0e6d6'
  if (id >= BALL_IDS.RED_MIN && id <= BALL_IDS.RED_MAX) return '#c0392b'
  const name = COLOR_NAMES[id]
  switch (name) {
    case 'yellow':
      return '#f1c40f'
    case 'green':
      return '#27ae60'
    case 'brown':
      return '#8d5524'
    case 'blue':
      return '#2980b9'
    case 'pink':
      return '#e84393'
    case 'black':
      return '#1f1f1f'
    default:
      return '#888'
  }
}

/**
 * The table state after `step` strokes (0-based), plus the event-sequence window
 * that stroke covers. A frame boundary resets the table with the loser breaking,
 * matching how a real frame re-racks. `reds` is the rack the match was played with
 * (Match.reds); matches from before that was recorded were all 15-red.
 */
export function frameAt(events: ReplayEvent[], step: number, reds = 15): FrameSnapshot | null {
  const shots = collectShots(events)
  if (shots.length === 0) return null
  const frames: FrameState[] = []
  const seqBounds: Array<{ start: number; end: number }> = []
  let breakIndex = 0
  let frame = createFrame(breakIndex, reds)
  for (const shot of shots) {
    const before = shot.seq
    applyStroke(frame, frame.turnIndex, shot.shot)
    frames.push(frame)
    const nextEvent = events.find((e) => e.seq > shot.seq && (e.type === 'SHOT' || e.type === 'FRAME_END'))
    if (nextEvent?.type === 'FRAME_END') {
      const frameEndData = nextEvent.data as { winnerIndex?: number; winnerSeat?: number }
      const winnerIndex = frameEndData.winnerIndex ?? frameEndData.winnerSeat
      breakIndex = winnerIndex === 0 || winnerIndex === 1 ? 1 - winnerIndex : breakIndex
      frame = createFrame(breakIndex, reds)
    }
    seqBounds.push({ start: before, end: nextEvent ? nextEvent.seq : Number.MAX_SAFE_INTEGER })
  }
  const clamped = Math.min(Math.max(0, step), frames.length - 1)
  const target = frames[clamped]
  const bounds = seqBounds[clamped]
  if (!target || !bounds) return null
  return { frame: target, startSeq: bounds.start, endSeq: bounds.end, index: clamped, total: frames.length }
}

const BALL_NAMES: Record<number, string> = { [BALL_IDS.CUE]: 'cue', ...COLOR_NAMES }

/** Names any ball, including the fifteen reds, which are not in COLOR_NAMES. */
export function ballName(id: number): string {
  if (id === BALL_IDS.CUE) return 'cue'
  if (id >= BALL_IDS.RED_MIN && id <= BALL_IDS.RED_MAX) return 'red'
  return BALL_NAMES[id] ?? String(id)
}

/** One readable line for an event in the replay log. */
export function eventLabel(event: ReplayEvent): string {
  const data = event.data as Record<string, unknown> | null
  if (event.type === 'SHOT' && data?.shot) {
    const shot = data.shot as { aimAngle?: number; power?: number }
    return `player ${String(data.byIndex)} aims ${Number(shot.aimAngle ?? 0).toFixed(2)}`
  }
  if (event.type === 'FOUL') return `player ${String(data?.byIndex ?? data?.bySeat)} foul (+${String(data?.penalty)})`
  if (event.type === 'BALL_POTTED') {
    const ballId = data?.ballId as number | undefined
    return `pot ${ballId !== undefined ? ballName(ballId) : '?'}`
  }
  if (event.type === 'TURN_CHANGE') return `turn -> player ${String(data?.turnSeat ?? data?.turnIndex)}`
  if (event.type === 'FRAME_END') return `frame won by player ${String(data?.winnerIndex)}`
  if (event.type === 'MATCH_END') return `match won by player ${String(data?.winnerIndex)} (${String(data?.reason)})`
  return `${event.type} ${JSON.stringify(event.data ?? {})}`
}
