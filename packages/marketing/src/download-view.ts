import { escapeHtml } from './html'
import type { SiteConfig } from './site-config'

export type DownloadVariant = 'hero' | 'header' | 'install' | 'final' | 'sticky'

function apkLink(config: SiteConfig, label: string, className: string): string {
  const href = escapeHtml(config.apkUrl ?? '')
  return `<a class="${className}" data-apk="true" href="${href}" rel="noopener noreferrer">${escapeHtml(label)}</a>`
}

/**
 * Download UI for one slot.
 * An unconfigured APK renders status text and in-page links only.
 * It never points at "#" and never pretends a file is attached.
 */
export function renderDownload(config: SiteConfig, variant: DownloadVariant): string {
  const ready = Boolean(config.apkUrl)
  if (variant === 'header') {
    if (!ready) return `<a class="btn btn-small" href="#install">Install</a>`
    return apkLink(config, 'Download', 'btn btn-small')
  }
  if (variant === 'sticky') {
    if (!ready) return `<a class="btn btn-small" href="#install">Install notes</a>`
    return apkLink(config, 'Download', 'btn btn-small')
  }
  if (!ready) {
    const lead =
      variant === 'install'
        ? 'The Android download is not published on this site yet. There is no file to install.'
        : 'The Android download is not published on this site yet.'
    const action =
      variant === 'install'
        ? ''
        : `<a class="btn" href="#install">Read the install steps</a>`
    return `<div class="download" data-state="unavailable"><p class="status" role="status">${lead}</p>${action}</div>`
  }
  const note = `<p class="note">Player app for Android, package com.snookerx.game. This is not a Google Play listing. Your phone will ask before it installs an app from the browser.</p>`
  return `<div class="download" data-state="ready">${apkLink(config, 'Download for Android', 'btn')}${note}</div>`
}
