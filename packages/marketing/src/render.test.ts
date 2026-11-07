import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { FAQS, PAGE_DESCRIPTION, PAGE_TITLE } from './content'
import { renderDownload } from './download-view'
import { applyTemplate, renderBody, renderHead, robotsTxt, sitemapXml } from './render'
import { resolveSiteConfig, type SiteConfig } from './site-config'

const blank: SiteConfig = { siteUrl: null, apkUrl: null, warnings: [] }
const live = resolveSiteConfig(
  {
    siteUrl: 'https://play.snookerstake.com',
    apkUrl: 'https://downloads.snookerstake.com/snooker-stake.apk'
  },
  { strict: true }
)

function documentFor(config: SiteConfig): string {
  const shell = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8')
  return applyTemplate(shell, config)
}

describe('download state', () => {
  it('says the file is not published and does not fake a download', () => {
    const html = renderBody(blank)
    expect(html).toContain('not published on this site yet')
    expect(html).not.toContain('data-apk')
    expect(html).not.toContain('href="#"')
    expect(html).not.toContain('href=""')
    const hero = renderDownload(blank, 'hero')
    expect(hero).toContain('href="#install"')
    expect(hero).not.toContain('Download for Android')
  })

  it('links only the configured player apk when one exists', () => {
    const html = renderBody(live)
    expect(html).toContain('href="https://downloads.snookerstake.com/snooker-stake.apk"')
    expect(html).toContain('data-apk="true"')
    expect(html).not.toContain('not published on this site yet')
    expect(html).not.toContain('snookerarena')
    expect(html).not.toContain('href="#"')
  })
})

describe('crawlable page', () => {
  const html = documentFor(blank)

  it('has one h1, the real package, and the rules the game actually plays', () => {
    expect(html.match(/<h1>/g)).toHaveLength(1)
    expect(html).toContain('A full frame,')
    expect(html).toContain('com.snookerx.game')
    expect(html).toContain('three matches')
    expect(html).toContain('does not award a free ball')
    expect(html).toContain('not a Google Play listing')
    expect(html).toContain('does not take payments')
    expect(PAGE_TITLE.length).toBeLessThanOrEqual(60)
    expect(PAGE_DESCRIPTION.length).toBeGreaterThan(80)
    expect(PAGE_DESCRIPTION.length).toBeLessThanOrEqual(160)
  })

  it('keeps in-page links pointed at real sections', () => {
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]))
    for (const match of html.matchAll(/href="#([^"]+)"/g)) {
      expect(ids.has(match[1])).toBe(true)
    }
  })

  it('does not publish a canonical, sitemap, or ratings before a domain exists', () => {
    expect(html).not.toContain('rel="canonical"')
    expect(html).not.toContain('example.com')
    expect(html).not.toContain('localhost')
    expect(html).toContain('content="noindex, follow"')
    expect(html).not.toContain('aggregateRating')
    expect(html).not.toContain('reviewCount')
    expect(html).not.toContain('"offers"')
    expect(html).not.toContain('price')
    expect(robotsTxt(blank)).not.toContain('Sitemap:')
    expect(sitemapXml(blank)).toBeNull()
    const json = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1]
    expect(json).toBeTruthy()
    const data = JSON.parse(json ?? '{}') as { '@graph': Array<Record<string, unknown>> }
    const questions = data['@graph'].find((node) => node['@type'] === 'FAQPage')
    const entities = questions?.mainEntity as Array<{ name: string }>
    expect(entities.map((item) => item.name)).toEqual(FAQS.map((faq) => faq.question))
  })

  it('turns indexing and the canonical on only for a configured origin', () => {
    const published = documentFor(live)
    expect(published).toContain('rel="canonical" href="https://play.snookerstake.com/"')
    expect(published).toContain('content="index, follow, max-image-preview:large"')
    expect(published).toContain('property="og:image" content="https://play.snookerstake.com/og.png"')
    expect(published).toContain('installUrl":"https://downloads.snookerstake.com/snooker-stake.apk"')
    expect(robotsTxt(live)).toContain('Sitemap: https://play.snookerstake.com/sitemap.xml')
    const map = sitemapXml(live, new Date('2026-11-07T00:00:00Z'))
    expect(map).toContain('<loc>https://play.snookerstake.com/</loc>')
    expect(map).toContain('<lastmod>2026-11-07</lastmod>')
    expect(renderHead(live)).not.toContain('noindex')
  })
})
