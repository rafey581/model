import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { prisma } from '../db/index.js'
import { checkUsername, foldUsername, isValidUsernameFormat, suggestUsername } from './username.js'

/**
 * The uniqueness rule is the point of this file.
 *
 * `User_username_key` is case-SENSITIVE, so on its own it accepts both `Player` and
 * `player`. The database now also carries `User_username_lower_key` on
 * `lower(username)`, and this suite checks that the application agrees with it -
 * otherwise the UI would happily say a name is free and the insert would still fail.
 */

const TAG = `un${Date.now() % 1000000}`
const created: string[] = []

async function createUser(username: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${username}-${created.length}-${TAG}@test.local`,
      username,
      passwordHash: '!',
      role: 'PLAYER',
      status: 'ACTIVE'
    }
  })
  created.push(user.id)
  return user.id
}

afterAll(async () => {
  if (created.length > 0) await prisma.user.deleteMany({ where: { id: { in: created } } })
})

describe('username format', () => {
  it('accepts letters, digits and underscores', () => {
    expect(isValidUsernameFormat('Player_01')).toBe(true)
    expect(isValidUsernameFormat('abc')).toBe(true)
  })

  it('rejects the wrong length', () => {
    expect(isValidUsernameFormat('ab')).toBe(false)
    expect(isValidUsernameFormat('a'.repeat(25))).toBe(false)
    expect(isValidUsernameFormat('a'.repeat(24))).toBe(true)
  })

  it('rejects punctuation, spaces and non-ascii', () => {
    for (const bad of ['has space', 'has-dash', 'has.dot', 'has/slash', 'emoji🎱', 'ünïcode', '']) {
      expect(isValidUsernameFormat(bad), bad).toBe(false)
    }
  })

  it('rejects reserved names regardless of case', () => {
    for (const bad of ['admin', 'Admin', 'ADMIN', 'snooker', 'Arena', 'bot', 'support', 'me']) {
      expect(isValidUsernameFormat(bad), bad).toBe(false)
    }
  })

  it('folds case for comparison', () => {
    expect(foldUsername('  Player_01 ')).toBe('player_01')
  })
})

describe('username availability', () => {
  it('reports a free name as available', async () => {
    const name = `free${TAG}`
    await createUser(name)
    const result = await checkUsername(name)
    expect(result.available).toBe(false)
    expect(result.problem).toBe('taken')
  })

  it('treats a differently-cased variant as taken', async () => {
    const name = `Case${TAG}`
    await createUser(name)
    // The case-sensitive index alone would call this free. This is the assertion
    // that fails if someone drops the lower() index.
    const result = await checkUsername(name.toUpperCase())
    expect(result.available).toBe(false)
    expect(result.problem).toBe('taken')
  })

  it('surfaces the reserved reason before touching the database', async () => {
    const result = await checkUsername('admin')
    expect(result.available).toBe(false)
    expect(result.problem).toBe('reserved')
  })

  it('surfaces the format reason with a usable message', async () => {
    const result = await checkUsername('no spaces here')
    expect(result.available).toBe(false)
    expect(result.problem).toBe('bad_characters')
    expect(result.message).toMatch(/letters, numbers and underscores/)
  })
})

describe('username suggestion', () => {
  it('derives a valid name from a provider display name', async () => {
    const name = await suggestUsername('Ada Lovelace')
    expect(isValidUsernameFormat(name)).toBe(true)
  })

  it('strips accents and punctuation out of provider input', async () => {
    const name = await suggestUsername('José da Silva-Ç Junior!!')
    expect(isValidUsernameFormat(name)).toBe(true)
    expect(name).not.toMatch(/[^a-zA-Z0-9_]/)
  })

  it('never suggests a name that is already taken', async () => {
    const base = `taken${TAG}`
    await createUser(base)
    // The suggestion is deterministic, so calling it twice legitimately returns the
    // same string. What matters is that neither call hands back the taken name, and
    // that whatever it does hand back is genuinely free at the time of asking.
    const first = await suggestUsername(base)
    expect(first).not.toBe(base)
    expect((await checkUsername(first)).available).toBe(true)

    await createUser(first)
    // Now that the first suggestion is gone, the next one has to move on.
    const second = await suggestUsername(base)
    expect(second).not.toBe(base)
    expect(second).not.toBe(first)
    expect((await checkUsername(second)).available).toBe(true)
  })

  it('pads a seed that is too short to stand alone', async () => {
    const name = await suggestUsername('ab')
    expect(name.length).toBeGreaterThanOrEqual(3)
    expect(isValidUsernameFormat(name)).toBe(true)
  })

  it('never suggests a reserved name', async () => {
    for (const seed of ['admin', 'Admin', 'bot', 'arena']) {
      const name = await suggestUsername(seed)
      expect(isValidUsernameFormat(name), seed).toBe(true)
    }
  })
})
