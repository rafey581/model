import { SETTINGS_COPY } from './content.js'
import { accentHeadline, el } from './dom.js'
import type { LobbyBridge } from './types.js'
import {
  qualityConfig,
  qualityPreference,
  setQualityPreference,
  type QualityPreference
} from '../game/qualityConfig.js'

export interface SettingsActions {
  onToggleSound: () => void
  /** Called after the graphics quality has been changed and saved, so the screen repaints. */
  onQualityChange: () => void
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
  panel.appendChild(renderQualityRow(actions))
  screen.appendChild(panel)
  return screen
}

/**
 * Graphics quality: Auto, or one of the three tiers held fixed.
 *
 * The choice is written straight through `setQualityPreference`, which saves it and moves
 * the tier the next match is built at. Nothing about a match in progress is touched from
 * here — this screen only exists in the lobby.
 */
function renderQualityRow(actions: SettingsActions): HTMLElement {
  const row = el('div', 'gl-settings-row gl-settings-row--stack')
  const current = qualityPreference()
  const copy = el('div')
  const tierName = qualityConfig().name
  const status =
    current === 'auto'
      ? `Auto is using ${tierName.charAt(0).toUpperCase()}${tierName.slice(1)} on this device.`
      : SETTINGS_COPY.qualityApplied
  copy.append(
    el('div', undefined, SETTINGS_COPY.qualityLabel),
    el('p', undefined, SETTINGS_COPY.qualityHint),
    el('p', 'gl-settings-status', status)
  )

  const options = el('div', 'gl-chip-row gl-settings-options')
  options.setAttribute('role', 'radiogroup')
  options.setAttribute('aria-label', SETTINGS_COPY.qualityLabel)
  for (const option of SETTINGS_COPY.qualityOptions) {
    const chip = el('button', 'gl-chip') as HTMLButtonElement
    chip.type = 'button'
    chip.setAttribute('role', 'radio')
    const selected = option.value === current
    chip.setAttribute('aria-checked', String(selected))
    chip.setAttribute('aria-pressed', String(selected))
    chip.append(el('span', undefined, option.label), el('span', 'gl-chip__hint', option.hint))
    chip.onclick = () => {
      if (option.value === qualityPreference()) return
      setQualityPreference(option.value as QualityPreference)
      actions.onQualityChange()
    }
    options.appendChild(chip)
  }
  row.append(copy, options)
  return row
}
