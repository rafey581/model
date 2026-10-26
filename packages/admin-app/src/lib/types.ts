/**
 * The shapes the admin API returns.
 *
 * Copied from the server's responses (and the panel that used to consume them) so
 * the app and the server cannot drift silently: a field rename breaks `tsc` here
 * rather than surfacing as `undefined` on a screen at 3am.
 */

export interface AdminIdentity {
  id: string
  username: string
  role: string
  status?: string
}

export interface PeriodTotals {
  today: number
  week: number
  month: number
  all: number
}

export type FinancePeriod = keyof PeriodTotals

export interface DashboardFinance {
  deposits: PeriodTotals & { countAll: number }
  withdrawals: PeriodTotals & { countAll: number }
  /** Platform fees from matches. */
  commission: PeriodTotals
  /** Welcome balances and referral rewards paid to players. */
  bonuses: PeriodTotals
  /** Net effect of staff balance adjustments. */
  adjustments: PeriodTotals
  /** commission - bonuses - adjustments. */
  netProfit: PeriodTotals
  /** deposits - withdrawals. */
  netFlow: PeriodTotals
  /** What players hold right now (available + locked). */
  playerBalances: number
}

export interface DashboardUserActivity {
  total: number
  activeWeek: number
  activeToday: number
  newToday: number
  suspended: number
  banned: number
}

export interface PendingCountsPayload {
  pendingDeposits: number
  pendingWithdrawals: number
  supportAwaiting: number
}

export interface DashboardStats {
  /** Optional: absent on a server older than this app. */
  finance?: DashboardFinance
  userActivity?: DashboardUserActivity
  timeZone?: string
  users: number
  activeMatches: number
  completedMatches: number
  deposits: number
  withdrawals: number
  pendingDeposits: number
  pendingWithdrawals: number
  /** Open support threads with a player message staff have not read yet. */
  supportAwaiting: number
  platformRevenue: number
}

export interface AdminUser {
  id: string
  username: string
  email: string | null
  role: string
  status: string
  createdAt: string
  wallet: { available: string | number; locked?: string | number } | null | undefined
  phone?: string | null
  lastSeenAt?: string | null
  lastLoginAt?: string | null
  level?: number
  totalDeposited?: number
  totalWithdrawn?: number
}

export interface AdminMatchPlayer {
  seat: number
  userId: string
  user: { id: string; username: string }
}

export interface AdminMatch {
  id: string
  matchType: string
  stakePerPlayer: string | number
  format: string
  /** Reds the match was racked with; null on matches from before this was recorded (15). */
  reds?: number | null
  status: string
  winnerId: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  resultJson: string | null
  players: AdminMatchPlayer[]
}

export interface AdminGameEvent {
  seq: number
  type: string
  data: unknown
}

export interface FraudFlagRow {
  id: string
  userId: string
  username: string | null
  kind: string
  confidence: number
  reason: string | null
  createdAt: string
}

export interface LedgerInvariance {
  ok: boolean
  checked: number
  violations: Array<{ userId: string; expected: number; actual: number; delta: number }>
}

export interface AdminActionRow {
  id: string
  adminId: string
  adminUsername: string | null
  action: string
  targetType: string
  targetId: string | null
  meta: unknown
  createdAt: string
}

export interface AdminDeposit {
  id: string
  userId: string
  network: string
  address: string
  amount: string | number
  currency: string
  status: string
  txHash: string | null
  screenshot: string | null
  creditedAmount: string | number | null
  rejectReason: string | null
  createdAt: string
  reviewedAt: string | null
  user: { id: string; username: string; email: string | null }
  reviewedBy: { id: string; username: string } | null
}

export interface AdminDepositsPayload {
  items: AdminDeposit[]
  pending: number
}

export interface AdminWithdrawalMatch {
  matchId: string
  mode: string
  format: string
  stake: number
  status: string
  finishedAt: string | null
  result: 'WIN' | 'LOSS' | 'UNKNOWN'
  opponent: string | null
}

export interface AdminWithdrawal {
  id: string
  userId: string
  network: string
  address: string
  amount: string | number
  currency: string
  status: string
  deducted: string | number | null
  /** Set aside from the player's balance at request time; null on requests from before holds. */
  heldAmount: string | number | null
  cancelledAt: string | null
  matchHistory: AdminWithdrawalMatch[] | null
  rejectReason: string | null
  createdAt: string
  reviewedAt: string | null
  user: { id: string; username: string; email: string | null }
  reviewedBy: { id: string; username: string } | null
}

export interface AdminWithdrawalsPayload {
  items: AdminWithdrawal[]
  pending: number
}

export type SettingsMap = Record<string, unknown>

export type ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED'
export const REVIEW_STATUSES: ReviewStatus[] = ['PENDING', 'APPROVED', 'REJECTED']

/** Withdrawals can also be withdrawn by the player while pending. */
export type WithdrawalStatus = ReviewStatus | 'CANCELLED'

export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'BANNED'
export const USER_STATUSES: UserStatus[] = ['ACTIVE', 'SUSPENDED', 'BANNED']

export type UserRole = 'PLAYER' | 'ADMIN'
export const USER_ROLES: UserRole[] = ['PLAYER', 'ADMIN']

export type SupportStatus = 'OPEN' | 'CLOSED'

export interface SupportMessage {
  id: string
  threadId: string
  senderId: string
  senderRole: 'USER' | 'ADMIN'
  body: string
  read: boolean
  createdAt: string
  sender: { id: string; username: string; role: string }
}

export interface SupportThreadRow {
  id: string
  userId: string
  status: SupportStatus
  lastMessageAt: string
  createdAt: string
  user: { id: string; username: string; email: string | null }
  assignedTo: { id: string; username: string } | null
  lastMessage: { id: string; body: string; senderRole: 'USER' | 'ADMIN'; createdAt: string } | null
  unreadCount: number
}

export interface SupportThreadDetail {
  id: string
  userId: string
  status: SupportStatus
  lastMessageAt: string
  createdAt: string
  user: { id: string; username: string; email: string | null; phone: string | null; status: string; createdAt: string }
  assignedTo: { id: string; username: string } | null
  messages: SupportMessage[]
}
