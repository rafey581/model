import { BALL_IDS } from '@snooker/shared'

/**
 * The one place the ball colours are written down.
 *
 * The 3D scene, the 2D fallback and the HUD all read from here, so a ball can never
 * be one shade on the table and another in the balls strip. The values are the ones
 * the 3D scene was already using, moved rather than restated: the two renderers
 * differed only imperceptibly before (cue `#f7f7f2` against `0xf5f3e4`, black
 * `#171717` against `0x1a1a1e`) and there was no reason to keep both.
 */
export const BALL_COLORS: Record<number, number> = {
  [BALL_IDS.CUE]: 0xf5f3e4,
  [BALL_IDS.YELLOW]: 0xf4c430,
  [BALL_IDS.GREEN]: 0x1b7f46,
  [BALL_IDS.BROWN]: 0x8a4b23,
  [BALL_IDS.BLUE]: 0x1e6fd9,
  [BALL_IDS.PINK]: 0xf0709c,
  [BALL_IDS.BLACK]: 0x1a1a1e
}

/** Every red is the same red; snooker has no ball numbering to keep straight. */
export const RED_BALL_COLOR = 0xd0201c

export function ballColor(id: number): number {
  return BALL_COLORS[id] ?? RED_BALL_COLOR
}

/** The same colour as a CSS string, for the 2D canvas and for the HUD chips. */
export function ballColorHex(id: number): string {
  return `#${ballColor(id).toString(16).padStart(6, '0')}`
}
