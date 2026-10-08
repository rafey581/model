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
const READY_MS = 250
const FADE_MS = 400

/** Snooker colours for the 6 colour balls (CSS). */
const COLOUR_FILLS = [
  '#e8c84a', // yellow
  '#2e8b57', // green
  '#8b5a2b', // brown
  '#2f6bff', // blue
  '#e85a9a', // pink
  '#1a1a1a' // black
] as const

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

  const rackWrap = document.createElement('div')
  rackWrap.className = 'ml-rack-wrap'
  rackWrap.setAttribute('aria-hidden', 'true')
  rackWrap.innerHTML = buildRackSvg()
  const ballEls = Array.from(rackWrap.querySelectorAll<SVGElement>('.ml-ball'))

  const cue = document.createElement('div')
  cue.className = 'ml-cue'
  rackWrap.appendChild(cue)

  const dust = document.createElement('div')
  dust.className = 'ml-dust'
  if (!reduced) {
    for (let i = 0; i < 10; i++) {
      const speck = document.createElement('span')
      speck.className = 'ml-speck'
      speck.style.left = `${8 + ((i * 9) % 84)}%`
      speck.style.bottom = `${6 + (i % 5) * 8}%`
      speck.style.setProperty('--ml-dur', `${8 + (i % 7)}s`)
      speck.style.setProperty('--ml-delay', `${(i * 0.7) % 5}s`)
      dust.appendChild(speck)
    }
  }
  rackWrap.appendChild(dust)

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
  bar.appendChild(fill)

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

  center.append(mode, rackWrap, title, status, tip, progressRow, readyLabel, longer)
  root.append(bg, center)
  document.body.appendChild(root)

  let tipIndex = 0
  let ballsLit = 0
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
      const nextBalls = Math.min(21, Math.floor((pct / 100) * 21 + 1e-6))
      while (ballsLit < nextBalls) {
        ballEls[ballsLit]?.classList.add('ml-ball--on')
        ballsLit++
      }
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

    // Light remaining balls + ready glow.
    for (const el of ballEls) el.classList.add('ml-ball--on')
    rackWrap.classList.add('ml-rack-wrap--ready')
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

  // Trap focus lightly: keep Tab inside overlay.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Tab') {
      e.preventDefault()
      root.focus()
    }
  }
  root.tabIndex = -1
  root.focus({ preventScroll: true })
  root.addEventListener('keydown', onKey)

  const handle: MatchLoadingHandle = {
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

  return handle
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

function buildRackSvg(): string {
  // Triangle of 15 reds (rows 1..5) + 6 colours below in snooker order.
  const r = 9.2
  const gap = 19.2
  const reds: Array<{ cx: number; cy: number }> = []
  const startY = 28
  for (let row = 0; row < 5; row++) {
    const count = row + 1
    const y = startY + row * gap * 0.9
    const width = (count - 1) * gap
    const x0 = 100 - width / 2
    for (let i = 0; i < count; i++) {
      reds.push({ cx: x0 + i * gap, cy: y })
    }
  }

  const colourY = startY + 5 * gap * 0.9 + 8
  const colours = [
    { cx: 55, cy: colourY }, // Y
    { cx: 75, cy: colourY }, // G
    { cx: 95, cy: colourY }, // Br
    { cx: 115, cy: colourY }, // Bl
    { cx: 100, cy: colourY + gap * 0.95 }, // P
    { cx: 100, cy: colourY + gap * 1.9 } // Bk
  ]

  const parts: string[] = [
    '<svg class="ml-rack" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">'
  ]

  let idx = 0
  for (const p of reds) {
    parts.push(ballCircle(idx++, p.cx, p.cy, r, '#c62828'))
  }
  COLOUR_FILLS.forEach((fill, i) => {
    const p = colours[i]!
    parts.push(ballCircle(idx++, p.cx, p.cy, r, fill))
  })
  parts.push('</svg>')
  return parts.join('')
}

function ballCircle(index: number, cx: number, cy: number, r: number, fill: string): string {
  const highlight = fill === '#1a1a1a' ? '#5a5a5a' : '#ffffff'
  return (
    `<g class="ml-ball" data-i="${index}">` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>` +
    `<circle cx="${cx - r * 0.28}" cy="${cy - r * 0.32}" r="${r * 0.34}" fill="url(#ml-hl-${index})"/>` +
    `<defs><radialGradient id="ml-hl-${index}" cx="35%" cy="30%" r="65%">` +
    `<stop offset="0%" stop-color="${highlight}" stop-opacity="0.55"/>` +
    `<stop offset="100%" stop-color="${highlight}" stop-opacity="0"/>` +
    `</radialGradient></defs></g>`
  )
}

/** Exported for callers that want phase labels. */
export { STATUS_FOR_PHASE }
export type { LoadPhase }
