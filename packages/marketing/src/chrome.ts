import { APP_NAME, PACKAGE_ID } from './content'
import { renderDownload, type DownloadVariant } from './download-view'
import { escapeHtml } from './html'
import type { SiteConfig } from './site-config'

export type SitePage = 'home' | 'rules' | 'ledger' | 'policies'

const LINKS: ReadonlyArray<{ href: string; label: string; page: SitePage | 'install' }> = [
  { href: '/rules.html', label: 'Rules', page: 'rules' },
  { href: '/ledger.html', label: 'Balance', page: 'ledger' },
  { href: '/policies.html', label: 'Policies', page: 'policies' },
  { href: '/#install', label: 'Install', page: 'install' }
]

function slot(variant: DownloadVariant, config: SiteConfig, anchor = false): string {
  const anchorAttr = anchor ? ` data-cta-anchor="${variant}"` : ''
  const sig = escapeHtml(config.apkUrl ? `ready:${config.apkUrl}` : 'unavailable')
  return `<div data-download-slot="${variant}" data-sig="${sig}"${anchorAttr}>${renderDownload(config, variant)}</div>`
}

export function siteHeader(config: SiteConfig, page: SitePage): string {
  const homeLinks =
    page === 'home'
      ? `<a href="#table">The table</a><a href="#how">How to play</a><a href="#faq">Questions</a>`
      : `<a href="/">Home</a>`
  const siteLinks = LINKS.map((link) => {
    const current = link.page === page ? ' aria-current="page"' : ''
    return `<a href="${link.href}"${current}>${link.label}</a>`
  }).join('')
  const brandHref = page === 'home' ? '#play' : '/'
  return `<a class="skip" href="#content">Skip to content</a>
    <header class="site-header">
      <a class="brand" href="${brandHref}">
        <svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r="12" fill="#0e6b45"/>
          <circle cx="16" cy="16" r="12" fill="none" stroke="#d5dbe0" stroke-width="1.4"/>
          <circle cx="20" cy="13" r="3" fill="#d32632"/>
        </svg>
        <span>Snooker Stake</span>
      </a>
      <nav class="nav" aria-label="Site">
        <button type="button" class="menu-btn" aria-expanded="false" aria-controls="site-nav">Menu</button>
        <div id="site-nav" class="nav-links">
          ${homeLinks}
          ${siteLinks}
        </div>
      </nav>
      ${slot('header', config)}
    </header>`
}

export function siteFooter(): string {
  return `<footer class="site-footer">
      <div class="wrap footer-grid">
        <div>
          <p><strong>${escapeHtml(APP_NAME)}</strong> · player app <span class="mono">${escapeHtml(PACKAGE_ID)}</span></p>
          <p>Virtual in-app play. This site does not take payments or pay winnings.</p>
        </div>
        <nav class="footer-nav" aria-label="More">
          <a href="/rules.html">Rules of the table</a>
          <a href="/ledger.html">Virtual balance</a>
          <a href="/policies.html">Policies (draft)</a>
          <a href="/#install">Android install</a>
        </nav>
      </div>
    </footer>`
}

export function docHero(eyebrow: string, title: string, lede: string, quote: string): string {
  return `<header class="doc-hero">
      <div class="wrap narrow">
        <p class="eyebrow">${escapeHtml(eyebrow)}</p>
        <h1>${title}</h1>
        <blockquote class="pull"><p>${escapeHtml(quote)}</p></blockquote>
        <p class="lede">${lede}</p>
      </div>
    </header>`
}
