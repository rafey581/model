/**
 * Flip to `false` to restore the previous lobby UI without deleting any of it.
 * Mount wiring lives in `main.ts` behind this flag only.
 */
export const USE_NEW_LOBBY = true

/**
 * Match loading screen with real progress and GPU warm-up before the first playable frame.
 * `false` keeps the exact previous START MATCH → enterMatch behaviour (no overlay).
 */
export const USE_LOADING_SCREEN = true
