/**
 * The match screen's menu, its pause, and the "turn your phone" notice.
 *
 * The corners of the match screen used to hold seven round buttons between them. On a
 * phone that is most of the top edge, over a table the player is trying to look at. This
 * gathers them: one menu button in the top-left corner opens a short list — sound, finish
 * or concede, fullscreen, the controls, leave — and the only things left out on the glass
 * are the ones reached for mid-frame: the menu itself, pause, and the camera.
 *
 * Nothing about what a button does is decided here. The buttons are the ones the game
 * already built, with the handlers they already had; they are moved into the list and
 * given their names to show beside their icons. That is why this needs to know nothing
 * about leaving a match, muting, or conceding.
 *
 * Pausing is a curtain, not a stopped clock. The game is played on a server and the
 * server's shot clock is not this screen's to stop, so a pause here covers the table,
 * takes the pointer and the keyboard away from it, and says plainly that the clock is
 * still running. It is for putting the phone down for a moment without playing a shot by
 * accident.
 */

const STYLE_ID = 'hud-menu-styles'

const CSS = `
/* The top-left row: menu, pause, camera. Small, and in a row so the left edge below them is free. */
.hud-tools--left.has-menu {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.hud-tools--left.has-menu > .hud-tool {
  width: 36px;
  height: 36px;
}

.hud-menu-panel {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 190px;
  padding: 8px;
  border-radius: 14px;
  background: rgba(12, 17, 26, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.5);
  transform-origin: top left;
  animation: hud-menu-in 160ms cubic-bezier(0.2, 0.9, 0.25, 1);
}
.hud-menu-panel[hidden] { display: none; }
@keyframes hud-menu-in {
  from { opacity: 0; transform: translateY(-6px) scale(0.97); }
  to { opacity: 1; transform: none; }
}
/* A moved tool button becomes a row: its icon, then its own name. */
.hud-menu-panel > .hud-tool {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  width: 100%;
  height: 40px;
  padding: 0 14px 0 11px;
  border-radius: 9px;
  background: transparent;
  border: 0;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  font: 600 13px/1 var(--font-body, system-ui, sans-serif);
  color: #e8eff7;
}
/* The glass buttons use this pseudo-element for their sheen, laid over the whole button.
   In the list it is the button's name instead, so everything that made it a sheen is undone. */
.hud-menu-panel > .hud-tool::after {
  content: attr(aria-label);
  position: static;
  inset: auto;
  width: auto;
  height: auto;
  background: none;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  opacity: 1;
  transform: none;
  white-space: nowrap;
  pointer-events: none;
}
.hud-menu-panel > .hud-tool::before { display: none; }
.hud-menu-panel > .hud-tool:hover,
.hud-menu-panel > .hud-tool:focus-visible { background: rgba(255, 255, 255, 0.09); transform: none; }
.hud-menu-panel > .hud-tool[data-danger='true'] { color: #ff9a9a; }
.hud-menu-panel > .hud-menu-rule { height: 1px; margin: 3px 4px; background: rgba(255, 255, 255, 0.1); }
.hud-menu-panel > .hud-pop { position: static; margin: 2px 0 0; max-width: 240px; }

/* The pause curtain. Above everything in the match, and it takes every touch. */
.hud-pause {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: grid;
  place-items: center;
  background: rgba(4, 7, 12, 0.72);
  touch-action: none;
  /* Said out loud, because the HUD it belongs to lets the pointer through to the table
     and this is the one thing in a match that must not. */
  pointer-events: auto;
}
.hud-pause[hidden] { display: none; }
.hud-pause-card { animation: hud-pause-in 200ms cubic-bezier(0.2, 1.2, 0.3, 1); }
@keyframes hud-pause-in { from { transform: scale(0.94); } to { transform: none; } }
.hud-pause-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  min-width: min(320px, 84vw);
  padding: 22px 34px 24px;
  clip-path: polygon(16px 0, 100% 0, calc(100% - 16px) 100%, 0 100%);
  background:
    radial-gradient(120% 90% at 50% 0%, rgba(231, 199, 104, 0.2), transparent 70%),
    linear-gradient(180deg, rgba(20, 27, 40, 0.98), rgba(7, 10, 16, 0.98));
  color: #e8eff7;
  font-family: var(--font-body, system-ui, sans-serif);
  text-align: center;
}
.hud-pause-title { font-size: clamp(22px, 4vw, 34px); font-weight: 800; letter-spacing: 0.16em; color: #e7c768; }
.hud-pause-note { font-size: 12px; line-height: 1.45; color: rgba(230, 237, 243, 0.72); max-width: 30ch; }
.hud-pause-resume {
  margin-top: 6px;
  padding: 11px 34px;
  border: 0;
  border-radius: 999px;
  background: linear-gradient(180deg, #f0d47c, #c9a23a);
  color: #1a1407;
  font: 800 14px/1 var(--font-body, system-ui, sans-serif);
  letter-spacing: 0.12em;
  cursor: pointer;
}
.hud-pause-resume:active { transform: scale(0.97); }

/*
 * "Play sideways": on a touch device held upright, over the whole site.
 *
 * The lobby can be waved away and used upright; a match cannot, because the table needs
 * the long side of the screen.
 */
.rotate-hint { display: none; }
@media (pointer: coarse) and (orientation: portrait) {
  body:not(.rotate-dismissed) .rotate-hint,
  body.game-mode .rotate-hint {
    position: fixed;
    inset: 0;
    z-index: 400;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 18px;
    padding: 24px;
    background: #070b12;
    color: #e8eff7;
    font-family: var(--font-body, system-ui, sans-serif);
    text-align: center;
  }
}
.rotate-hint-phone {
  width: 54px;
  height: 92px;
  border: 3px solid #e7c768;
  border-radius: 10px;
  animation: rotate-hint-turn 2.2s ease-in-out infinite;
}
@keyframes rotate-hint-turn {
  0%, 20% { transform: rotate(0deg); }
  55%, 100% { transform: rotate(-90deg); }
}
.rotate-hint-title { font-size: 20px; font-weight: 800; letter-spacing: 0.08em; }
.rotate-hint-note { font-size: 13px; color: rgba(230, 237, 243, 0.7); max-width: 28ch; }
.rotate-hint-go {
  margin-top: 4px;
  padding: 14px 30px;
  border: 0;
  border-radius: 999px;
  background: linear-gradient(180deg, #f0d47c, #c9a23a);
  color: #1a1407;
  font: 800 15px/1 var(--font-body, system-ui, sans-serif);
  letter-spacing: 0.08em;
}
.rotate-hint-go:active { transform: scale(0.97); }
.rotate-hint-skip {
  padding: 8px 12px;
  border: 0;
  background: none;
  color: rgba(230, 237, 243, 0.55);
  font: 600 12px/1 var(--font-body, system-ui, sans-serif);
  text-decoration: underline;
}
/* In a match there is no staying upright, so the way out of this screen is not offered. */
body.game-mode .rotate-hint-skip { display: none; }

/*
 * The match on a phone held sideways (and on any very short window).
 *
 * The table is everything, so what is left on the glass is pushed to its edges: the score
 * goes to the bottom centre and gets smaller, the power cue moves to the left under the
 * thumb that is not aiming, and the spin dial and the opponent's meter go right to make
 * room for it.
 */
@media (pointer: coarse), (max-height: 520px) {
  .hud-tools--left.has-menu > .hud-tool { width: 34px; height: 34px; }
  .hud-capsule {
    position: fixed;
    left: 50%;
    bottom: calc(env(safe-area-inset-bottom, 0px) + 4px);
    transform: translateX(-50%) scale(0.78);
    transform-origin: bottom center;
    max-width: 86vw;
  }
  .power-rail {
    right: auto;
    left: calc(env(safe-area-inset-left, 0px) + 0px);
    padding: 0 12px 0 16px;
    top: 56%;
  }
  .spin-dial {
    left: auto;
    right: calc(env(safe-area-inset-right, 0px) + clamp(8px, 1.6vw, 20px));
    transform: scale(0.86);
    transform-origin: bottom right;
  }
  .venue-opponent-power {
    left: auto !important;
    right: calc(env(safe-area-inset-right, 0px) + clamp(6px, 1.4vw, 18px));
  }
  .hud-menu-panel > .hud-tool { height: 44px; }
}

@media (prefers-reduced-motion: reduce) {
  .hud-menu-panel, .hud-pause-card, .rotate-hint-phone { animation: none; }
}
`

const MENU_ICON =
  '<svg class="hud-tool-icon" viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 6h12M4 10h12M4 14h12"/></svg>'
const PAUSE_ICON =
  '<svg class="hud-tool-icon" viewBox="0 0 20 20" width="17" height="17" fill="currentColor" aria-hidden="true"><rect x="5.2" y="4.5" width="3.3" height="11" rx="1"/><rect x="11.5" y="4.5" width="3.3" height="11" rx="1"/></svg>'

function ensureStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

function button(className: string, label: string, icon: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = className
  b.title = label
  b.setAttribute('aria-label', label)
  b.innerHTML = icon
  return b
}

/**
 * Asks the browser for the whole screen, turned sideways.
 *
 * A page is not allowed to turn the screen by itself. It may ask once it is fullscreen,
 * and it may only go fullscreen from a tap — so this is what the button on the notice
 * does. Where the browser refuses either step (an iPhone refuses both), nothing happens
 * and the notice stays, asking for the phone to be turned by hand.
 */
async function goLandscape(): Promise<void> {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' })
  } catch {
    // No fullscreen here. The lock below will most likely be refused as well.
  }
  try {
    const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
    await orientation.lock?.('landscape')
  } catch {
    // Not allowed to turn the screen. The player turns the phone instead.
  }
}

/** The one notice, added to the page once. The stylesheet decides when it is seen. */
function ensureRotateHint(): void {
  if (document.querySelector('.rotate-hint')) return
  const hint = document.createElement('div')
  hint.className = 'rotate-hint'
  hint.setAttribute('role', 'dialog')
  hint.setAttribute('aria-label', 'Play in landscape')
  const phone = document.createElement('div')
  phone.className = 'rotate-hint-phone'
  const title = document.createElement('div')
  title.className = 'rotate-hint-title'
  title.textContent = 'Play sideways'
  const note = document.createElement('div')
  note.className = 'rotate-hint-note'
  note.textContent = 'The table needs the long side of the screen. Tap below, or turn your phone.'
  const go = document.createElement('button')
  go.type = 'button'
  go.className = 'rotate-hint-go'
  go.textContent = 'PLAY FULL SCREEN'
  go.onclick = () => void goLandscape()
  const skip = document.createElement('button')
  skip.type = 'button'
  skip.className = 'rotate-hint-skip'
  skip.textContent = 'Stay upright for now'
  skip.onclick = () => document.body.classList.add('rotate-dismissed')
  hint.append(phone, title, note, go, skip)
  document.body.appendChild(hint)
}

/**
 * Puts the notice on the page as soon as the app loads, not only once a match starts: on
 * a phone the whole site is meant to be used sideways, lobby included.
 */
function installRotateGate(): void {
  try {
    if (typeof document === 'undefined') return
    const mount = (): void => {
      ensureStyles()
      ensureRotateHint()
    }
    if (document.body) mount()
    else document.addEventListener('DOMContentLoaded', mount, { once: true })
  } catch {
    // The notice is a courtesy. The app loads without it.
  }
}
installRotateGate()

export interface HudMenuMounts {
  /** The HUD's root, which the pause curtain is hung on so it leaves with the match. */
  root: HTMLElement
  /** The top-left slot, already holding Leave and the camera toggle. */
  toolsRoot: HTMLElement
  /** The top-right slot, already holding sound, finish, fullscreen and the controls. */
  sessionToolsRoot: HTMLElement
}

export interface HudMenu {
  isPaused(): boolean
  setPaused(paused: boolean): void
  dispose(): void
}

/**
 * Gathers the match screen's buttons into a menu and adds pause.
 *
 * Call it once, after the game has put its own buttons into the two slots.
 */
export function installHudMenu(mounts: HudMenuMounts): HudMenu {
  ensureStyles()
  ensureRotateHint()
  const { root, toolsRoot, sessionToolsRoot } = mounts
  toolsRoot.classList.add('has-menu')

  const menuBtn = button('hud-tool hud-glass hud-tool--menu', 'Menu', MENU_ICON)
  menuBtn.setAttribute('aria-expanded', 'false')
  const pauseBtn = button('hud-tool hud-glass hud-tool--pause', 'Pause', PAUSE_ICON)
  const panel = document.createElement('div')
  panel.className = 'hud-menu-panel'
  panel.setAttribute('role', 'menu')
  panel.hidden = true

  // Everything in the top-right goes into the list, in the order it was built. The "more"
  // button was only ever the phone's way into those same buttons, so it is not needed.
  for (const child of Array.from(sessionToolsRoot.children) as HTMLElement[]) {
    if (child.classList.contains('hud-tool--more')) continue
    panel.appendChild(child)
  }
  sessionToolsRoot.hidden = true
  // Leave goes last, under a rule, and in red: the one entry that ends something.
  const leave = Array.from(toolsRoot.children).find(
    (child) => child instanceof HTMLElement && child.getAttribute('aria-label') === 'Leave'
  ) as HTMLElement | undefined
  if (leave) {
    const rule = document.createElement('div')
    rule.className = 'hud-menu-rule'
    leave.dataset.danger = 'true'
    panel.append(rule, leave)
  }
  toolsRoot.prepend(menuBtn, pauseBtn)
  toolsRoot.appendChild(panel)

  const setOpen = (open: boolean): void => {
    panel.hidden = !open
    menuBtn.setAttribute('aria-expanded', String(open))
  }
  menuBtn.onclick = () => setOpen(panel.hidden)
  // Choosing something closes the list, except the toggles a player may want to flip and see.
  panel.addEventListener('click', (event) => {
    const item = (event.target as Element | null)?.closest('.hud-tool')
    if (!item) return
    const label = item.getAttribute('aria-label') ?? ''
    if (!label.startsWith('Sound') && label !== 'Controls') setOpen(false)
  })
  const onOutside = (event: Event): void => {
    if (panel.hidden) return
    const target = event.target as Node | null
    if (target && (panel.contains(target) || menuBtn.contains(target))) return
    setOpen(false)
  }
  document.addEventListener('pointerdown', onOutside, true)

  /* --- pause --------------------------------------------------------- */

  const curtain = document.createElement('div')
  curtain.className = 'hud-pause'
  curtain.hidden = true
  curtain.setAttribute('role', 'dialog')
  curtain.setAttribute('aria-modal', 'true')
  curtain.setAttribute('aria-label', 'Game paused')
  const card = document.createElement('div')
  card.className = 'hud-pause-card'
  const title = document.createElement('div')
  title.className = 'hud-pause-title'
  title.textContent = 'PAUSED'
  const note = document.createElement('div')
  note.className = 'hud-pause-note'
  note.textContent = 'The table is covered so nothing is played by accident. The shot clock keeps running.'
  const resume = document.createElement('button')
  resume.type = 'button'
  resume.className = 'hud-pause-resume'
  resume.textContent = 'RESUME'
  card.append(title, note, resume)
  curtain.appendChild(card)
  // On the page itself, not inside the HUD: the HUD sits under the table's own overlay,
  // where the power slider is, and a curtain down there would leave the slider live.
  document.body.appendChild(curtain)

  let paused = false
  let watch = 0
  const setPaused = (next: boolean): void => {
    paused = next
    curtain.hidden = !next
    window.clearInterval(watch)
    if (next) {
      setOpen(false)
      resume.focus()
      // If the match goes away underneath a pause — it ended, or the player was sent back
      // to the lobby — the curtain goes with it rather than being left over another screen.
      watch = window.setInterval(() => {
        if (!root.isConnected) setPaused(false)
      }, 500)
    }
  }
  pauseBtn.onclick = () => setPaused(true)
  resume.onclick = () => setPaused(false)
  // The curtain takes the pointer by covering the table. The keyboard has to be taken
  // separately: the game listens for Space and the arrows on the window, and a paused
  // game must not shoot. Caught first, on the way down, and stopped there.
  const onKey = (event: KeyboardEvent): void => {
    if (!root.isConnected) {
      window.removeEventListener('keydown', onKey, true)
      return
    }
    if (!paused) {
      if ((event.key === 'p' || event.key === 'P') && !event.repeat && !(event.target instanceof HTMLInputElement)) setPaused(true)
      return
    }
    event.stopPropagation()
    event.preventDefault()
    if (event.key === 'p' || event.key === 'P' || event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
      if (!event.repeat) setPaused(false)
    }
  }
  window.addEventListener('keydown', onKey, true)
  // A phone put down, or a tab switched away from, pauses by itself: coming back to a
  // table that is live under a thumb is how a shot gets played by accident.
  const onHidden = (): void => {
    if (document.hidden && root.isConnected) setPaused(true)
  }
  document.addEventListener('visibilitychange', onHidden)

  // Asked for again as a match starts, in case the player is already fullscreen. Outside
  // fullscreen the browser refuses, and the notice does the asking instead.
  try {
    const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
    void orientation.lock?.('landscape').catch(() => undefined)
  } catch {
    // No orientation lock here.
  }

  return {
    isPaused: () => paused,
    setPaused,
    dispose(): void {
      document.removeEventListener('pointerdown', onOutside, true)
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('keydown', onKey, true)
      window.clearInterval(watch)
      curtain.remove()
    }
  }
}
