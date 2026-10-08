import { APP_TITLE } from '@snooker/shared'
import { BG_IMAGE, HOME_COPY } from './content.js'
import { el, isFinePointer } from './dom.js'
import { ICONS } from './icons.js'
import type { LobbyBridge, LobbyTab, LobbyView } from './types.js'

export interface ShellHandlers {
  onTab: (tab: LobbyTab) => void
  onSoundToggle: () => void
  onFullscreen: () => void
  onSettingsIcon: () => void
  onProfile: () => void
}

const TAB_TO_VIEW: Record<LobbyTab, LobbyView> = {
  play: 'home',
  statistics: 'statistics',
  settings: 'settings',
  info: 'info'
}

export function viewToTab(view: LobbyView): LobbyTab {
  if (view === 'setup' || view === 'home') return 'play'
  if (view === 'statistics') return 'statistics'
  if (view === 'settings') return 'settings'
  return 'info'
}

export function tabToView(tab: LobbyTab): LobbyView {
  return TAB_TO_VIEW[tab]
}

export function createBackground(): HTMLElement {
  const bg = el('div', 'gl-bg')
  bg.setAttribute('aria-hidden', 'true')
  const img = document.createElement('img')
  img.className = 'gl-bg__img'
  img.src = BG_IMAGE
  img.alt = ''
  img.decoding = 'async'
  bg.append(img, el('div', 'gl-bg__tint'), el('div', 'gl-bg__vignette'))
  return bg
}

export function createShell(
  bridge: LobbyBridge,
  view: LobbyView,
  handlers: ShellHandlers
): { root: HTMLElement; main: HTMLElement } {
  const root = el('div', 'gl-root')
  root.appendChild(createBackground())

  const shell = el('div', 'gl-shell')
  const top = el('div', 'gl-top')

  const brand = el('div', 'gl-brand')
  const mark = el('span', 'gl-brand__mark')
  mark.innerHTML = bridge.logoSvg
  const title = bridge.appTitle || APP_TITLE
  brand.append(mark, brandText(title))
  top.appendChild(brand)

  const hideTabs = view === 'statistics'
  if (!hideTabs) {
    const tabs = el('div', 'gl-tabs')
    tabs.setAttribute('role', 'tablist')
    tabs.setAttribute('aria-label', 'Lobby sections')
    const active = viewToTab(view)
    for (const [id, label] of [
      ['play', 'PLAY'],
      ['statistics', 'STATISTICS'],
      ['settings', 'SETTINGS'],
      ['info', 'INFO']
    ] as const) {
      const tab = el('button', 'gl-tab', label) as HTMLButtonElement
      tab.type = 'button'
      tab.setAttribute('role', 'tab')
      tab.id = `gl-tab-${id}`
      tab.setAttribute('aria-selected', String(id === active))
      tab.tabIndex = id === active ? 0 : -1
      tab.onclick = () => handlers.onTab(id)
      tabs.appendChild(tab)
    }
    const indicator = el('span', 'gl-tabs__ind')
    indicator.setAttribute('aria-hidden', 'true')
    tabs.appendChild(indicator)
    top.appendChild(tabs)
  } else {
    top.appendChild(el('div'))
  }

  const chrome = el('div', 'gl-chrome')
  const profile = el('button', 'gl-profile') as HTMLButtonElement
  profile.type = 'button'
  profile.setAttribute('aria-label', `Profile ${bridge.username}`)
  profile.appendChild(bridge.createAvatar(bridge.username))
  const meta = el('span', 'gl-profile__meta')
  meta.append(
    el('span', 'gl-profile__name', bridge.username),
    el('span', 'gl-profile__wallet', bridge.formatCash(bridge.walletBalance))
  )
  profile.appendChild(meta)
  profile.onclick = () => handlers.onProfile()
  chrome.appendChild(profile)

  const cluster = el('div', 'gl-icon-cluster')
  const muted = bridge.getSoundMuted()

  const soundBtn = iconButton(
    muted ? ICONS.speakerOff : ICONS.speaker,
    muted ? 'Unmute table sounds' : 'Mute table sounds',
    handlers.onSoundToggle
  )
  soundBtn.setAttribute('aria-pressed', String(muted))

  const settingsBtn = iconButton(ICONS.gear, 'Settings', handlers.onSettingsIcon)
  const inFullscreen = Boolean(document.fullscreenElement)
  const fullBtn = iconButton(
    inFullscreen ? ICONS.fullscreenExit : ICONS.fullscreen,
    inFullscreen ? 'Exit fullscreen' : 'Fullscreen',
    handlers.onFullscreen
  )

  cluster.append(settingsBtn, soundBtn, fullBtn)
  chrome.appendChild(cluster)
  top.appendChild(chrome)

  const main = el('div', 'gl-main')
  main.id = 'gl-main'

  const bottom = el('div', 'gl-bottom')
  if (isFinePointer()) {
    const hints = el('div', 'gl-hints')
    hints.append(el('span', 'gl-hint', 'Enter select'), el('span', 'gl-hint', 'Esc back'))
    bottom.appendChild(hints)
  } else {
    bottom.appendChild(el('div'))
  }
  const foot = el('div', 'gl-footer-brand')
  foot.textContent = `${title} · ${HOME_COPY.footerMode}`
  bottom.appendChild(foot)

  shell.append(top, main, bottom)
  root.appendChild(shell)
  return { root, main }
}

function iconButton(svg: string, label: string, onClick: () => void): HTMLButtonElement {
  const btn = el('button', 'gl-icon-btn') as HTMLButtonElement
  btn.type = 'button'
  btn.title = label
  btn.setAttribute('aria-label', label)
  btn.innerHTML = svg
  btn.onclick = onClick
  return btn
}

/**
 * Wordmark on one line: the trailing X is its own amber span, never a second
 * row of the same word. `sub` adds the small second line (statistics header).
 */
export function brandText(title: string, sub?: string): HTMLElement {
  const text = el('span', 'gl-brand__text')
  const word = el('span', 'gl-brand__word')
  const xAt = title.toUpperCase().lastIndexOf('X')
  if (xAt > 0) {
    word.append(document.createTextNode(title.slice(0, xAt)), el('span', 'gl-brand__x', title.slice(xAt)))
  } else {
    word.textContent = title
  }
  text.appendChild(word)
  if (sub) text.appendChild(el('span', 'gl-brand__sub', sub))
  return text
}

/** Sizes and slides the single amber tab indicator under the selected tab. */
export function syncTabIndicator(scope: ParentNode): void {
  const indicator = scope.querySelector<HTMLElement>('.gl-tabs__ind')
  const active = scope.querySelector<HTMLElement>('.gl-tab[aria-selected="true"]')
  if (!indicator || !active) return
  const place = (): void => {
    indicator.style.width = `${active.offsetWidth}px`
    indicator.style.transform = `translateX(${active.offsetLeft}px)`
  }
  place()
  requestAnimationFrame(place)
}
