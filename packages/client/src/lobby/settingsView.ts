import { SETTINGS_COPY } from './content.js'
import { accentHeadline, el } from './dom.js'
import type { LobbyBridge } from './types.js'

export interface SettingsActions {
  onToggleSound: () => void
}

export function renderSettings(bridge: LobbyBridge, actions: SettingsActions): HTMLElement {
  const screen = el('div', 'gl-screen')
  screen.dataset.view = 'settings'

  const head = el('div', 'gl-home-head')
  head.append(el('div', 'gl-label', SETTINGS_COPY.eyebrow), accentHeadline(SETTINGS_COPY.headline, 1))
  screen.appendChild(head)

  const panel = el('div', 'gl-panel gl-settings')
  const row = el('div', 'gl-settings-row')
  const copy = el('div')
  copy.append(el('div', undefined, SETTINGS_COPY.soundLabel), el('p', undefined, SETTINGS_COPY.soundHint))
  const muted = bridge.getSoundMuted()
  const toggle = el('button', 'gl-chip', muted ? 'OFF' : 'ON') as HTMLButtonElement
  toggle.type = 'button'
  toggle.setAttribute('aria-pressed', String(!muted))
  toggle.onclick = () => actions.onToggleSound()
  row.append(copy, toggle)
  panel.appendChild(row)
  screen.appendChild(panel)
  return screen
}
