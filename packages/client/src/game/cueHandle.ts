/**
 * The handle a cue ball in hand is moved by, on a touch screen.
 *
 * A finger on the ball covers the ball, and a finger anywhere else on the table is an aim.
 * So the ball gets a grip of its own beside it: four arrows in a ring, big enough to land a
 * thumb on. Dragging it moves the ball; nothing else on the screen does.
 *
 * This is only the grip. It reports where the ball is being asked to go, in screen
 * coordinates, and is told where to draw itself. Whether a spot is legal, and what happens
 * to the ball, is decided by whoever is listening.
 */

/** Where the grip sits relative to the ball it moves, in CSS pixels. */
export const CUE_HANDLE_OFFSET = { x: 64, y: -6 }
const HANDLE_SIZE_PX = 56

export interface CueHandle {
  /** Draws the grip beside a ball that is at this point on the screen. */
  show(ballClientX: number, ballClientY: number): void
  hide(): void
  /** Whether a finger is on the grip right now. */
  dragging(): boolean
  dispose(): void
}

const STYLE_ID = 'cue-handle-style'
const STYLE = `
.cue-handle {
  position: fixed;
  left: 0;
  top: 0;
  width: ${HANDLE_SIZE_PX}px;
  height: ${HANDLE_SIZE_PX}px;
  margin: ${-HANDLE_SIZE_PX / 2}px 0 0 ${-HANDLE_SIZE_PX / 2}px;
  border-radius: 50%;
  background: rgba(8, 14, 22, 0.42);
  border: 2px solid rgba(255, 255, 255, 0.9);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
  z-index: 60;
  touch-action: none;
  cursor: grab;
  display: grid;
  place-items: center;
  will-change: transform;
}
.cue-handle[hidden] { display: none; }
.cue-handle.is-dragging { cursor: grabbing; background: rgba(40, 170, 90, 0.5); border-color: #7dffb0; }
.cue-handle svg { width: 34px; height: 34px; pointer-events: none; }
`

const ARROWS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="2.4"/>' +
  '<path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5"/>' +
  '<path d="M9.6 4.6 12 2.2l2.4 2.4M9.6 19.4 12 21.8l2.4-2.4M4.6 9.6 2.2 12l2.4 2.4M19.4 9.6 21.8 12l-2.4 2.4"/>' +
  '</svg>'

/**
 * Makes the grip. `onMove` is called while it is dragged, with the screen point the ball
 * is being asked to move to.
 */
export function createCueHandle(onMove: (ballClientX: number, ballClientY: number) => void): CueHandle {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = STYLE
    document.head.appendChild(style)
  }
  const el = document.createElement('div')
  el.className = 'cue-handle'
  el.hidden = true
  el.setAttribute('role', 'button')
  el.setAttribute('aria-label', 'Move the cue ball')
  el.innerHTML = ARROWS
  document.body.appendChild(el)

  let active: number | null = null
  // Where on the grip the finger landed, so the grip does not jump to centre itself under it.
  let grabX = 0
  let grabY = 0
  let centreX = 0
  let centreY = 0

  const down = (e: PointerEvent): void => {
    active = e.pointerId
    grabX = e.clientX - centreX
    grabY = e.clientY - centreY
    el.classList.add('is-dragging')
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      // A pointer that cannot be captured still drags while it stays over the grip.
    }
    e.preventDefault()
    e.stopPropagation()
  }
  const move = (e: PointerEvent): void => {
    if (active !== e.pointerId) return
    onMove(e.clientX - grabX - CUE_HANDLE_OFFSET.x, e.clientY - grabY - CUE_HANDLE_OFFSET.y)
    e.preventDefault()
    e.stopPropagation()
  }
  const up = (e: PointerEvent): void => {
    if (active !== e.pointerId) return
    active = null
    el.classList.remove('is-dragging')
    e.preventDefault()
    e.stopPropagation()
  }
  el.addEventListener('pointerdown', down)
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)

  return {
    show(ballClientX, ballClientY): void {
      centreX = ballClientX + CUE_HANDLE_OFFSET.x
      centreY = ballClientY + CUE_HANDLE_OFFSET.y
      el.style.transform = `translate(${centreX.toFixed(1)}px, ${centreY.toFixed(1)}px)`
      el.hidden = false
    },
    hide(): void {
      if (el.hidden) return
      el.hidden = true
      active = null
      el.classList.remove('is-dragging')
    },
    dragging(): boolean {
      return active !== null
    },
    dispose(): void {
      el.remove()
    }
  }
}
