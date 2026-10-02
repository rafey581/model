import { describe, expect, it } from 'vitest'
import { BALL_RADIUS, BAULK_LINE_X, D_RADIUS, TABLE_LENGTH, TABLE_WIDTH } from '@snooker/shared'
import {
  D_CENTRE,
  D_ZONE_RADIUS,
  GHOST_COMMIT_TOLERANCE_MM,
  confirmPlacement,
  followGhost,
  ghostSettled,
  initialPlacementFlow,
  isInsideD,
  isInsideAPocket,
  isCrowded,
  isOnTable,
  placementAllowsGameplayInput,
  placementAllowsGhostInput,
  placementStatus,
  rejectPlacement,
  stepPlacementFlow
} from './placement.js'

const pocket = { x: 0, y: 0, radius: 85 }

function ball(id: number, x: number, y: number, potted = false): { id: number; x: number; y: number; potted: boolean } {
  return { id, x, y, potted }
}

describe('the D geometry', () => {
  it('matches the shared constants', () => {
    expect(D_CENTRE.x).toBe(BAULK_LINE_X)
    expect(D_CENTRE.y).toBe(TABLE_WIDTH / 2)
    expect(D_ZONE_RADIUS).toBe(D_RADIUS)
  })

  it('accepts the centre of the D and the baulk line itself', () => {
    expect(isInsideD(D_CENTRE)).toBe(true)
    expect(isInsideD({ x: BAULK_LINE_X, y: TABLE_WIDTH / 2 })).toBe(true)
  })

  it('rejects a point one millimetre past the baulk line', () => {
    expect(isInsideD({ x: BAULK_LINE_X + 1, y: TABLE_WIDTH / 2 })).toBe(false)
  })

  it('rejects a point just outside the arc but behind baulk', () => {
    expect(isInsideD({ x: BAULK_LINE_X, y: TABLE_WIDTH / 2 + D_RADIUS + 1 })).toBe(false)
  })
})

describe('validity checks', () => {
  it('mirrors the on-table bound at the cushion', () => {
    expect(isOnTable({ x: BALL_RADIUS, y: TABLE_WIDTH / 2 })).toBe(true)
    expect(isOnTable({ x: BALL_RADIUS - 0.5, y: TABLE_WIDTH / 2 })).toBe(false)
    expect(isOnTable({ x: TABLE_LENGTH - BALL_RADIUS, y: TABLE_WIDTH / 2 })).toBe(true)
  })

  it('sees a centre inside a pocket mouth as unplaceable', () => {
    expect(isInsideAPocket({ x: pocket.x + 10, y: pocket.y + 10 })).toBe(true)
    expect(isInsideAPocket({ x: pocket.x + pocket.radius + 50, y: pocket.y })).toBe(false)
  })

  it('sees a spot a diameter from another ball as crowded, a touch further as free', () => {
    const other = ball(5, 2000, 500)
    const here = { x: 2000, y: 500 }
    const diameter = BALL_RADIUS * 2
    expect(isCrowded({ x: here.x + diameter * 0.99, y: here.y }, [other])).toBe(true)
    expect(isCrowded({ x: here.x + diameter * 1.01, y: here.y }, [other])).toBe(false)
  })

  it('ignores the cue ball itself and potted balls when testing crowding', () => {
    const cue = ball(0, 2000, 500)
    const potted = ball(7, 2000, 500, true)
    expect(isCrowded({ x: 2000, y: 500 }, [cue, potted])).toBe(false)
  })
})

describe('placementStatus', () => {
  const free = { x: 2000, y: 900 }
  const inD = { x: BAULK_LINE_X - 100, y: TABLE_WIDTH / 2 }

  it('accepts a clear spot in either restriction mode', () => {
    expect(placementStatus(free, false, []).ok).toBe(true)
    expect(placementStatus(inD, true, []).ok).toBe(true)
  })

  it('names the D as the reason during break-off and stays quiet mid-frame', () => {
    const pastBaulk = { x: BAULK_LINE_X + 400, y: TABLE_WIDTH / 2 }
    expect(placementStatus(pastBaulk, true, []).reason).toBe('outside-D')
    expect(placementStatus(pastBaulk, false, []).ok).toBe(true)
  })

  it('reports the right reason for each failure class', () => {
    expect(placementStatus({ x: -50, y: 500 }, false, []).reason).toBe('off-table')
    // A middle-pocket mouth: inside the pocket radius, but on the cloth.
    const midPocketMouth = { x: TABLE_LENGTH / 2, y: 40 }
    expect(placementStatus(midPocketMouth, false, []).reason).toBe('in-pocket')
    expect(placementStatus({ x: 2000, y: 500 }, false, [ball(3, 2000, 500)]).reason).toBe('crowded')
  })

  it('checks the hard failures before the D, so the message is never misleading', () => {
    // A spot that is both in a pocket mouth and past the D must not be reported
    // as merely outside the D.
    const midPocketPastD = { x: TABLE_LENGTH / 2, y: 40 }
    expect(placementStatus(midPocketPastD, true, []).reason).toBe('in-pocket')
  })
})

describe('the ghost follow', () => {
  it('never overshoots and converges on the target', () => {
    let current = { x: 0, y: 0 }
    const target = { x: 1000, y: 500 }
    for (let i = 0; i < 600; i++) current = followGhost(current, target, 1 / 60)
    expect(current.x).toBeCloseTo(target.x, 3)
    expect(current.y).toBeCloseTo(target.y, 3)
  })

  it('is frame-rate independent: two half steps land where one full step does', () => {
    const target = { x: 800, y: 300 }
    const one = followGhost({ x: 0, y: 0 }, target, 1 / 30)
    const two = followGhost(followGhost({ x: 0, y: 0 }, target, 1 / 60), target, 1 / 60)
    expect(one.x).toBeCloseTo(two.x, 9)
    expect(one.y).toBeCloseTo(two.y, 9)
  })

  it('treats a negative or zero dt as no movement', () => {
    const current = { x: 120, y: 90 }
    expect(followGhost(current, { x: 9999, y: 9999 }, 0)).toEqual(current)
    expect(followGhost(current, { x: 9999, y: 9999 }, -1)).toEqual(current)
  })

  it('settles within the commit tolerance once it has caught up', () => {
    const target = { x: 500, y: 500 }
    const far = { x: target.x + GHOST_COMMIT_TOLERANCE_MM * 3, y: target.y }
    expect(ghostSettled(far, target)).toBe(false)
    expect(ghostSettled(target, target)).toBe(true)
    let current = far
    for (let i = 0; i < 240; i++) current = followGhost(current, target, 1 / 60)
    expect(ghostSettled(current, target)).toBe(true)
  })
})

describe('the placement flow', () => {
  const D_SPOT = { x: BAULK_LINE_X - 100, y: TABLE_WIDTH / 2 }
  const MID_TABLE_SPOT = { x: TABLE_LENGTH / 2, y: TABLE_WIDTH / 2 }

  /**
   * Drives the flow the way the frame loop does: `placing` is the server's own
   * cueInHand, `cameraSettled` is the scene's, and `serverAccepted` is the snapshot
   * stopping saying the ball is in hand.
   */
  function drive(
    start: ReturnType<typeof initialPlacementFlow>,
    frames: Array<{ placing: boolean; cameraSettled: boolean; serverAccepted: boolean }>
  ) {
    let flow = start
    const seen: Array<typeof flow.phase> = []
    for (const frame of frames) {
      flow = stepPlacementFlow(flow, frame)
      seen.push(flow.phase)
    }
    return { flow, seen }
  }

  /** The camera's answer for a frame: never settled while a move is running. */
  const settled = { placing: true, cameraSettled: true, serverAccepted: false }
  const moving = { placing: true, cameraSettled: false, serverAccepted: false }

  it('starts idle with nothing confirmed and the player in control', () => {
    const flow = initialPlacementFlow()
    expect(flow.phase).toBe('IDLE')
    expect(flow.confirmed).toBeNull()
    expect(placementAllowsGameplayInput(flow)).toBe(true)
  })

  describe('entering the placement view', () => {
    it('refuses input on the very first frame of the flight in', () => {
      // The regression this guards: the camera used to start moving while the controls
      // stayed live, so a player could aim or fire against a camera in mid-air.
      const entered = stepPlacementFlow(initialPlacementFlow(), moving)
      expect(entered.phase).toBe('ENTERING')
      expect(placementAllowsGameplayInput(entered)).toBe(false)
      expect(placementAllowsGhostInput(entered)).toBe(false)
    })

    it('stays entering while the camera is still moving, however long that takes', () => {
      const once = stepPlacementFlow(initialPlacementFlow(), moving)
      for (let i = 0; i < 300; i++) {
        expect(stepPlacementFlow(once, moving).phase).toBe('ENTERING')
      }
    })

    it('only starts once and never restarts mid-flight', () => {
      // The bug a phase machine exists to prevent: a flag-based flow re-entered its "is
      // placing" branch every frame, restarting a camera move that was already running.
      const { seen } = drive(initialPlacementFlow(), new Array(120).fill(moving))
      expect(seen[0]).toBe('ENTERING')
      expect(new Set(seen)).toEqual(new Set(['ENTERING']))
    })

    it('becomes placing only once the camera has arrived', () => {
      const entered = stepPlacementFlow(initialPlacementFlow(), moving)
      expect(stepPlacementFlow(entered, moving).phase).toBe('ENTERING')
      expect(stepPlacementFlow(entered, settled).phase).toBe('PLACING')
    })

    it('gives the player the ghost, and only the ghost, once it has arrived', () => {
      const placing = stepPlacementFlow(stepPlacementFlow(initialPlacementFlow(), moving), settled)
      expect(placing.phase).toBe('PLACING')
      // The ghost is movable, but the cue is still not: the ball has no position yet, so
      // there is nothing to aim and nothing to shoot.
      expect(placementAllowsGhostInput(placing)).toBe(true)
      expect(placementAllowsGameplayInput(placing)).toBe(false)
    })

    it('goes home again if the placement is withdrawn while the camera is still moving', () => {
      // A frame that ended or a turn that went elsewhere mid-flight. There is nothing
      // left to place, so the camera has to come back down rather than sit overhead.
      const entered = stepPlacementFlow(initialPlacementFlow(), moving)
      const dropped = stepPlacementFlow(entered, { placing: false, cameraSettled: false, serverAccepted: true })
      expect(dropped.phase).toBe('RETURNING')
      expect(dropped.confirmed).toBeNull()
    })
  })

  describe('the D placement at the break-off', () => {
    it('confirms a spot inside the D and holds it through the flight home', () => {
      const placing = drive(initialPlacementFlow(), [moving, settled]).flow
      const confirmed = confirmPlacement(placing, D_SPOT)
      expect(confirmed.phase).toBe('RETURNING')
      // Held on the flow rather than read back from the ghost: this is the position the
      // server was told, and it must not be recomputed while the camera is still moving.
      expect(confirmed.confirmed).toEqual(D_SPOT)
    })

    it('refuses a click outside the D, because the server will reject it', () => {
      // The flow does not decide legality, but it must not be the thing that lets an
      // illegal spot through either. This is the shape of the break-off restriction: a
      // spot past the baulk line is not placeable while `cueInHandInD` is set.
      const placing = drive(initialPlacementFlow(), [moving, settled]).flow
      const pastBaulk = { x: BAULK_LINE_X + 400, y: TABLE_WIDTH / 2 }
      expect(isInsideD(D_SPOT)).toBe(true)
      expect(isInsideD(pastBaulk)).toBe(false)
      expect(placementStatus(pastBaulk, true, []).reason).toBe('outside-D')
      // The flow itself only confirms; the legality gate above it is what refuses this.
      expect(confirmPlacement(placing, D_SPOT).confirmed).toEqual(D_SPOT)
    })

    it('never lets a second click start a second placement while it flies home', () => {
      const returning = confirmPlacement(drive(initialPlacementFlow(), [moving, settled]).flow, D_SPOT)
      // Refused, and refused by identity: the flow is untouched, so nothing about the
      // in-flight placement or its camera move is disturbed.
      expect(confirmPlacement(returning, MID_TABLE_SPOT)).toBe(returning)
      expect(returning.confirmed).toEqual(D_SPOT)
    })
  })

  describe('ball in hand over the whole table', () => {
it('confirms a spot anywhere on the cloth, not just in the D', () => {
      // The difference between the two scenarios: mid-frame there is no D restriction, so
      // the whole playing surface is legal and the flow confirms any clear spot on it.
      // The spots are spread across the table but kept clear of the pockets, which are
      // not placeable in either scenario.
      const placing = drive(initialPlacementFlow(), [moving, settled]).flow
      for (const spot of [
        { x: BAULK_LINE_X + 300, y: BALL_RADIUS },
        { x: TABLE_LENGTH / 2, y: TABLE_WIDTH / 2 },
        { x: TABLE_LENGTH - 600, y: TABLE_WIDTH - 400 }
      ]) {
        expect(isInsideD(spot)).toBe(false)
        expect(placementStatus(spot, false, []).ok).toBe(true)
        expect(confirmPlacement(placing, spot).confirmed).toEqual(spot)
      }
    })

    it('still refuses a spot off the table or inside a pocket mouth', () => {
      expect(placementStatus({ x: -50, y: 500 }, false, []).ok).toBe(false)
      expect(placementStatus({ x: TABLE_LENGTH / 2, y: 40 }, false, []).reason).toBe('in-pocket')
      expect(placementStatus({ x: 2000, y: 500 }, false, [ball(3, 2000, 500)]).reason).toBe('crowded')
    })
  })

  describe('returning to the gameplay view', () => {
    it('keeps the controls away for the whole flight home', () => {
      const returning = confirmPlacement(drive(initialPlacementFlow(), [moving, settled]).flow, MID_TABLE_SPOT)
      for (let i = 0; i < 300; i++) {
        const step = stepPlacementFlow(returning, {
          placing: false,
          cameraSettled: false,
          serverAccepted: true
        })
        expect(step.phase).toBe('RETURNING')
        expect(placementAllowsGameplayInput(step)).toBe(false)
        expect(placementAllowsGhostInput(step)).toBe(false)
      }
    })

    it('does not release input until the camera has landed and the server has agreed', () => {
      const returning = confirmPlacement(drive(initialPlacementFlow(), [moving, settled]).flow, MID_TABLE_SPOT)
      // Camera home but the server has not confirmed the ball is down: the next shot
      // state must not be reachable yet.
      const cameraOnly = stepPlacementFlow(returning, {
        placing: false,
        cameraSettled: true,
        serverAccepted: false
      })
      expect(cameraOnly.phase).toBe('RETURNING')
      expect(placementAllowsGameplayInput(cameraOnly)).toBe(false)
      // Both conditions together release it.
      const done = stepPlacementFlow(returning, { placing: false, cameraSettled: true, serverAccepted: true })
      expect(done.phase).toBe('IDLE')
      expect(placementAllowsGameplayInput(done)).toBe(true)
    })

    it('holds the confirmed position unchanged right up to the end', () => {
      let flow = confirmPlacement(drive(initialPlacementFlow(), [moving, settled]).flow, D_SPOT)
      for (let i = 0; i < 120; i++) {
        const before = flow.confirmed
        flow = stepPlacementFlow(flow, { placing: false, cameraSettled: false, serverAccepted: true })
        // Nothing re-reads the ghost or the snapshot during the flight, so the position
        // the server was given is the position that survives it.
        if (before) expect(flow.confirmed).toEqual(before)
      }
      expect(flow.confirmed).toEqual(D_SPOT)
    })

    it('clears the confirmed position once the placement is finished', () => {
      const returning = confirmPlacement(drive(initialPlacementFlow(), [moving, settled]).flow, MID_TABLE_SPOT)
      const done = stepPlacementFlow(returning, { placing: false, cameraSettled: true, serverAccepted: true })
      // Nothing is carried into the next visit: a stale confirmed position would be the
      // starting point for a placement that has not happened yet.
      expect(done.confirmed).toBeNull()
      expect(done).toEqual(initialPlacementFlow())
    })

it('completes the placement before the next one can start', () => {
      // A whole cycle: fly up, place, confirm, wait for the camera home while the server
      // takes it, then back to idle and ready for the next placement. The order matters and
      // is the point - there is no path from placing straight to idle, so the next shot
      // state cannot be reached while a placement is still in flight.
      const entering = drive(initialPlacementFlow(), [moving]).flow
      const placing = drive(entering, [settled]).flow
      const returning = confirmPlacement(placing, MID_TABLE_SPOT)
      const { flow: home, seen } = drive(returning, [
        { placing: true, cameraSettled: false, serverAccepted: true },
        { placing: true, cameraSettled: true, serverAccepted: true }
      ])
      // Only after both the camera and the server are done does the flow let go.
      expect(seen).toEqual(['RETURNING', 'IDLE'])
      expect(home).toEqual(initialPlacementFlow())
      // And the next placement starts from idle like any other.
      expect(drive(home, [moving]).flow.phase).toBe('ENTERING')
    })

it('waits for the server before releasing a confirmed placement, but not a withdrawn one', () => {
      // A confirmed placement has something to be acknowledged. A withdrawn one never sent
      // anything, so gating it on an acknowledgement that cannot arrive would strand the
      // camera at the gameplay view with the controls still refused.
      const placing = drive(initialPlacementFlow(), [moving, settled]).flow
      const confirmed = confirmPlacement(placing, MID_TABLE_SPOT)
      expect(stepPlacementFlow(confirmed, { placing: false, cameraSettled: true, serverAccepted: false }).phase).toBe(
        'RETURNING'
      )

      const withdrawn = drive(initialPlacementFlow(), [moving, settled]).flow
      // No confirmPlacement call at all: the placement went away with the snapshot.
      const cancelled = stepPlacementFlow(withdrawn, { placing: false, cameraSettled: false, serverAccepted: false })
      expect(cancelled.phase).toBe('RETURNING')
      expect(cancelled.confirmed).toBeNull()
      const home = stepPlacementFlow(cancelled, { placing: false, cameraSettled: true, serverAccepted: false })
      expect(home.phase).toBe('IDLE')
    })

it('hands the placement back when the server refuses it', () => {
      // The dead end this closes: a refused commit leaves the snapshot still saying the
      // ball is in hand, which is indistinguishable from a slow one, so the flow would wait
      // in `RETURNING` for an acknowledgement that is never coming - at a gameplay view,
      // with dead controls, holding a cue ball the player still owns.
      const placing = drive(initialPlacementFlow(), [moving, settled]).flow
      const returning = confirmPlacement(placing, MID_TABLE_SPOT)
      const rejected = rejectPlacement(returning)
      expect(rejected.phase).toBe('ENTERING')
      expect(rejected.confirmed).toBeNull()
      // Back through the camera before the ghost is live again, because the camera is
      // halfway down to the gameplay view at the moment of the refusal.
      expect(placementAllowsGhostInput(rejected)).toBe(false)
      expect(stepPlacementFlow(rejected, moving).phase).toBe('ENTERING')
      expect(stepPlacementFlow(rejected, settled).phase).toBe('PLACING')
      // The position goes with it: the refused spot is not remembered as chosen.
      expect(rejected.confirmed).toBeNull()
    })

it('ignores a refusal that is not about a placement in flight', () => {
      // Refusals arrive for many reasons. One that lands while no placement has been sent
      // must not drag a normal gameplay frame back into a placement.
      const idle = initialPlacementFlow()
      expect(rejectPlacement(idle)).toBe(idle)
      const placing = drive(initialPlacementFlow(), [moving, settled]).flow
      expect(rejectPlacement(placing)).toBe(placing)
      // A withdrawal was never sent either, so there is nothing to refuse.
      const withdrawn = drive(placing, [{ placing: false, cameraSettled: false, serverAccepted: false }]).flow
      expect(rejectPlacement(withdrawn)).toBe(withdrawn)
    })
  })

  it('gives a full placement to exactly one player, and only while the cue is in hand', () => {
    // The turn and ownership rules are the server's, but the flow is driven by the same
    // `placing` answer that already folds in "my turn" and "the table has settled". This
    // is what stops the opponent's client running a placement of its own.
    const myTurn = drive(initialPlacementFlow(), [moving, settled]).flow
    expect(myTurn.phase).toBe('PLACING')
    // The same snapshot read by the other client: not their visit, so not placing.
    const theirTurn = drive(initialPlacementFlow(), [
      { placing: false, cameraSettled: true, serverAccepted: true }
    ]).flow
    expect(theirTurn.phase).toBe('IDLE')
    expect(placementAllowsGhostInput(theirTurn)).toBe(false)
  })

  it('survives a nonsense frame without throwing or inventing a phase', () => {
    // A snapshot arriving before the camera has moved, a phase arriving with no placing
    // behind it, a `dt` of nothing: the machine has to stay on a legal phase whatever it
    // is handed rather than falling off the end of a switch.
    for (const flow of [initialPlacementFlow(), { phase: 'ENTERING' as const, confirmed: null }]) {
      for (const input of [
        { placing: false, cameraSettled: false, serverAccepted: false },
        { placing: true, cameraSettled: false, serverAccepted: true },
        { placing: true, cameraSettled: true, serverAccepted: true }
      ]) {
        const next = stepPlacementFlow(flow, input)
        expect(['IDLE', 'ENTERING', 'PLACING', 'RETURNING']).toContain(next.phase)
      }
    }
  })
})
