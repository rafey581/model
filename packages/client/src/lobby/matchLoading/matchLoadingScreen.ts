import './matchLoading.css'
import {
  createProgressController,
  STATUS_FOR_PHASE,
  type LoadPhase,
  type ProgressController
} from './progressController.js'

export interface MatchLoadingShowOpts {
  modeLabel: string
}

export interface MatchLoadingHandle {
  report(phase: LoadPhase, fraction: number): void
  finish(): Promise<void>
  /** Resolves when the overlay has faded out and been removed. */
  readonly gone: Promise<void>
}

const TIPS = [
  'Wait a minute, the 3D table is rendering...',
  'Racking the balls...',
  'Chalking the cue...',
  'Setting up the arena lights...',
  'Almost there, take a breath.',
  'Polishing the cloth...',
  'Warming up the crowd...',
  'Lining up the cushions...',
  'Good tables take a moment.'
] as const

const TIP_MS = 2400
const READY_MS = 280
const FADE_MS = 400

/**
 * Show the match loading overlay above everything.
 * Mounts on document.body so renderGame clearing `#app` cannot remove it.
 */
export function showMatchLoading(opts: MatchLoadingShowOpts): MatchLoadingHandle {
  const reduced =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

  const root = document.createElement('div')
  root.className = 'ml-root'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-label', 'Preparing your table')

  const bg = document.createElement('div')
  bg.className = 'ml-bg'
  bg.setAttribute('aria-hidden', 'true')

  const center = document.createElement('div')
  center.className = 'ml-center'

  const mode = document.createElement('p')
  mode.className = 'ml-mode'
  mode.textContent = opts.modeLabel

  const stage = buildClubStage(reduced)

  const title = document.createElement('h1')
  title.className = 'ml-title'
  title.innerHTML = 'PREPARING YOUR <span class="ml-title-amber">TABLE</span>'

  const status = document.createElement('p')
  status.className = 'ml-status'
  status.setAttribute('aria-live', 'polite')
  status.textContent = STATUS_FOR_PHASE.fonts

  const tip = document.createElement('p')
  tip.className = 'ml-tip'
  tip.textContent = TIPS[0]

  const progressRow = document.createElement('div')
  progressRow.className = 'ml-progress-row'
  progressRow.setAttribute('role', 'progressbar')
  progressRow.setAttribute('aria-valuemin', '0')
  progressRow.setAttribute('aria-valuemax', '100')
  progressRow.setAttribute('aria-valuenow', '0')

  const bar = document.createElement('div')
  bar.className = 'ml-bar'
  const fill = document.createElement('span')
  fill.className = 'ml-bar-fill'
  const sheen = document.createElement('span')
  sheen.className = 'ml-bar-sheen'
  sheen.setAttribute('aria-hidden', 'true')
  bar.append(fill, sheen)

  const pctEl = document.createElement('span')
  pctEl.className = 'ml-pct'
  pctEl.textContent = '0%'

  progressRow.append(bar, pctEl)

  const readyLabel = document.createElement('p')
  readyLabel.className = 'ml-ready'
  readyLabel.textContent = 'READY'

  const longer = document.createElement('p')
  longer.className = 'ml-longer'
  longer.textContent = 'Taking a little longer than usual, thanks for your patience.'

  center.append(mode, stage, title, status, tip, progressRow, readyLabel, longer)
  root.append(bg, center)
  document.body.appendChild(root)

  let tipIndex = 0
  let currentPhase: LoadPhase = 'fonts'
  let finishStarted = false
  let goneResolve!: () => void
  const gone = new Promise<void>((resolve) => {
    goneResolve = resolve
  })

  const controller: ProgressController = createProgressController({
    onDisplay: (pct) => {
      const shown = Math.floor(pct)
      fill.style.transform = `scaleX(${Math.min(1, pct / 100)})`
      pctEl.textContent = `${shown}%`
      progressRow.setAttribute('aria-valuenow', String(shown))
    },
    onLonger: () => {
      longer.classList.add('ml-longer--on')
    },
    onWatchdog: () => {
      void finishInternal(true)
    }
  })

  const tipTimer = window.setInterval(() => {
    if (finishStarted) return
    tipIndex = Math.min(TIPS.length - 1, tipIndex + 1)
    const next = TIPS[tipIndex]!
    if (reduced) {
      tip.textContent = next
      return
    }
    tip.classList.add('ml-tip--swap')
    window.setTimeout(() => {
      tip.textContent = next
      tip.classList.remove('ml-tip--swap')
    }, 300)
    if (tipIndex >= TIPS.length - 1) {
      window.clearInterval(tipTimer)
    }
  }, TIP_MS)

  const setPhaseStatus = (phase: LoadPhase): void => {
    if (phase === currentPhase) return
    currentPhase = phase
    status.textContent = STATUS_FOR_PHASE[phase]
  }

  async function finishInternal(fromWatchdog = false): Promise<void> {
    if (finishStarted) return gone
    finishStarted = true
    window.clearInterval(tipTimer)

    if (!fromWatchdog) controller.markReady()
    else controller.forceComplete()

    await controller.whenReady()

    stage.classList.add('ml-stage--ready')
    root.classList.add('ml-root--ready')
    status.textContent = 'ALMOST READY'
    fill.style.transform = 'scaleX(1)'
    pctEl.textContent = '100%'
    progressRow.setAttribute('aria-valuenow', '100')

    await sleep(READY_MS)
    root.classList.add('ml-root--fade')
    await sleep(FADE_MS)
    root.remove()
    controller.dispose()
    goneResolve()
    return gone
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Tab') {
      e.preventDefault()
      root.focus()
    }
  }
  root.tabIndex = -1
  root.focus({ preventScroll: true })
  root.addEventListener('keydown', onKey)

  return {
    report(phase, fraction) {
      setPhaseStatus(phase)
      try {
        controller.report(phase, fraction)
      } catch (err) {
        console.warn('[match-loading] phase report failed', phase, err)
      }
    },
    finish: () => finishInternal(false),
    gone
  }
}

/** Prefetch lobby background so the overlay paint is warm. */
export function ensureLobbyBgReady(): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve()
    img.onerror = () => resolve()
    img.src = '/lobby-pic-blurred.jpg'
    if (img.complete) resolve()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Snooker-club vignette: felt table, cue stroke, orbit, chalk — CSS-only motion. */
function buildClubStage(reduced: boolean): HTMLElement {
  const stage = document.createElement('div')
  stage.className = 'ml-stage'
  stage.setAttribute('aria-hidden', 'true')

  const orbit = document.createElement('div')
  orbit.className = 'ml-orbit'
  const beadA = document.createElement('span')
  beadA.className = 'ml-orbit-bead'
  const beadB = document.createElement('span')
  beadB.className = 'ml-orbit-bead ml-orbit-bead--dim'
  orbit.append(beadA, beadB)

  const table = document.createElement('div')
  table.className = 'ml-table'

  const rail = document.createElement('div')
  rail.className = 'ml-table-rail'
  table.appendChild(rail)

  for (const pos of ['tl', 'tr', 'bl', 'br', 'ml', 'mr'] as const) {
    const pocket = document.createElement('span')
    pocket.className = `ml-pocket ml-pocket--${pos}`
    table.appendChild(pocket)
  }

  const baulk = document.createElement('span')
  baulk.className = 'ml-baulk'
  const dZone = document.createElement('span')
  dZone.className = 'ml-d'
  table.append(baulk, dZone)

  for (const spot of ['blue', 'pink', 'black'] as const) {
    const el = document.createElement('span')
    el.className = `ml-spot ml-spot--${spot}`
    table.appendChild(el)
  }

  const cueball = document.createElement('div')
  cueball.className = 'ml-cueball'

  const cue = document.createElement('div')
  cue.className = 'ml-cue'
  const shaft = document.createElement('div')
  shaft.className = 'ml-cue-shaft'
  const tip = document.createElement('div')
  tip.className = 'ml-cue-tip'
  cue.append(shaft, tip)

  const chalk = document.createElement('div')
  chalk.className = 'ml-chalk'

  const dust = document.createElement('div')
  dust.className = 'ml-dust'
  if (!reduced) {
    for (let i = 0; i < 8; i++) {
      const speck = document.createElement('span')
      speck.className = 'ml-speck'
      speck.style.left = `${10 + ((i * 11) % 80)}%`
      speck.style.bottom = `${8 + (i % 4) * 10}%`
      speck.style.setProperty('--ml-dur', `${9 + (i % 5)}s`)
      speck.style.setProperty('--ml-delay', `${(i * 0.8) % 6}s`)
      dust.appendChild(speck)
    }
  }

  stage.append(orbit, table, cueball, cue, chalk, dust)
  return stage
}

export { STATUS_FOR_PHASE }
export type { LoadPhase }
