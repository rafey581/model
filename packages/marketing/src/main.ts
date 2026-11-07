import { renderDownload, type DownloadVariant } from './download-view'
import { menuOpenAfterKey, shouldShowSticky, webglMode, type WebGLMode } from './motion'
import { resolveSiteConfig, type SiteConfig } from './site-config'
import type { StageController } from './scene'

const root = document.documentElement
root.classList.add('js')

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
if (motionQuery.matches) root.classList.add('reduce-motion')

const menuButton = document.querySelector<HTMLButtonElement>('.menu-btn')
const nav = document.querySelector<HTMLElement>('#site-nav')

function setMenu(open: boolean): void {
  const wasOpen = root.classList.contains('nav-open')
  root.classList.toggle('nav-open', open)
  menuButton?.setAttribute('aria-expanded', open ? 'true' : 'false')
  if (menuButton) menuButton.textContent = open ? 'Close' : 'Menu'
  syncSticky()
  if (open) nav?.querySelector<HTMLAnchorElement>('a')?.focus()
  else if (wasOpen) menuButton?.focus()
}

menuButton?.addEventListener('click', () => {
  setMenu(!root.classList.contains('nav-open'))
})

document.addEventListener('keydown', (event) => {
  const next = menuOpenAfterKey(root.classList.contains('nav-open'), event.key)
  if (next === false) {
    event.preventDefault()
    setMenu(false)
  }
})

document.addEventListener('pointerdown', (event) => {
  if (!root.classList.contains('nav-open')) return
  const target = event.target
  if (!(target instanceof Node)) return
  if (menuButton?.contains(target) || nav?.contains(target)) return
  setMenu(false)
})

nav?.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => setMenu(false))
})

const header = document.querySelector<HTMLElement>('.site-header')
const cue = document.querySelector<HTMLElement>('.scroll-cue span')

function onScroll(): void {
  header?.classList.toggle('is-solid', window.scrollY > 12)
  if (!cue || root.classList.contains('reduce-motion')) return
  const max = document.documentElement.scrollHeight - window.innerHeight
  const progress = max <= 0 ? 0 : Math.min(1, Math.max(0, window.scrollY / max))
  cue.style.transform = `scaleY(${progress})`
}

window.addEventListener('scroll', onScroll, { passive: true })
onScroll()

const heroAnchor = document.querySelector('[data-cta-anchor="hero"]')
const finalAnchor = document.querySelector('[data-cta-anchor="final"]')
const sticky = document.querySelector<HTMLElement>('.sticky-cta')
let heroVisible = true
let finalVisible = false

function stickyWouldCover(): boolean {
  const target = document.elementFromPoint(28, window.innerHeight - 24)
  if (!target || target.closest('.sticky-cta, .site-header')) return false
  return Boolean(target.closest('h1, h2, h3, h4, .colours, summary, .btn, .download'))
}

function syncSticky(): void {
  const narrow = window.matchMedia('(max-width: 760px)').matches
  const show =
    shouldShowSticky({
      narrow,
      heroVisible,
      finalVisible,
      menuOpen: root.classList.contains('nav-open')
    }) && !stickyWouldCover()
  sticky?.classList.toggle('is-on', show)
  root.classList.toggle('has-sticky', show)
}

const ctaObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (entry.target === heroAnchor) heroVisible = entry.isIntersecting
      if (entry.target === finalAnchor) finalVisible = entry.isIntersecting
    }
    syncSticky()
  },
  { threshold: 0.35 }
)
if (heroAnchor) ctaObserver.observe(heroAnchor)
if (finalAnchor) ctaObserver.observe(finalAnchor)
window.addEventListener('resize', syncSticky)
syncSticky()

function applyDownload(config: SiteConfig): void {
  document.querySelectorAll<HTMLElement>('[data-download-slot]').forEach((el) => {
    const variant = el.dataset.downloadSlot as DownloadVariant | undefined
    if (!variant) return
    const sig = config.apkUrl ? `ready:${config.apkUrl}` : 'unavailable'
    if (el.dataset.sig === sig) return
    el.innerHTML = renderDownload(config, variant)
    el.dataset.sig = sig
  })
}

async function refreshDownload(): Promise<void> {
  try {
    const response = await fetch('/site-config.json', { cache: 'no-store' })
    if (!response.ok) return
    const json: unknown = await response.json()
    if (!json || typeof json !== 'object') return
    const record = json as Record<string, unknown>
    const config = resolveSiteConfig({ siteUrl: record.siteUrl, apkUrl: record.apkUrl })
    for (const warning of config.warnings) console.warn(warning)
    applyDownload(config)
  } catch (error) {
    console.warn('Snooker Stake kept the built download state because site-config.json could not be read.', error)
  }
}

function hasWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

function currentMode(): WebGLMode {
  const params = new URLSearchParams(window.location.search)
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } }
  return webglMode({
    reducedMotion: motionQuery.matches || root.classList.contains('reduce-motion'),
    saveData: Boolean(nav.connection?.saveData),
    deviceMemoryGb: nav.deviceMemory,
    webgl: hasWebGL(),
    forcedStatic: params.get('static') === '1'
  })
}

let stage: StageController | null = null

async function mount(): Promise<void> {
  const mode = currentMode()
  if (mode === 'skip') return
  const mod = await import('./scene')
  stage = await mod.mountStage({ reducedMotion: mode === 'static-frame' })
}

motionQuery.addEventListener('change', () => {
  const reduced = motionQuery.matches
  root.classList.toggle('reduce-motion', reduced)
  stage?.setReducedMotion(reduced)
  onScroll()
})

void refreshDownload()

function scheduleMount(): void {
  const start = (): void => {
    void mount()
  }
  // The drawn table is the fallback until this runs, so the first paint is not
  // waiting on three.js. Idle keeps that work off the first interaction.
  const kick = (): void => {
    window.requestIdleCallback(start, { timeout: 1500 })
  }
  if (document.readyState === 'complete') kick()
  else window.addEventListener('load', kick, { once: true })
}

scheduleMount()
