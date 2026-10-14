import { describe, expect, it } from 'vitest'
import {
  formatAmount,
  formatDate,
  formatDateTime,
  formatRelative,
  formatSignedAmount,
  humanize,
  jsonSummary,
  shortId,
  truncate
} from './format'

describe('formatAmount', () => {
  it('trims trailing zeros from decimal strings', () => {
    expect(formatAmount('12.500000')).toBe('12.5')
    expect(formatAmount('10.000000')).toBe('10')
  })

  it('keeps meaningful decimals', () => {
    expect(formatAmount('0.500000')).toBe('0.5')
    expect(formatAmount('1.234567')).toBe('1.234567')
  })

  it('renders zero, null and undefined as "0"', () => {
    expect(formatAmount(0)).toBe('0')
    expect(formatAmount(null)).toBe('0')
    expect(formatAmount(undefined)).toBe('0')
    expect(formatAmount('')).toBe('0')
  })

  it('passes non-numeric strings through unchanged', () => {
    expect(formatAmount('not a number')).toBe('not a number')
  })
})

describe('formatSignedAmount', () => {
  it('adds a plus to positives and keeps the minus on negatives', () => {
    expect(formatSignedAmount(5)).toBe('+5')
    expect(formatSignedAmount(-5)).toBe('-5')
  })

  it('does not sign zero', () => {
    expect(formatSignedAmount(0)).toBe('0')
  })
})

describe('formatDateTime and formatDate', () => {
  it('turns an ISO timestamp into a readable pair', () => {
    expect(formatDateTime('2026-10-14T09:31:05.000Z')).toBe('2026-10-14 09:31:05')
    expect(formatDate('2026-10-14T09:31:05.000Z')).toBe('2026-10-14')
  })

  it('returns a dash for missing or invalid values', () => {
    expect(formatDateTime(null)).toBe('-')
    expect(formatDateTime(undefined)).toBe('-')
    expect(formatDate(null)).toBe('-')
  })
})

describe('formatRelative', () => {
  const now = Date.parse('2026-10-14T09:31:00.000Z')

  it('rounds to the nearest sensible unit', () => {
    expect(formatRelative('2026-10-14T09:30:30.000Z', now)).toBe('30s ago')
    expect(formatRelative('2026-10-14T09:30:00.000Z', now)).toBe('1m ago')
    expect(formatRelative('2026-10-14T07:31:00.000Z', now)).toBe('2h ago')
    expect(formatRelative('2026-10-12T09:31:00.000Z', now)).toBe('2d ago')
  })

  it('returns a dash for missing input', () => {
    expect(formatRelative(null, now)).toBe('-')
  })
})

describe('shortId', () => {
  it('cuts long ids to the requested length', () => {
    expect(shortId('abcdefghijkl', 4)).toBe('abcd')
  })

  it('leaves short ids intact and dashes missing ones', () => {
    expect(shortId('abc', 8)).toBe('abc')
    expect(shortId(null)).toBe('-')
  })
})

describe('truncate', () => {
  it('adds an ellipsis only when it cut something', () => {
    expect(truncate('hello world', 5)).toBe('hello...')
    expect(truncate('hi', 5)).toBe('hi')
  })
})

describe('jsonSummary', () => {
  it('serialises values for a table cell', () => {
    expect(jsonSummary({ a: 1 })).toBe('{"a":1}')
  })

  it('caps the length', () => {
    expect(jsonSummary({ a: 'x'.repeat(50) }, 10)).toHaveLength(13)
  })

  it('returns an empty string for nothing', () => {
    expect(jsonSummary(null)).toBe('')
    expect(jsonSummary(undefined)).toBe('')
  })
})

describe('humanize', () => {
  it('turns an enum into a sentence', () => {
    expect(humanize('MATCH_IN_PROGRESS')).toBe('Match in progress')
    expect(humanize('PENDING')).toBe('Pending')
  })

  it('dashes missing values', () => {
    expect(humanize(null)).toBe('-')
  })
})
