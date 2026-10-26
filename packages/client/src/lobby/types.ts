import type { MatchFormat, PracticeAiLevel } from '@snooker/shared'

/** Screens owned entirely by the new lobby view (not AppScreen). */
export type LobbyView =
  | 'home'
  | 'setup'
  | 'statistics'
  | 'info'
  | 'settings'
  | 'deposit'
  | 'withdraw'
  | 'friends'
  | 'invite'

export type LobbyTab = 'play' | 'statistics' | 'settings' | 'info'

export type PlayMode = 'ai' | 'online'

export type InfoSection = 'controls' | 'rules'

export type StatsMode = 'ai' | 'online'

export interface LobbyStakeTier {
  id: string
  label: string
  usdt: number
  /** Absent on an older server: the id prefix is the fallback. */
  table?: 'OPEN' | 'MASTER'
}

export type StakeTableChoice = 'open' | 'master'

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
  /** A guest can practice, and is stopped from stakes, cash, and friends. */
  guest?: boolean
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
  /**
   * Opens an online table as a challenge: a public broadcast anyone may accept
   * (no `targetUsername`) or a direct invite to one friend. This does not enter
   * the match — it raises the "finding an opponent" overlay and resolves when
   * somebody accepts, or is cancelled.
   */
  startOnlineChallenge: (opts: { stakeTier: string; format: MatchFormat; targetUsername?: string }) => Promise<void>
  toast: (message: string, kind?: 'error' | 'info') => void
  /** Existing profile menu actions (logout) — optional. */
  onProfileActivate: () => void
  /** Hands back to main.ts for the existing tournaments screen (create / join / bracket). */
  openTournaments: () => void
}

export interface SetupState {
  mode: PlayMode | null
  difficulty: PracticeAiLevel
  format: MatchFormat
  stakeTierId: string | null
  /** Online only: ordinary open table, or a Master Match. */
  table: StakeTableChoice
  /** Online only: open to everyone, or invite one friend. */
  opponent: 'anyone' | 'friend'
  /** The friend to invite when `opponent` is 'friend'. */
  friendUsername: string | null
}
