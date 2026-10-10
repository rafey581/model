/**
 * The one door between the game and the sounds.
 *
 * The game says what happened — a cue struck a ball, two balls met, a ball went down —
 * and anything listening may make a noise about it. The game never asks for a sound and
 * never hears back: `emit` returns nothing, swallows whatever a listener throws, and
 * costs a loop over an empty list when nobody is listening. That is what lets a hook in
 * the game be one line that cannot change what the game does.
 *
 * Positions are table millimetres, the game's own: `x` along the length from the baulk
 * end, `z` across the width. Speeds are millimetres a second.
 */

interface Timed {
  /**
   * When this happened, on the `performance.now()` clock, if the caller knows. An event
   * that turns up long after its moment — a replay that was skipped through, a tab that
   * was hidden — is not played.
   */
  at?: number
  /** The simulation step it happened in, if known: one pair cannot sound twice in a step. */
  step?: number
}

export type SfxEvent =
  | ({ type: 'cueStrike'; power: number; x: number; z: number } & Timed)
  | ({ type: 'ballBall'; idA: number; idB: number; speed: number; x: number; z: number } & Timed)
  | ({ type: 'cushion'; ballId: number; speed: number; x: number; z: number; cushion?: number } & Timed)
  | ({ type: 'jaw'; ballId: number; speed: number; x: number; z: number } & Timed)
  | ({ type: 'pocket'; ballId: number; pocketIndex: number; speed: number; x?: number; jaw?: boolean } & Timed)
  | { type: 'rollTick'; balls: ReadonlyArray<{ id: number; speed: number; x: number; z: number }> }
  /** A ball is back on the table, or a new frame has begun: it may be potted again. */
  | { type: 'respot'; ballId: number }
  | { type: 'frameStart' }
  | ({ type: 'aux'; sound: 'uiClick' | 'uiHover' | 'placeTick' | 'turnTick' | 'chalk' | 'foul' } & Timed)

export type SfxListener = (event: SfxEvent) => void

const listeners = new Set<SfxListener>()

/** Listens. Returns the way to stop. */
export function subscribeSfx(listener: SfxListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Says that something happened. Never throws, never returns anything. */
export function emitSfx(event: SfxEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // A sound that fails is a sound that is not heard. The game is not told.
    }
  }
}
