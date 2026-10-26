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
 * Radius of the rounded pocket jaw (knuckle) that caps each end of a cushion
 * face, in mm.
 *
 * A real cushion does not run all the way into a pocket: its face stops a little
 * short and the last few centimetres are a rounded jaw that steers a ball into
 * the pocket mouth. Modelling that jaw as a circle of this radius is what lets a
 * ball rolled along the rail drop in instead of being turned back by a cushion
 * that is not physically there.
 */
export const CUSHION_KNUCKLE_RADIUS = 20

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
 * Sliding friction, in mm/s^2: the cloth's grip on a ball that is skidding (mu_s * g).
 *
 * A ball skids whenever its surface is not keeping pace with its centre: straight off
 * the tip on anything but a top-spin strike, an object ball just after it is hit, a
 * ball just off a cushion. While it skids the cloth pulls on the contact point, which
 * both slows the centre and spins the ball up (or, against back spin, wears the back
 * spin off). The skid ends on its own the moment surface and centre agree — natural
 * roll — and from then on only rolling resistance acts. Nothing here depends on how
 * fast the ball is going; it depends only on whether it is skidding.
 *
 * 1800 mm/s^2 is a sliding coefficient of about 0.18 on cloth, the measured band for
 * a phenolic ball on woollen cloth.
 */
export const SLIDE_FRICTION = 1800
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
// Sidespin lasts longer on cloth than vertical tip spin.
export const SIDE_SPIN_FRICTION = 0.55
export const MIN_SPEED = 1.5
export const MAX_CUE_SPEED = 9000

/**
 * How much rotation a full top or bottom tip offset puts on the cue ball, as the speed
 * its surface turns at over the speed its centre leaves at.
 *
 * Struck dead centre the cue ball leaves with no rotation at all and skids; struck at
 * the highest (or lowest) offset a tip can hold, about half a radius from centre, it
 * leaves turning at 5/2 x 0.5 = 1.25 times its own pace. That is why a top-spin
 * ball pushes on a touch faster once it grips, and why a screw shot keeps its back spin
 * for a while before the cloth wears it off. Follow and screw are not added at the
 * contact as a kick: they are what the ball's rotation does once the object ball has
 * taken its pace.
 */
export const TIP_SPIN_RATIO = 1.25
// Spin-induced throw, in degrees of object-ball deflection at full side spin.
// A bounded rotation, so it cannot add energy to the collision.
export const SIDE_SPIN_THROW_DEG = 3
// Fraction of cue tip-spin copied onto the object ball at contact.
export const SPIN_TRANSFER = 0.18
// Tangential rebound nudge from sidespin as a fraction of post-bounce normal speed.
export const CUSHION_SIDESPIN_KICK = 0.04
/**
 * How a cushion's rebound changes with the pace a ball arrives at, per m/s of normal speed.
 *
 * A rubber cushion gives back more of a gentle touch than of a hard hit, because a hard
 * hit drives the ball into the rubber and the cloth beneath it. The listed restitution
 * is the figure at a medium pace of 2 m/s; the rebound is scaled by
 * 1 + falloff x (2 - v) and held within the bounds below, so a ball rolled softly into a
 * cushion comes back a little livelier and a hard one a little deader.
 */
export const CUSHION_SPEED_FALLOFF = 0.04
export const CUSHION_SPEED_SCALE_MIN = 0.86
export const CUSHION_SPEED_SCALE_MAX = 1.07

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
 * break in 5-7. Replayed at 1.5x that is roughly 3-4.5 seconds on screen, which is
 * slow enough to follow any individual ball with your eye as it runs and settles
 * rather than having the whole position snap into place. At 2x a hard-struck ball
 * crossed too much cloth per frame to be followed, and six times too fast made the
 * table look like it was twitching.
 *
 * This is a presentation choice only, and it is meant to be tuned by eye: the
 * simulation is unaffected by it, and the server's playback hold is derived from
 * it so the two cannot drift apart.
 *
 * Now real time. Sped up, every ball moved half as fast again as the cloth said it
 * should, and a ball rolling to a stop read as one gliding across ice: a real table is
 * the speed a player's eye is tuned to, and anything else looks like a skid.
 */
export const SHOT_PLAYBACK_SPEED = 1

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

/**
 * The product's name, in one place.
 *
 * `index.html` cannot import it, so its `<title>` is typed again there. Everything the
 * app renders — sign-in, the hall, the loading line — reads this constant.
 */
export const APP_TITLE = 'Snooker Stake'

/** Shown when a guest tries to stake, deposit, withdraw, or use friends. */
export const GUEST_STAKE_PROMPT = 'Sign up to play for stakes'

export const PRACTICE_AI_LEVELS = ['EASY', 'MEDIUM', 'HARD'] as const
export type PracticeAiLevel = (typeof PRACTICE_AI_LEVELS)[number]

export const MATCH_FORMATS = ['BO1', 'BO3', 'BO5'] as const
export type MatchFormat = (typeof MATCH_FORMATS)[number]

export const TOURNAMENT_SIZE = 8
/** Balance a new account starts with, in USDT (1 USDT = 1 unit). */
export const START_BALANCE_USDT = 1

/**
 * What an inviter earns when someone who signed up with their code plays their
 * first real match. Paid once per invitee, never at signup.
 */
export const REFERRAL_BONUS_USDT = 1

export const PRACTICE_DAILY_FREE_LIMIT = 3

/**
 * Which public table a stake belongs to.
 *
 * `OPEN` is the ordinary challenge (1 through 100 USDT). `MASTER` is the high-stake
 * Master Match (500 through 5000 USDT). Both still go through the same ledger freeze
 * and the same balance check; neither turns on the crypto rails.
 */
export const STAKE_TABLES = ['OPEN', 'MASTER'] as const
export type StakeTable = (typeof STAKE_TABLES)[number]

/**
 * The stake tables. The game plays in USDT at 1:1 — a `1 USDT` table stakes one USDT
 * per player — so the tier amount *is* the table's money, no conversion.
 */
export const STAKE_TIERS = [
  { id: 'TIER_1', usdt: 1, label: '1 USDT', table: 'OPEN' },
  { id: 'TIER_5', usdt: 5, label: '5 USDT', table: 'OPEN' },
  { id: 'TIER_10', usdt: 10, label: '10 USDT', table: 'OPEN' },
  { id: 'TIER_20', usdt: 20, label: '20 USDT', table: 'OPEN' },
  { id: 'TIER_50', usdt: 50, label: '50 USDT', table: 'OPEN' },
  { id: 'TIER_100', usdt: 100, label: '100 USDT', table: 'OPEN' },
  { id: 'MASTER_500', usdt: 500, label: '500 USDT', table: 'MASTER' },
  { id: 'MASTER_1000', usdt: 1000, label: '1000 USDT', table: 'MASTER' },
  { id: 'MASTER_2000', usdt: 2000, label: '2000 USDT', table: 'MASTER' },
  { id: 'MASTER_3000', usdt: 3000, label: '3000 USDT', table: 'MASTER' },
  { id: 'MASTER_5000', usdt: 5000, label: '5000 USDT', table: 'MASTER' }
] as const
export type StakeTierId = (typeof STAKE_TIERS)[number]['id']
export const STAKE_TIER_IDS = STAKE_TIERS.map((tier) => tier.id) as unknown as readonly [StakeTierId, ...StakeTierId[]]
export type StakeTier = (typeof STAKE_TIERS)[number]

export function stakeTierById(id: string): StakeTier | undefined {
  return STAKE_TIERS.find((tier) => tier.id === id)
}

export function stakesForTable(table: StakeTable): StakeTier[] {
  return STAKE_TIERS.filter((tier) => tier.table === table)
}

/** Match row type written when a tier is accepted. Master stakes are not practice. */
export function matchTypeForStake(tierId: string): 'ONE_V_ONE' | 'MASTER' {
  return stakeTierById(tierId)?.table === 'MASTER' ? 'MASTER' : 'ONE_V_ONE'
}