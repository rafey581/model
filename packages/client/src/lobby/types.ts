import type { MatchFormat, PracticeAiLevel } from '@snooker/shared'

/** Screens owned entirely by the new lobby view (not AppScreen). */
export type LobbyView =
  | 'home'
  | 'setup'
  | 'statistics'
  | 'info'
  | 'settings'

export type LobbyTab = 'play' | 'statistics' | 'settings' | 'info'

export type PlayMode = 'ai' | 'online'

export type InfoSection = 'controls' | 'rules'

export type StatsMode = 'ai' | 'online'

export interface LobbyStakeTier {
  id: string
  label: string
  credits: number
}

export interface LobbyProfileStats {
  matches: number
  wins: number
  losses: number
  winRate: number
  highestBreak: number
}

export interface LobbyHistoryMatch {
  id: string
  format: string
  winnerId: string | null
  finishedAt: string | null
  players: Array<{ userId: string; user: { username: string } }>
}

export interface LobbyBridge {
  appTitle: string
  username: string
  userId: string
  walletBalance: number
  logoSvg: string
  formatCash: (amount: number) => string
  createAvatar: (name: string) => HTMLElement
  getSoundMuted: () => boolean
  setSoundMuted: (muted: boolean) => void
  practiceDifficulty: PracticeAiLevel
  setPracticeDifficulty: (level: PracticeAiLevel) => void
  getStakeTiers: () => LobbyStakeTier[]
  getDefaultStakeTierId: () => string | null
  refreshWallet: () => Promise<void>
  fetchProfileStats: () => Promise<LobbyProfileStats | null>
  fetchMatchHistory: () => Promise<LobbyHistoryMatch[]>
  startPractice: (aiLevel: PracticeAiLevel) => Promise<void>
  startOnlineMatch: (opts: { stakeTier: string; format: MatchFormat }) => Promise<void>
  toast: (message: string, kind?: 'error' | 'info') => void
  /** Existing profile menu actions (logout / admin) — optional. */
  onProfileActivate: () => void
  /** Hands back to main.ts for the existing tournaments screen (create / join / bracket). */
  openTournaments: () => void
}

export interface SetupState {
  mode: PlayMode | null
  difficulty: PracticeAiLevel
  format: MatchFormat
  stakeTierId: string | null
}
