import { MATCH_FORMATS, PRACTICE_AI_LEVELS } from '@snooker/shared'
import type { MatchFormat, PracticeAiLevel } from '@snooker/shared'
import { DIFFICULTIES } from '../lobbyModel.js'
import { SETUP_COPY } from './content.js'
import { accentHeadline, el } from './dom.js'
import { ICONS } from './icons.js'
import type { LobbyBridge, PlayMode, SetupState } from './types.js'

export interface SetupActions {
  onBack: () => void
  onChange: (next: SetupState) => void
  onStart: () => void
  starting: boolean
}

export function renderSetup(bridge: LobbyBridge, state: SetupState, actions: SetupActions): HTMLElement {
  const screen = el('div', 'gl-screen')
  screen.dataset.view = 'setup'

  const top = el('div', 'gl-setup-top')
  const back = el('button', 'gl-link-back') as HTMLButtonElement
  back.type = 'button'
  const backIcon = el('span')
  backIcon.innerHTML = ICONS.back
  back.append(backIcon, document.createTextNode(SETUP_COPY.back))
  back.onclick = () => actions.onBack()
  const rightHead = el('div', 'gl-setup-top__right')
  rightHead.append(el('div', 'gl-label', SETUP_COPY.eyebrow), accentHeadline(SETUP_COPY.headline, 2))
  top.append(back, rightHead)
  screen.appendChild(top)

  const grid = el('div', 'gl-setup')
  const left = el('div', 'gl-panel gl-setup__left')

  const head = el('div', 'gl-setup-head')
  head.append(el('div', 'gl-label', SETUP_COPY.step), el('div', 'gl-label', bridge.appTitle))
  left.appendChild(head)
  left.appendChild(el('h2', 'gl-setup-title', SETUP_COPY.titleAi))

  const options = el('div', 'gl-options')
  options.append(
    modeCard('ai', SETUP_COPY.vsAiTitle, SETUP_COPY.vsAiDesc, ICONS.robot, state, actions),
    modeCard('online', SETUP_COPY.onlineTitle, SETUP_COPY.onlineDesc, ICONS.online, state, actions)
  )
  left.appendChild(options)

  if (state.mode === 'ai') {
    left.appendChild(el('div', 'gl-label gl-row-label', SETUP_COPY.difficultyLabel))
    const row = el('div', 'gl-chip-row')
    row.setAttribute('role', 'radiogroup')
    row.setAttribute('aria-label', SETUP_COPY.difficultyLabel)
    for (const level of PRACTICE_AI_LEVELS) {
      const spec = DIFFICULTIES.find((d) => d.level === level)
      const chip = el('button', 'gl-chip', spec?.label.toUpperCase() ?? level) as HTMLButtonElement
      chip.type = 'button'
      chip.setAttribute('role', 'radio')
      chip.setAttribute('aria-pressed', String(state.difficulty === level))
      chip.onclick = () => {
        bridge.setPracticeDifficulty(level)
        actions.onChange({ ...state, difficulty: level })
      }
      row.appendChild(chip)
    }
    left.appendChild(row)
  }

  // Practice is always BO1 on the server. Online supports BO1 / BO3 / BO5.
  const formats: MatchFormat[] = state.mode === 'online' ? [...MATCH_FORMATS] : state.mode === 'ai' ? ['BO1'] : []
  if (formats.length) {
    left.appendChild(el('div', 'gl-label gl-row-label', SETUP_COPY.lengthLabel))
    const row = el('div', 'gl-chip-row')
    for (const format of formats) {
      const meta = SETUP_COPY.formats[format]
      const chip = el('button', 'gl-chip') as HTMLButtonElement
      chip.type = 'button'
      chip.setAttribute('aria-pressed', String(state.format === format))
      chip.append(document.createTextNode(meta.label), el('span', 'gl-chip__hint', meta.hint))
      chip.onclick = () => actions.onChange({ ...state, format })
      row.appendChild(chip)
    }
    left.appendChild(row)
  }

  if (state.mode === 'online') {
    const tiers = bridge.getStakeTiers()
    if (tiers.length) {
      left.appendChild(el('div', 'gl-label gl-row-label', SETUP_COPY.stakeLabel))
      const row = el('div', 'gl-chip-row gl-chip-row--stakes')
      const active = state.stakeTierId ?? bridge.getDefaultStakeTierId() ?? tiers[0]!.id
      for (const tier of tiers) {
        const chip = el('button', 'gl-chip', `${tier.label}`) as HTMLButtonElement
        chip.type = 'button'
        chip.setAttribute('aria-pressed', String(tier.id === active))
        chip.appendChild(el('span', 'gl-chip__hint', bridge.formatCash(tier.credits)))
        chip.onclick = () => actions.onChange({ ...state, stakeTierId: tier.id })
        row.appendChild(chip)
      }
      left.appendChild(row)
    }
  }

  const facts = el('div', 'gl-facts')
  for (const fact of SETUP_COPY.facts) facts.appendChild(el('span', 'gl-fact', fact))
  left.appendChild(facts)

  const right = el('div', 'gl-panel gl-setup__right')
  const img = document.createElement('img')
  img.className = 'gl-setup__right-img'
  img.src = '/lobby-pic-blurred.jpg'
  img.alt = ''
  img.decoding = 'async'
  const body = el('div', 'gl-setup__right-body')
  const brandRow = el('div', 'gl-setup__brand-row')
  brandRow.append(el('div', 'gl-label', SETUP_COPY.panelBrand), el('span', 'gl-badge', SETUP_COPY.panelBadge))
  const copy = el('div', 'gl-setup__copy')
  copy.append(
    el('h3', 'gl-headline gl-setup__right-title', SETUP_COPY.panelTitle),
    el('p', undefined, SETUP_COPY.panelBody)
  )
  const start = el('button', 'gl-btn gl-btn--primary', SETUP_COPY.start) as HTMLButtonElement
  start.type = 'button'
  start.disabled = !state.mode || actions.starting
  start.onclick = () => actions.onStart()
  const summary = el('div', 'gl-setup__summary', buildSummary(state))
  const foot = el('div', 'gl-setup__foot')
  foot.append(start, summary)
  body.append(brandRow, copy, foot)
  right.append(img, el('div', 'gl-setup__right-shade'), body)

  grid.append(left, right)
  screen.appendChild(grid)
  return screen
}

function modeCard(
  mode: PlayMode,
  title: string,
  desc: string,
  icon: string,
  state: SetupState,
  actions: SetupActions
): HTMLButtonElement {
  const btn = el('button', 'gl-option') as HTMLButtonElement
  btn.type = 'button'
  btn.setAttribute('aria-pressed', String(state.mode === mode))
  const iconEl = el('span', 'gl-option__icon')
  iconEl.innerHTML = icon
  const mark = el('span', 'gl-option__mark')
  mark.innerHTML = ICONS.check
  btn.append(iconEl, el('span', 'gl-option__title', title), el('span', 'gl-option__desc', desc), mark)
  btn.onclick = () => {
    const next: SetupState = {
      ...state,
      mode,
      format: mode === 'ai' ? 'BO1' : state.format
    }
    actions.onChange(next)
  }
  return btn
}

function buildSummary(state: SetupState): string {
  if (!state.mode) return 'SELECT A MODE TO BEGIN'
  if (state.mode === 'ai') {
    return `VS AI / ${state.difficulty} / ${SETUP_COPY.formats.BO1.label}`
  }
  const fmt = SETUP_COPY.formats[state.format]
  return `ONLINE / ${fmt.label}`
}

export function defaultSetupState(
  bridge: LobbyBridge,
  preselect: PlayMode | null
): SetupState {
  return {
    mode: preselect,
    difficulty: bridge.practiceDifficulty,
    format: 'BO1',
    stakeTierId: bridge.getDefaultStakeTierId()
  }
}

export type { PracticeAiLevel }
