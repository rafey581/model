import { createFrame, applyStroke } from '@snooker/shared'
import type { FrameState } from '@snooker/shared'
import { TABLE_LENGTH, TABLE_WIDTH, BALL_IDS, COLOR_NAMES } from '@snooker/shared'

export interface ReplayEvent {
  seq: number
  type: string
  data: unknown
}

interface ShotPlayed {
  seq: number
  byIndex: number
  shot: { aimAngle: number; power: number; spin: { x: number; y: number }; timestamp?: number; cuePos?: { x: number; y: number } }
}

function collectShots(events: ReplayEvent[]): ShotPlayed[] {
  const shots: ShotPlayed[] = []
  for (const event of events) {
    if (event.type !== 'SHOT') continue
    const data = event.data as { shot?: ShotPlayed['shot']; byIndex?: number }
    if (!data?.shot) continue
    shots.push({ seq: event.seq, byIndex: data.byIndex ?? 0, shot: data.shot })
  }
  return shots
}

function ballColor(id: number): string {
  if (id === BALL_IDS.CUE) return '#f0e6d6'
  if (id >= BALL_IDS.RED_MIN && id <= BALL_IDS.RED_MAX) return '#c0392b'
  const name = COLOR_NAMES[id]
  switch (name) {
    case 'yellow':
      return '#f1c40f'
    case 'green':
      return '#27ae60'
    case 'brown':
      return '#8d5524'
    case 'blue':
      return '#2980b9'
    case 'pink':
      return '#e84393'
    case 'black':
      return '#1f1f1f'
    default:
      return '#888'
  }
}

function drawFrame(canvas: HTMLCanvasElement, frame: FrameState): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const pad = 6
  const scale = (canvas.height - pad * 2) / TABLE_WIDTH
  const width = TABLE_LENGTH * scale
  const xOff = (canvas.width - width) / 2
  const yOff = pad
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#0e5c3f'
  ctx.fillRect(xOff, yOff, width, canvas.height - yOff * 2)
  ctx.strokeStyle = '#f0c987'
  ctx.lineWidth = 3
  ctx.strokeRect(xOff, yOff, width, canvas.height - yOff * 2)
  const rail = 4
  ctx.fillStyle = '#7b4a1d'
  ctx.fillRect(xOff - rail, yOff - rail, width + rail * 2, canvas.height - yOff * 2 + rail * 2)
  ctx.fillStyle = '#0e5c3f'
  ctx.fillRect(xOff, yOff, width, canvas.height - yOff * 2)
  for (const ball of frame.balls) {
    if (ball.potted) continue
    const x = xOff + ball.pos.x * scale
    const y = yOff + ball.pos.y * scale
    const r = 5.5
    ctx.beginPath()
    ctx.fillStyle = ballColor(ball.id)
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
    if (ball.isCue) {
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1
      ctx.stroke()
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.55)'
      ctx.beginPath()
      ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.28, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

function frameAt(events: ReplayEvent[], step: number): { frame: FrameState; startSeq: number; endSeq: number } | null {
  const shots = collectShots(events)
  if (shots.length === 0) return null
  const frames: FrameState[] = []
  const seqBounds: Array<{ start: number; end: number }> = []
  let breakIndex = 0
  let frame = createFrame(breakIndex)
  for (const shot of shots) {
    const before = shot.seq
    applyStroke(frame, frame.turnIndex, shot.shot)
    frames.push(frame)
    const nextEvent = events.find((e) => e.seq > shot.seq && (e.type === 'SHOT' || e.type === 'FRAME_END'))
    if (nextEvent?.type === 'FRAME_END') {
      const frameEndData = nextEvent.data as { winnerIndex?: number; winnerSeat?: number }
      const winnerIndex = frameEndData.winnerIndex ?? frameEndData.winnerSeat
      breakIndex = winnerIndex === 0 || winnerIndex === 1 ? 1 - winnerIndex : breakIndex
      frame = createFrame(breakIndex)
    }
    seqBounds.push({ start: before, end: nextEvent ? nextEvent.seq : Number.MAX_SAFE_INTEGER })
  }
  const idx = Math.min(Math.max(0, step), frames.length - 1)
  const target = frames[idx]
  const bounds = seqBounds[idx]
  if (!target || !bounds) return null
  return { frame: target, startSeq: bounds.start, endSeq: bounds.end }
}

const BALL_NAMES: Record<number, string> = { [BALL_IDS.CUE]: 'cue', ...COLOR_NAMES }

function eventLabel(event: ReplayEvent): string {
  const data = event.data as Record<string, unknown> | null
  if (event.type === 'SHOT' && data?.shot) {
    const shot = data.shot as { aimAngle?: number; power?: number }
    return `player ${String(data.byIndex)} aims ${Number(shot.aimAngle ?? 0).toFixed(2)}`
  }
  if (event.type === 'FOUL') return `player ${String(data?.byIndex ?? data?.bySeat)} foul (+${String(data?.penalty)})`
  if (event.type === 'BALL_POTTED') {
    const ballId = data?.ballId as number | undefined
    return `pot ${ballId !== undefined ? (BALL_NAMES[ballId] ?? String(ballId)) : '?'}`
  }
  if (event.type === 'TURN_CHANGE') return `turn -> player ${String(data?.turnSeat ?? data?.turnIndex)}`
  if (event.type === 'FRAME_END') return `frame won by player ${String(data?.winnerIndex)}`
  if (event.type === 'MATCH_END') return `match won by player ${String(data?.winnerIndex)} (${String(data?.reason)})`
  return `${event.type} ${JSON.stringify(event.data ?? {})}`
}

export function renderReplayViewer(events: ReplayEvent[]): HTMLElement {
  const wrap = el('div', 'replay')
  const canvas = el('canvas') as HTMLCanvasElement
  canvas.width = 640
  canvas.height = 340
  const shots = collectShots(events)
  const steps = Math.max(shots.length, 1)
  let step = 0
  let playing = false
  let timer: ReturnType<typeof setInterval> | null = null

  const status = el('div', 'replay-status')
  const controls = el('div', 'replay-controls')
  const summary = el('div', 'muted', `${events.length} events · ${shots.length} strokes`)

  const render = (): void => {
    const snap = frameAt(events, step)
    if (snap) drawFrame(canvas, snap.frame)
    status.textContent = snap
      ? `stroke ${Math.min(step + 1, steps)}/${steps} · seq ${snap.startSeq}-${snap.endSeq}`
      : `stroke ${step + 1}/${steps}`
    const list = wrap.querySelector('.replay-events')
    if (list) {
      const nodes = list.querySelectorAll('.replay-event')
      let activeSeq = snap?.startSeq ?? 0
      nodes.forEach((node) => {
        const s = Number((node as HTMLElement).dataset.seq)
        node.classList.toggle('active', s === activeSeq)
        node.classList.toggle('dimmed', s < activeSeq)
      })
    }
    const btn = controls.querySelector('[data-act="toggle"]')
    if (btn) (btn as HTMLButtonElement).textContent = playing ? 'Pause' : 'Play'
  }

  const setStep = (next: number): void => {
    step = Math.min(Math.max(0, next), steps - 1)
    render()
    const slider = controls.querySelector('input[type=range]') as HTMLInputElement
    if (slider) slider.value = String(step)
  }

  const startTimer = (): void => {
    if (timer) return
    timer = setInterval(() => {
      if (step >= steps - 1) {
        playing = false
        if (timer) clearInterval(timer)
        timer = null
        render()
        return
      }
      setStep(step + 1)
    }, 650)
  }

  const stopTimer = (): void => {
    if (timer) clearInterval(timer)
    timer = null
  }

  const mkButton = (label: string, action: () => void, dataAct?: string): HTMLButtonElement => {
    const b = el('button', 'ghost', label) as HTMLButtonElement
    if (dataAct) b.dataset.act = dataAct
    b.onclick = action
    return b
  }

  controls.appendChild(mkButton('|<', () => setStep(0)))
  controls.appendChild(
    mkButton(
      'Play',
      () => {
        playing = !playing
        if (playing) startTimer()
        else {
          stopTimer()
          render()
        }
      },
      'toggle'
    )
  )
  controls.appendChild(mkButton('<', () => setStep(step - 1)))
  controls.appendChild(mkButton('>', () => setStep(step + 1)))
  controls.appendChild(mkButton('>|', () => setStep(steps - 1)))

  const slider = el('input') as HTMLInputElement
  slider.type = 'range'
  slider.min = '0'
  slider.max = String(steps - 1)
  slider.value = '0'
  slider.oninput = () => setStep(Number(slider.value))
  controls.appendChild(slider)

  const list = el('div', 'replay-events')
  for (const event of events) {
    const line = el('div', 'replay-event')
    line.dataset.seq = String(event.seq)
    line.appendChild(el('span', 'admin-event-seq', String(event.seq)))
    line.appendChild(el('span', undefined, eventLabel(event)))
    list.appendChild(line)
  }

  wrap.append(canvas, controls, status, summary)
  wrap.appendChild(list)
  render()
  return wrap
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}