export { USE_NEW_LOBBY, USE_LOADING_SCREEN } from './flag.js'
export { mountGamingLobby } from './mount.js'
export type { LobbySession } from './mount.js'
export type { LobbyBridge } from './types.js'
export {
  showMatchLoading,
  ensureLobbyBgReady,
  createProgressController,
  PHASE_WEIGHTS,
  PHASE_ORDER
} from './matchLoading/index.js'
export type { MatchLoadingHandle, MatchLoadingShowOpts, LoadPhase } from './matchLoading/index.js'
