/**
 * The app's palette and spacing.
 *
 * Dark, low-chrome and gold-accented to match the player app, but tuned for
 * one-handed use: a single accent, generous row height, and semantic colour names
 * so a status pill never hard-codes a hex value at the call site.
 */
export const colors = {
  background: '#0b0d12',
  surface: '#141822',
  surfaceAlt: '#1b2130',
  border: '#262d3d',
  text: '#e7ecf5',
  muted: '#8b97ad',
  accent: '#d29922',
  accentSoft: '#3a2f14',
  positive: '#3fb950',
  positiveSoft: '#12241a',
  negative: '#f85149',
  negativeSoft: '#2a1416',
  warning: '#d29922',
  warningSoft: '#2a2210',
  info: '#4c8dff',
  infoSoft: '#141f33',
  cloth: '#0e5c3f',
  clothRail: '#7b4a1d',
  clue: '#f0e6d6'
} as const

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32
} as const

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999
} as const

/** Colour pair for a status/score token, chosen by an upper-case status string. */
export function statusTone(status: string | null | undefined): { fg: string; bg: string } {
  switch ((status ?? '').toUpperCase()) {
    case 'APPROVED':
    case 'ACTIVE':
    case 'PRIZE_SETTLED':
    case 'WIN':
      return { fg: colors.positive, bg: colors.positiveSoft }
    case 'REJECTED':
    case 'BANNED':
    case 'LOSS':
      return { fg: colors.negative, bg: colors.negativeSoft }
    case 'PENDING':
    case 'SUSPENDED':
    case 'MATCH_STARTED':
    case 'MATCH_IN_PROGRESS':
    case 'UNKNOWN':
      return { fg: colors.warning, bg: colors.warningSoft }
    default:
      return { fg: colors.muted, bg: colors.surfaceAlt }
  }
}
