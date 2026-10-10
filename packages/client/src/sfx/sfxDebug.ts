import type { SfxRuntime } from './index.js'
import { emitSfx } from './sfxEvents.js'
import { SFX_CONFIG, type RecipeParams } from './sfxConfig.js'

/**
 * The tuning panel. Only ever loaded with `?sfxdebug=1` in the address: without it this
 * file is not fetched, so it costs the game nothing and changes nothing on screen.
 *
 * Every button goes through the same door the game uses, `emitSfx`, so what is heard here
 * is what a real event of that kind will sound like — the thresholds, the layers, the
 * burst rule and the limiter are all in the path.
 */

const VMAX = SFX_CONFIG.vmax
const MID_X = SFX_CONFIG.halfLength

const RECIPE_FIELDS: Array<[keyof RecipeParams, string]> = [
  ['baseFreqMin', 'base Hz min'],
  ['baseFreqMax', 'base Hz max'],
  ['decayMs', 'decay ms'],
  ['noiseLevel', 'noise level'],
  ['lowpassBase', 'low-pass base Hz'],
  ['lowpassRange', 'low-pass + per strength'],
  ['bodyFreqMin', 'body Hz min'],
  ['bodyFreqMax', 'body Hz max'],
  ['bodyDecayMs', 'body decay ms'],
  ['bodyLevel', 'body level'],
  ['lengthMs', 'length ms']
]

function el<K extends keyof HTMLElementTagNameMap>(tag: K, style = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (style) node.style.cssText = style
  if (text) node.textContent = text
  return node
}

export function mountSfxDebug(runtime: SfxRuntime): () => void {
  const root = el(
    'div',
    'position:fixed;left:8px;bottom:8px;z-index:99999;width:330px;max-height:92vh;overflow:auto;padding:10px;' +
      'background:rgba(10,14,20,.94);color:#e6edf3;font:12px/1.35 system-ui,sans-serif;border:1px solid #2b3644;border-radius:8px'
  )
  root.id = 'sfx-debug'
  const timers: number[] = []
  let frame = 0

  const row = (label: string): HTMLDivElement => {
    const wrap = el('div', 'margin:6px 0')
    wrap.appendChild(el('div', 'opacity:.7;margin-bottom:3px', label))
    root.appendChild(wrap)
    return wrap
  }
  const button = (parent: HTMLElement, label: string, run: () => void): void => {
    const b = el('button', 'margin:0 4px 4px 0;padding:4px 8px;background:#1f2a37;color:inherit;border:1px solid #3a4758;border-radius:5px;cursor:pointer', label)
    b.type = 'button'
    b.onclick = () => {
      try {
        run()
      } catch {
        // A debug button never takes the page down.
      }
    }
    parent.appendChild(b)
  }
  const slider = (parent: HTMLElement, label: string, min: number, max: number, value: number, onInput: (v: number) => void): void => {
    const wrap = el('label', 'display:flex;align-items:center;gap:6px;margin:2px 0')
    const name = el('span', 'width:92px', label)
    const input = el('input', 'flex:1')
    input.type = 'range'
    input.min = String(min)
    input.max = String(max)
    input.step = '0.5'
    input.value = String(value)
    const out = el('span', 'width:44px;text-align:right', String(value))
    input.oninput = () => {
      out.textContent = input.value
      onInput(Number(input.value))
    }
    wrap.append(name, input, out)
    parent.appendChild(wrap)
  }

  root.appendChild(el('div', 'font-weight:700;margin-bottom:4px', `SFX debug — tier ${runtime.tier}`))
  const status = el('div', 'opacity:.75')
  root.appendChild(status)

  const speeds: Array<[string, number]> = [
    ['soft', 0.08],
    ['medium', 0.3],
    ['hard', 0.9]
  ]
  const cue = row('Cue strike')
  for (const [name, k] of speeds) button(cue, name, () => emitSfx({ type: 'cueStrike', power: k, x: MID_X, z: 0 }))
  const ball = row('Ball on ball')
  let pair = 100
  for (const [name, k] of speeds) {
    // A fresh pair each press, so the cooldown for a real pair does not swallow the test.
    button(ball, name, () => emitSfx({ type: 'ballBall', idA: pair++, idB: pair++, speed: k * VMAX, x: MID_X, z: 0 }))
  }
  const cushion = row('Cushion')
  let cushionBall = 500
  for (const [name, k] of speeds) button(cushion, name, () => emitSfx({ type: 'cushion', ballId: cushionBall++, speed: k * VMAX, x: MID_X * 1.8, z: 0 }))
  const pocket = row('Pocket / other')
  let pottedBall = 900
  button(pocket, 'pocket (with jaw)', () => emitSfx({ type: 'pocket', ballId: pottedBall++, pocketIndex: 0, speed: 0.2 * VMAX, x: MID_X * 2, jaw: true }))
  button(pocket, 'pocket (clean)', () => emitSfx({ type: 'pocket', ballId: pottedBall++, pocketIndex: 0, speed: 0.12 * VMAX, x: 0 }))
  button(pocket, 'break-off', () => {
    // About thirty impacts in a second, the pack bursting: the test for the burst rule.
    for (let i = 0; i < 30; i++) {
      const at = Math.pow(i / 30, 1.6) * 1000
      timers.push(
        window.setTimeout(() => {
          const speed = (0.75 - (i / 30) * 0.6) * VMAX
          if (i % 5 === 4) emitSfx({ type: 'cushion', ballId: 2000 + i, speed, x: MID_X * (0.4 + (i % 7) * 0.2), z: 0 })
          else emitSfx({ type: 'ballBall', idA: 3000 + i * 2, idB: 3001 + i * 2, speed, x: MID_X * (1.3 + (i % 5) * 0.1), z: 0 })
        }, at)
      )
    }
  })
  for (const sound of ['uiClick', 'uiHover', 'placeTick', 'turnTick', 'chalk', 'foul'] as const) {
    button(pocket, sound, () => emitSfx({ type: 'aux', sound }))
  }

  const roll = row('Rolling (one ball, speed as a share of max)')
  let rollSpeed = 0
  slider(roll, 'speed %', 0, 60, 0, (v) => {
    rollSpeed = v / 100
  })
  timers.push(
    window.setInterval(() => {
      if (rollSpeed > 0 || rolling) {
        rolling = rollSpeed > 0
        emitSfx({ type: 'rollTick', balls: rollSpeed > 0 ? [{ id: 9999, speed: rollSpeed * VMAX, x: MID_X, z: 0 }] : [] })
      }
    }, 40)
  )
  let rolling = false

  const mix = row('Mix (dB)')
  slider(mix, 'master', -30, 0, SFX_CONFIG.masterDb, (v) => runtime.engine.setMasterDb(v))
  slider(mix, 'sfx bus', -30, 6, SFX_CONFIG.busDb.sfx, (v) => runtime.engine.setBusDb('sfx', v))
  slider(mix, 'rolling bus', -30, 6, SFX_CONFIG.busDb.rolling, (v) => runtime.engine.setBusDb('rolling', v))
  slider(mix, 'ui bus', -30, 6, SFX_CONFIG.busDb.ui, (v) => runtime.engine.setBusDb('ui', v))

  const meterRow = row('Master peak')
  const meterText = el('div', 'font-variant-numeric:tabular-nums', '-inf dBFS')
  const meterBar = el('div', 'height:8px;background:#1f2a37;border-radius:4px;overflow:hidden;margin-top:3px')
  const meterFill = el('div', 'height:100%;width:0;background:#3ddc84')
  meterBar.appendChild(meterFill)
  meterRow.append(meterText, meterBar)
  let held = -Infinity
  let heldAt = 0
  const draw = (): void => {
    const now = performance.now()
    const peak = runtime.engine.peakDb()
    if (peak > held || now - heldAt > 1500) {
      held = peak
      heldAt = now
    }
    meterText.textContent = `${Number.isFinite(held) ? held.toFixed(1) : '-inf'} dBFS (peak hold)   voices ${runtime.engine.activeVoices()}`
    meterFill.style.width = `${Math.max(0, Math.min(100, ((peak + 60) / 60) * 100))}%`
    meterFill.style.background = peak > -1 ? '#ff4d4d' : peak > -6 ? '#ffb020' : '#3ddc84'
    status.textContent = `${runtime.engine.audible() ? 'audible' : 'not audible (click anywhere, or unmute)'} · ${runtime.pendingRenders()} rendering · ${runtime.recordedBuffers()} recorded`
    frame = requestAnimationFrame(draw)
  }
  frame = requestAnimationFrame(draw)

  const editor = row('Recipe editor')
  const select = el('select', 'margin-bottom:6px;background:#1f2a37;color:inherit;border:1px solid #3a4758;border-radius:5px;padding:3px')
  for (const type of Object.keys(SFX_CONFIG.recipes)) {
    const option = el('option', '', type)
    option.value = type
    select.appendChild(option)
  }
  const fields = el('div')
  const fill = (): void => {
    fields.replaceChildren()
    const recipe = SFX_CONFIG.recipes[select.value as keyof typeof SFX_CONFIG.recipes]
    for (const [key, label] of RECIPE_FIELDS) {
      const wrap = el('label', 'display:flex;align-items:center;gap:6px;margin:2px 0')
      const input = el('input', 'width:80px;background:#0d131a;color:inherit;border:1px solid #3a4758;border-radius:4px;padding:2px 4px')
      input.type = 'number'
      input.step = 'any'
      input.value = String(recipe[key])
      input.onchange = () => {
        const value = Number(input.value)
        if (Number.isFinite(value)) recipe[key] = value
      }
      wrap.append(el('span', 'flex:1', label), input)
      fields.appendChild(wrap)
    }
  }
  select.onchange = fill
  fill()
  editor.append(select, fields)
  button(editor, 're-render', () => runtime.rerender(select.value as keyof typeof SFX_CONFIG.recipes))
  button(editor, 'copy recipe as JSON', () => {
    const type = select.value as keyof typeof SFX_CONFIG.recipes
    const text = JSON.stringify({ [type]: SFX_CONFIG.recipes[type] }, null, 2)
    void navigator.clipboard?.writeText(text).catch(() => undefined)
    output.value = text
  })
  const output = el('textarea', 'width:100%;height:70px;margin-top:4px;background:#0d131a;color:inherit;border:1px solid #3a4758;border-radius:4px')
  output.readOnly = true
  editor.appendChild(output)

  document.body.appendChild(root)

  return () => {
    cancelAnimationFrame(frame)
    for (const id of timers) {
      clearTimeout(id)
      clearInterval(id)
    }
    root.remove()
  }
}
