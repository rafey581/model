import { describe, expect, it } from 'vitest'
import { BAULK_LINE_X, BALL_IDS, COLOR_ORDER, COLOR_VALUES, TABLE_LENGTH, TABLE_WIDTH, TOTAL_REDS, BALL_RADIUS } from '../constants.js'
import { colourSpotPosition, cueStartPosition } from '../physics/layout.js'
import { vec, type Vec2 } from '../vec.js'
import type { FrameState } from '../state.js'
import { buildInitialBalls } from '../state.js'
import { applyFrameWinner, applyStroke, createFrame, createMatch, frameFromSnapshot, frameSnapshot, framesToWin, matchWinnerIndex, maybeEndFrame } from './frame.js'
import { applyResolution, isRedId, resolveStroke, respotBall, applyTimeoutFoul } from './snooker.js'

function stroke(frame: FrameState, shooterIndex: number, pottedIds: number[], cuePotted: boolean, firstContactId: number | null): { frameEnded: boolean; frameWinner: number | null; reason?: string } {
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
  const ended = maybeEndFrame(frame)
  return { ...ended, reason: resolution.reason }
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

  it('names a wrong first contact "wrong ball first", not "no legal contact"', () => {
    // The reported case: a red was on and the cue ball reached the brown. Contact
    // certainly happened, so calling it a miss describes a stroke that did something
    // as a stroke that did nothing. The penalty is the brown's 4 either way.
    const f = createFrame(0)
    expect(f.ballOn).toBe('RED')
    const out = stroke(f, 0, [], false, BALL_IDS.BROWN)
    expect(out.reason).toBe('wrong ball first')
    expect(f.scores.player1).toBe(4)
    expect(f.turnIndex).toBe(1)
  })

  it('names a stroke that touched nothing "no legal contact"', () => {
    // Nothing was hit at all, which is the only case that label describes.
    const f = createFrame(0)
    const out = stroke(f, 0, [], false, null)
    expect(out.reason).toBe('no legal contact')
    expect(f.scores.player1).toBe(4)
    expect(f.turnIndex).toBe(1)
  })

  it('keeps calling a wrong contact after a red a wrong first contact', () => {
    // With a colour on after a red, a red is the wrong ball to reach first. The
    // contact is real, so it must not borrow the no-contact wording either.
    const f = createFrame(0)
    stroke(f, 0, [BALL_IDS.RED_MIN], false, BALL_IDS.RED_MIN)
    expect(f.ballOn).toBe('ANY_COLOUR')
    const out = stroke(f, 0, [], false, BALL_IDS.RED_MIN)
    expect(out.reason).toBe('wrong ball first')
  })

  it('allows any colour to be nominated after a red, not just the lowest one', () => {
    // The ball on after a red is "a colour of the striker's choice", so the black is
    // a legal first contact and scores its own value. This used to be called a foul
    // for missing the ball on, which reported "no legal contact" on a shot that had
    // plainly potted a ball.
    const f = createFrame(0)
    stroke(f, 0, [BALL_IDS.RED_MIN], false, BALL_IDS.RED_MIN)
    expect(f.ballOn).toBe('ANY_COLOUR')
    stroke(f, 0, [BALL_IDS.BLACK], false, BALL_IDS.BLACK)
    expect(f.scores.player0).toBe(1 + 7)
    expect(f.scores.player1).toBe(0)
    // A colour potted after a red is spotted again, so it goes back on the table
    // rather than staying off it.
    expect(f.colorsRemaining.has(BALL_IDS.BLACK)).toBe(true)
    expect(ball(f, BALL_IDS.BLACK).potted).toBe(false)
    // The break carries on, and the striker is back on a red.
    expect(f.turnIndex).toBe(0)
    expect(f.ballOn).toBe('RED')
  })

  it('scores a colour after a red at the value of the colour actually potted', () => {
    // The blue is not the lowest colour on the table, so a fixed "lowest colour" rule
    // would have scored this at the yellow's 2 points.
    const f = createFrame(0)
    stroke(f, 0, [BALL_IDS.RED_MIN], false, BALL_IDS.RED_MIN)
    stroke(f, 0, [BALL_IDS.BLUE], false, BALL_IDS.BLUE)
    expect(f.scores.player0).toBe(1 + 5)
  })

  it('treats hitting a red first while on ANY_COLOUR as a foul', () => {
    // Reds are not on after a red, so the first contact may not be a red.
    const f = createFrame(0)
    stroke(f, 0, [BALL_IDS.RED_MIN], false, BALL_IDS.RED_MIN)
    stroke(f, 0, [], false, BALL_IDS.RED_MAX)
    expect(f.scores.player1).toBe(4)
    expect(f.turnIndex).toBe(1)
    expect(f.ballOn).toBe('RED')
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

/**
 * The size of a foul, which is the one part of the rules that moves real credits.
 *
 * A foul is worth the value of the highest ball involved -- the ball on, the ball
 * struck first, or any ball potted -- and never less than four. The struck-first ball
 * is the case that gets left out: a player who reaches the blue when a red is on has
 * fouled by hitting a five-point ball, and charging them the flat four minimum
 * understates what they did. It is a real-money difference, so it is pinned per ball
 * rather than tested once.
 */
describe('foul value is the highest ball involved, minimum 4', () => {
  /** A red on, nothing potted, and a given first contact. What the opponent is given. */
  function foulWorth(firstContactId: number | null): number {
    const f = createFrame(0)
    stroke(f, 0, [], false, firstContactId)
    return f.scores.player1
  }

  it('charges 5 for reaching the blue when a red is on', () => {
    expect(foulWorth(BALL_IDS.BLUE)).toBe(5)
  })

  it('charges 7 for reaching the black when a red is on', () => {
    expect(foulWorth(BALL_IDS.BLACK)).toBe(7)
  })

  it('charges 6 for reaching the pink when a red is on', () => {
    expect(foulWorth(BALL_IDS.PINK)).toBe(6)
  })

  it('still charges only 4 for reaching the brown, whose value is the minimum', () => {
    expect(foulWorth(BALL_IDS.BROWN)).toBe(4)
  })

  it('charges the flat 4 for a stroke that touched nothing', () => {
    // No contact at all: there is no ball involved to be worth anything, so this is
    // the minimum rather than the red's 1.
    expect(foulWorth(null)).toBe(4)
  })

  it('is not a foul at all to reach the ball on and pot nothing', () => {
    // Reaching a red when a red is on is a legal stroke that simply did not score, so
    // there is no penalty to size and the visit passes with the scores untouched. This
    // is the case that keeps the flat 4 above from being read as a red-sized foul.
    const f = createFrame(0)
    const out = stroke(f, 0, [], false, BALL_IDS.RED_MIN)
    expect(out.reason).toBe('no-ball-potted')
    expect(f.scores.player0).toBe(0)
    expect(f.scores.player1).toBe(0)
    expect(f.turnIndex).toBe(1)
  })

  it('charges the ball on when it outranks the ball struck', () => {
    // The black is on for the clearance, so reaching a red is worth the black's 7
    // rather than the red's 1.
    const f = createFrame(0)
    f.remainingReds = 0
    f.ballOn = { colour: BALL_IDS.BLACK }
    stroke(f, 0, [], false, BALL_IDS.RED_MIN)
    expect(f.scores.player1).toBe(7)
  })

  it('charges a yellow on for four when a red is reached first, not one', () => {
    const f = createFrame(0)
    f.ballOn = { colour: BALL_IDS.YELLOW }
    stroke(f, 0, [], false, BALL_IDS.RED_MIN)
    expect(f.scores.player1).toBe(4)
  })

  it('charges 7 for potting the black while a red was on', () => {
    // The illegal pot is worth the ball potted, and the ball on is only 1.
    const f = createFrame(0)
    const out = stroke(f, 0, [BALL_IDS.BLACK], false, BALL_IDS.RED_MIN)
    expect(out.reason).toBe('wrong ball potted')
    expect(f.scores.player1).toBe(7)
    expect(f.scores.player0).toBe(0)
  })

  it('charges 7 for reaching and potting the black when a red is on', () => {
    // Both halves of the same mistake -- the wrong ball was struck and the wrong ball
    // went down -- and the black is what decides it either way.
    const f = createFrame(0)
    stroke(f, 0, [BALL_IDS.BLACK], false, BALL_IDS.BLACK)
    expect(f.scores.player1).toBe(7)
  })

  it('never charges less than 4, even when every ball involved is worth 1', () => {
    const f = createFrame(0)
    stroke(f, 0, [], false, null)
    expect(f.scores.player1).toBe(4)
  })

  it('awards the foul to the opponent rather than deducting from the striker', () => {
    const f = createFrame(0)
    f.scores.player0 = 30
    stroke(f, 0, [], false, BALL_IDS.BLACK)
    expect(f.scores.player0).toBe(30)
    expect(f.scores.player1).toBe(7)
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
  it('runs the colour sequence and ends the frame once the lead covers the rest', () => {
    // A frame is decided by the points, not by the last ball. Potting up to the blue
    // leaves the pink and black worth 13, and the striker is 14 ahead, so the frame
    // is over there and the pink and black are never touched. Requiring every colour
    // to be potted off the table first is not the rule, and it is what allowed a tied
    // frame on the final black to be traded back and forth indefinitely.
    const f = createFrame(0)
    f.remainingReds = 0
    f.ballOn = 'ANY_COLOUR'
    let points = 0
    for (let i = 0; i < COLOR_ORDER.length; i++) {
      const colorId = COLOR_ORDER[i]!
      const before = points
      points += COLOR_VALUES[colorId] ?? 0
      const end = stroke(f, 0, [colorId], false, colorId)
      expect(f.scores.player0).toBe(points)
      expect(f.colorsRemaining.has(colorId)).toBe(false)

      // What the trailing player could still score, and whether that can catch up.
      let remaining = 0
      for (const id of f.colorsRemaining) remaining += COLOR_VALUES[id] ?? 0
      const decided = points - before > remaining || points > remaining
      if (decided) {
        expect(end.frameEnded).toBe(true)
        expect(end.frameWinner).toBe(0)
        expect(f.phase).toBe('FRAME_END')
      } else {
        expect(end.frameEnded).toBe(false)
        expect(f.ballOn).toEqual({ colour: COLOR_ORDER[i + 1] })
      }
      if (end.frameEnded) return
    }
    throw new Error('colour sequence never ended the frame')
  })

  it('ends the frame on the blue when one player is 14 ahead of the other', () => {
    const f = createFrame(0)
    f.remainingReds = 0
    f.ballOn = 'ANY_COLOUR'
    for (const colorId of [BALL_IDS.YELLOW, BALL_IDS.GREEN, BALL_IDS.BROWN]) {
      stroke(f, 0, [colorId], false, colorId)
      expect(f.phase).not.toBe('FRAME_END')
    }
    // 2 + 3 + 4 + 5 = 14 ahead, with only the pink and black (13) left to play.
    const end = stroke(f, 0, [BALL_IDS.BLUE], false, BALL_IDS.BLUE)
    expect(end.frameEnded).toBe(true)
    expect(end.frameWinner).toBe(0)
    expect(f.scores.player0).toBe(14)
    expect(f.colorsRemaining.has(BALL_IDS.PINK)).toBe(true)
    expect(f.colorsRemaining.has(BALL_IDS.BLACK)).toBe(true)
  })

  it('respots the black to decide a frame that is level on the last ball', () => {
    // Level scores with only the black left: it goes back on its spot, and the next
    // pot of it wins the frame outright because there is nothing left to win back.
    const g = createFrame(0)
    g.remainingReds = 0
    for (const colorId of [BALL_IDS.YELLOW, BALL_IDS.GREEN, BALL_IDS.BROWN, BALL_IDS.BLUE, BALL_IDS.PINK]) {
      ball(g, colorId).potted = true
      g.colorsRemaining.delete(colorId)
    }
    g.scores.player0 = 20
    g.scores.player1 = 20
    g.ballOn = { colour: BALL_IDS.BLACK }

    // Potting the black at level scores 7 with nothing left on the table, so the
    // frame ends on the spot rather than being played on.
    const end = stroke(g, 0, [BALL_IDS.BLACK], false, BALL_IDS.BLACK)
    expect(end.frameEnded).toBe(true)
    expect(end.frameWinner).toBe(0)
    expect(g.scores.player0).toBe(27)
  })

  it('leaves a part-played colour sequence alone when the scores are level', () => {
    // Level scores must not drag the ball on forward to the black: the colours are
    // still played in ascending order.
    const f = createFrame(0)
    f.remainingReds = 0
    f.ballOn = 'ANY_COLOUR'
    stroke(f, 0, [BALL_IDS.YELLOW], false, BALL_IDS.YELLOW)
    stroke(f, 0, [BALL_IDS.GREEN], false, BALL_IDS.GREEN)
    // Even out the scores by hand, then carry on the sequence.
    f.scores.player0 = f.scores.player1
    stroke(f, 0, [BALL_IDS.BROWN], false, BALL_IDS.BROWN)
    expect(f.ballOn).toEqual({ colour: BALL_IDS.BLUE })
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

/**
 * The D is a break-off restriction and nothing else.
 *
 * Every test here plays at power 0, which the simulation settles on its first tick, so
 * the cue ball is still exactly where the placement put it afterwards. That makes the
 * accepted and rejected placements directly readable off the frame, with no replay to
 * reason about.
 */
describe('ball in hand placement', () => {
  const IN_D: Vec2 = vec(600, TABLE_WIDTH / 2)
  /** Well clear of the D, and of every ball and pocket on the table. */
  const ANYWHERE: Vec2 = vec(1200, 1400)
  const ON_THE_BLUE = vec(TABLE_LENGTH / 2, TABLE_WIDTH / 2)

  function place(frame: FrameState, at: { x: number; y: number }): Vec2 {
    // Each placement consumes the in-hand, because playing a stroke clears it. Re-armed
    // here so one test can assert several placements independently; `cueInHandInD` is
    // left alone, since which side of the break-off we are on is what is under test.
    frame.cueInHand = true
    applyStroke(frame, frame.turnIndex, { aimAngle: 0, power: 0, spin: { x: 0, y: 0 }, cuePos: at })
    return vec(ball(frame, BALL_IDS.CUE).pos.x, ball(frame, BALL_IDS.CUE).pos.y)
  }

  /** Puts the cue ball in hand the way a real in-off does, and returns that frame. */
  function midFrameInHand(): FrameState {
    const frame = createFrame(0)
    frame.balls = frame.balls.filter((b) => b.isCue)
    frame.balls[0]!.pos = vec(400, 400)
    frame.balls[0]!.vel = vec(0, 0)
    frame.cueInHand = false
    frame.ballOn = 'RED'
    const outcome = applyStroke(frame, 0, { aimAngle: Math.atan2(-400, -400), power: 0.15, spin: { x: 0, y: 0 } })
    expect(outcome.sim.cuePotted).toBe(true)
    expect(frame.cueInHand).toBe(true)
    return frame
  }

  it('restricts the break-off to the D', () => {
    const frame = createFrame(0)
    expect(frame.cueInHandInD, 'a frame opens with the break-off restriction in force').toBe(true)
    expect(place(frame, IN_D)).toEqual(IN_D)
  })

  it('refuses a break-off placement outside the D', () => {
    const frame = createFrame(0)
    // Anywhere is not the D: the rejected placement leaves the cue on its own spot.
    expect(place(frame, ANYWHERE)).toEqual(cueStartPosition())
  })

  it('refuses a break-off placement short of the D, on the far side of the baulk line', () => {
    const frame = createFrame(0)
    // Inside the semicircle but on the wrong side of the baulk line is not in the D.
    const beyondBaulk = vec(BAULK_LINE_X + 10, TABLE_WIDTH / 2)
    expect(place(frame, beyondBaulk)).toEqual(cueStartPosition())
  })

  it('lets a mid-frame ball in hand go anywhere on the table', () => {
    const frame = midFrameInHand()
    expect(frame.cueInHandInD, 'the D restriction does not survive the first stroke').toBe(false)
    expect(place(frame, ANYWHERE)).toEqual(ANYWHERE)
  })

  it('still refuses a mid-frame placement that is not on the table', () => {
    const frame = midFrameInHand()
    const before = vec(ball(frame, BALL_IDS.CUE).pos.x, ball(frame, BALL_IDS.CUE).pos.y)
    for (const off of [vec(-500, 900), vec(9000, 900), vec(1200, -40), vec(1200, 1900)]) {
      expect(place(frame, off), `placement ${off.x},${off.y} must be refused`).toEqual(before)
    }
  })

  it('still refuses a mid-frame placement inside a pocket', () => {
    const frame = midFrameInHand()
    const before = vec(ball(frame, BALL_IDS.CUE).pos.x, ball(frame, BALL_IDS.CUE).pos.y)
    // On the cloth by the test's own measure, but inside the corner pocket's jaws, so
    // the cue ball would drop before it could be struck.
    expect(place(frame, vec(30, 30))).toEqual(before)
  })

  it('still refuses a mid-frame placement overlapping a ball', () => {
    const frame = midFrameInHand()
    frame.balls = frame.balls.filter((b) => b.isCue)
    // Two reds on the table, so the overlap check has something to reject against.
    const reds = buildInitialBalls().filter((b) => b.isRed).slice(0, 2)
    reds[0]!.pos = vec(1200, 400)
    reds[1]!.pos = vec(1800, 900)
    for (const red of reds) {
      red.potted = false
      red.vel = vec(0, 0)
      frame.balls.push(red)
    }
    const before = vec(ball(frame, BALL_IDS.CUE).pos.x, ball(frame, BALL_IDS.CUE).pos.y)

    expect(place(frame, vec(1200, 400)), 'inside a red').toEqual(before)
    expect(place(frame, ON_THE_BLUE), 'inside a red').toEqual(before)
    expect(place(frame, vec(1200, 445)), 'a ball a diameter away is still touching').toEqual(before)
    expect(place(frame, vec(1200, 470)), 'a clear ball-width away is legal').toEqual(vec(1200, 470))
  })

  it('carries the restriction through a snapshot round trip', () => {
    const frame = createFrame(0)
    expect(frameSnapshot(frame).cueInHandInD).toBe(true)
    const restored = frameFromSnapshot(frameSnapshot(midFrameInHand()))
    expect(restored.cueInHandInD).toBe(false)
  })

  it('reads a pre-split snapshot as unrestricted rather than as a break-off', () => {
    const legacy = frameSnapshot(createFrame(0))
    delete legacy.cueInHandInD
    expect(frameFromSnapshot(legacy).cueInHandInD).toBe(false)
  })
})