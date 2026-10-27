import type { BallOn, BallState, FrameState, PracticeAiLevel, ShotInput } from '@snooker/shared'
import {
  BALL_RADIUS,
  BAULK_LINE_X,
  COLOR_VALUES,
  D_RADIUS,
  MAX_CUE_SPEED,
  TABLE_LENGTH,
  TABLE_WIDTH,
  applyStroke,
  canPlaceCueBall,
  clamp,
  pocketPositions,
  seededRandom,
  simulateStroke,
  vec
} from '@snooker/shared'

/**
 * The practice robot.
 *
 * Every shot it plays has been played first, on a copy of the frame, through the same
 * physics and the same rules the room uses (`applyStroke`). The table is deterministic,
 * so a shot that pots on the copy pots on the table, and a shot the rules call legal on
 * the copy is legal on the table. That is what keeps it from the two faults it used to
 * make: hitting a colour first while a red is on, and missing everything when the
 * direct line was covered.
 *
 * A turn is chosen in three steps:
 *   1. Pots. Every legal ball is paired with every pocket it has a clear line to, and the
 *      most makeable of those are tried across a ladder of powers (and, for the stronger
 *      levels, spins and fine aim). A pot that also leaves a good next shot wins.
 *   2. Safety. With no pot, it plays the legal contact that leaves the opponent the
 *      least, preferring to leave them snookered.
 *   3. Escape. Snookered, it sweeps the full circle for any angle, cushions included,
 *      that reaches a legal ball first.
 * Only when nothing legal exists anywhere does it play the least costly foul.
 *
 * Levels differ in how wide they search, whether they think about the next shot, and
 * how cleanly they strike a pot once it is chosen. EASY and MEDIUM carry a small cueing
 * error on pots, so they miss the way a human misses: a pot rattles, it does not turn
 * into hitting the wrong ball.
 */

export interface BotMove {
  shot: ShotInput
}

interface BotSkillProfile {
  /** Pot lines (ball + pocket) actually simulated, best first. */
  potPool: number
  /** Multipliers on the estimated pot power, nearest first. */
  powers: readonly number[]
  /** Fine aim corrections in radians, for cut-induced throw. */
  offsets: readonly number[]
  /** Top/back spin options tried on a pot that works, for the cue ball's leave. */
  spins: readonly number[]
  /** Whether a pot is valued by the next shot it leaves. */
  position: boolean
  /** Thinnest cut considered (cosine of the cut angle). */
  minCut: number
  /** Legal balls considered for a safety, nearest first. */
  safetyBalls: number
  safetyPowers: readonly number[]
  safetyFractions: readonly number[]
  /** Escape sweep step, in degrees. */
  sweepStep: number
  /** Cue-ball spots tried with the ball in hand. */
  inHandSpots: number
  /** Cueing error after the shot is chosen: aim (radians) and power (fraction). */
  aimError: number
  powerError: number
  /**
   * Trial shots allowed per decision. Each trial is a full simulation, and the room runs
   * on the server's one thread, so this is what keeps the robot's thinking from holding
   * up other tables. Counted in trials, not milliseconds, so the same position always
   * gets the same shot. The escape sweep is exempt: a legal shot is never given up for time.
   */
  budget: number
}

const LEVEL_CONFIG: Record<PracticeAiLevel, BotSkillProfile> = {
  EASY: {
    potPool: 2,
    powers: [1, 0.8, 1.25],
    offsets: [0],
    spins: [],
    position: false,
    minCut: 0.5,
    safetyBalls: 2,
    safetyPowers: [0.3],
    safetyFractions: [0],
    sweepStep: 6,
    inHandSpots: 1,
    aimError: 0.012,
    powerError: 0.1,
    budget: 16
  },
  MEDIUM: {
    potPool: 5,
    powers: [1, 0.85, 1.18, 0.72, 1.35],
    offsets: [0, 0.006, -0.006],
    spins: [],
    position: true,
    minCut: 0.35,
    safetyBalls: 3,
    safetyPowers: [0.22, 0.38],
    safetyFractions: [0, 0.5, -0.5],
    sweepStep: 3,
    inHandSpots: 3,
    aimError: 0.0035,
    powerError: 0.04,
    budget: 50
  },
  HARD: {
    potPool: 8,
    powers: [1, 0.86, 1.16, 0.74, 1.32, 0.62, 1.5],
    offsets: [0, 0.004, -0.004, 0.009, -0.009],
    spins: [-0.6, 0.5],
    position: true,
    minCut: 0.2,
    safetyBalls: 4,
    safetyPowers: [0.18, 0.3, 0.45, 0.62],
    safetyFractions: [0, 0.45, -0.45, 0.8, -0.8],
    sweepStep: 2,
    inHandSpots: 4,
    aimError: 0,
    powerError: 0,
    budget: 90
  }
}

/** Ticks a trial shot may run: long enough for every ball to stop on any sensible shot. */
const TRIAL_TICKS = 1800
/** Longest an escape-sweep probe may run before its first contact (several cushions). */
const PROBE_TICKS = 480
/** Ways out of a snooker that are played through in full to pick the best. */
const ESCAPE_TRIALS = 6
const CONTACT = 2 * BALL_RADIUS
const D_CENTRE = { x: BAULK_LINE_X, y: TABLE_WIDTH / 2 }
/** A pot that leaves at least this good a next shot is taken without looking further. */
const GOOD_LEAVE = 0.6

/** Trials used by the decision in progress (computeBotShot is synchronous, so one at a time). */
let trialsUsed = 0
let trialBudget = Infinity
const outOfBudget = () => trialsUsed >= trialBudget

interface Vec {
  x: number
  y: number
}

interface PotLine {
  targetId: number
  angle: number
  power: number
  quality: number
}

interface Trial {
  shot: ShotInput
  score: number
  pots: boolean
  foul: boolean
}

export function computeBotShot(frame: FrameState, level: PracticeAiLevel, seed: string): BotMove {
  const cueBall = frame.balls.find((b) => b.isCue && !b.potted)
  if (!cueBall && !frame.cueInHand) {
    return { shot: { aimAngle: 0, power: 0.1, spin: vec(0, 0), timestamp: 0 } }
  }
  const config = LEVEL_CONFIG[level]
  const rng = seededRandom(shotSeed(frame, level, seed))
  trialsUsed = 0
  trialBudget = config.budget
  const best = frame.cueInHand ? chooseInHand(frame, config) : chooseFrom(frame, config)
  // The cueing error goes on pots only. A pot that is struck a hair off rattles in the
  // jaws, which is how a weaker player misses. The same error on a safety or an escape
  // off several cushions grows into missing every ball, which is not a weaker player but
  // a broken one, so those are struck as chosen.
  if (!best.pots) return { shot: best.shot }
  const struck = withCueingError(best.shot, config, rng)
  // A pot may rattle, but the error must never be what turns it into a foul: if the shot
  // as it will actually be struck fouls, it is struck as chosen instead.
  if (struck !== best.shot && evaluateIn(frame, struck, config).foul) return { shot: best.shot }
  return { shot: struck }
}

function chooseFrom(frame: FrameState, config: BotSkillProfile): Trial {
  const pot = bestPot(frame, config)
  if (pot) return pot
  return bestSafety(frame, config)
}

/**
 * Ball in hand: try a handful of spots and play the best shot from the best of them.
 * At the break-off the spots are inside the D; later in the frame they may be anywhere,
 * so the robot also tries spots set up straight behind a pot.
 */
function chooseInHand(frame: FrameState, config: BotSkillProfile): Trial {
  const spots = inHandSpots(frame, config)
  let best: Trial | null = null
  for (const spot of spots) {
    const placed = withCueAt(frame, spot)
    const trial = chooseFrom(placed, config)
    const shot = { ...trial.shot, cuePos: { x: spot.x, y: spot.y } }
    if (!best || trial.score > best.score) best = { ...trial, shot }
    if ((best.pots && best.score > 1250) || outOfBudget()) break
  }
  return best ?? { shot: { aimAngle: 0, power: 0.3, spin: vec(0, 0), timestamp: 0 }, score: -Infinity, pots: false, foul: true }
}

function inHandSpots(frame: FrameState, config: BotSkillProfile): Vec[] {
  const ranked: Array<{ spot: Vec; quality: number }> = []
  const legal = legalTargets(frame, frame.ballOn)
  const fallback = { x: D_CENTRE.x - D_RADIUS * 0.5, y: D_CENTRE.y + D_RADIUS * 0.45 }
  // The break-off: nothing can be potted from the D into a full pack, so where in the D
  // matters little. One spot, beside the brown, leaves the whole budget to the shot.
  if (frame.cueInHandInD && frame.pottedOrder.length === 0 && canPlaceCueBall(frame, fallback)) return [fallback]
  const consider = (spot: Vec) => {
    if (!canPlaceCueBall(frame, spot)) return
    const lines = potLines(withCueAt(frame, spot), spot, legal, config.minCut)
    ranked.push({ spot, quality: lines[0]?.quality ?? 0 })
  }
  for (const r of [0.25, 0.55, 0.85]) {
    for (const deg of [180, 135, 225, 100, 260]) {
      const a = (deg * Math.PI) / 180
      consider({ x: D_CENTRE.x + Math.cos(a) * D_RADIUS * r, y: D_CENTRE.y + Math.sin(a) * D_RADIUS * r })
    }
  }
  if (!frame.cueInHandInD) {
    // Anywhere on the table: line up behind each pot, at a comfortable distance.
    for (const id of legal) {
      const target = frame.balls.find((b) => b.id === id && !b.potted)
      if (!target) continue
      for (const pocket of pocketPositions()) {
        const dir = unit(sub(pocket, target.pos))
        if (!dir) continue
        for (const back of [260, 480]) {
          consider({ x: target.pos.x - dir.x * (CONTACT + back), y: target.pos.y - dir.y * (CONTACT + back) })
        }
      }
    }
  }
  ranked.sort((a, b) => b.quality - a.quality)
  const spots = ranked.slice(0, config.inHandSpots).map((r) => r.spot)
  // A spot in the D is always kept as a fallback for a safety.
  if (canPlaceCueBall(frame, fallback) && !spots.some((s) => s.x === fallback.x && s.y === fallback.y)) spots.push(fallback)
  return spots
}

function withCueAt(frame: FrameState, spot: Vec): FrameState {
  const copy = cloneFrame(frame)
  const cue = copy.balls.find((b) => b.isCue)!
  cue.pos = { x: spot.x, y: spot.y }
  cue.vel = vec(0, 0)
  cue.spin = vec(0, 0)
  cue.angularVel = 0
  cue.potted = false
  copy.cueInHand = false
  return copy
}

// ---------------------------------------------------------------- pots

function bestPot(frame: FrameState, config: BotSkillProfile): Trial | null {
  const cue = frame.balls.find((b) => b.isCue && !b.potted)
  if (!cue) return null
  const lines = potLines(frame, cue.pos, legalTargets(frame, frame.ballOn), config.minCut, config.aimError).slice(0, config.potPool)
  let best: Trial | null = null
  let refined = 0
  for (const line of lines) {
    if (outOfBudget()) break
    const found = firstPottingShot(frame, line, config)
    if (!found) continue
    let lineBest = found
    // Spin for position is worked out on the two most promising pots only.
    if (refined < 2 && !leavesWell(found, config)) {
      refined++
      for (const spinY of config.spins) {
        for (const scaleBy of [1, 0.88, 1.14]) {
          if (outOfBudget()) break
          const shot = { ...found.shot, power: clamp(found.shot.power * scaleBy, 0.08, 1), spin: vec(0, spinY) }
          const trial = evaluate(frame, shot, config)
          if (trial.pots && trial.score > lineBest.score) lineBest = trial
        }
      }
    }
    if (!best || lineBest.score > best.score) best = lineBest
    if (leavesWell(best, config)) break
  }
  return best
}

/** A pot worth taking at once: it wins the frame, or (for levels that look ahead) leaves a good next shot. */
function leavesWell(trial: Trial, config: BotSkillProfile): boolean {
  if (trial.score >= 5000) return true
  return config.position && trial.score >= 1000 + 15 + GOOD_LEAVE * 300
}

function firstPottingShot(frame: FrameState, line: PotLine, config: BotSkillProfile): Trial | null {
  for (const scaleBy of config.powers) {
    for (const offset of config.offsets) {
      if (outOfBudget()) return null
      const shot: ShotInput = { aimAngle: line.angle + offset, power: clamp(line.power * scaleBy, 0.08, 1), spin: vec(0, 0), timestamp: 0 }
      const trial = evaluate(frame, shot, config)
      if (trial.pots) return trial
    }
  }
  return null
}

/**
 * Every makeable pot from `from`: a legal ball, a pocket, a clear line for the cue ball
 * to the contact point and a clear line for the object ball to the pocket. Best first.
 */
function potLines(frame: FrameState, from: Vec, legalIds: number[], minCut: number, aimError = 0): PotLine[] {
  const lines: PotLine[] = []
  for (const id of legalIds) {
    const target = frame.balls.find((b) => b.id === id && !b.potted)
    if (!target) continue
    for (const pocket of pocketPositions()) {
      const toPocket = sub(pocket, target.pos)
      const pocketDist = len(toPocket)
      if (pocketDist < BALL_RADIUS) continue
      const dir = { x: toPocket.x / pocketDist, y: toPocket.y / pocketDist }
      // A middle pocket only takes a ball coming at it, not one running along the cushion.
      if (pocket.kind === 'middle' && Math.abs(dir.y) < 0.6) continue
      const ghost = { x: target.pos.x - dir.x * CONTACT, y: target.pos.y - dir.y * CONTACT }
      const toGhost = sub(ghost, from)
      const aimDist = len(toGhost)
      if (aimDist < BALL_RADIUS) continue
      const aimDir = { x: toGhost.x / aimDist, y: toGhost.y / aimDist }
      const cut = aimDir.x * dir.x + aimDir.y * dir.y
      if (cut < minCut) continue
      // On a thin cut the cue ball only just reaches the object ball. A player whose aim
      // wanders by `aimError` does not attempt one so fine that the wander misses it.
      const reachMargin = CONTACT * (1 - Math.sqrt(Math.max(0, 1 - cut * cut)))
      if (aimError > 0 && reachMargin < aimError * aimDist * 2 + 4) continue
      if (pathBlocked(frame, from, ghost, [target.id])) continue
      if (pathBlocked(frame, target.pos, pocket, [target.id])) continue
      const reach = 1 - (aimDist + pocketDist) / (TABLE_LENGTH * 2.2)
      lines.push({
        targetId: id,
        angle: Math.atan2(toGhost.y, toGhost.x),
        power: potPower(aimDist, pocketDist, cut),
        quality: clamp(cut * cut * reach, 0, 1)
      })
    }
  }
  lines.sort((a, b) => b.quality - a.quality)
  return lines
}

/** A first guess at the pace a pot needs; the power ladder and the simulation correct it. */
function potPower(aimDist: number, pocketDist: number, cut: number): number {
  const objectSpeed = clamp(900 + pocketDist * 0.95, 1000, 3600)
  const cueSpeed = objectSpeed / Math.max(cut, 0.3) + aimDist * 0.35
  return clamp(cueSpeed / MAX_CUE_SPEED, 0.1, 0.95)
}

// ---------------------------------------------------------------- safety and escape

function bestSafety(frame: FrameState, config: BotSkillProfile): Trial {
  const cue = frame.balls.find((b) => b.isCue && !b.potted)!
  const legalIds = legalTargets(frame, frame.ballOn)
  let best: Trial | null = null
  const consider = (shot: ShotInput) => {
    // Out of trials: stop here. With nothing legal found yet, the escape sweep below
    // (which is not limited) still finds one.
    if (outOfBudget()) return
    const trial = evaluate(frame, shot, config)
    if (!best || trial.score > best.score) best = trial
  }

  const targets = legalIds
    .map((id) => frame.balls.find((b) => b.id === id && !b.potted))
    .filter((b): b is BallState => !!b)
    .sort((a, b) => len(sub(a.pos, cue.pos)) - len(sub(b.pos, cue.pos)))
  let tried = 0
  for (const target of targets) {
    if (tried >= config.safetyBalls) break
    const toTarget = sub(target.pos, cue.pos)
    const dist = len(toTarget)
    if (dist < CONTACT) continue
    const centre = Math.atan2(toTarget.y, toTarget.x)
    let open = false
    for (const fraction of config.safetyFractions) {
      // Fraction of a full ball: 0 is full in the face, ±0.8 is a fine contact on either side.
      const angle = centre + Math.asin(clamp((fraction * CONTACT) / dist, -0.95, 0.95))
      const contact = { x: cue.pos.x + Math.cos(angle) * (dist - CONTACT), y: cue.pos.y + Math.sin(angle) * (dist - CONTACT) }
      if (pathBlocked(frame, cue.pos, contact, [target.id])) continue
      open = true
      for (const power of config.safetyPowers) {
        consider({ aimAngle: angle, power, spin: vec(0, 0), timestamp: 0 })
      }
    }
    if (open) tried++
  }

  const current = best as Trial | null
  if (current && !current.foul) return current
  return escape(frame, config, legalIds) ?? current ?? evaluate(frame, nearestAim(frame, legalIds, cue.pos), config)
}

/**
 * Snookered: sweep the whole circle, at two paces, for any line (off one cushion or
 * several) whose first contact is a legal ball, then play the best of those.
 */
function escape(frame: FrameState, config: BotSkillProfile, legalIds: number[]): Trial | null {
  const hits: ShotInput[] = []
  // A firm pace first: it reaches off one cushion or several. Softer and harder only if
  // that finds too few ways out to choose between.
  for (const power of [0.6, 0.85, 0.4]) {
    for (let deg = 0; deg < 360; deg += config.sweepStep) {
      const shot: ShotInput = { aimAngle: (deg * Math.PI) / 180, power, spin: vec(0, 0), timestamp: 0 }
      const probe = simulateStroke(frame.balls, shot, { maxTicks: PROBE_TICKS, untilFirstContact: true })
      if (probe.firstContactId !== null && legalIds.includes(probe.firstContactId) && !probe.cuePotted) hits.push(shot)
    }
    if (hits.length >= 3) break
  }
  if (hits.length === 0) return null
  // Spread the full evaluations over the hits rather than taking only the first few
  // neighbouring angles, which would all leave much the same position.
  const step = Math.max(1, Math.ceil(hits.length / ESCAPE_TRIALS))
  let best: Trial | null = null
  for (let i = 0; i < hits.length; i += step) {
    const trial = evaluate(frame, hits[i]!, config)
    if (!best || trial.score > best.score) best = trial
  }
  return best
}

function nearestAim(frame: FrameState, legalIds: number[], from: Vec): ShotInput {
  let nearest: BallState | null = null
  for (const id of legalIds) {
    const ball = frame.balls.find((b) => b.id === id && !b.potted)
    if (ball && (!nearest || len(sub(ball.pos, from)) < len(sub(nearest.pos, from)))) nearest = ball
  }
  const aim = nearest?.pos ?? { x: TABLE_LENGTH * 0.7, y: TABLE_WIDTH / 2 }
  return { aimAngle: Math.atan2(aim.y - from.y, aim.x - from.x), power: 0.4, spin: vec(0, 0), timestamp: 0 }
}

// ---------------------------------------------------------------- judging a shot

/**
 * Plays `shot` on a copy of the frame through the real rules and scores the result.
 *   foul        well below zero, by the points it gives away
 *   pot         1000 + the points, + the next shot it leaves (levels that look ahead)
 *   safety      0..400, more the less it leaves the opponent
 */
/** `evaluate` for a finished shot, which may carry the cue ball's in-hand spot. */
function evaluateIn(frame: FrameState, shot: ShotInput, config: BotSkillProfile): Trial {
  return shot.cuePos ? evaluate(withCueAt(frame, shot.cuePos), shot, config) : evaluate(frame, shot, config)
}

function evaluate(frame: FrameState, shot: ShotInput, config: BotSkillProfile): Trial {
  trialsUsed++
  const copy = cloneFrame(frame)
  const shooter = copy.turnIndex
  const outcome = applyStroke(copy, shooter, shot, { maxTicks: TRIAL_TICKS })
  const res = outcome.resolution
  if (res.foul) {
    return { shot, score: -1000 - res.foulValue * 10, pots: false, foul: true }
  }
  if (outcome.frameEnded && outcome.frameWinner === shooter) {
    return { shot, score: 5000, pots: true, foul: false }
  }
  if (res.points > 0 && copy.turnIndex === shooter) {
    const leave = config.position ? bestLineQuality(copy) * 300 : 0
    return { shot, score: 1000 + res.points * 15 + leave, pots: true, foul: false }
  }
  // A legal stroke that hands the table over: judged by what the opponent is left.
  const left = bestLineQuality(copy)
  const snookered = isSnookered(copy) ? 120 : 0
  return { shot, score: 300 - left * 300 + snookered, pots: false, foul: false }
}

/** How good the best pot is for whoever is now at the table, 0 (none) to 1 (sitter). */
function bestLineQuality(frame: FrameState): number {
  if (frame.phase === 'FRAME_END') return 0
  const cue = frame.balls.find((b) => b.isCue && !b.potted)
  // A cue ball in hand leaves the next player a free choice of spot: treat it as a good chance.
  if (!cue || frame.cueInHand) return 0.8
  const lines = potLines(frame, cue.pos, legalTargets(frame, frame.ballOn), 0.35)
  if (lines.length === 0) return 0
  const top = lines[0]!.quality
  // Prefer the colour worth most when a colour is on and several are open.
  const value = frame.ballOn === 'ANY_COLOUR' ? (COLOR_VALUES[lines[0]!.targetId] ?? 2) / 7 : 1
  return clamp(top * (0.7 + 0.3 * value), 0, 1)
}

function isSnookered(frame: FrameState): boolean {
  const cue = frame.balls.find((b) => b.isCue && !b.potted)
  if (!cue || frame.cueInHand) return false
  for (const id of legalTargets(frame, frame.ballOn)) {
    const ball = frame.balls.find((b) => b.id === id && !b.potted)
    if (!ball) continue
    // Any part of the ball visible: centre or either edge.
    const toBall = sub(ball.pos, cue.pos)
    const d = len(toBall)
    if (d < CONTACT) return false
    const normal = { x: -toBall.y / d, y: toBall.x / d }
    for (const side of [0, 0.9, -0.9]) {
      const contact = { x: ball.pos.x + normal.x * side * BALL_RADIUS - (toBall.x / d) * BALL_RADIUS, y: ball.pos.y + normal.y * side * BALL_RADIUS - (toBall.y / d) * BALL_RADIUS }
      if (!pathBlocked(frame, cue.pos, contact, [id])) return false
    }
  }
  return true
}

// ---------------------------------------------------------------- helpers

function legalTargets(frame: FrameState, ballOn: BallOn): number[] {
  if (ballOn === 'RED') return frame.balls.filter((b) => b.isRed && !b.potted).map((b) => b.id)
  if (ballOn === 'ANY_COLOUR') return Array.from(frame.colorsRemaining)
  return [ballOn.colour]
}

/**
 * Whether a ball travelling from `from` to `to` would touch any other ball on the way.
 * Two balls touch when their centres are one ball's width apart, so that is the corridor.
 */
function pathBlocked(frame: FrameState, from: Vec, to: Vec, ignoreIds: number[]): boolean {
  const ab = sub(to, from)
  const lenSq = ab.x * ab.x + ab.y * ab.y
  if (lenSq === 0) return false
  for (const ball of frame.balls) {
    if (ball.potted || ball.isCue || ignoreIds.includes(ball.id)) continue
    const t = clamp(((ball.pos.x - from.x) * ab.x + (ball.pos.y - from.y) * ab.y) / lenSq, 0, 1)
    const dx = ball.pos.x - (from.x + ab.x * t)
    const dy = ball.pos.y - (from.y + ab.y * t)
    if (dx * dx + dy * dy < (CONTACT - 1) * (CONTACT - 1)) return true
  }
  return false
}

function withCueingError(shot: ShotInput, config: BotSkillProfile, rng: () => number): ShotInput {
  if (config.aimError === 0 && config.powerError === 0) return shot
  return {
    ...shot,
    aimAngle: shot.aimAngle + (rng() - 0.5) * 2 * config.aimError,
    power: clamp(shot.power * (1 + (rng() - 0.5) * 2 * config.powerError), 0.05, 1)
  }
}

function cloneFrame(frame: FrameState): FrameState {
  return {
    ...frame,
    balls: frame.balls.map((b) => ({ ...b, pos: { ...b.pos }, vel: { ...b.vel }, spin: { ...b.spin } })),
    scores: { ...frame.scores },
    pottedOrder: [...frame.pottedOrder],
    colorsRemaining: new Set(frame.colorsRemaining),
    foulChoice: frame.foulChoice ? { ...frame.foulChoice } : frame.foulChoice
  }
}

function shotSeed(frame: FrameState, level: PracticeAiLevel, seed: string): string {
  const cue = frame.balls.find((b) => b.isCue)!
  const ballOn = frame.ballOn === 'RED' ? 'R' : frame.ballOn === 'ANY_COLOUR' ? 'A' : `C${frame.ballOn.colour}`
  return [
    seed,
    level,
    frame.turnIndex,
    frame.remainingReds,
    ballOn,
    Array.from(frame.colorsRemaining).join('.'),
    frame.pottedOrder.join('.'),
    Math.round(cue.pos.x),
    Math.round(cue.pos.y)
  ].join(':')
}

function sub(a: Vec, b: Vec): Vec {
  return { x: a.x - b.x, y: a.y - b.y }
}

function len(v: Vec): number {
  return Math.hypot(v.x, v.y)
}

function unit(v: Vec): Vec | null {
  const l = len(v)
  return l < 1e-9 ? null : { x: v.x / l, y: v.y / l }
}
