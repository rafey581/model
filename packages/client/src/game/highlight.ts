import type { ShotPlayback } from '@snooker/shared'
import type { PlaybackBall } from './playback.js'

/**
 * Which shots are worth seeing twice.
 *
 * A pot is replayed, slowed down, when it was hard to play: a long pot, a thin cut, a
 * double off a cushion, a plant, two balls in one stroke, or a pot made after the cue
 * ball came off a cushion first. The decision is made from the recording of the shot the
 * server sent and the positions the balls started from, and from nothing else, so every
 * client watching the same shot comes to the same answer.
 *
 * Picture only. Nothing here changes a score or a rule: the caller asks only after the
 * stroke has been judged legal, and only for balls the striker scored with.
 */

/** Why a shot is a highlight, strongest first when there is more than one reason. */
export type HighlightKind = 'plant' | 'double' | 'kick' | 'multi' | 'thin-cut' | 'long-pot'

export interface Highlight {
  kind: HighlightKind
  /** The words for the banner over the replay. */
  label: string
}

/** A pot is long when the cue ball and the object ball between them travel this far, in mm... */
export const LONG_POT_TOTAL_MM = 2500
/** ...with the object ball itself going at least this far to the pocket. */
export const LONG_POT_OBJECT_MM = 1100
/** A cut this many degrees or finer, on an object ball travelling at least this far, is thin. */
export const THIN_CUT_DEG = 62
export const THIN_CUT_OBJECT_MM = 450

const LABELS: Record<HighlightKind, string> = {
  plant: 'PLANT',
  double: 'DOUBLE',
  kick: 'OFF THE CUSHION',
  multi: 'TWO IN ONE',
  'thin-cut': 'THIN CUT',
  'long-pot': 'LONG POT'
}

/** The order reasons are ranked in: the rarer and harder the shot, the earlier. */
const RANK: HighlightKind[] = ['plant', 'double', 'kick', 'multi', 'thin-cut', 'long-pot']

const CONTACT_BALL = 0
const CONTACT_CUSHION = 1
const CUE_ID = 0

interface Point {
  x: number
  y: number
}

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)

/** Where a ball was last seen moving before it dropped: the mouth of its pocket, near enough. */
function lastSeen(playback: ShotPlayback, id: number, before: number): Point | null {
  let seen: Point | null = null
  for (const keyframe of playback.keyframes) {
    if (keyframe.t > before) break
    for (const [ballId, x, y] of keyframe.balls) {
      if (ballId === id) seen = { x, y }
    }
  }
  return seen
}

/**
 * The highlight a legal, scoring stroke makes, or null when it was an ordinary one.
 *
 * `scoredIds` are the balls the striker potted and scored with in this stroke; the cue
 * ball is never among them. A shot without contacts in its recording (an older server)
 * can still be a long pot, a thin cut or two in one: those read off the ball tracks.
 */
export function rateShot(start: PlaybackBall[], playback: ShotPlayback, scoredIds: number[]): Highlight | null {
  const pottedIds = scoredIds.filter((id) => id !== CUE_ID)
  if (pottedIds.length === 0 || playback.keyframes.length === 0) return null
  const startOf = new Map(start.map((ball) => [ball.id, { x: ball.x, y: ball.y }]))
  const cueStart = startOf.get(CUE_ID)
  if (!cueStart) return null
  const potTime = new Map(playback.pots.map(([id, t]) => [id, t]))
  const contacts = [...(playback.contacts ?? [])].sort((a, b) => a[1] - b[1])

  // The cue ball's first ball contact, and whether it touched a cushion before it.
  let firstHit: { id: number; t: number; at: Point } | null = null
  let cueCushionFirst = false
  for (const [kind, t, a, b, , x, y] of contacts) {
    if (kind === CONTACT_CUSHION && a === CUE_ID && firstHit === null) cueCushionFirst = true
    if (kind === CONTACT_BALL && (a === CUE_ID || b === CUE_ID)) {
      firstHit = { id: a === CUE_ID ? b : a, t, at: { x, y } }
      break
    }
  }

  const found = new Set<HighlightKind>()
  if (pottedIds.length >= 2) found.add('multi')
  if (cueCushionFirst && firstHit !== null) found.add('kick')

  for (const id of pottedIds) {
    const from = startOf.get(id)
    const droppedAt = potTime.get(id)
    if (!from || droppedAt === undefined) continue
    const mouth = lastSeen(playback, id, droppedAt)
    if (!mouth) continue
    const objectTravel = dist(from, mouth)

    // Struck by another object ball rather than by the cue ball: a plant.
    if (firstHit !== null && firstHit.id !== id) {
      const touchedByCue = contacts.some(
        ([kind, t, a, b]) => kind === CONTACT_BALL && t <= droppedAt && ((a === CUE_ID && b === id) || (b === CUE_ID && a === id))
      )
      if (!touchedByCue) found.add('plant')
    }
    // Off a cushion on its way to the pocket: a double.
    if (contacts.some(([kind, t, a]) => kind === CONTACT_CUSHION && a === id && t < droppedAt)) found.add('double')

    // Long pot and thin cut are measured on the ball the cue ball struck.
    if (firstHit === null || firstHit.id === id) {
      const contact = firstHit?.at ?? from
      const cueTravel = dist(cueStart, contact)
      if (objectTravel >= LONG_POT_OBJECT_MM && cueTravel + objectTravel >= LONG_POT_TOTAL_MM) found.add('long-pot')
      if (objectTravel >= THIN_CUT_OBJECT_MM && cueTravel > 1) {
        const cx = (contact.x - cueStart.x) / cueTravel
        const cy = (contact.y - cueStart.y) / cueTravel
        const ox = (mouth.x - from.x) / objectTravel
        const oy = (mouth.y - from.y) / objectTravel
        const cut = (Math.acos(Math.max(-1, Math.min(1, cx * ox + cy * oy))) * 180) / Math.PI
        if (cut >= THIN_CUT_DEG) found.add('thin-cut')
      }
    }
  }

  const kind = RANK.find((k) => found.has(k))
  return kind ? { kind, label: LABELS[kind] } : null
}
