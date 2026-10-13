import { describe, expect, it } from 'vitest'
import { SHOT_PLAYBACK_SPEED, layoutTableBalls, simulateStroke, type ShotPlayback } from '@snooker/shared'
import { createReplaySfx } from './replayAdapter.js'
import { subscribeSfx, type SfxEvent } from './sfxEvents.js'

/** A real break-off, simulated by the game's own engine, as the server would send it. */
function breakOff(): { playback: ShotPlayback; start: Array<{ id: number; x: number; y: number; potted: boolean }> } {
  const start = layoutTableBalls()
  const sim = simulateStroke(start, { aimAngle: 0.02, power: 0.85, spin: { x: 0, y: 0 } }, { playback: { rate: 30 } })
  return {
    playback: { duration: sim.simSeconds, keyframes: sim.keyframes!, pots: sim.pots ?? [], contacts: sim.contacts ?? [] },
    start: start.map((b) => ({ id: b.id, x: b.pos.x, y: b.pos.y, potted: b.potted }))
  }
}

/** Plays a recording through the adapter at sixty frames a second and collects what it says. */
function play(playback: ShotPlayback, start: Array<{ id: number; x: number; y: number; potted: boolean }>, frameMs = 1000 / 60) {
  const events: SfxEvent[] = []
  const stop = subscribeSfx((event) => events.push(event))
  const adapter = createReplaySfx()
  adapter.shotStarted(playback, start)
  let now = 10000
  let clock = 0
  while (clock < playback.duration) {
    clock = Math.min(playback.duration, clock + (frameMs / 1000) * SHOT_PLAYBACK_SPEED)
    now += frameMs
    adapter.tick(clock, SHOT_PLAYBACK_SPEED, start, now)
  }
  adapter.shotEnded()
  stop()
  return { events, endedAt: now }
}

describe('the replay as sound events', () => {
  const shot = breakOff()

  it('strikes the cue once, first, at about the power the shot was played with', () => {
    // A clear run at a distant ball, so the cue ball's first samples are its launch. (In
    // the break above it meets a baulk colour inside the first two samples, which is the
    // one case the recording cannot give the power for.)
    const start = layoutTableBalls().filter((b) => b.isCue || b.id === 1)
    start.find((b) => b.isCue)!.pos = { x: 600, y: 889 }
    start.find((b) => b.id === 1)!.pos = { x: 3000, y: 889 }
    const sim = simulateStroke(start, { aimAngle: 0, power: 0.85, spin: { x: 0, y: 0 } }, { playback: { rate: 30 } })
    const playback: ShotPlayback = { duration: sim.simSeconds, keyframes: sim.keyframes!, pots: sim.pots ?? [], contacts: sim.contacts ?? [] }
    const { events } = play(playback, start.map((b) => ({ id: b.id, x: b.pos.x, y: b.pos.y, potted: false })))
    const audible = events.filter((e) => e.type !== 'respot' && e.type !== 'rollTick')
    expect(audible[0]!.type).toBe('cueStrike')
    expect(events.filter((e) => e.type === 'cueStrike').length).toBe(1)
    const strike = audible[0] as Extract<SfxEvent, { type: 'cueStrike' }>
    expect(strike.power).toBeGreaterThan(0.75)
    expect(strike.power).toBeLessThanOrEqual(0.86)
    expect(strike.x).toBeGreaterThan(590)
  })

  it('strikes the cue once in a break too', () => {
    const { events } = play(shot.playback, shot.start)
    expect(events.filter((e) => e.type === 'cueStrike').length).toBe(1)
    expect(events.filter((e) => e.type !== 'respot' && e.type !== 'rollTick')[0]!.type).toBe('cueStrike')
  })

  it('reports every recorded contact exactly once, in order, as the replay reaches it', () => {
    const { events } = play(shot.playback, shot.start)
    const contacts = shot.playback.contacts!
    const heard = events.filter((e) => e.type === 'ballBall' || e.type === 'cushion' || e.type === 'jaw')
    expect(heard.length).toBe(contacts.length)
    expect(heard.filter((e) => e.type === 'ballBall').length).toBe(contacts.filter((c) => c[0] === 0).length)
    expect(heard.filter((e) => e.type === 'cushion').length).toBe(contacts.filter((c) => c[0] === 1).length)
    // Each one is reported within a frame of when it was due: never early, never queued.
    for (const event of heard) {
      const at = (event as { at?: number }).at
      expect(at).toBeDefined()
    }
  })

  it('never reports a contact before the replay has got there', () => {
    const events: Array<{ type: string; clock: number; t?: number }> = []
    const adapter = createReplaySfx()
    let clock = 0
    const stop = subscribeSfx((event) => {
      if (event.type === 'ballBall' || event.type === 'cushion' || event.type === 'jaw') events.push({ type: event.type, clock })
    })
    adapter.shotStarted(shot.playback, shot.start)
    const firstContact = shot.playback.contacts![0]![1]
    clock = firstContact * 0.5
    adapter.tick(clock, SHOT_PLAYBACK_SPEED, shot.start, 10000)
    expect(events.length).toBe(0)
    clock = firstContact + 0.001
    adapter.tick(clock, SHOT_PLAYBACK_SPEED, shot.start, 10100)
    expect(events.length).toBeGreaterThanOrEqual(1)
    stop()
  })

  it('stamps a skipped-over contact with a moment long past, so it is not played', () => {
    const adapter = createReplaySfx()
    const stamped: number[] = []
    const stop = subscribeSfx((event) => {
      if (event.type === 'ballBall' && event.at !== undefined) stamped.push(10000 - event.at)
    })
    adapter.shotStarted(shot.playback, shot.start)
    // The replay jumps straight to the end: a fast-forward, or a tab that was hidden.
    adapter.tick(shot.playback.duration, SHOT_PLAYBACK_SPEED, shot.start, 10000)
    stop()
    expect(stamped.length).toBeGreaterThan(0)
    // Everything but the last moments of the shot is far outside the 250ms the sounds allow.
    expect(stamped.filter((late) => late > 250).length).toBeGreaterThan(stamped.length * 0.8)
  })

  it('reports a pot once per ball, with the pocket it went into', () => {
    // Straight into the top-left corner pocket from close by.
    const start = layoutTableBalls().filter((b) => b.isCue || b.id === 1)
    const cue = start.find((b) => b.isCue)!
    const red = start.find((b) => b.id === 1)!
    cue.pos = { x: 500, y: 500 }
    red.pos = { x: 250, y: 250 }
    const sim = simulateStroke(start, { aimAngle: Math.atan2(-1, -1), power: 0.3, spin: { x: 0, y: 0 } }, { playback: { rate: 30 } })
    expect(sim.pottedIds).toContain(1)
    const playback: ShotPlayback = { duration: sim.simSeconds, keyframes: sim.keyframes!, pots: sim.pots ?? [], contacts: sim.contacts ?? [] }
    const shown = start.map((b) => ({ id: b.id, x: b.pos.x, y: b.pos.y, potted: false }))
    const { events } = play(playback, shown)
    const pots = events.filter((e): e is Extract<SfxEvent, { type: 'pocket' }> => e.type === 'pocket')
    expect(pots.filter((p) => p.ballId === 1).length).toBe(1)
    expect(pots.find((p) => p.ballId === 1)!.speed).toBeGreaterThan(0)
    // The pot comes after the contact that sent the ball there.
    const order = events.map((e) => e.type)
    expect(order.indexOf('pocket')).toBeGreaterThan(order.indexOf('ballBall'))
  })

  it('reports the roll every frame while the replay runs, and silence when it ends', () => {
    const { events } = play(shot.playback, shot.start)
    const rolls = events.filter((e): e is Extract<SfxEvent, { type: 'rollTick' }> => e.type === 'rollTick')
    expect(rolls.length).toBeGreaterThan(30)
    expect(rolls[rolls.length - 1]!.balls.length).toBe(0)
  })

  it('lets every ball on the table be potted afresh at the start of a shot', () => {
    const { events } = play(shot.playback, shot.start)
    const respots = events.filter((e) => e.type === 'respot')
    expect(respots.length).toBe(shot.start.filter((b) => !b.potted).length)
  })

  it('says nothing for a recording with no contacts in it, and does not throw', () => {
    const bare: ShotPlayback = { duration: 1, keyframes: [], pots: [] }
    const { events } = play(bare, [])
    expect(events.filter((e) => e.type === 'ballBall' || e.type === 'cushion' || e.type === 'pocket').length).toBe(0)
  })
})
