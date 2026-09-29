export const TABLE_LENGTH = 3569
export const TABLE_WIDTH = 1778

export const BALL_DIAMETER = 52.5
export const BALL_RADIUS = BALL_DIAMETER / 2

export const BAULK_LINE_X = 737
export const D_RADIUS = 292

export const POCKET_RADIUS_CORNER = BALL_RADIUS + 22
export const POCKET_RADIUS_MIDDLE = BALL_RADIUS + 26

export const CUSHION_RESTITUTION_LONG = 0.85
export const CUSHION_RESTITUTION_SHORT = 0.85
export const CUSHION_TANGENTIAL_DAMP = 0.85

/**
 * Ball-to-ball coefficient of restitution.
 *
 * Phenolic snooker balls collide nearly elastically — measured values sit around
 * 0.92-0.96 — so 0.96 is the authentic figure: an object ball leaves a full hit
 * carrying almost the whole of the cue ball's pace, which is what stops the pack
 * feeling heavy and object balls dying on the spot they were struck.
 */
export const BALL_RESTITUTION = 0.96

/**
 * Sliding friction, in mm/s^2, applied to a ball that is still skidding.
 *
 * Right after the strike a snooker ball is sliding, not rolling, and sliding cloth
 * drags roughly five to eight times harder than rolling resistance does. 1800
 * mm/s^2 (1.8 m/s^2) sits in that band. The slide phase only lasts while the ball
 * is quick — it hands over to rolling resistance below `SLIDE_SPEED_THRESHOLD` —
 * so its job is the short, brisk scrub that takes the edge off a hard shot
 * immediately after impact, exactly the way cloth does.
 */
export const SLIDE_FRICTION = 1800
/**
 * The speed, in mm/s, below which a ball is treated as rolling rather than sliding.
 *
 * Roughly the pace at which a snooker ball's surface speed matches its centre —
 * natural roll — reached in a fraction of a second on anything but a soft stun
 * shot. Below it the ball rolls and only rolling resistance applies.
 */
export const SLIDE_SPEED_THRESHOLD = 800
/**
 * Rolling resistance coefficient: the constant-deceleration model of C_rr.
 *
 * On snooker cloth C_rr sits around 0.01-0.015; the game uses g*C_rr with g in
 * mm/s^2, so 0.018 * 9810 = 176.6 mm/s^2 — at the glidey end of real cloth, so
 * balls run on to the pocket rather than dying short of it. The old single-phase
 * model (400 mm/s^2 at every speed) over-braked exactly this: the last stretch of
 * every pot arrived with an abrupt stop.
 */
export const CLOTH_CRR = 0.018
export const GRAVITY_MM_S2 = 9810
/**
 * Rolling deceleration in mm/s^2, derived from the coefficient above.
 *
 * Kept as a named constant rather than computed at the call site so the value the
 * simulation uses is the one the tests read.
 */
export const ROLL_FRICTION = CLOTH_CRR * GRAVITY_MM_S2
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

/**
 * How much faster than real time a shot is replayed at.
 *
 * This lives in shared because the server needs it too: it works out how long a
 * client's replay will run so it can hold the next shot until that replay has
 * finished. The two sides therefore have to agree on one number.
 *
 * The current cloth brings a routine shot to rest in 4-5 seconds and a full-power
 * break in 5-7. Replayed at 2x that is roughly 2-3.5 seconds on screen, which is
 * slow enough to follow any individual ball with your eye as it runs and settles
 * rather than having the whole position snap into place. Six times too fast made
 * the table look like it was twitching.
 *
 * This is a presentation choice only, and it is meant to be tuned by eye: the
 * simulation is unaffected by it, and the server's playback hold is derived from
 * it so the two cannot drift apart.
 */
export const SHOT_PLAYBACK_SPEED = 2

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