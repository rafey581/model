import type { BallOn, BallState, FrameState, PracticeAiLevel, ShotInput, SimResult } from '@snooker/shared'
import {
  BALL_IDS,
  BALL_RADIUS,
  BAULK_LINE_X,
  D_RADIUS,
  MAX_CUE_SPEED,
  TABLE_LENGTH,
  TABLE_WIDTH,
  seededRandom,
  length,
  sub,
  scale,
  dot,
  clamp,
  vec,
  cloneBall,
  simulateStroke
} from '@snooker/shared'

export interface BotMove {
  shot: ShotInput
}

interface PotCandidate {
  targetId: number
  angle: number
  basePower: number
  score: number
}

interface SafetyCandidate {
  targetId: number
  angle: number
  power: number
}

interface BotSkillProfile {
  jitter: number
  powerJitter: number
  minPower: number
  potSelectivity: number
  randomTargetChance: number
  validate: boolean
  safetyJitter: number
  pool: number
}

const LEVEL_CONFIG: Record<PracticeAiLevel, BotSkillProfile> = {
  EASY: { jitter: 0.09, powerJitter: 0.18, minPower: 0.2, potSelectivity: 0.8, randomTargetChance: 0.35, validate: false, safetyJitter: 0.14, pool: 1 },
  MEDIUM: { jitter: 0.025, powerJitter: 0.07, minPower: 0.25, potSelectivity: 1, randomTargetChance: 0, validate: true, safetyJitter: 0.08, pool: 3 },
  HARD: { jitter: 0.008, powerJitter: 0.03, minPower: 0.3, potSelectivity: 1, randomTargetChance: 0, validate: true, safetyJitter: 0.03, pool: 3 }
}

const MIN_CUT = 0.5
const SCREEN_MARGIN = 12
const POT_OFFSETS = [0, 0.03, -0.03, 0.06, -0.06] as const
const VALIDATION_TICKS = 500
const ESCAPE_OFFSETS = [0, 0.3, -0.3, 0.5, -0.5] as const
const BREAK_OFFSETS = [0, 0.08, -0.08] as const
const BREAK_POWER = 0.5
const D_PLACEMENTS: ReadonlyArray<{ x: number; y: number }> = [
  { x: BAULK_LINE_X - D_RADIUS * 0.75, y: TABLE_WIDTH / 2 - D_RADIUS * 0.55 },
  { x: BAULK_LINE_X - D_RADIUS * 0.75, y: TABLE_WIDTH / 2 + D_RADIUS * 0.55 },
  { x: BAULK_LINE_X - D_RADIUS * 0.5, y: TABLE_WIDTH / 2 },
  { x: BAULK_LINE_X - D_RADIUS * 0.2, y: TABLE_WIDTH / 2 }
]

function computeInHandMove(frame: FrameState, config: BotSkillProfile, rng: () => number): BotMove {
  const legalIds = legalTargets(frame, frame.ballOn)
  if (!config.validate) {
    const cuePos = D_PLACEMENTS[0]!
    return { shot: { ...formShot({ targetId: 0, angle: packAngle(frame, cuePos), basePower: BREAK_POWER, score: 0 }, config, rng), cuePos } }
  }
  let best: { move: BotMove; score: number } | null = null
  for (const cuePos of D_PLACEMENTS) {
    const balls = frame.balls.map(cloneBall)
    const cue = balls.find((b) => b.isCue)!
    cue.pos.x = cuePos.x
    cue.pos.y = cuePos.y
    cue.vel = vec(0, 0)
    cue.spin = vec(0, 0)
    const frameLike = { ...frame, balls } as FrameState
    const targets: Array<{ angle: number; power: number; targetId: number | null }> = []
    const candidates = buildPotCandidates(frameLike, cuePos, legalIds)
    for (const candidate of candidates.slice(0, config.pool)) {
      for (const offset of BREAK_OFFSETS) {
        targets.push({ angle: candidate.angle + offset, power: candidate.basePower, targetId: candidate.targetId })
      }
    }
    for (const offset of BREAK_OFFSETS) {
      if (frame.ballOn !== 'RED') break
      targets.push({ angle: packAngle(frame, cuePos) + offset, power: BREAK_POWER, targetId: null })
    }
    for (const target of targets) {
      const shot = withJitter({ aimAngle: target.angle, power: target.power, spin: vec(0, 0), timestamp: 0 }, config, rng)
      const sim = simulateStroke(balls, shot, { maxTicks: VALIDATION_TICKS })
      const score = scoreBreakShot(sim, target.targetId, legalIds)
      if (score > (best?.score ?? -Infinity)) {
        best = { move: { shot: { ...shot, cuePos } }, score }
      }
    }
  }
  if (best && best.score >= 0) return best.move
  const cuePos = D_PLACEMENTS[1]!
  return { shot: { ...nearestLegalAim(frame, legalIds, cuePos), cuePos } }
}

function nearestLegalAim(frame: FrameState, legalIds: number[], from: { x: number; y: number }): ShotInput {
  let nearest: number | null = null
  let nearestDist = Infinity
  for (const legalId of legalIds) {
    const target = frame.balls.find((b) => b.id === legalId && !b.potted)
    if (!target) continue
    const dist = length(sub(target.pos, from))
    if (dist < nearestDist) {
      nearestDist = dist
      nearest = legalId
    }
  }
  const target = nearest !== null ? frame.balls.find((b) => b.id === nearest)! : (frame.balls.find((b) => !b.potted && !b.isCue) ?? frame.balls[0]!)
  const angle = Math.atan2(target.pos.y - from.y, target.pos.x - from.x)
  const power = Math.max(0.18, Math.min(0.4, nearestDist / 3000))
  return { aimAngle: angle, power, spin: vec(0, 0), timestamp: 0 }
}

function scoreBreakShot(sim: SimResult, targetId: number | null, legalIds: number[]): number {
  if (sim.cuePotted) return -50
  if (!isLegalContact(sim, legalIds)) return -50
  let score = 100
  if (targetId !== null && sim.pottedIds.includes(targetId)) score += 800
  score += sim.pottedIds.length * 150
  const hitIds = new Set<number>()
  for (const ev of sim.events) {
    if (ev.type !== 'BALL_HIT') continue
    if (ev.ballId !== undefined && ev.ballId !== BALL_IDS.CUE) hitIds.add(ev.ballId)
    if (ev.otherBallId !== undefined && ev.otherBallId !== BALL_IDS.CUE) hitIds.add(ev.otherBallId)
  }
  score += hitIds.size * 40
  return score
}

function packAngle(frame: FrameState, cuePos: { x: number; y: number }): number {
  let ax = 0
  let ay = 0
  let n = 0
  for (const ball of frame.balls) {
    if (ball.potted || ball.isCue) continue
    ax += ball.pos.x
    ay += ball.pos.y
    n++
  }
  const cx = n > 0 ? ax / n : TABLE_LENGTH * 0.75
  const cy = n > 0 ? ay / n : TABLE_WIDTH / 2
  return Math.atan2(cy - cuePos.y, cx - cuePos.x)
}

export function computeBotShot(frame: FrameState, level: PracticeAiLevel, seed: string): BotMove {
  const cueBall = frame.balls.find((b) => b.isCue && !b.potted)
  if (!cueBall) {
    return { shot: { aimAngle: 0, power: 0.1, spin: vec(0, 0), timestamp: 0 } }
  }
  const config = LEVEL_CONFIG[level]
  const rng = seededRandom(shotSeed(frame, level, seed))
  if (frame.cueInHand) {
    return computeInHandMove(frame, config, rng)
  }
  const legalIds = maybeRandomTarget(legalTargets(frame, frame.ballOn), config, rng)
  const candidates = buildPotCandidates(frame, cueBall.pos, legalIds)
  const attemptsPot = candidates.length > 0 && rng() < config.potSelectivity
  if (attemptsPot) {
    const potMove = computePotMove(frame, candidates, config, rng)
    if (potMove) return potMove
  }
  return buildSafety(frame, cueBall, config, rng)
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

function maybeRandomTarget(legalIds: number[], config: BotSkillProfile, rng: () => number): number[] {
  if (legalIds.length <= 1 || config.randomTargetChance <= 0) return legalIds
  if (rng() >= config.randomTargetChance) return legalIds
  const index = Math.floor(rng() * legalIds.length)
  return [legalIds[index]!]
}

export function buildPotCandidates(frame: FrameState, cuePosition: { x: number; y: number }, legalIds: number[]): PotCandidate[] {
  const pockets = pocketTargets()
  const candidates: PotCandidate[] = []
  for (const legalId of legalIds) {
    const target = frame.balls.find((b) => b.id === legalId && !b.potted)
    if (!target) continue
    for (const pocket of pockets) {
      const toPocket = sub(pocket, target.pos)
      const pocketDist = length(toPocket)
      if (pocketDist < BALL_RADIUS) continue
      const pocketDir = scale(toPocket, 1 / pocketDist)
      const aimPoint = { x: target.pos.x - pocketDir.x * 2 * BALL_RADIUS, y: target.pos.y - pocketDir.y * 2 * BALL_RADIUS }
      const toAim = sub(aimPoint, cuePosition)
      const aimDist = length(toAim)
      if (aimDist < BALL_RADIUS) continue
      const aimDir = scale(toAim, 1 / aimDist)
      const cut = dot(aimDir, pocketDir)
      if (cut < MIN_CUT) continue
      candidates.push({
        targetId: legalId,
        angle: Math.atan2(toAim.y, toAim.x),
        basePower: cutPowerFor(pocketDist, cut),
        score: cut * (1 - pocketDist / (TABLE_LENGTH * 1.7)) + (pocketDist < 1100 ? 0.06 : 0)
      })
    }
  }
  candidates.sort((a, b) => b.score - a.score)
  return candidates
}

function cutPowerFor(pocketDist: number, cut: number): number {
  const needed = clamp(1400 + pocketDist * 0.9, 1500, 3200)
  const cueSpeed = needed / Math.max(cut, 0.35)
  return clamp(cueSpeed / MAX_CUE_SPEED, 0.2, 0.95)
}

function computePotMove(frame: FrameState, candidates: PotCandidate[], config: BotSkillProfile, rng: () => number): BotMove | null {
  if (!config.validate) {
    const candidate = candidates[0]!
    return { shot: formShot(candidate, config, rng) }
  }
  const pool = candidates.slice(0, config.pool)
  let bestLegal: BotMove | null = null
  for (const candidate of pool) {
    // The power a shot needs is not a fixed multiple of the distance to the pocket:
    // it depends on how much of the cue ball's pace the cut actually passes on, and
    // on how the cloth slows the ball over the two legs of the shot. A closed form
    // for that has to be re-derived whenever the cloth model changes, and when it is
    // even slightly out the ball arrives with too much pace and runs through the
    // pocket. Searching a ladder of powers and letting the simulation decide keeps
    // the bot honest about the physics it is actually playing on, and it also gives
    // the weaker levels a coarser, sloppier ladder so they miss more.
    for (const scale of powerLadder(config)) {
      for (const offset of POT_OFFSETS) {
        const base = withJitter(
          { aimAngle: candidate.angle + offset, power: clamp(candidate.basePower * scale, 0.15, 1), spin: vec(0, 0), timestamp: 0 },
          config,
          rng
        )
        const sim = simulateStroke(frame.balls, base, { maxTicks: VALIDATION_TICKS })
        const targetPotted = sim.pottedIds.includes(candidate.targetId)
        const foul = sim.cuePotted || sim.firstContactId !== candidate.targetId
        if (targetPotted && !foul) {
          return { shot: base }
        }
        if (!foul && sim.firstContactId !== null && !bestLegal) {
          bestLegal = { shot: base }
        }
      }
    }
  }
  return bestLegal
}

/**
 * Powers to try around the candidate's estimate, nearest first. The stronger the
 * level, the closer it sticks to the estimate, so a stronger bot is not simply a
 * stronger bot with a wider search.
 */
function powerLadder(config: BotSkillProfile): number[] {
  if (config.validate) return [1, 0.88, 1.12, 0.78, 1.24]
  return [1, 0.85, 1.15]
}

function formShot(candidate: PotCandidate, config: BotSkillProfile, rng: () => number): ShotInput {
  return withJitter(
    { aimAngle: candidate.angle, power: candidate.basePower, spin: vec(0, 0), timestamp: 0 },
    config,
    rng
  )
}

function withJitter(shot: ShotInput, config: BotSkillProfile, rng: () => number): ShotInput {
  return {
    aimAngle: shot.aimAngle + (rng() - 0.5) * 2 * config.jitter,
    power: clamp(shot.power + (rng() - 0.5) * 2 * config.powerJitter, 0.15, 1),
    spin: shot.spin,
    timestamp: 0
  }
}

function buildSafety(frame: FrameState, cueBall: BallState, config: BotSkillProfile, rng: () => number): BotMove {
  const legalIds = legalTargets(frame, frame.ballOn)
  const candidates = safetyCandidates(frame, cueBall)
  if (!config.validate) {
    return candidates.length ? { shot: formSafety(candidates[0]!, config, rng) } : { shot: escapeShot(frame, cueBall, 0, legalIds) }
  }
  let fallback = candidates.length ? formSafety(candidates[0]!, config, rng) : escapeShot(frame, cueBall, 0, legalIds)
  for (const candidate of candidates.slice(0, 3)) {
    const shot = formSafety(candidate, config, rng)
    fallback = shot
    const sim = simulateStroke(frame.balls, shot, { maxTicks: VALIDATION_TICKS })
    if (isLegalContact(sim, legalIds) && !sim.cuePotted) return { shot }
  }
  for (const offset of ESCAPE_OFFSETS) {
    const shot = escapeShot(frame, cueBall, offset, legalIds)
    fallback = shot
    const sim = simulateStroke(frame.balls, shot, { maxTicks: VALIDATION_TICKS })
    if (isLegalContact(sim, legalIds) && !sim.cuePotted) return { shot }
  }
  const lastResort = lastResortLegal(frame, cueBall)
  const sim = simulateStroke(frame.balls, lastResort, { maxTicks: VALIDATION_TICKS })
  return isLegalContact(sim, legalIds) && !sim.cuePotted ? { shot: lastResort } : { shot: fallback }
}

function lastResortLegal(frame: FrameState, cueBall: BallState): ShotInput {
  return nearestLegalAim(frame, legalTargets(frame, frame.ballOn), cueBall.pos)
}

function safetyCandidates(frame: FrameState, cueBall: BallState): SafetyCandidate[] {
  const candidates: SafetyCandidate[] = []
  const legalIds = legalTargets(frame, frame.ballOn)
  for (const legalId of legalIds) {
    const target = frame.balls.find((b) => b.id === legalId && !b.potted)
    if (!target) continue
    const toTarget = sub(target.pos, cueBall.pos)
    const distance = length(toTarget)
    if (distance < BALL_RADIUS) continue
    const aimPoint = { x: target.pos.x - toTarget.x / distance * BALL_RADIUS, y: target.pos.y - toTarget.y / distance * BALL_RADIUS }
    if (isBlocked(frame, cueBall.pos, aimPoint)) continue
    candidates.push({
      targetId: legalId,
      angle: Math.atan2(toTarget.y, toTarget.x),
      power: clamp(distance / 1400, 0.25, 0.55)
    })
  }
  candidates.sort((a, b) => a.power - b.power)
  return candidates
}

function formSafety(candidate: SafetyCandidate, config: BotSkillProfile, rng: () => number): ShotInput {
  return {
    aimAngle: candidate.angle + (rng() - 0.5) * 2 * config.safetyJitter,
    power: clamp(candidate.power + (rng() - 0.5) * 0.1, 0.15, 0.7),
    spin: vec(0, 0),
    timestamp: 0
  }
}

function escapeShot(frame: FrameState, cueBall: BallState, offset: number, legalIds: number[]): ShotInput {
  const legal = frame.balls.find((b) => legalIds.includes(b.id) && !b.potted)
  const target = legal ?? frame.balls.find((b) => b.isRed && !b.potted) ?? frame.balls.find((b) => b.isColor && !b.potted)
  const aim = target ?? { pos: { x: TABLE_LENGTH * 0.7, y: TABLE_WIDTH / 2 } }
  const angle = Math.atan2(aim.pos.y - cueBall.pos.y, aim.pos.x - cueBall.pos.x) + offset
  return { aimAngle: angle, power: 0.45, spin: vec(0, 0), timestamp: 0 }
}

function isLegalContact(sim: { firstContactId: number | null }, legalIds: number[]): boolean {
  return sim.firstContactId !== null && legalIds.includes(sim.firstContactId)
}

function legalTargets(frame: FrameState, ballOn: BallOn): number[] {
  if (ballOn === 'RED') {
    return frame.balls.filter((b) => b.isRed && !b.potted).map((b) => b.id)
  }
  if (ballOn === 'ANY_COLOUR') {
    return Array.from(frame.colorsRemaining)
  }
  return [ballOn.colour]
}

function isBlocked(
  frame: FrameState,
  from: { x: number; y: number },
  to: { x: number; y: number }
): boolean {
  const ab = { x: to.x - from.x, y: to.y - from.y }
  const lenSq = ab.x * ab.x + ab.y * ab.y
  if (lenSq === 0) return false
  for (const ball of frame.balls) {
    if (ball.potted || ball.isCue) continue
    const ap = { x: ball.pos.x - from.x, y: ball.pos.y - from.y }
    let t = (ap.x * ab.x + ap.y * ab.y) / lenSq
    t = clamp(t, 0, 1)
    const px = from.x + ab.x * t
    const py = from.y + ab.y * t
    const dx = ball.pos.x - px
    const dy = ball.pos.y - py
    if (dx * dx + dy * dy < SCREEN_MARGIN * SCREEN_MARGIN) return true
  }
  return false
}

function pocketTargets(): Array<{ x: number; y: number }> {
  return [
    { x: 0, y: 0 },
    { x: TABLE_LENGTH / 2, y: 0 },
    { x: TABLE_LENGTH, y: 0 },
    { x: 0, y: TABLE_WIDTH },
    { x: TABLE_LENGTH / 2, y: TABLE_WIDTH },
    { x: TABLE_LENGTH, y: TABLE_WIDTH }
  ]
}