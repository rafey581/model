import type { ShotInput } from '@snooker/shared'
import { BALL_RADIUS } from '@snooker/shared'
import { tableToCanvas } from './renderer.js'
import { aimAngleTo, ballRadiusPx, cueAxisPixels } from './cameraPick.js'
import { POWER_ARROW_STEP, POWER_FINE_STEP, POWER_RESTING_DEFAULT, powerAdjust, powerFromDrag } from './power.js'

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
 * How far behind the cue ball the cue axis is sampled to find its direction on screen.
 *
 * A couple of ball diameters is enough to be well clear of the projection's own precision
 * without reaching so far that the point behind the ball would fall outside the frame.
 */
const AXIS_PROBE_MM = BALL_RADIUS * 4

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

  const onPointerMove = (event: PointerEvent) => handleMove(event)
  const onPointerDown = (event: PointerEvent) => {
    // A second gesture starting on the canvas while the slider is mid-drag would
    // stomp `aim.power` with its press default — and possibly fire a shot on release —
    // over the top of the value the player is setting on the rail. The canvas simply
    // refuses to join a power drag it does not own.
    if (!options.enabled() || powerLocked) return
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
        aim.power = powerAdjust(aim.power, event.key === 'ArrowUp' ? POWER_ARROW_STEP : -POWER_ARROW_STEP)
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
      options.canvas.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
    },
    setCuePosition: (x: number, y: number) => {
      cue = { x, y }
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
