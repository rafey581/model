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

export function createCueController(options: CueControllerOptions): CueController {
  const aim: AimState = { angle: 0, power: 0.4, spinX: 0, spinY: 0 }
  let cue = options.cuePosition
  let dragging = false

  function pointerAngle(event: { clientX: number; clientY: number }): number {
    const rect = options.canvas.getBoundingClientRect()
    const px = ((event.clientX - rect.left) / rect.width) * options.canvas.width
    const py = ((event.clientY - rect.top) / rect.height) * options.canvas.height
    const target = tableToCanvas(cue.x, cue.y)
    return Math.atan2(py - target.y, px - target.x)
  }

  function handleMove(event: MouseEvent): void {
    aim.angle = pointerAngle(event)
    if (dragging) {
      const rect = options.canvas.getBoundingClientRect()
      const py = ((event.clientY - rect.top) / rect.height) * options.canvas.height
      const target = tableToCanvas(cue.x, cue.y)
      aim.power = Math.min(1, Math.max(0.05, ((target.y - py) / options.canvas.height) * 2))
    }
    options.onChange({ ...aim })
  }

  const onMouseMove = (event: MouseEvent) => handleMove(event)
  const onMouseDown = (event: MouseEvent) => {
    if (!options.enabled()) return
    dragging = true
    handleMove(event)
    event.preventDefault()
  }
  const onMouseUp = (event: MouseEvent) => {
    if (!dragging) return
    dragging = false
    if (!options.enabled()) return
    const rect = options.canvas.getBoundingClientRect()
    const px = ((event.clientX - rect.left) / rect.width) * options.canvas.width
    const py = ((event.clientY - rect.top) / rect.height) * options.canvas.height
    const target = tableToCanvas(cue.x, cue.y)
    if (Math.hypot(px - target.x, py - target.y) > 12) {
      options.onChange({ ...aim })
      return
    }
    options.onShoot({ aimAngle: aim.angle, power: aim.power, spin: { x: aim.spinX, y: aim.spinY } })
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

  options.canvas.addEventListener('mousemove', onMouseMove)
  options.canvas.addEventListener('mousedown', onMouseDown)
  options.canvas.addEventListener('mouseup', onMouseUp)
  window.addEventListener('keydown', onKeyDown)

  return {
    aim,
    destroy: () => {
      options.canvas.removeEventListener('mousemove', onMouseMove)
      options.canvas.removeEventListener('mousedown', onMouseDown)
      options.canvas.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('keydown', onKeyDown)
    },
    setCuePosition: (x: number, y: number) => {
      cue = { x, y }
    }
  }
}