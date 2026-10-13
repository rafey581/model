import type { ShotInput } from '@snooker/shared'
import { BALL_RADIUS } from '@snooker/shared'
import { tableToCanvas } from './renderer.js'
import { aimAngleTo, ballRadiusPx, cueAxisPixels } from './cameraPick.js'
import { powerAfterArrow, POWER_FINE_STEP, POWER_RESTING_DEFAULT, powerAdjust, powerFromDrag } from './power.js'

/**
 * How a view answers pointer questions.
 *
 * The 3D scene casts the pointer through the camera it is actually drawing with; the
 * fallback renderer draws one fixed, near-overhead view and answers with its own projection
 * instead. Everything below asks through this and does not care which it is talking to.
 */
export interface TableView {
  /** The point on the cloth under a canvas pixel, or null above the horizon. */
  screenToTable: (px: number, py: number) => { x: number; y: number } | null
  /** Where a point on the cloth is drawn, in canvas pixels. */
  tableToScreen: (x: number, y: number) => { x: number; y: number } | null
  /** How wide a ball is drawn at a point on the cloth, in canvas pixels. */
  ballRadiusPx: (x: number, y: number, radiusMm: number) => number
}

export interface AimState {
  angle: number
  power: number
  spinX: number
  spinY: number
}

export interface CueControllerOptions {
  canvas: HTMLCanvasElement
  cuePosition: { x: number; y: number }
  enabled: () => boolean
  onChange: (aim: AimState) => void
  onShoot: (shot: Omit<ShotInput, 'timestamp'>) => void
  /**
   * One step of look-around, in pixels of horizontal drag. Only ever called for a
   * deliberate right- or middle-button drag, which is the only gesture that turns
   * the camera — a plain pointer move never does.
   */
  onOrbit?: (pixels: number) => void
  /**
   * The view to ask, if there is one right now.
   *
   * Asked for fresh each time rather than handed over once, because a view can stop
   * existing while the game is running: if the 3D scene hits a graphics error the caller
   * drops it and falls back to the flat renderer, which has its own answers. A controller
   * holding a view it no longer has would go on casting rays through a camera that is not
   * drawing anything.
   */
  view?: () => TableView | undefined
}

export interface CueController {
  aim: AimState
  destroy: () => void
  setCuePosition: (x: number, y: number) => void
  /**
   * Re-reads the aim from a mouse pointer that is resting over the table.
   *
   * The pointer is cast through the live camera, so when the camera pans under a pointer
   * that has not moved, the spot under it has. Called once a frame, this keeps the aim on
   * what the pointer is actually over instead of leaving it behind until the next move
   * and then jumping. Does nothing mid-gesture, with no mouse over the table, or while the
   * visit cannot be played.
   */
  refreshAim: () => void
  /**
   * Plays the shot as it is set right now, exactly as a release on the cue ball would.
   * For the power slider, which is let go of to shoot. Does nothing when the visit
   * cannot be played.
   */
  shoot: () => void
  /** Eases the power back to rest, for between shots. */
  resetPower: () => void
  /**
   * Stops the controller from writing power at all, for as long as the slider owns
   * the value. While locked, the eased reset animation is cancelled where it stands
   * rather than left decaying underneath the drag, and presses, wheel and +/- keys
   * are refused, so no other gesture can stomp the number the slider just wrote.
   */
  lockPower: () => void
  /** Hands power writes back to the canvas gestures. */
  unlockPower: () => void
}

/**
 * Power gained per second of holding. Starting from the current power a full-power
 * shot takes roughly 0.9s, which is long enough to see the meter climb and short
 * enough that a quick tap still plays the shot.
 */
const POWER_PER_SECOND = 0.65
/**
 * How far the pointer may drift before the gesture is read as "setting power by
 * dragging" rather than "holding to charge".
 */
const CHARGE_DEADZONE_PX = 6
/** Releasing further than this from the cue ball is a cancellation, not a shot. */
const SHOOT_RADIUS_PX = 12
/**
 * The primary button, the one that aims, charges and fires. A bitmask against
 * `PointerEvent.buttons`, where bit 0 is the primary button.
 */
const PRIMARY_BUTTON = 1
/**
 * `PointerEvent.button` for the right button: the one held to drag the camera round,
 * not to aim. Note this is the `button` property value, not the `buttons` bitmask.
 */
const BUTTON_RIGHT = 2
/**
 * `PointerEvent.button` for the middle button, the other one that may drag the
 * camera. Again the `button` property value — a middle press reports 1 here and 4
 * in the `buttons` bitmask — which is why the two constants must not be shared.
 */
const BUTTON_MIDDLE = 1
/**
 * How far behind the cue ball the cue axis is sampled to find its direction on screen.
 *
 * A couple of ball diameters is enough to be well clear of the projection's own precision
 * without reaching so far that the point behind the ball would fall outside the frame.
 */
const AXIS_PROBE_MM = BALL_RADIUS * 4
/**
 * How far the aim turns for a pixel of finger travel, in radians, at a brisk drag.
 *
 * The same figure the game turns its camera by for a pixel of look-around drag. It has to
 * be: on a touch screen one drag does both — the aim turns and the camera turns with it —
 * and if the two disagreed the cue would slide off the line of sight as the finger moved.
 */
const TOUCH_AIM_RAD_PER_PX = Math.PI / 900
/**
 * A slow drag turns the aim more finely than a fast one.
 *
 * Under this many pixels a move, the turn is scaled down towards the floor: a quick
 * swipe swings the cue round the table, a careful creep of the finger trims a thin cut.
 */
const TOUCH_FINE_BELOW_PX = 7
const TOUCH_FINE_FLOOR = 0.3

export function createCueController(options: CueControllerOptions): CueController {
  const aim: AimState = { angle: 0, power: 0, spinX: 0, spinY: 0 }
  let cue = options.cuePosition
  let dragging = false
  /** Set once the pointer moves far enough to mean "drag to set power". */
  let settingPowerByDrag = false
  let holdOrigin = { x: 0, y: 0 }
  let chargeFrame = 0
  /** The power the current gesture started from, so Escape and a deadzone exit can restore it. */
  let powerAtPress = 0
  /**
   * The aim axis, frozen when the drag gesture starts.
   *
   * Freezing it is what makes the two-way drag steady. Aiming follows the pointer, so
   * a live axis would rotate under the drag and the power would chase it; fixed at
   * the start of the gesture, the distance the pointer has travelled along the cue is
   * the power, and it only goes up or down as the player moves.
   */
  let dragAxis = { x: 1, y: 0, originPx: 0 }
  let resetFrame = 0
  /**
   * True while the power slider owns the value.
   *
   * The controller is the usual writer — charging, dragging, wheel, keys, the eased
   * reset after a shot — and every one of those would otherwise be free to move the
   * number while the player's finger is still on the slider handle. The lock is what
   * makes the slider's writes stick for the whole gesture instead of being fought
   * by whichever animation happened to be running.
   */
  let powerLocked = false
  /** True while a right- or middle-button drag is turning the camera. */
  let orbiting = false
  /** The horizontal pixel the orbit drag started from, so deltas are measured from it. */
  let orbitOriginX = 0
  /**
   * The finger that is turning the aim, and where it was last seen, or null.
   *
   * A finger does not point at a spot the way a mouse does: it covers what it is on, and
   * it cannot hover. So a touch aims by how far it has moved, not by where it is — drag
   * left and right anywhere on the table and the cue turns, with the view turning with it.
   * It never charges power and never fires; on a touch screen that is the slider's job.
   */
  let touch: { id: number; x: number } | null = null
  /**
   * Where a mouse was last seen hovering over the table with no button held, or null.
   *
   * Mouse only: a finger has no hover, and a touch that has lifted is not still pointing
   * at anything.
   */
  let hover: { clientX: number; clientY: number } | null = null

  function pointerInCanvas(event: { clientX: number; clientY: number }): { px: number; py: number; rect: DOMRect } {
    const rect = options.canvas.getBoundingClientRect()
    const px = ((event.clientX - rect.left) / rect.width) * options.canvas.width
    const py = ((event.clientY - rect.top) / rect.height) * options.canvas.height
    return { px, py, rect }
  }

  /**
   * Where a point on the cloth is drawn.
   *
   * Two questions get asked this way and they are not the same: the screen direction the
   * cue points in (which has to survive the camera's foreshortening), and the cue ball's own
   * position (which decides whether a release was a shot or a cancellation).
   */
  function tableToScreen(x: number, y: number): { x: number; y: number } | null {
    const view = options.view?.()
    if (view) return view.tableToScreen(x, y)
    return tableToCanvas(x, y)
  }

  /** The cue ball's drawn position. */
  function cueOnScreen(): { x: number; y: number } {
    // A point the lens cannot see is behind the camera, which cannot happen to the cue ball
    // while it is on the table and being aimed at — but the fallback keeps the old flat
    // projection rather than losing the cue ball off the edge of the frame if it ever did.
    return tableToScreen(cue.x, cue.y) ?? tableToCanvas(cue.x, cue.y)
  }

  /**
   * The direction the cue points, in pixels.
   *
   * With a 3D view this is read off the projection, because the screen angle and the aim
   * angle only agree from directly overhead. Without one, the flat projection is the view,
   * so the aim angle is its own screen direction.
   */
  function axisPixels(angle: number): { x: number; y: number } {
    const flat = { x: Math.cos(angle), y: Math.sin(angle) }
    if (!options.view?.()) return flat
    return cueAxisPixels(cue, angle, AXIS_PROBE_MM, tableToScreen) ?? flat
  }

  /**
   * How near the cue ball a release has to be to count as firing.
   *
   * The ball's own drawn size, so the target stays the same physical gesture in every view:
   * a ball close to the lens in the aim view covers far more pixels than one at the far
   * cushion, and a fixed pixel radius would be a tap tolerance on one and a slap on the
   * other. The floor keeps a distant ball comfortably tappable on a touch screen.
   */
  function shootRadiusPx(): number {
    const view = options.view?.()
    if (!view) return SHOOT_RADIUS_PX
    return Math.max(SHOOT_RADIUS_PX, view.ballRadiusPx(cue.x, cue.y, BALL_RADIUS))
  }

  function pointerAngle(event: { clientX: number; clientY: number }): number {
    const { px, py } = pointerInCanvas(event)
    const view = options.view?.()
    if (view) {
      const picked = view.screenToTable(px, py)
      // Above the horizon there is no answer, and the honest thing to do with no answer is
      // nothing: the aim stays where the player last put it rather than snapping.
      const angle = picked ? aimAngleTo(cue, picked) : null
      return angle ?? aim.angle
    }
    const target = cueOnScreen()
    return Math.atan2(py - target.y, px - target.x)
  }

  /**
   * Builds power for as long as the pointer is held still. This is the gesture
   * the player is asked to use; a tap simply fires at whatever power it had
   * reached, so the control stays usable for quick shots.
   */
  function startCharging(): void {
    if (chargeFrame) return
    let previous = performance.now()
    const step = (now: number): void => {
      // A tab switch or a long stall must not dump a huge jump into the charge.
      const dt = Math.min(0.1, (now - previous) / 1000)
      previous = now
      if (!dragging || settingPowerByDrag || powerLocked) {
        chargeFrame = 0
        return
      }
      aim.power = Math.min(1, aim.power + POWER_PER_SECOND * dt)
      options.onChange({ ...aim })
      chargeFrame = requestAnimationFrame(step)
    }
    chargeFrame = requestAnimationFrame(step)
  }

  function stopCharging(): void {
    if (!chargeFrame) return
    cancelAnimationFrame(chargeFrame)
    chargeFrame = 0
  }

  function stopReset(): void {
    if (!resetFrame) return
    cancelAnimationFrame(resetFrame)
    resetFrame = 0
  }

  function handleMove(event: { clientX: number; clientY: number }): void {
    // A visit that cannot be played has no aim to set: the balls may be mid-shot, the
    // visit may be somebody else's. Holding the aim still is what keeps the angle the
    // player last set intact for when their visit does come round.
    if (!options.enabled()) return
    aim.angle = pointerAngle(event)
    if (dragging) {
      if (
        !settingPowerByDrag &&
        Math.hypot(event.clientX - holdOrigin.x, event.clientY - holdOrigin.y) > CHARGE_DEADZONE_PX
      ) {
        // Deliberate movement: hand power over to the drag gesture from here so
        // both ways of setting power stay available. The axis is captured here, at
        // the moment the gesture is recognised, and not before, so a player who only
        // nudged the pointer never accidentally changed their power.
        settingPowerByDrag = true
        stopCharging()
        const { px, py } = pointerInCanvas(event)
        const target = cueOnScreen()
        const axis = axisPixels(aim.angle)
        // The axis is the direction the cue points as it is drawn, and where the pointer
        // sits along it is measured from the cue ball, so the gesture is "how far off the
        // ball am I" rather than "where on the table is my cursor".
        dragAxis = {
          x: axis.x,
          y: axis.y,
          originPx: (px - target.x) * axis.x + (py - target.y) * axis.y
        }
      }
      if (settingPowerByDrag) {
        const { px, py } = pointerInCanvas(event)
        const target = cueOnScreen()
        const along = (px - target.x) * dragAxis.x + (py - target.y) * dragAxis.y
        // Positive when the pointer has travelled back along the cue, which is the
        // direction that adds power.
        aim.power = powerFromDrag(dragAxis.originPx - along, powerAtPress)
      }
    }
    options.onChange({ ...aim })
  }

  const onPointerMove = (event: PointerEvent) => {
    if (touch && event.pointerId === touch.id) {
      const dx = event.clientX - touch.x
      touch.x = event.clientX
      if (dx === 0 || !options.enabled()) return
      const fine = Math.max(TOUCH_FINE_FLOOR, Math.min(1, Math.abs(dx) / TOUCH_FINE_BELOW_PX))
      const turn = dx * fine
      aim.angle += turn * TOUCH_AIM_RAD_PER_PX
      // The view turns by the same amount, so the cue stays straight up the screen.
      options.onOrbit?.(turn)
      options.onChange({ ...aim })
      return
    }
    // Any other finger says nothing: a second one down, or one that started while the visit
    // could not be played. A touch never aims by where it is.
    if (event.pointerType === 'touch') return
    // The orbit drag comes first: while the camera gesture is live, every move is a
    // look-around step and says nothing about the shot.
    if (orbiting) {
      options.onOrbit?.(event.clientX - orbitOriginX)
      orbitOriginX = event.clientX
      return
    }
    // The aim is the primary button's gesture. If a button is held and it is not the
    // primary one — most importantly the right button — this move says nothing about
    // the shot: the angle stays where the player left it rather than swinging with a
    // button that is being held for the camera. No button held is a hover, which aims.
    // `buttons` is a bitmask here, unlike `button` above: bit 0 is the primary button.
    const buttons = event.buttons ?? PRIMARY_BUTTON
    if (buttons !== 0 && (buttons & PRIMARY_BUTTON) === 0) return
    hover = event.pointerType === 'mouse' && buttons === 0 ? { clientX: event.clientX, clientY: event.clientY } : null
    handleMove(event)
  }
  const onPointerLeave = () => {
    hover = null
  }
  const onPointerDown = (event: PointerEvent) => {
    hover = null
    // A right- or middle-button press anywhere on the canvas is the camera's gesture,
    // and it never aims, charges or fires. The look-around is consumed as horizontal
    // drag pixels by the caller; the browser's own menu on the same button is refused
    // so the drag can run undisturbed.
    if (event.button === BUTTON_RIGHT || event.button === BUTTON_MIDDLE) {
      if (!options.onOrbit) return
      event.preventDefault()
      orbiting = true
      orbitOriginX = event.clientX
      options.canvas.setPointerCapture(event.pointerId)
      return
    }
    // A second gesture starting on the canvas while the slider is mid-drag would
    // stomp `aim.power` with its press default — and possibly fire a shot on release —
    // over the top of the value the player is setting on the rail. The canvas simply
    // refuses to join a power drag it does not own.
    if (!options.enabled() || powerLocked) return
    if (event.pointerType === 'touch') {
      // One finger at a time turns the aim; a second one down is ignored.
      if (touch) return
      touch = { id: event.pointerId, x: event.clientX }
      options.canvas.setPointerCapture(event.pointerId)
      event.preventDefault()
      return
    }
    dragging = true
    settingPowerByDrag = false
    holdOrigin = { x: event.clientX, y: event.clientY }
    stopReset()
    // A press picks the power up from the default a tap has always used, so the
    // quick-shot gesture plays the same shot it did before the bar started at rest.
    powerAtPress = aim.power > 0 ? aim.power : POWER_RESTING_DEFAULT
    aim.power = powerAtPress
    options.canvas.setPointerCapture(event.pointerId)
    handleMove(event)
    startCharging()
    event.preventDefault()
  }
  const onPointerUp = (event: PointerEvent) => {
    if (orbiting && (event.button === BUTTON_RIGHT || event.button === BUTTON_MIDDLE)) {
      orbiting = false
      return
    }
    if (touch && event.pointerId === touch.id) {
      touch = null
      return
    }
    if (!dragging) return
    dragging = false
    stopCharging()
    if (!options.enabled()) return
    const { px, py } = pointerInCanvas(event)
    const target = cueOnScreen()
    if (Math.hypot(px - target.x, py - target.y) > shootRadiusPx()) {
      // Released away from the ball, so the gesture was setting power and not firing.
      options.onChange({ ...aim })
      return
    }
    options.onShoot({ aimAngle: aim.angle, power: aim.power, spin: { x: aim.spinX, y: aim.spinY } })
  }
  const onPointerCancel = (event: PointerEvent) => {
    touch = null
    orbiting = false
    dragging = false
    stopCharging()
    event.preventDefault()
  }
  const onWheel = (event: WheelEvent) => {
    if (!options.enabled() || powerLocked) return
    // The page cannot scroll on the table, so a wheel gesture here has nothing else
    // to do. Fine steps only: this trims a power that is already set, and a notch
    // should not be able to send a shot from a full swing to a tap.
    event.preventDefault()
    const direction = event.deltaY < 0 ? 1 : -1
    aim.power = powerAdjust(aim.power, direction * POWER_FINE_STEP)
    options.onChange({ ...aim })
  }
  const onKeyDown = (event: KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowDown':
        // Power trimming, not spin: the up/down arrows are the keyboard's power
        // control, stepped and clamped, and they must not touch the aim angle.
        // Vertical spin lives on W/S now, which keeps every spin axis on the keys
        // a hand already rests near while the arrows do the thing they visibly
        // control on screen.
        if (!options.enabled() || powerLocked) return
        event.preventDefault()
        stopReset()
        aim.power = powerAfterArrow(aim.power, event.key === 'ArrowUp' ? 1 : -1)
        break
      case 'ArrowLeft':
        aim.spinX = Math.max(-1, aim.spinX - 0.2)
        break
      case 'ArrowRight':
        aim.spinX = Math.min(1, aim.spinX + 0.2)
        break
      case 'w':
      case 'W':
        aim.spinY = Math.min(1, aim.spinY + 0.2)
        break
      case 's':
      case 'S':
        aim.spinY = Math.max(-1, aim.spinY - 0.2)
        break
      case '+':
      case '=':
        if (!options.enabled() || powerLocked) return
        event.preventDefault()
        stopReset()
        aim.power = powerAdjust(aim.power, POWER_FINE_STEP)
        break
      case '-':
      case '_':
        if (!options.enabled() || powerLocked) return
        event.preventDefault()
        stopReset()
        aim.power = powerAdjust(aim.power, -POWER_FINE_STEP)
        break
      case 'Escape':
        // Abandons the charge in progress and puts the power back where it was
        // before the press, without playing a shot.
        if (!dragging) return
        event.preventDefault()
        dragging = false
        settingPowerByDrag = false
        stopCharging()
        aim.power = powerAtPress
        options.onChange({ ...aim })
        return
      case ' ':
        event.preventDefault()
        // Refused while the slider owns power, same as a canvas press: the two input
        // paths do not run over each other mid-gesture.
        if (options.enabled() && !powerLocked) {
          options.onShoot({ aimAngle: aim.angle, power: aim.power, spin: { x: aim.spinX, y: aim.spinY } })
        }
        return
      default:
        return
    }
    options.onChange({ ...aim })
  }

  options.canvas.style.touchAction = 'none'
  options.canvas.addEventListener('pointermove', onPointerMove)
  options.canvas.addEventListener('pointerdown', onPointerDown)
  options.canvas.addEventListener('pointerup', onPointerUp)
  options.canvas.addEventListener('pointercancel', onPointerCancel)
  options.canvas.addEventListener('pointerleave', onPointerLeave)
  // The right button drags the camera. The menu the browser would open on its release
  // would swallow the gesture's own pointerup and leave the drag half-finished, so it
  // is refused where it would appear.
  const onContextMenu = (event: MouseEvent): void => {
    if (options.onOrbit) event.preventDefault()
  }
  options.canvas.addEventListener('contextmenu', onContextMenu)
  options.canvas.addEventListener('wheel', onWheel, { passive: false })
  window.addEventListener('keydown', onKeyDown)

  return {
    aim,
    destroy: () => {
      stopCharging()
      stopReset()
      options.canvas.removeEventListener('pointermove', onPointerMove)
      options.canvas.removeEventListener('pointerdown', onPointerDown)
      options.canvas.removeEventListener('pointerup', onPointerUp)
      options.canvas.removeEventListener('pointercancel', onPointerCancel)
      options.canvas.removeEventListener('pointerleave', onPointerLeave)
      options.canvas.removeEventListener('contextmenu', onContextMenu)
      options.canvas.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
    },
    setCuePosition: (x: number, y: number) => {
      cue = { x, y }
    },
    refreshAim: () => {
      if (!hover || dragging || orbiting || !options.enabled()) return
      aim.angle = pointerAngle(hover)
    },
    shoot: () => {
      if (!options.enabled()) return
      options.onShoot({ aimAngle: aim.angle, power: aim.power, spin: { x: aim.spinX, y: aim.spinY } })
    },
    resetPower: () => {
      // The slider owns the value while locked; an eased decay running underneath a
      // drag is exactly the "handle drops back down on its own" bug.
      if (powerLocked) return
      stopReset()
      if (aim.power <= 0) return
      // Eased rather than cleared: the bar sliding down to rest reads as the shot
      // being spent, where a jump to zero reads as the control having broken.
      let display = aim.power
      const from = display
      const step = (): void => {
        display = from * 0.82
        aim.power = display < 0.01 ? 0 : display
        options.onChange({ ...aim })
        resetFrame = aim.power > 0 ? requestAnimationFrame(step) : 0
      }
      resetFrame = requestAnimationFrame(step)
    },
    lockPower: () => {
      powerLocked = true
      // A reset animation already in flight would keep multiplying `aim.power` down
      // on its own frames — the lock cancels it where it stands rather than letting
      // it run to zero under the drag.
      stopReset()
    },
    unlockPower: () => {
      powerLocked = false
    }
  }
}
