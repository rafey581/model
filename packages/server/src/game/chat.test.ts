import { describe, expect, it } from 'vitest'
import { MATCH_CHAT_PHRASES, MATCH_CHAT_COOLDOWN_MS, isMatchChatPhrase, matchChatPhraseText } from '@snooker/shared'

describe('match quick chat phrases', () => {
  it('has unique ids that are all the server will accept', () => {
    const ids = MATCH_CHAT_PHRASES.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const phrase of MATCH_CHAT_PHRASES) {
      expect(phrase.id).toMatch(/^[a-z]{2,8}$/)
      expect(phrase.text.trim().length).toBeGreaterThan(0)
      // Short enough to render inline as one chip, whatever the locale does to it.
      expect(phrase.text.length).toBeLessThanOrEqual(24)
    }
  })

  it('recognises only whitelisted ids and maps them back to their text', () => {
    for (const phrase of MATCH_CHAT_PHRASES) {
      expect(isMatchChatPhrase(phrase.id)).toBe(true)
      expect(matchChatPhraseText(phrase.id)).toBe(phrase.text)
    }
    // The wire protocol is ids, never free text: anything else is refused.
    expect(isMatchChatPhrase('')).toBe(false)
    expect(isMatchChatPhrase('gg; drop table users')).toBe(false)
    expect(isMatchChatPhrase('Have a nice day')).toBe(false)
    expect(isMatchChatPhrase('gg2')).toBe(false)
  })

  it('keeps a sane cooldown so the channel cannot be spammed', () => {
    expect(MATCH_CHAT_COOLDOWN_MS).toBeGreaterThanOrEqual(500)
    expect(MATCH_CHAT_COOLDOWN_MS).toBeLessThanOrEqual(5000)
  })
})