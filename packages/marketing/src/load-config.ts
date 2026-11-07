import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSiteConfig, type SiteConfig } from './site-config'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Build-time config. Environment variables override the JSON file when they
 * are set (including to an empty string, which clears a value). Invalid values
 * fail the build.
 */
export function loadSiteConfig(): SiteConfig {
  const filePath = join(packageRoot, 'site.config.json')
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('site.config.json must be a JSON object with siteUrl and apkUrl.')
  }
  const record = parsed as Record<string, unknown>
  const siteUrl = process.env.SNOOKER_SITE_URL ?? record.siteUrl
  const apkUrl = process.env.SNOOKER_APK_URL ?? record.apkUrl
  return resolveSiteConfig({ siteUrl, apkUrl }, { strict: true })
}

export function siteConfigPath(): string {
  return join(packageRoot, 'site.config.json')
}
