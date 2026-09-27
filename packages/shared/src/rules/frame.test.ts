import { describe, expect, it } from 'vitest'
import { BALL_IDS, COLOR_ORDER, COLOR_VALUES, TOTAL_REDS, BALL_RADIUS } from '../constants.js'
import { colourSpotPosition, cueStartPosition } from '../physics/layout.js'
import { vec } from '../vec.js'
import type { FrameState } from '../state.js'
import { applyFrameWinner, applyStroke, createFrame, createMatch, frameSnapshot, framesToWin, matchWinnerIndex, maybeEndFrame } from './frame.js'
import { applyResolution, isRedId, resolveStroke, respotBall, applyTimeoutFoul } from './snooker.js'

function stroke(frame: FrameState, shooterIndex: number, pottedIds: number[], cuePotted: boolean, firstContactId: number | null): { frameEnded: boolean; frameWinner: number | null } {
  const resolution = resolveStroke(frame, shooterIndex, pottedIds, cuePotted, firstContactId)
  const pottedReds = pottedIds.filter(isRedId).length
  frame.remainingReds -= resolution.foul ? 0 : pottedReds
  for (const id of pottedIds) {
    if (!frame.pottedOrder.includes(id)) frame.pottedOrder.push(id)
    const ball = frame.balls.find((b) => b.id === id)
    if (ball) ball.potted = true
  }
  applyResolution(frame, resolution, frame.remainingReds)
  if (cuePotted) respotBall(frame, BALL_IDS.CUE)
  return maybeEndFrame(frame)
}

function ball(frame: FrameState, id: number) {
  return frame.balls.find((b) => b.id === id)!
}

function totalColourPoints(): number {
  let total = 0
  for (const colorId of COLOR_ORDER) total += COLOR_VALUES[colorId] ?? 0
  return total
}

describe('initial frame', () => {
  it('lays out a legal snooker set', () => {
    const f = createFrame(0)
    expect(f.remainingReds).toBe(TOTAL_REDS)
    expect(f.ballOn).toBe('RED')
    expect(f.turnIndex).toBe(0)
    expect(f.colorsRemaining.size).toBe(COLOR_ORDER.length)
    const start = cueStartPosition()
    expect(ball(f, BALL_IDS.CUE).pos.x).toBeCloseTo(start.x)
    expect(ball(f, BALL_IDS.CUE).pos.y).toBeCloseTo(start.y)
    for (const colorId of COLOR_ORDER) {
      const spot = colourSpotPosition(colorId)
      expect(ball(f, colorId).pos.x).toBeCloseTo(spot.x)
      expect(ball(f, colorId).pos.y).toBeCloseTo(spot.y)
    }
  })
})

describe('legal pots', () => {
  it('scores a red and switches to ANY_COLOUR without losing the visit', () => {
    const f = createFrame(0)
    stroke(f, 0, [BALL_IDS.RED_MIN], false, BALL_IDS.RED_MIN)
    expect(f.scores.player0).toBe(1)
    expect(f.ballOn).toBe('ANY_COLOUR')
    expect(f.turnIndex).toBe(0)
    expect(f.remainingReds).toBe(TOTAL_REDS - 1)
  })

  it('scores multiple reds in one stroke', () => {
    const f = createFrame(0)
    stroke(f, 0, [BALL_IDS.RED_MIN, BALL_IDS.RED_MIN + 1], false, BALL_IDS.RED_MIN)
    expect(f.scores.player0).toBe(2)
    expect(f.remainingReds).toBe(TOTAL_REDS - 2)
    expect(ball(f, BALL_IDS.RED_MIN).potted).toBe(true)
  })

  it('re-spots a colour potted legally while reds remain (F11)', () => {
    const f = createFrame(0)
    stroke(f, 0, [BALL_IDS.RED_MIN], false, BALL_IDS.RED_MIN)
    stroke(f, 0, [BALL_IDS.YELLOW], false, BALL_IDS.YELLOW)
    expect(f.scores.player0).toBe(3)
    expect(f.ballOn).toBe('RED')
    expect(f.remainingReds).toBe(TOTAL_REDS - 1)
    expect(f.colorsRemaining.has(BALL_IDS.YELLOW)).toBe(true)
    const yellow = ball(f, BALL_IDS.YELLOW)
    expect(yellow.potted).toBe(false)
    const spot = colourSpotPosition(BALL_IDS.YELLOW)
    expect(yellow.pos.x).toBeCloseTo(spot.x)
    expect(yellow.pos.y).toBeCloseTo(spot.y)
  })

  it('keeps visit and break after a red then a colour', () => {
    const f = createFrame(0)
    stroke(f, 0, [BALL_IDS.RED_MIN], false, BALL_IDS.RED_MIN)
    stroke(f, 0, [BALL_IDS.YELLOW], false, BALL_IDS.YELLOW)
    stroke(f, 0, [BALL_IDS.RED_MIN + 1], false, BALL_IDS.RED_MIN + 1)
    expect(f.scores.player0).toBe(4)
    expect(f.turnIndex).toBe(0)
    expect(f.remainingReds).toBe(TOTAL_REDS - 2)
  })
})

describe('fouls', () => {
  it('re-spots reds potted in a foul stroke and keeps them (F1/F2)', () => {
    const f = createFrame(0)
    stroke(f, 0, [BALL_IDS.RED_MIN, BALL_IDS.BLACK], false, BALL_IDS.RED_MIN)
    expect(f.scores.player1).toBe(7)
    expect(f.remainingReds).toBe(TOTAL_REDS)
    expect(ball(f, BALL_IDS.RED_MIN).potted).toBe(false)
    expect(ball(f, BALL_IDS.BLACK).potted).toBe(false)
    const blackSpot = colourSpotPosition(BALL_IDS.BLACK)
    expect(ball(f, BALL_IDS.BLACK).pos.x).toBeCloseTo(blackSpot.x)
    expect(f.ballOn).toBe('RED')
    expect(f.turnIndex).toBe(1)
  })

  it('treats potting a colour while red is on as a foul (F3)', () => {
    const f = createFrame(0)
    stroke(f, 0, [BALL_IDS.BLACK], false, BALL_IDS.BLACK)
    expect(f.scores.player1).toBe(7)
    expect(f.remainingReds).toBe(TOTAL_REDS)
    expect(ball(f, BALL_IDS.BLACK).potted).toBe(false)
    expect(f.ballOn).toBe('RED')
  })

  it('treats hitting the wrong colour on ANY_COLOUR as a foul', () => {
    const f = createFrame(0)
    stroke(f, 0, [BALL_IDS.RED_MIN], false, BALL_IDS.RED_MIN)
    stroke(f, 0, [BALL_IDS.BLACK], false, BALL_IDS.YELLOW)
    expect(f.scores.player1).toBe(7)
    expect(f.remainingReds).toBe(TOTAL_REDS - 1)
    expect(ball(f, BALL_IDS.BLACK).potted).toBe(false)
    expect(f.colorsRemaining.has(BALL_IDS.BLACK)).toBe(true)
    expect(f.ballOn).toBe('RED')
    expect(f.turnIndex).toBe(1)
  })

  it('treats potting the required colour plus another colour as a foul (F4)', () => {
    const f = createFrame(0)
    stroke(f, 0, [BALL_IDS.RED_MIN], false, BALL_IDS.RED_MIN)
    stroke(f, 0, [BALL_IDS.YELLOW, BALL_IDS.BLACK], false, BALL_IDS.YELLOW)
    expect(f.scores.player1).toBe(7)
    expect(f.ballOn).toBe('RED')
    expect(f.colorsRemaining.has(BALL_IDS.YELLOW)).toBe(true)
    expect(ball(f, BALL_IDS.YELLOW).potted).toBe(false)
    expect(ball(f, BALL_IDS.BLACK).potted).toBe(false)
  })

  it('re-spots the cue to the D after a potted-cue foul (F6)', () => {
    const f = createFrame(0)
    stroke(f, 0, [], true, BALL_IDS.RED_MIN)
    expect(f.scores.player1).toBeGreaterThanOrEqual(4)
    expect(ball(f, BALL_IDS.CUE).potted).toBe(false)
    const start = cueStartPosition()
    expect(ball(f, BALL_IDS.CUE).pos.x).toBeCloseTo(start.x)
    expect(ball(f, BALL_IDS.CUE).pos.y).toBeCloseTo(start.y)
    expect(f.ballOn).toBe('RED')
  })

  it('re-spots every ball potted in a foul including reds', () => {
    const f = createFrame(0)
    stroke(f, 0, [BALL_IDS.RED_MIN, BALL_IDS.YELLOW], true, BALL_IDS.RED_MIN)
    expect(f.remainingReds).toBe(TOTAL_REDS)
    expect(ball(f, BALL_IDS.RED_MIN).potted).toBe(false)
    expect(ball(f, BALL_IDS.YELLOW).potted).toBe(false)
    expect(f.colorsRemaining.has(BALL_IDS.YELLOW)).toBe(true)
  })
})

describe('timeout foul (no stroke)', () => {
  it('a time-out on red costs 4 and switches the visit', () => {
    const f = createFrame(0)
    const out = applyTimeoutFoul(f, 0, 'turn timeout')
    expect(out.foulValue).toBe(4)
    expect(out.reason).toBe('turn timeout')
    expect(f.scores.player1).toBe(4)
    expect(f.scores.player0).toBe(0)
    expect(f.turnIndex).toBe(1)
    expect(f.ballOn).toBe('RED')
    expect(f.breakScore).toBe(0)
    expect(f.remainingReds).toBe(TOTAL_REDS)
  })

  it('a time-out on the black during colouring up costs 7 and switches the visit', () => {
    const f = createFrame(0)
    f.remainingReds = 0
    f.ballOn = { colour: BALL_IDS.BLACK }
    f.colorsRemaining = new Set([BALL_IDS.BLACK])
    f.phase = 'COLOURING_UP'
    const out = applyTimeoutFoul(f, 1, 'turn timeout')
    expect(out.foulValue).toBe(7)
    expect(f.scores.player0).toBe(7)
    expect(f.turnIndex).toBe(0)
    expect(f.ballOn).toEqual({ colour: BALL_IDS.BLACK })
  })

  it('idempotently repots nothing and leaves the table untouched', () => {
    const f = createFrame(0)
    const ballsBefore = f.balls.map((b) => ({ id: b.id, x: b.pos.x, y: b.pos.y, potted: b.potted }))
    applyTimeoutFoul(f, 0, 'turn timeout')
    for (const before of ballsBefore) {
      const after = ball(f, before.id)
      expect(after.pos.x).toBe(before.x)
      expect(after.pos.y).toBe(before.y)
      expect(after.potted).toBe(before.potted)
    }
  })
})

describe('colouring up', () => {
  it('runs the full colour sequence and ends the frame', () => {
    const f = createFrame(0)
    f.remainingReds = 0
    f.ballOn = 'ANY_COLOUR'
    let points = 0
    for (let i = 0; i < COLOR_ORDER.length; i++) {
      const colorId = COLOR_ORDER[i]!
      const end = stroke(f, 0, [colorId], false, colorId)
      points += COLOR_VALUES[colorId] ?? 0
      expect(f.scores.player0).toBe(points)
      expect(f.colorsRemaining.has(colorId)).toBe(false)
      if (i < COLOR_ORDER.length - 1) {
        expect(end.frameEnded).toBe(false)
        expect(f.ballOn).toEqual({ colour: COLOR_ORDER[i + 1] })
      } else {
        expect(end.frameEnded).toBe(true)
        expect(end.frameWinner).toBe(0)
        expect(f.phase).toBe('FRAME_END')
        expect(f.scores.player0).toBe(totalColourPoints())
      }
    }
  })

  it('re-spots a colour potted on a foul during colouring up', () => {
    const f = createFrame(0)
    f.remainingReds = 0
    f.ballOn = 'ANY_COLOUR'
    stroke(f, 0, [BALL_IDS.YELLOW], false, BALL_IDS.YELLOW)
    stroke(f, 0, [BALL_IDS.GREEN, BALL_IDS.CUE], true, BALL_IDS.GREEN)
    expect(f.colorsRemaining.has(BALL_IDS.GREEN)).toBe(true)
    expect(ball(f, BALL_IDS.GREEN).potted).toBe(false)
    const greenSpot = colourSpotPosition(BALL_IDS.GREEN)
    expect(ball(f, BALL_IDS.GREEN).pos.x).toBeCloseTo(greenSpot.x)
    expect(f.scores.player1).toBeGreaterThanOrEqual(4)
  })
})

describe('tie on the black', () => {
  it('re-spots the black and keeps the frame alive (F5)', () => {
    const f = createFrame(0)
    f.remainingReds = 0
    f.colorsRemaining = new Set()
    f.ballOn = { colour: BALL_IDS.BLACK }
    f.scores = { player0: totalColourPoints(), player1: totalColourPoints() }
    ball(f, BALL_IDS.BLACK).potted = true

    const first = maybeEndFrame(f)
    expect(first.frameEnded).toBe(false)
    expect(f.colorsRemaining.has(BALL_IDS.BLACK)).toBe(true)
    expect(ball(f, BALL_IDS.BLACK).potted).toBe(false)
    const blackSpot = colourSpotPosition(BALL_IDS.BLACK)
    expect(ball(f, BALL_IDS.BLACK).pos.x).toBeCloseTo(blackSpot.x)
    expect(ball(f, BALL_IDS.BLACK).pos.y).toBeCloseTo(blackSpot.y)
    expect(f.ballOn).toEqual({ colour: BALL_IDS.BLACK })
    expect(f.phase).toBe('PLAYING')

    const end = stroke(f, 0, [BALL_IDS.BLACK], false, BALL_IDS.BLACK)
    expect(f.scores.player0).toBe(totalColourPoints() + 7)
    expect(end.frameEnded).toBe(true)
    expect(end.frameWinner).toBe(0)
  })
})

describe('respot collides', () => {
  it('moves a respotted ball to a free position when its spot is occupied', () => {
    const f = createFrame(0)
    const yellow = ball(f, BALL_IDS.YELLOW)
    const spot = colourSpotPosition(BALL_IDS.YELLOW)
    yellow.potted = true
    ball(f, BALL_IDS.GREEN).pos.x = spot.x
    ball(f, BALL_IDS.GREEN).pos.y = spot.y + 1
    respotBall(f, BALL_IDS.YELLOW)
    expect(yellow.potted).toBe(false)
    expect(Math.abs(yellow.pos.x) + Math.abs(yellow.pos.y)).toBeGreaterThan(0)
  })
})

describe('match progression', () => {
  it('tracks frames won to the target', () => {
    const m = createMatch('m1', 'CUSTOM', 'BO3')
    expect(framesToWin('BO3')).toBe(2)
    expect(matchWinnerIndex(m)).toBe(-1)
    applyFrameWinner(m, 0)
    expect(matchWinnerIndex(m)).toBe(-1)
    applyFrameWinner(m, 0)
    expect(matchWinnerIndex(m)).toBe(0)
  })
})

describe('shot playback', () => {
  /**
   * The invariant the client depends on: a replay must finish on the table the
   * rules actually settled on. The rules move balls after the simulation ends
   * (respotting a colour potted out of turn, an in-off cue ball, a re-racked
   * black), and any move the last keyframe does not show becomes a visible snap
   * across the table on the final frame.
   */
  function expectReplayEndsOnFrameState(frame: FrameState, sim: { keyframes?: Array<{ t: number; balls: Array<[number, number, number]> }> }, label: string): void {
    const keyframes = sim.keyframes!
    const last = keyframes[keyframes.length - 1]!
    for (const ball of frameSnapshot(frame).balls) {
      if (ball.potted) continue
      const sample = last.balls.find(([id]) => id === ball.id)
      expect(sample, `${label}: ball ${ball.id} missing from the final keyframe`).toBeDefined()
      // Positions are rounded to whole millimetres, so allow a rounding diagonal.
      expect(Math.hypot(sample![1] - ball.x, sample![2] - ball.y), `${label}: ball ${ball.id} off`).toBeLessThan(1.5)
    }
  }

  it('ends a replay on the settled state across a sweep of real shots', () => {
    for (let i = 0; i < 60; i++) {
      const frame = createFrame(0)
      const outcome = applyStroke(
        frame,
        0,
        {
          aimAngle: (i / 60) * Math.PI * 2,
          power: 0.25 + (i % 6) * 0.13,
          spin: { x: (i % 3) - 1, y: (i % 5) - 2 }
        },
        { playback: { rate: 30 } }
      )
      expectReplayEndsOnFrameState(frame, outcome.sim, `sweep ${i}`)
    }
  })

  it('shows the cue ball going in hand rather than leaving it in the pocket', () => {
    // The in-off case: the sim drops the cue ball, the rules then put it back.
    const frame = createFrame(0)
    frame.balls = frame.balls.filter((b) => b.isCue)
    frame.balls[0]!.pos = vec(400, 400)
    frame.balls[0]!.vel = vec(0, 0)
    frame.cueInHand = false
    frame.ballOn = 'RED'

    const outcome = applyStroke(
      frame,
      0,
      { aimAngle: Math.atan2(-400, -400), power: 0.15, spin: { x: 0, y: 0 } },
      { playback: { rate: 30 } }
    )
    expect(outcome.sim.cuePotted).toBe(true)
    expect(frame.cueInHand).toBe(true)

    const cue = frameSnapshot(frame).balls.find((b) => b.id === BALL_IDS.CUE)!
    expect(cue.potted, 'the cue ball must be back in play').toBe(false)
    expectReplayEndsOnFrameState(frame, outcome.sim, 'in-off')

    const last = outcome.sim.keyframes![outcome.sim.keyframes!.length - 1]!
    const sample = last.balls.find(([id]) => id === BALL_IDS.CUE)!
    // The pocket is nowhere near where the cue ball is put back in hand.
    expect(Math.hypot(sample[1], sample[2])).toBeGreaterThan(BALL_RADIUS * 4)
  })

  it('does not sample a frame when playback was not requested', () => {
    const frame = createFrame(0)
    const outcome = applyStroke(frame, 0, { aimAngle: 0.2, power: 0.5, spin: { x: 0, y: 0 } })
    expect(outcome.sim.keyframes).toBeUndefined()
  })
})

describe('applyStroke integration', () => {
  it('treats a stroke with no contact as a foul (deterministic power-0 shot)', () => {
    const f = createFrame(0)
    const outcome = applyStroke(f, 0, { aimAngle: 0, power: 0, spin: { x: 0, y: 0 } })
    expect(outcome.resolution.foul).toBe(true)
    expect(f.scores.player1).toBe(4)
    expect(f.turnIndex).toBe(1)
    expect(f.remainingReds).toBe(TOTAL_REDS)
    expect(ball(f, BALL_IDS.CUE).potted).toBe(false)
    expect(outcome.frameEnded).toBe(false)
  })
})