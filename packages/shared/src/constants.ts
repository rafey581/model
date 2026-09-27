export const TABLE_LENGTH = 3569
export const TABLE_WIDTH = 1778

export const BALL_DIAMETER = 52.5
export const BALL_RADIUS = BALL_DIAMETER / 2

export const BAULK_LINE_X = 737
export const D_RADIUS = 292

export const POCKET_RADIUS_CORNER = BALL_RADIUS + 22
export const POCKET_RADIUS_MIDDLE = BALL_RADIUS + 26

export const CUSHION_RESTITUTION_LONG = 0.8
export const CUSHION_RESTITUTION_SHORT = 0.75
export const CUSHION_TANGENTIAL_DAMP = 0.92

export const BALL_RESTITUTION = 0.95

export const ROLL_FRICTION = 90
// Fractional spin bleed-off per second: spin retains (1 - SPIN_FRICTION)^TICK_RATE
// each second, i.e. about 37% per second at 1.
export const SPIN_FRICTION = 1
export const MIN_SPEED = 1.5
export const MAX_CUE_SPEED = 9000

// Follow and draw are applied once, at the cue ball's first contact, as a
// fraction of the cue ball's speed immediately before that contact. Scaling by
// the post-contact residual instead makes both effects vanishingly small.
export const FOLLOW_IMPULSE = 0.08
export const DRAW_IMPULSE = 0.1
// Spin-induced throw, in degrees of object-ball deflection at full side spin.
// A bounded rotation, so it cannot add energy to the collision.
export const SIDE_SPIN_THROW_DEG = 3

export const TICK_RATE = 120
export const TICK_DT = 1 / TICK_RATE
export const MAX_SIM_TICKS = TICK_RATE * 60

export const RED_VALUE = 1

export const BALL_IDS = {
  CUE: 0,
  RED_MIN: 1,
  RED_MAX: 15,
  YELLOW: 16,
  GREEN: 17,
  BROWN: 18,
  BLUE: 19,
  PINK: 20,
  BLACK: 21
} as const

export const COLOR_VALUES: Record<number, number> = {
  [BALL_IDS.YELLOW]: 2,
  [BALL_IDS.GREEN]: 3,
  [BALL_IDS.BROWN]: 4,
  [BALL_IDS.BLUE]: 5,
  [BALL_IDS.PINK]: 6,
  [BALL_IDS.BLACK]: 7
}

export const COLOR_ORDER: number[] = [
  BALL_IDS.YELLOW,
  BALL_IDS.GREEN,
  BALL_IDS.BROWN,
  BALL_IDS.BLUE,
  BALL_IDS.PINK,
  BALL_IDS.BLACK
]

export const COLOR_NAMES: Record<number, string> = {
  [BALL_IDS.YELLOW]: 'yellow',
  [BALL_IDS.GREEN]: 'green',
  [BALL_IDS.BROWN]: 'brown',
  [BALL_IDS.BLUE]: 'blue',
  [BALL_IDS.PINK]: 'pink',
  [BALL_IDS.BLACK]: 'black'
}

export const TOTAL_REDS = 15

export const PRACTICE_AI_LEVELS = ['EASY', 'MEDIUM', 'HARD'] as const
export type PracticeAiLevel = (typeof PRACTICE_AI_LEVELS)[number]

export const MATCH_FORMATS = ['BO1', 'BO3', 'BO5'] as const
export type MatchFormat = (typeof MATCH_FORMATS)[number]

export const TOURNAMENT_SIZE = 8
export const START_BALANCE_VIRTUAL = 1000

export const PRACTICE_DAILY_FREE_LIMIT = 3

export const STAKE_TIERS = [
  { id: 'TIER_1', usd: 1, credits: 100, label: '$1 table' },
  { id: 'TIER_5', usd: 5, credits: 500, label: '$5 table' },
  { id: 'TIER_10', usd: 10, credits: 1000, label: '$10 table' }
] as const
export type StakeTierId = (typeof STAKE_TIERS)[number]['id']
export const STAKE_TIER_IDS: readonly [StakeTierId, ...StakeTierId[]] = [STAKE_TIERS[0].id, STAKE_TIERS[1].id, STAKE_TIERS[2].id]
export type StakeTier = (typeof STAKE_TIERS)[number]