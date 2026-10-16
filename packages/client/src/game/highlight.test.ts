import { describe, expect, it } from 'vitest'
import type { ShotPlayback } from '@snooker/shared'
import type { PlaybackBall } from './playback.js'
import { rateShot } from './highlight.js'

const CUE = 0
const RED = 1
const RED_2 = 2

type Contact = NonNullable<ShotPlayback['contacts']>[number]

/** A recording of a shot from keyframe tracks, pots and contacts. */
function playback(
  tracks: Record<number, Array<[t: number, x: number, y: number]>>,
  pots: Array<[number, number]>,
  contacts: Contact[] = []
): ShotPlayback {
  const times = new Set<number>()
  for (const samples of Object.values(tracks)) for (const [t] of samples) times.add(t)
  const keyframes = [...times]
    .sort((a, b) => a - b)
    .map((t) => ({
      t,
      balls: Object.entries(tracks).flatMap(([id, samples]) =>
        samples.filter(([st]) => st === t).map(([, x, y]) => [Number(id), x, y] as [number, number, number])
      )
    }))
  return { duration: 3, keyframes, pots, contacts }
}

const ball = (id: number, x: number, y: number): PlaybackBall => ({ id, x, y, potted: false })

describe('rateShot', () => {
  it('lets an ordinary short pot go by', () => {
    const start = [ball(CUE, 2400, 889), ball(RED, 2700, 889)]
    const shot = playback(
      { [CUE]: [[0.1, 2500, 889]], [RED]: [[0.3, 2900, 889], [0.6, 3200, 889]] },
      [[RED, 0.7]],
      [[0, 0.2, CUE, RED, 2000, 2650, 889]]
    )
    expect(rateShot(start, shot, [RED])).toBeNull()
  })

  it('calls a pot down the length of the table a long pot', () => {
    const start = [ball(CUE, 600, 889), ball(RED, 1900, 889)]
    const shot = playback(
      { [CUE]: [[0.2, 1200, 889]], [RED]: [[0.6, 2600, 889], [1.2, 3500, 889]] },
      [[RED, 1.3]],
      [[0, 0.4, CUE, RED, 3000, 1850, 889]]
    )
    expect(rateShot(start, shot, [RED])?.kind).toBe('long-pot')
  })

  it('calls a fine cut a thin cut', () => {
    // The cue ball travels along +x; the red leaves at about 70 degrees to that line.
    const start = [ball(CUE, 1000, 889), ball(RED, 1700, 900)]
    const shot = playback(
      { [CUE]: [[0.2, 1400, 889]], [RED]: [[0.5, 1800, 1200], [0.9, 1900, 1520]] },
      [[RED, 1.0]],
      [[0, 0.3, CUE, RED, 2500, 1650, 893]]
    )
    expect(rateShot(start, shot, [RED])?.kind).toBe('thin-cut')
  })

  it('calls a pot that comes off a cushion first a double', () => {
    const start = [ball(CUE, 1500, 889), ball(RED, 1800, 1200)]
    const shot = playback(
      { [CUE]: [[0.1, 1600, 1000]], [RED]: [[0.4, 1900, 1700], [0.8, 2000, 900], [1.2, 2100, 60]] },
      [[RED, 1.3]],
      [
        [0, 0.2, CUE, RED, 2500, 1780, 1180],
        [1, 0.5, RED, 2, 1800, 1900, 1750]
      ]
    )
    expect(rateShot(start, shot, [RED])?.kind).toBe('double')
  })

  it('calls a ball potted by another object ball a plant, over every other reason', () => {
    const start = [ball(CUE, 1500, 889), ball(RED, 2000, 889), ball(RED_2, 2100, 889)]
    const shot = playback(
      { [CUE]: [[0.1, 1800, 889]], [RED]: [[0.3, 2050, 889]], [RED_2]: [[0.5, 2700, 889], [0.9, 3500, 889]] },
      [[RED_2, 1.0]],
      [
        [0, 0.2, CUE, RED, 2500, 1950, 889],
        [0, 0.35, RED, RED_2, 1800, 2050, 889]
      ]
    )
    expect(rateShot(start, shot, [RED_2])?.kind).toBe('plant')
  })

  it('calls two balls in one stroke two in one', () => {
    const start = [ball(CUE, 2400, 889), ball(RED, 2700, 889), ball(RED_2, 2700, 940)]
    const shot = playback(
      { [CUE]: [[0.1, 2500, 889]], [RED]: [[0.3, 2900, 889], [0.6, 3200, 889]], [RED_2]: [[0.3, 2900, 940], [0.6, 3200, 940]] },
      [
        [RED, 0.7],
        [RED_2, 0.8]
      ],
      [
        // The cue ball takes both reds itself, so neither is a plant.
        [0, 0.2, CUE, RED, 2000, 2650, 889],
        [0, 0.25, CUE, RED_2, 1500, 2660, 930]
      ]
    )
    expect(rateShot(start, shot, [RED, RED_2])?.kind).toBe('multi')
  })

  it('has nothing to say about a stroke that scored nothing, or only the cue ball', () => {
    const start = [ball(CUE, 600, 889), ball(RED, 1900, 889)]
    const shot = playback({ [CUE]: [[0.2, 1200, 889]] }, [[CUE, 1.0]])
    expect(rateShot(start, shot, [])).toBeNull()
    expect(rateShot(start, shot, [CUE])).toBeNull()
  })
})
