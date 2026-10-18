import { describe, expect, it } from 'vitest'
import { BALL_IDS, applyStroke, createFrame, frameSnapshot } from '@snooker/shared'
import { PREDICTED_KEYFRAME_RATE, predictShot } from './predictShot.js'

/** A frame at the break with the cue ball already down in the D, as the server holds it. */
function breakFrame() {
  const frame = createFrame(0)
  const cue = frame.balls.find((b) => b.id === BALL_IDS.CUE)!
  cue.potted = false
  cue.pos = { x: 737, y: 960 }
  frame.cueInHand = false
  frame.cueInHandInD = false
  return frame
}

describe('the device’s own copy of a shot', () => {
  const shots = [
    { aimAngle: 0.02, power: 1, spin: { x: 0, y: 0 } },
    { aimAngle: -0.05, power: 0.55, spin: { x: 0.4, y: -0.6 } },
    { aimAngle: 0.3, power: 0.2, spin: { x: -0.8, y: 0.7 } }
  ]

  for (const shot of shots) {
    it(`matches the server's recording sample for sample (power ${shot.power})`, () => {
      const server = breakFrame()
      const snapshot = frameSnapshot(server)
      const predicted = predictShot(snapshot.balls, shot)
      const outcome = applyStroke(server, 0, { ...shot }, { playback: { rate: PREDICTED_KEYFRAME_RATE } })
      const recorded = outcome.sim.keyframes!
      expect(predicted).not.toBeNull()
      expect(predicted!.duration).toBe(outcome.sim.simSeconds)
      expect(predicted!.pots).toEqual(outcome.sim.pots ?? [])
      // The server appends (or folds in) one last sample with where the rules left the
      // balls; every sample before it is the simulation's own and must match exactly.
      const shared = Math.min(predicted!.keyframes.length, recorded.length) - 1
      expect(shared).toBeGreaterThan(5)
      for (let i = 0; i < shared; i++) expect(predicted!.keyframes[i]).toEqual(recorded[i])
    })
  }

  it('tidies the input the way the server does', () => {
    const snapshot = frameSnapshot(breakFrame())
    const wild = predictShot(snapshot.balls, { aimAngle: 0.1, power: 3, spin: { x: 0, y: 0 } })
    const tidy = predictShot(snapshot.balls, { aimAngle: 0.1, power: 1, spin: { x: 0, y: 0 } })
    expect(wild).toEqual(tidy)
  })
})
