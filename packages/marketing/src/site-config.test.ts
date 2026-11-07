import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadSiteConfig, siteConfigPath } from './load-config'
import { publicConfigJson, resolveSiteConfig } from './site-config'

const PLAYER = 'https://downloads.snookerstake.com/snooker-stake.apk'
const SITE = 'https://play.snookerstake.com'

describe('site config', () => {
  it('ships with both urls blank', () => {
    const raw = JSON.parse(readFileSync(siteConfigPath(), 'utf8')) as { siteUrl: string; apkUrl: string }
    expect(raw.siteUrl).toBe('')
    expect(raw.apkUrl).toBe('')
  })

  it('loads the blank file as an unpublished site', () => {
    const previousSite = process.env.SNOOKER_SITE_URL
    const previousApk = process.env.SNOOKER_APK_URL
    delete process.env.SNOOKER_SITE_URL
    delete process.env.SNOOKER_APK_URL
    try {
      const config = loadSiteConfig()
      expect(config.siteUrl).toBeNull()
      expect(config.apkUrl).toBeNull()
      expect(config.warnings).toEqual([])
    } finally {
      if (previousSite === undefined) delete process.env.SNOOKER_SITE_URL
      else process.env.SNOOKER_SITE_URL = previousSite
      if (previousApk === undefined) delete process.env.SNOOKER_APK_URL
      else process.env.SNOOKER_APK_URL = previousApk
    }
  })

  it('accepts a real https origin and a player apk', () => {
    const config = resolveSiteConfig({ siteUrl: `${SITE}/`, apkUrl: PLAYER }, { strict: true })
    expect(config.siteUrl).toBe(SITE)
    expect(config.apkUrl).toBe(PLAYER)
    expect(publicConfigJson(config)).toContain(PLAYER)
  })

  it('refuses localhost, example domains, and bare IPs', () => {
    for (const siteUrl of ['http://localhost:5173', 'https://example.com', 'https://www.example.com', 'https://127.0.0.1', 'https://10.0.0.8']) {
      expect(() => resolveSiteConfig({ siteUrl, apkUrl: '' }, { strict: true })).toThrow(/siteUrl/)
    }
  })

  it('refuses a staff apk and a url that is not an apk file', () => {
    expect(() =>
      resolveSiteConfig({ siteUrl: '', apkUrl: 'https://expo.dev/builds/snookerarena-admin.apk' }, { strict: true })
    ).toThrow(/staff app/)
    expect(() =>
      resolveSiteConfig({ siteUrl: '', apkUrl: 'https://downloads.snookerstake.com/admin-app.apk' }, { strict: true })
    ).toThrow(/staff app/)
    expect(() =>
      resolveSiteConfig({ siteUrl: '', apkUrl: 'https://downloads.snookerstake.com/get' }, { strict: true })
    ).toThrow(/\.apk/)
    expect(() => resolveSiteConfig({ siteUrl: '', apkUrl: 'http://downloads.snookerstake.com/app.apk' }, { strict: true })).toThrow(/https/)
  })

  it('drops a bad apk in the browser instead of linking it', () => {
    const config = resolveSiteConfig({
      siteUrl: SITE,
      apkUrl: 'https://cdn.snookerstake.com/com.snookerarena.admin.apk'
    })
    expect(config.siteUrl).toBe(SITE)
    expect(config.apkUrl).toBeNull()
    expect(config.warnings.join(' ')).toMatch(/staff app/)
  })
})
