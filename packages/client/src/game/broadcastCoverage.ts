import type { PlayerCameraMode } from './camera.js'

/**
 * Television coverage while a shot is being watched.
 *
 * The player's own aim view is never one of these. Coverage is a sequence of fixed
 * cameras — baulk end, side, black end — chosen by how far the shot has got, not a
 * heading that keeps turning. A player who has picked a view keeps that view. Reduced
 * motion and a low-performance device stay on the one wide end camera for the whole shot.
 */

export type CoveragePhase = 'wide' | 'side' | 'end'

export interface CoverageInput {
  /** A shot replay is on screen. */
  replaying: boolean
  /** The player can aim, set power or place the cue ball. Coverage must stay off. */
  inputActive: boolean
  /** The view the player chose. Only Main (`AIM`) is allowed to hand the shot to television. */
  selected: PlayerCameraMode
  /** Prefers-reduced-motion, or a device on the low quality tier. */
  calm: boolean
  /** 0 at the strike, 1 when the balls have stopped. */
  progress: number
}

/** The fixed view for this moment of a replay, or null when the player's own camera stays. */
export function televisionCoverage(input: CoverageInput): PlayerCameraMode | null {
  if (input.inputActive || !input.replaying) return null
  if (input.selected !== 'AIM') return null
  if (input.calm) return 'BROADCAST'
  return phaseMode(replayPhase(input.progress))
}

export function replayPhase(progress: number): CoveragePhase {
  const t = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0
  if (t < 0.34) return 'wide'
  if (t < 0.67) return 'side'
  return 'end'
}

export function phaseMode(phase: CoveragePhase): PlayerCameraMode {
  if (phase === 'wide') return 'BROADCAST'
  if (phase === 'side') return 'SIDE'
  return 'END'
}

/**
 * How long a change from one television camera to the next takes, in seconds.
 *
 * Long enough to read as a move and short enough that the shot is not hidden behind
 * the transition. Calm playback cuts.
 */
export function coverageTransitionSeconds(calm: boolean): number {
  return calm ? 0.05 : 0.45
}
