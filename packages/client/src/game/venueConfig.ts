/**
 * VENUE_CONFIG — every tunable behind the crowd, the applause and the turn presentation.
 *
 * Same units as `arenaConfig.ts` next door: millimetres, degrees, seconds. One object, so
 * the pace of the whole venue is dialled from one place: how full the bowl is, how long
 * the crowd claps for, how loud it is, how long the turn banner hangs, and how much of a
 * beat the game waits between visits.
 *
 * Nothing here reaches the rules. The delays in this file move *pictures and sound*
 * around an already-decided shot; they never move a ball, a score or a turn.
 */

/**
 * The applause file, served as-is from `public/`.
 *
 * The clip is an MP4 container holding an AAC stream, which is why it can be handed
 * straight to `decodeAudioData` or an `<audio>` element without being converted: every
 * browser that can play the video can decode its audio, and the video track is ignored.
 * Put the file at `packages/client/public/audio/clapping-best.mp4` and it resolves to the
 * path above. If it is missing, `crowdAudio` gives up quietly and the venue is silent.
 */
export const CLAP_AUDIO_PATH = '/audio/clapping-best.mp4'

export interface VenueConfig {
  crowd: {
    /**
     * Whether the bowl is filled at all.
     *
     * The master switch for the whole crowd: off, and `buildAudience` returns an empty
     * one — no instances, no matrices, no per-frame work. It exists for machines that
     * cannot spare the draws and for the render harness, which needs both sides of it
     * from a single build. Nothing else in the venue reads it: the seats, the bowl, the
     * lighting and the applause are all there whether anybody is sitting in them or not.
     */
    enabled: boolean
    /**
     * Fraction of seats that hold somebody.
     *
     * 0.88 rather than 1.0 on purpose: a full bowl reads as wallpaper, and the gaps are
     * what make a crowd read as a crowd of people who each arrived on their own.
     */
    occupancy: number
    /** Fixed seed, so the same bowl is filled the same way every reload. */
    seed: number
    /** Clothing. Weighted by repetition: two reds, then the rest. */
    clothing: string[]
    skinTones: string[]
    hairColors: string[]
    /** Hair silhouettes, cycled per person. */
    hairStyles: 'crop' | 'bob' | 'long' | 'bun'
    /** Shortest and tallest person, as a multiplier on the one-metre rig. */
    heightRange: [number, number]
    /** Low-poly budget: radial segments on a head. Six is a facet, not a sphere. */
    headSegments: number
    /** Idle sway, in degrees, and how fast it runs. */
    swayDeg: number
    swayRateHz: number
    /** How far the chest rises and falls while idle, in millimetres. */
    breathMm: number
    /**
     * Idle is slow enough to be re-run at half rate. Clapping is not, so it gets its own.
     * Both are per-second counts, and both exist to keep a five-draw-call crowd off the
     * per-frame budget.
     */
    idleUpdateHz: number
    clapUpdateHz: number
    clap: {
      /** Claps a second. A crowd claps faster than a person can, deliberately. */
      rateHz: number
      /** How far the arms swing up and forward at the top of a clap. */
      armRaiseDeg: number
      /** How much of that swing also carries the arms inward, as a fraction. */
      armInward: number
      /** Vertical bounce at the top of a clap, in millimetres. */
      bounceMm: number
      /** Forward lean at the top of a clap, in degrees. */
      leanDeg: number
    }
    /** People never cast: the lamp's shadow map is baked once and they are not in it. */
    castShadows: boolean
    receiveShadows: boolean
  }

  audio: {
    path: string
    /** Base level for a single potted ball. */
    volume: number
    /** Ceiling, so a four-ball break cannot clip. */
    maxGain: number
    /** Shortest and longest applause, in seconds. */
    minSeconds: number
    maxSeconds: number
    /** What each extra ball in the same shot adds, in seconds. */
    secondsPerExtraBall: number
    /** ...and in level. */
    gainPerExtraBall: number
    /** Start somewhere inside the clip rather than always at its first sample. */
    randomStart: boolean
  }

  banner: {
    /** How long the turn banner is up before it fades, in milliseconds. */
    holdMs: number
    youText: string
    opponentText: string
    /** The small always-on chip. */
    chipYouText: string
    chipOpponentText: string
  }

  /**
   * The beat between visits, in seconds.
   *
   * Purely presentational. When a turn changes, the table keeps showing what it was
   * showing for this long while the banner reads and the opponent's cue comes up; the
   * authoritative snapshot, the score, the clock and the rules are untouched, and the
   * delay is invisible whenever the table is standing still anyway.
   */
  turnDelaySeconds: number

  cue: {
    /** Where the cue tip rests, in millimetres behind the cue ball. */
    restGapMm: number
    /** Length of the stick. */
    lengthMm: number
    /** How far back the tip draws at full power. */
    drawBackMm: number
    /** Rise in front of the ball while the bot is still lining up. */
    liftMm: number
    /** Phase lengths, in seconds. */
    aimSeconds: number
    backswingSeconds: number
    strikeSeconds: number
    /** How long the stick stays across the table after the strike. */
    followThroughSeconds: number
    /** The power bar beside the cue. */
    barLengthMm: number
    barWidthMm: number
    barHeightMm: number
    /** Heat ramp, bottom to top, matching the player's power rail. */
    barColors: string[]
    /** How far the bar stands off the stick. */
    barOffsetMm: number
  }
}

export const VENUE_CONFIG: VenueConfig = {
  crowd: {
    enabled: true,
    occupancy: 0.88,
    seed: 0x5eed1a,
    clothing: ['#b03a3f', '#2f4d7c', '#e8e4dc', '#1f6a5a', '#c98a2b', '#4a3550', '#7d8a99'],
    skinTones: ['#f0c9a4', '#e0aa7e', '#c98a5e', '#a4673c', '#7a4a29', '#5c3520'],
    hairColors: ['#1b1512', '#3a2a1c', '#6b4a2b', '#a8a29b', '#d9d2c8', '#5a2f22'],
    hairStyles: 'crop',
    heightRange: [0.86, 1.06],
    headSegments: 6,
    swayDeg: 1.7,
    swayRateHz: 0.42,
    breathMm: 7,
    idleUpdateHz: 30,
    clapUpdateHz: 60,
    clap: {
      rateHz: 4.1,
      armRaiseDeg: 64,
      armInward: 0.55,
      bounceMm: 26,
      leanDeg: 7
    },
    castShadows: false,
    receiveShadows: false
  },

  audio: {
    path: CLAP_AUDIO_PATH,
    volume: 0.5,
    maxGain: 0.85,
    minSeconds: 2.1,
    maxSeconds: 4,
    secondsPerExtraBall: 0.5,
    gainPerExtraBall: 0.11,
    randomStart: true
  },

  banner: {
    holdMs: 2000,
    youText: 'YOUR TURN',
    opponentText: "OPPONENT'S TURN",
    chipYouText: 'Your turn',
    chipOpponentText: "Opponent's turn"
  },

  turnDelaySeconds: 1.5,

  cue: {
    restGapMm: 10,
    lengthMm: 1450,
    drawBackMm: 210,
    liftMm: 26,
    aimSeconds: 0.55,
    backswingSeconds: 0.4,
    strikeSeconds: 0.11,
    followThroughSeconds: 0.32,
    barLengthMm: 900,
    barWidthMm: 70,
    barHeightMm: 26,
    barColors: ['#27ae60', '#7ec35a', '#d29922', '#e0752f', '#c9302b'],
    barOffsetMm: 150
  }
}