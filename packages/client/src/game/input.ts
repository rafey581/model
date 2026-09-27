import type { ShotInput } from '@snooker/shared'
import { tableToCanvas } from './renderer.js'

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
}

/** The floor a shot always has, matching the minimum the drag gesture can reach. */
const POWER_MIN = 0.05
/**
 * Power gained per second of holding. Starting from the current power (0.4 by
 * default) a full-power shot takes roughly 0.9s, which is long enough to see the
 * meter climb and short enough that a quick tap still plays the shot.
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
  const aim: AimState = { angle: 0, power: 0.4, spinX: 0, spinY: 0 }
  let cue = options.cuePosition
  let dragging = false
  /** Set once the pointer moves far enough to mean "drag to set power". */
  let settingPowerByDrag = false
  let holdOrigin = { x: 0, y: 0 }
  let chargeFrame = 0

  function pointerAngle(event: { clientX: number; clientY: number }): number {
    const rect = options.canvas.getBoundingClientRect()
    const px = ((event.clientX - rect.left) / rect.width) * options.canvas.width
    const py = ((event.clientY - rect.top) / rect.height) * options.canvas.height
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

  function handleMove(event: { clientX: number; clientY: number }): void {
    aim.angle = pointerAngle(event)
    if (dragging) {
      if (
        !settingPowerByDrag &&
        Math.hypot(event.clientX - holdOrigin.x, event.clientY - holdOrigin.y) > CHARGE_DEADZONE_PX
      ) {
        // Deliberate movement: hand power over to the drag gesture from here so
        // both ways of setting power stay available.
        settingPowerByDrag = true
        stopCharging()
      }
      if (settingPowerByDrag) {
        const rect = options.canvas.getBoundingClientRect()
        const py = ((event.clientY - rect.top) / rect.height) * options.canvas.height
        const target = tableToCanvas(cue.x, cue.y)
        aim.power = Math.min(1, Math.max(POWER_MIN, ((target.y - py) / options.canvas.height) * 2))
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
    const rect = options.canvas.getBoundingClientRect()
    const px = ((event.clientX - rect.left) / rect.width) * options.canvas.width
    const py = ((event.clientY - rect.top) / rect.height) * options.canvas.height
    const target = tableToCanvas(cue.x, cue.y)
    if (Math.hypot(px - target.x, py - target.y) > SHOOT_RADIUS_PX) {
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
  window.addEventListener('keydown', onKeyDown)

  return {
    aim,
    destroy: () => {
      stopCharging()
      options.canvas.removeEventListener('pointermove', onPointerMove)
      options.canvas.removeEventListener('pointerdown', onPointerDown)
      options.canvas.removeEventListener('pointerup', onPointerUp)
      options.canvas.removeEventListener('pointercancel', onPointerCancel)
      window.removeEventListener('keydown', onKeyDown)
    },
    setCuePosition: (x: number, y: number) => {
      cue = { x, y }
    }
  }
}