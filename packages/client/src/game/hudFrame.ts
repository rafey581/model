import type { FrameSnapshotData } from './renderer.js'

/**
 * The frame the HUD is allowed to describe.
 *
 * The server's snapshot arrives with the shot's outcome already written into it, so the
 * instant it lands the scoreboard already knows how the shot ended: the pot's points,
 * the foul's penalty, the frame won. The replay that explains it has not started yet,
 * and for the length of that replay the two would disagree — a scoreline that has moved
 * while the balls are still rolling gives the shot away as plainly as announcing the pot
 * early would.
 *
 * So while a replay is on screen the HUD describes the frame the replay started from,
 * and catches up the moment the replay ends. Everything the HUD reads comes through here
 * for one reason: the scores are not the exception to the rule, they are the reason for
 * it.
 */
export function frameForHud(options: {
  /** True while a replay is on screen. */
  replayRunning: boolean
  /** The frame the HUD is showing now. */
  shown: FrameSnapshotData | null
  /** The server's latest snapshot, authoritative and already carrying the shot's result. */
  authoritative: FrameSnapshotData | null
}): FrameSnapshotData | null {
  return options.replayRunning ? options.shown : options.authoritative
}