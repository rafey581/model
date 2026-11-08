import {
  APP_NAME,
  COLOUR_BALLS,
  CONTROL_STEPS,
  FAQS,
  INSTALL_STEPS,
  MIN_ANDROID,
  MIN_SDK,
  PACKAGE_ID,
  PAGE_DESCRIPTION,
  PAGE_TITLE,
  RULES,
  START_STEPS,
  type Step
} from './content'
import { siteFooter, siteHeader, type SitePage } from './chrome'
import { renderDownload, type DownloadVariant } from './download-view'
import { escapeHtml, safeJsonLd } from './html'
import { renderLedgerBody, renderPoliciesBody, renderRulesBody } from './pages'
import type { SiteConfig } from './site-config'

const SHARE_ALT = 'Snooker Stake wordmark over a green snooker table on charcoal, for the Android game.'

const PAGE_META: Record<SitePage, { path: string; title: string; description: string }> = {
  home: {
    path: '/',
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION
  },
  rules: {
    path: '/rules.html',
    title: 'Rules of the table — Snooker Stake',
    description:
      'How Snooker Stake actually plays: 6 or 10 reds, ball values, fouls from 4 to 7, the D, the shot clock, and a dropped connection. Not a full official rulebook.'
  },
  ledger: {
    path: '/ledger.html',
    title: 'Virtual balance — Snooker Stake',
    description:
      'Snooker Stake keeps an in-app virtual balance. This website does not take deposits or pay withdrawals. Real-money play is not offered here.'
  },
  policies: {
    path: '/policies.html',
    title: 'Draft policies — Snooker Stake',
    description:
      'Draft notes on accounts, fair play, privacy, and terms for Snooker Stake. The legal entity, licence, and contact details are still open.'
  }
}

function steps(items: readonly Step[], className: string, level: 'h3' | 'h4'): string {
  const lis = items
    .map(
      (step) =>
        `<li><${level}>${escapeHtml(step.title)}</${level}><p>${escapeHtml(step.body)}</p></li>`
    )
    .join('')
  return `<ol class="${className}">${lis}</ol>`
}

function slot(variant: DownloadVariant, config: SiteConfig, anchor = false): string {
  const anchorAttr = anchor ? ` data-cta-anchor="${variant}"` : ''
  const sig = escapeHtml(config.apkUrl ? `ready:${config.apkUrl}` : 'unavailable')
  return `<div data-download-slot="${variant}" data-sig="${sig}"${anchorAttr}>${renderDownload(config, variant)}</div>`
}

function tableFallback(): string {
  return `<div class="table-fallback" aria-hidden="true">
    <svg class="table-svg" viewBox="0 0 900 640" preserveAspectRatio="xMidYMid slice">
      <defs>
        <radialGradient id="room" cx="50%" cy="38%" r="70%">
          <stop offset="0%" stop-color="#1a221c"/>
          <stop offset="70%" stop-color="#0c0f0c"/>
          <stop offset="100%" stop-color="#070807"/>
        </radialGradient>
        <linearGradient id="felt" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#1a8f62"/>
          <stop offset="55%" stop-color="#0e6b45"/>
          <stop offset="100%" stop-color="#0a4a32"/>
        </linearGradient>
        <linearGradient id="rail" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#6d5138"/>
          <stop offset="50%" stop-color="#3a2a1d"/>
          <stop offset="100%" stop-color="#24180f"/>
        </linearGradient>
        <linearGradient id="cue" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#6a4324"/>
          <stop offset="78%" stop-color="#e6d2b5"/>
          <stop offset="90%" stop-color="#f4f7f8"/>
          <stop offset="100%" stop-color="#8e99a1"/>
        </linearGradient>
        <radialGradient id="g-red" cx="35%" cy="32%" r="70%">
          <stop offset="0%" stop-color="#ffb4b4"/><stop offset="45%" stop-color="#d32632"/><stop offset="100%" stop-color="#5c1016"/>
        </radialGradient>
        <radialGradient id="g-yellow" cx="35%" cy="32%" r="70%">
          <stop offset="0%" stop-color="#fff1b0"/><stop offset="50%" stop-color="#e2b423"/><stop offset="100%" stop-color="#7a5a10"/>
        </radialGradient>
        <radialGradient id="g-green" cx="35%" cy="32%" r="70%">
          <stop offset="0%" stop-color="#b7f0c8"/><stop offset="50%" stop-color="#1f8a43"/><stop offset="100%" stop-color="#0c3d20"/>
        </radialGradient>
        <radialGradient id="g-brown" cx="35%" cy="32%" r="70%">
          <stop offset="0%" stop-color="#e0b48a"/><stop offset="50%" stop-color="#7a3e12"/><stop offset="100%" stop-color="#3a1c08"/>
        </radialGradient>
        <radialGradient id="g-blue" cx="35%" cy="32%" r="70%">
          <stop offset="0%" stop-color="#c5d4ff"/><stop offset="50%" stop-color="#2450b0"/><stop offset="100%" stop-color="#101e48"/>
        </radialGradient>
        <radialGradient id="g-pink" cx="35%" cy="32%" r="70%">
          <stop offset="0%" stop-color="#ffe0ea"/><stop offset="50%" stop-color="#e7a0b4"/><stop offset="100%" stop-color="#8a4d5c"/>
        </radialGradient>
        <radialGradient id="g-black" cx="35%" cy="32%" r="70%">
          <stop offset="0%" stop-color="#8a9096"/><stop offset="40%" stop-color="#1a1c1e"/><stop offset="100%" stop-color="#050506"/>
        </radialGradient>
        <radialGradient id="g-cue" cx="35%" cy="32%" r="70%">
          <stop offset="0%" stop-color="#ffffff"/><stop offset="55%" stop-color="#f3efe4"/><stop offset="100%" stop-color="#b7b1a4"/>
        </radialGradient>
        <linearGradient id="chrome" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#f7fbfc"/><stop offset="50%" stop-color="#9aa6ae"/><stop offset="100%" stop-color="#e6ecef"/>
        </linearGradient>
      </defs>
      <rect width="900" height="640" fill="url(#room)"/>
      <polygon points="90,168 810,168 730,548 170,548" fill="url(#rail)"/>
      <polygon points="128,196 772,196 706,522 194,522" fill="url(#felt)"/>
      <g fill="#070808">
        <circle cx="150" cy="214" r="16"/><circle cx="750" cy="214" r="16"/>
        <circle cx="450" cy="188" r="14"/><circle cx="450" cy="530" r="14"/>
        <circle cx="214" cy="504" r="16"/><circle cx="686" cy="504" r="16"/>
      </g>
      <g>
        <circle cx="250" cy="430" r="13" fill="url(#g-yellow)"/>
        <circle cx="450" cy="430" r="13" fill="url(#g-brown)"/>
        <circle cx="650" cy="430" r="13" fill="url(#g-green)"/>
        <circle cx="450" cy="340" r="13" fill="url(#g-blue)"/>
        <circle cx="450" cy="268" r="13" fill="url(#g-pink)"/>
        <circle cx="450" cy="228" r="13" fill="url(#g-black)"/>
        <circle cx="430" cy="286" r="12" fill="url(#g-red)"/>
        <circle cx="452" cy="298" r="12" fill="url(#g-red)"/>
        <circle cx="474" cy="286" r="12" fill="url(#g-red)"/>
        <circle cx="418" cy="310" r="12" fill="url(#g-red)"/>
        <circle cx="440" cy="322" r="12" fill="url(#g-red)"/>
        <circle cx="462" cy="310" r="12" fill="url(#g-red)"/>
        <circle cx="390" cy="470" r="14" fill="url(#g-cue)"/>
      </g>
      <line x1="120" y1="560" x2="372" y2="478" stroke="url(#cue)" stroke-width="7" stroke-linecap="round"/>
    </svg>
  </div>`
}

function structuredData(config: SiteConfig, page: SitePage): unknown {
  if (page !== 'home') {
    const meta = PAGE_META[page]
    const webPage: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: meta.title,
      description: meta.description
    }
    if (config.siteUrl) webPage.url = `${config.siteUrl}${meta.path}`
    return webPage
  }
  const app: Record<string, unknown> = {
    '@type': 'SoftwareApplication',
    name: APP_NAME,
    applicationCategory: 'GameApplication',
    operatingSystem: 'Android',
    description: PAGE_DESCRIPTION,
    featureList:
      'Robot practice on Easy, Medium, and Hard; real-time 1v1 invitations; 8-player knockout; 6-red and 10-red frames; server-run snooker rules; virtual in-app balance'
  }
  if (config.siteUrl) app.url = `${config.siteUrl}/`
  if (config.apkUrl) app.installUrl = config.apkUrl
  if (config.siteUrl) app.image = `${config.siteUrl}/og.png`
  return {
    '@context': 'https://schema.org',
    '@graph': [
      app,
      {
        '@type': 'FAQPage',
        mainEntity: FAQS.map((faq) => ({
          '@type': 'Question',
          name: faq.question,
          acceptedAnswer: { '@type': 'Answer', text: faq.answer }
        }))
      }
    ]
  }
}

export function renderHead(config: SiteConfig, page: SitePage = 'home'): string {
  const meta = PAGE_META[page]
  const title = escapeHtml(meta.title)
  const description = escapeHtml(meta.description)
  const canonical = config.siteUrl
    ? `<link rel="canonical" href="${escapeHtml(`${config.siteUrl}${meta.path}`)}">`
    : '<!-- Indexing stays off until siteUrl is set in site.config.json. See README. -->'
  const robots = config.siteUrl
    ? 'index, follow, max-image-preview:large'
    : 'noindex, follow'
  const image = config.siteUrl ? `${config.siteUrl}/og.png` : ''
  const socialImage = image
    ? `<meta property="og:image" content="${escapeHtml(image)}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="${escapeHtml(SHARE_ALT)}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:image" content="${escapeHtml(image)}">
    <meta name="twitter:image:alt" content="${escapeHtml(SHARE_ALT)}">`
    : `<meta name="twitter:card" content="summary">`
  const ogUrl = config.siteUrl ? `<meta property="og:url" content="${escapeHtml(`${config.siteUrl}${meta.path}`)}">` : ''
  return `<title>${title}</title>
    <meta name="description" content="${description}">
    <meta name="robots" content="${robots}">
    <meta name="theme-color" content="#090b09">
    <meta name="application-name" content="${escapeHtml(APP_NAME)}">
    ${canonical}
    <meta property="og:type" content="website">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:site_name" content="${escapeHtml(APP_NAME)}">
    ${ogUrl}
    ${socialImage}
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    <script type="application/ld+json">${safeJsonLd(structuredData(config, page))}</script>`
}

export function renderBody(config: SiteConfig): string {
  const colours = COLOUR_BALLS.map(
    (ball) =>
      `<li><span class="swatch ${ball.swatch}" aria-hidden="true"></span><span>${escapeHtml(ball.name)}</span><b>${escapeHtml(ball.value)}</b></li>`
  ).join('')
  const faqs = FAQS.map(
    (faq) =>
      `<details><summary>${escapeHtml(faq.question)}</summary><p>${escapeHtml(faq.answer)}</p></details>`
  ).join('')
  return `<div class="scroll-cue" aria-hidden="true"><span></span></div>
    <div class="vignette" aria-hidden="true"></div>
    <div class="page">
      ${siteHeader(config, 'home')}
      <main id="content">
        <section class="hero scene-window" id="play" data-scene="0">
          ${tableFallback()}
          <div class="hero-copy">
            <p class="eyebrow">Android player app</p>
            <h1>A full frame,<br><em>in your pocket.</em></h1>
            <p class="lede">Snooker Stake is a 3D snooker game for Android. Aim along the cloth, set the power, put spin on the cue ball, and the server plays the shot back. Practise against a robot, invite a friend, or offer the table to whoever is online.</p>
            <blockquote class="pull"><p>Play snooker. Sharpen your skills. Own the table.</p></blockquote>
            ${slot('hero', config, true)}
            <p class="fine">Package ${escapeHtml(PACKAGE_ID)}. Stakes inside the app are a virtual balance. This site does not take payments.</p>
          </div>
        </section>

        <section class="cloth scene-window" id="table" data-scene="0.38">
          <div class="cloth-copy">
            <p class="eyebrow">The cloth</p>
            <h2>Six reds to learn the table. Ten when it gets serious.</h2>
            <p>Practice, and any match staked below 100 on the in-app balance, is a six-red frame. From 100 up, including every Master Match, the rack is ten reds. The six colours stay with the frame either way. A red is one point. There is no free ball.</p>
            <ol class="colours">${colours}</ol>
          </div>
        </section>

        <section class="ways" id="ways">
          <div class="wrap">
            <p class="eyebrow">One engine</p>
            <h2>Three ways onto the table.</h2>
            <p class="intro">Practice, a live invitation, and an eight-player knockout all use the same table. The robot never fills in for a person on a competitive match.</p>
            <article class="mode">
              <p class="idx">01</p>
              <div>
                <h3>Practice</h3>
                <p>Play the computer on Easy, Medium, or Hard. Nothing is staked. If your in-app balance is zero, practice stops after three matches that day. With a balance above zero, that cap is not applied.</p>
              </div>
            </article>
            <article class="mode">
              <p class="idx">02</p>
              <div>
                <h3>A live opponent</h3>
                <p>Open a table and it is offered to players who are connected, for about 90 seconds, or send it to one friend. Nothing is held on your balance while you wait. Both stakes lock only when someone accepts. Choose one frame, best of 3, or best of 5.</p>
                <p>Open tables are 1, 5, 10, 20, 50, or 100 on the in-app balance. Master Match is 500, 1000, 2000, 3000, or 5000. The app labels that unit USDT. It is the stake inside the game, not a payment this website can take or send.</p>
              </div>
            </article>
            <article class="mode">
              <p class="idx">03</p>
              <div>
                <h3>Eight-player cup</h3>
                <p>A tournament starts when the eighth person joins, then plays quarters, semis, and a final. New tournaments default to best of 3 and an entry of zero. Bots cannot take a seat.</p>
              </div>
            </article>
            <p class="aside">This website does not accept deposits, process withdrawals, or pay cash. An in-app balance is for play inside Snooker Stake. The conditional manual flow, and why it is not offered here, is on the <a href="/ledger.html">balance page</a>.</p>
          </div>
        </section>

        <section class="how" id="how">
          <div class="wrap block">
            <p class="eyebrow">Get started</p>
            <h2>From an empty phone to the first shot.</h2>
            ${steps(START_STEPS, 'timeline', 'h3')}
          </div>
          <div class="how-band">
            <div class="how-copy block">
              <h3 class="subhead">How a visit works</h3>
              <p>The phone is the table. These are the controls the game actually uses.</p>
              ${steps(CONTROL_STEPS, 'sheet', 'h4')}
              <p class="fine">Table sounds and the background music can each be muted in settings. Graphics quality is automatic, and you can pin Low, Medium, or High for the next match.</p>
            </div>
            <div class="how-window scene-window" data-scene="0.72">
              <div class="mini-table" aria-hidden="true">
                <span class="mini-felt"></span>
                <span class="mini-caption">Table view</span>
              </div>
            </div>
          </div>
          <div class="wrap block">
            <h3 class="subhead">The rules this table plays</h3>
            <p>Written for this game, including what it does not do. A free ball is not part of the table. The longer version is on the <a href="/rules.html">rules page</a>.</p>
            ${steps(RULES, 'sheet rules', 'h4')}
          </div>
        </section>

        <section class="install" id="install">
          <div class="wrap narrow">
            <p class="eyebrow">Android</p>
            <h2>Put Snooker Stake on a phone.</h2>
            <p>The player app is package <span class="mono">${escapeHtml(PACKAGE_ID)}</span>. The project’s minimum SDK is ${MIN_SDK} (Android ${escapeHtml(MIN_ANDROID)}). These steps are for a sideloaded APK. They are not a Play Store install, and they are not a claim that anyone has scanned the file.</p>
            ${slot('install', config, true)}
            ${steps(INSTALL_STEPS, 'sheet', 'h3')}
            <p class="fine">No file size and no version number are shown here. Those belong to a real signed APK, and this page will not invent them. When you publish one, set its https address in the site config and rebuild.</p>
          </div>
        </section>

        <section class="faq" id="faq">
          <div class="wrap narrow">
            <p class="eyebrow">Questions</p>
            <h2>Before you install.</h2>
            <div class="faq-list">${faqs}</div>
          </div>
        </section>

        <section class="closing" id="download">
          <div class="closing-window scene-window" data-scene="1" aria-hidden="true"></div>
          <div class="wrap closing-copy">
            <p class="eyebrow">Download</p>
            <h2>Take the table with you.</h2>
            <p class="lede">Your next great break starts here. The same aim, power, and spin, on Android. When a player file is published, the button is that APK and nothing else.</p>
            ${slot('final', config, true)}
          </div>
        </section>
      </main>
      ${siteFooter()}
    </div>
    <div class="sticky-cta" data-download-slot="sticky" data-sig="${escapeHtml(config.apkUrl ? `ready:${config.apkUrl}` : 'unavailable')}">${renderDownload(config, 'sticky')}</div>`
}

export function pageFromFilename(filename: string, path = ''): SitePage {
  const id = `${filename} ${path}`
  if (id.includes('rules.html')) return 'rules'
  if (id.includes('ledger.html')) return 'ledger'
  if (id.includes('policies.html')) return 'policies'
  return 'home'
}

export function renderPageBody(page: SitePage, config: SiteConfig): string {
  if (page === 'rules') return renderRulesBody(config)
  if (page === 'ledger') return renderLedgerBody(config)
  if (page === 'policies') return renderPoliciesBody(config)
  return renderBody(config)
}

export function applyDocument(shell: string, page: SitePage, config: SiteConfig): string {
  if (!shell.includes('<!--head:inject-->') || !shell.includes('<!--body:inject-->')) {
    throw new Error('page shell is missing inject markers')
  }
  return shell.replace('<!--head:inject-->', renderHead(config, page)).replace('<!--body:inject-->', renderPageBody(page, config))
}

export function applyTemplate(shell: string, config: SiteConfig): string {
  return applyDocument(shell, 'home', config)
}

export function robotsTxt(config: SiteConfig): string {
  const lines = ['User-agent: *', 'Allow: /', '']
  if (config.siteUrl) lines.push(`Sitemap: ${config.siteUrl}/sitemap.xml`, '')
  return lines.join('\n')
}

export function sitemapXml(config: SiteConfig, now = new Date()): string | null {
  if (!config.siteUrl) return null
  const day = now.toISOString().slice(0, 10)
  const paths = ['/', '/rules.html', '/ledger.html', '/policies.html']
  const urls = paths
    .map(
      (path) => `  <url>
    <loc>${config.siteUrl}${path}</loc>
    <lastmod>${day}</lastmod>
  </url>`
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`
}
