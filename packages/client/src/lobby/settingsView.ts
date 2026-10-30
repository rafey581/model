import { SETTINGS_COPY } from './content.js'
import { accentHeadline, el } from './dom.js'
import type { LobbyBridge } from './types.js'
import {
  qualityConfig,
  qualityPreference,
  setQualityPreference,
  type QualityPreference
} from '../game/qualityConfig.js'
import { musicEnabled, musicTrack, musicVolume, setMusicEnabled, setMusicTrack, setMusicVolume, type MusicTrack } from '../game/music.js'

export interface SettingsActions {
  onToggleSound: () => void
  onSignOut: () => void
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
  panel.appendChild(renderMusic(actions))
  panel.appendChild(renderQualityRow(actions))

  // The account a phone is signed in to stays signed in: there is no log-out button.
  // One account per phone is the rule, so there is no other account to switch to.
  const account = el('div', 'gl-settings-row')
  const accountCopy = el('div')
  accountCopy.append(el('div', undefined, SETTINGS_COPY.accountLabel), el('p', undefined, SETTINGS_COPY.accountHint(bridge.username)))
  account.append(accountCopy)
  panel.appendChild(account)

  screen.appendChild(panel)
  return screen
}

function renderMusic(actions: SettingsActions): HTMLElement {
  const section = el('div', 'gl-settings-row gl-settings-row--stack')
  const enabled = musicEnabled()
  const head = el('div', 'gl-settings-row')
  const copy = el('div')
  copy.append(el('div', undefined, SETTINGS_COPY.musicLabel), el('p', undefined, SETTINGS_COPY.musicHint))
  const toggle = el('button', 'gl-chip', enabled ? 'ON' : 'OFF') as HTMLButtonElement
  toggle.type = 'button'
  toggle.setAttribute('aria-pressed', String(enabled))
  toggle.onclick = () => {
    setMusicEnabled(!musicEnabled())
    actions.onQualityChange()
  }
  head.append(copy, toggle)

  const volumeLabel = el('p', undefined, SETTINGS_COPY.musicVolume)
  const slider = document.createElement('input')
  slider.type = 'range'
  slider.className = 'gl-music-volume'
  slider.min = '0'
  slider.max = '100'
  slider.value = String(Math.round(musicVolume() * 100))
  slider.setAttribute('aria-label', SETTINGS_COPY.musicVolume)
  slider.oninput = () => setMusicVolume(Number(slider.value) / 100)

  const tracks = el('div', 'gl-chip-row gl-music-tracks')
  tracks.setAttribute('role', 'radiogroup')
  tracks.setAttribute('aria-label', SETTINGS_COPY.musicLabel)
  const current = musicTrack()
  for (const option of SETTINGS_COPY.musicTracks) {
    const chip = el('button', 'gl-chip') as HTMLButtonElement
    chip.type = 'button'
    chip.setAttribute('role', 'radio')
    const selected = option.value === current
    chip.setAttribute('aria-checked', String(selected))
    chip.setAttribute('aria-pressed', String(selected))
    chip.append(el('span', undefined, option.label))
    if ('hint' in option && option.hint) chip.append(el('span', 'gl-chip__hint', option.hint))
    chip.onclick = () => {
      setMusicTrack(option.value as MusicTrack)
      actions.onQualityChange()
    }
    tracks.appendChild(chip)
  }
  section.append(head, volumeLabel, slider, tracks)
  return section
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
