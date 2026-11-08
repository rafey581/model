import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { applyDocument, pageFromFilename, renderPageBody } from './render'
import type { SiteConfig } from './site-config'

const blank: SiteConfig = { siteUrl: null, apkUrl: null, warnings: [] }
const shell = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'rules.html'), 'utf8')

const pages = ['rules', 'ledger', 'policies'] as const

describe('rules, balance, and draft policies', () => {
  const documents = Object.fromEntries(pages.map((page) => [page, applyDocument(shell, page, blank)])) as Record<
    (typeof pages)[number],
    string
  >

  it('names the pages from their files', () => {
    expect(pageFromFilename('/tmp/rules.html', '/rules.html')).toBe('rules')
    expect(pageFromFilename('/tmp/ledger.html', '')).toBe('ledger')
    expect(pageFromFilename('', '/policies.html')).toBe('policies')
    expect(pageFromFilename('/tmp/index.html', '/')).toBe('home')
  })

  it('links the new pages from each other and keeps one h1', () => {
    for (const html of Object.values(documents)) {
      expect(html.match(/<h1>/g)).toHaveLength(1)
      expect(html).toContain('href="/rules.html"')
      expect(html).toContain('href="/ledger.html"')
      expect(html).toContain('href="/policies.html"')
      expect(html).toContain('content="noindex, follow"')
      expect(html).not.toContain('rel="canonical"')
      expect(html).not.toMatch(/earn money/i)
      expect(html).not.toContain('7oK51mdQkub5kMsZoTMFRVpcsfcNvrGKTigu9wWbvMyR')
      expect(html).not.toContain('aggregateRating')
      expect(html).not.toContain('"offers"')
    }
  })

  it('describes the implemented table, not a full official rulebook', () => {
    const rules = documents.rules
    expect(rules).toContain('no free ball')
    expect(rules).toContain('6 reds')
    expect(rules).toContain('10 reds')
    expect(rules).toContain('only inside the D')
    expect(rules).toContain('at least 4')
    expect(rules).toContain('plays the shot again')
    expect(rules).toContain('30 seconds')
    expect(rules).toContain('not a 15-red frame')
  })

  it('keeps deposits and withdrawals conditional and not offered here', () => {
    const ledger = documents.ledger
    expect(ledger).toContain('does not take deposits')
    expect(ledger).toContain('not offered here')
    expect(ledger).toContain('answer 403')
    expect(ledger).toContain('answer 501')
    expect(ledger).toContain('after approval, not before')
    expect(ledger).toContain('Do not send')
    expect(ledger).not.toContain('processing time')
    expect(renderPageBody('ledger', blank)).not.toContain('href="http')
  })

  it('labels unfinished legal terms as a draft and records the age check', () => {
    const policies = documents.policies
    expect(policies).toContain('Draft for the owner')
    expect(policies).toContain('younger than 18')
    expect(policies).toContain('does not describe a separate identity document')
    expect(policies).toContain('third-party analytics')
    expect(policies).toContain('retention period')
    expect(policies).toContain('No company')
    expect(policies).not.toMatch(/mailto:|@[a-z0-9.-]+\.[a-z]{2,}/i)
  })
})
