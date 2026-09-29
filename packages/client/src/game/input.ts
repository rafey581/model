import type { ShotInput } from '@snooker/shared'
import { tableToCanvas } from './renderer.js'
import { POWER_FINE_STEP, POWER_RESTING_DEFAULT, powerAdjust, powerFromDrag } from './power.js'

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
}

export interface CueController {
  aim: AimState
  destroy: () => void
  setCuePosition: (x: number, y: number) => void
  /** Eases the power back to rest, for between shots. */
  resetPower: () => void
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

  function pointerInCanvas(event: { clientX: number; clientY: number }): { px: number; py: number; rect: DOMRect } {
    const rect = options.canvas.getBoundingClientRect()
    const px = ((event.clientX - rect.left) / rect.width) * options.canvas.width
    const py = ((event.clientY - rect.top) / rect.height) * options.canvas.height
    return { px, py, rect }
  }

  function pointerAngle(event: { clientX: number; clientY: number }): number {
    const { px, py } = pointerInCanvas(event)
    const target = tableToCanvas(cue.x, cue.y)
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
      if (!dragging || settingPowerByDrag) {
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
        const target = tableToCanvas(cue.x, cue.y)
        // The axis is the direction the cue points, and where the pointer sits along
        // it is measured from the cue ball, so the gesture is "how far off the ball am
        // I" rather than "where on the table is my cursor".
        dragAxis = {
          x: Math.cos(aim.angle),
          y: Math.sin(aim.angle),
          originPx: (px - target.x) * Math.cos(aim.angle) + (py - target.y) * Math.sin(aim.angle)
        }
      }
      if (settingPowerByDrag) {
        const { px, py } = pointerInCanvas(event)
        const target = tableToCanvas(cue.x, cue.y)
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
    if (!options.enabled()) return
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
    const target = tableToCanvas(cue.x, cue.y)
    if (Math.hypot(px - target.x, py - target.y) > SHOOT_RADIUS_PX) {
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
    if (!options.enabled()) return
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
        aim.spinY = Math.min(1, aim.spinY + 0.2)
        break
      case 'ArrowDown':
        aim.spinY = Math.max(-1, aim.spinY - 0.2)
        break
      case 'ArrowLeft':
        aim.spinX = Math.max(-1, aim.spinX - 0.2)
        break
      case 'ArrowRight':
        aim.spinX = Math.min(1, aim.spinX + 0.2)
        break
      case '+':
      case '=':
        if (!options.enabled()) return
        event.preventDefault()
        stopReset()
        aim.power = powerAdjust(aim.power, POWER_FINE_STEP)
        break
      case '-':
      case '_':
        if (!options.enabled()) return
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
        if (options.enabled()) {
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
    }
  }
}
