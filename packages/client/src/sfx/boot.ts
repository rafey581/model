import { isSoundMuted, sharedAudioContext } from '../game/audio.js'
import { qualityConfig } from '../game/qualityConfig.js'
import { USE_NEW_SFX } from '../lobby/flag.js'
import { startSfx, type SfxRuntime } from './index.js'

/**
 * Starts the new sounds, if they are wanted.
 *
 * Loaded by the game's audio module as a side effect and nothing else. With the flag off
 * and no `?sfxdebug=1` in the address, this does nothing at all: no engine, no buffers, no
 * listeners. Everything is inside a `try`, because this runs at page load and a failure
 * here must not be the reason the game does not start.
 */

let runtime: SfxRuntime | null = null

/** The running sound system, or null when it is off. */
export function sfxRuntime(): SfxRuntime | null {
  return runtime
}

function debugRequested(): boolean {
  try {
    return new URLSearchParams(location.search).get('sfxdebug') === '1'
  } catch {
    return false
  }
}

try {
  const debug = typeof window !== 'undefined' && debugRequested()
  if (typeof window !== 'undefined' && (USE_NEW_SFX || debug)) {
    runtime = startSfx({
      tier: qualityConfig().name,
      // The game's own context, so there is still one for its sounds. It is only asked
      // for from inside a user gesture or a play call, never at load.
      context: sharedAudioContext,
      isMuted: isSoundMuted
    })
    if (debug) {
      const started = runtime
      void import('./sfxDebug.js').then((panel) => panel.mountSfxDebug(started)).catch(() => undefined)
    }
  }
} catch {
  runtime = null
}
