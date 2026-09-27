import { TABLE_LENGTH, TABLE_WIDTH, BALL_RADIUS } from '@snooker/shared'

export interface DrawableBall {
  id: number
  x: number
  y: number
  potted: boolean
}

export interface FrameSnapshotData {
  turnIndex: number
  ballOn: string
  scores: { player0: number; player1: number }
  breakScore: number
  remainingReds: number
  balls: DrawableBall[]
  phase?: string
  cueInHand?: boolean
}

export interface AimState {
  angle: number
  power: number
  spinX?: number
  spinY?: number
}

const BALL_COLORS: Record<number, string> = {
  0: '#f7f7f2',
  16: '#f4c430',
  17: '#1b7f46',
  18: '#8a4b23',
  19: '#1e6fd9',
  20: '#f0709c',
  21: '#171717'
}

const RED = '#d62828'
const BALL_VALUE_LABEL: Record<number, number> = { 16: 2, 17: 3, 18: 4, 19: 5, 20: 6, 21: 7 }

interface TableTransform {
  offsetX: number
  offsetY: number
  scale: number
}

let currentTransform: TableTransform = { offsetX: 0, offsetY: 0, scale: 0 }
let lastInterpTime = 0
const interpPos = new Map<number, { x: number; y: number }>()

export function setTableTransform(transform: TableTransform): void {
  currentTransform = transform
}

export function tableToCanvas(x: number, y: number): { x: number; y: number } {
  return { x: currentTransform.offsetX + x * currentTransform.scale, y: currentTransform.offsetY + y * currentTransform.scale }
}

export interface RenderOptions {
  aim?: AimState
  youSeat?: number
}

const POCKETS = [
  { x: 0, y: 0 },
  { x: TABLE_LENGTH / 2, y: 0 },
  { x: TABLE_LENGTH, y: 0 },
  { x: 0, y: TABLE_WIDTH },
  { x: TABLE_LENGTH / 2, y: TABLE_WIDTH },
  { x: TABLE_LENGTH, y: TABLE_WIDTH }
]

export function drawTable(
  canvas: HTMLCanvasElement,
  snapshot: FrameSnapshotData | null,
  options: RenderOptions = {}
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const frameWidth = canvas.width
  const frameHeight = canvas.height
  const margin = 56
  const innerW = frameWidth - margin * 2
  const innerH = frameHeight - margin * 2
  const scale = Math.min(innerW / TABLE_LENGTH, innerH / TABLE_WIDTH)
  const offsetX = (frameWidth - TABLE_LENGTH * scale) / 2
  const offsetY = (frameHeight - TABLE_WIDTH * scale) / 2
  currentTransform = { offsetX, offsetY, scale }

  ctx.clearRect(0, 0, frameWidth, frameHeight)

  ctx.fillStyle = '#331d0d'
  ctx.fillRect(0, 0, frameWidth, frameHeight)

  const frameGrad = ctx.createLinearGradient(0, offsetY - 30, 0, offsetY + TABLE_WIDTH * scale + 30)
  frameGrad.addColorStop(0, '#4a2c16')
  frameGrad.addColorStop(0.5, '#3c2415')
  frameGrad.addColorStop(1, '#2f1a0c')
  ctx.fillStyle = frameGrad
  ctx.fillRect(offsetX - 26, offsetY - 26, TABLE_LENGTH * scale + 52, TABLE_WIDTH * scale + 52)

  ctx.fillStyle = '#0a6e3e'
  ctx.fillRect(offsetX, offsetY, TABLE_LENGTH * scale, TABLE_WIDTH * scale)

  const felt = ctx.createRadialGradient(
    offsetX + TABLE_LENGTH * scale * 0.5,
    offsetY + TABLE_WIDTH * scale * 0.35,
    TABLE_LENGTH * scale * 0.1,
    offsetX + TABLE_LENGTH * scale * 0.5,
    offsetY + TABLE_WIDTH * scale * 0.5,
    TABLE_LENGTH * scale * 0.75
  )
  felt.addColorStop(0, 'rgba(40, 150, 85, 0.20)')
  felt.addColorStop(1, 'rgba(0, 0, 0, 0.5)')
  ctx.fillStyle = felt
  ctx.fillRect(offsetX, offsetY, TABLE_LENGTH * scale, TABLE_WIDTH * scale)

  ctx.strokeStyle = '#c9a227'
  ctx.lineWidth = 3
  ctx.strokeRect(offsetX + 1.5, offsetY + 1.5, TABLE_LENGTH * scale - 3, TABLE_WIDTH * scale - 3)

  for (const pocket of POCKETS) {
    drawPocket(ctx, offsetX + pocket.x * scale, offsetY + pocket.y * scale, scale)
  }

  if (!snapshot) return

  const now = performance.now()
  const dt = lastInterpTime ? Math.min(0.1, (now - lastInterpTime) / 1000) : 0
  lastInterpTime = now
  const k = dt ? 1 - Math.exp(-dt * 14) : 1

  const highlightBallId = resolveHighlight(snapshot)
  const alive = new Set<number>()

  for (const ball of snapshot.balls) {
    if (ball.potted) continue
    alive.add(ball.id)
    const tx = ball.x
    const ty = ball.y
    const prev = interpPos.get(ball.id)
    let px = tx
    let py = ty
    if (prev) {
      px = prev.x + (tx - prev.x) * k
      py = prev.y + (ty - prev.y) * k
    }
    interpPos.set(ball.id, { x: px, y: py })
    drawBall(ctx, offsetX + px * scale, offsetY + py * scale, scale, ball.id, ball.id === highlightBallId)
  }
  for (const id of [...interpPos.keys()]) {
    if (!alive.has(id)) interpPos.delete(id)
  }

  const cueBall = snapshot.balls.find((b) => b.id === 0 && !b.potted)
  if (options.aim && options.youSeat !== undefined && cueBall) {
    const myTurn = snapshot.turnIndex === options.youSeat
    if (myTurn) {
      const interp = interpPos.get(0)
      const cx = interp ? interp.x : cueBall.x
      const cy = interp ? interp.y : cueBall.y
      drawAim(ctx, offsetX + cx * scale, offsetY + cy * scale, scale, options.aim)
    }
  }

  drawHud(ctx, frameWidth, snapshot, options)
}

function resolveHighlight(snapshot: FrameSnapshotData): number | null {
  if (snapshot.ballOn === 'RED') return null
  const match = /colour:(\d+)/.exec(snapshot.ballOn)
  if (match) return Number(match[1])
  return null
}

function drawHud(
  ctx: CanvasRenderingContext2D,
  frameWidth: number,
  snapshot: FrameSnapshotData,
  options: RenderOptions
): void {
  const you = options.youSeat === 1 ? snapshot.scores.player1 : snapshot.scores.player0
  const opp = options.youSeat === 1 ? snapshot.scores.player0 : snapshot.scores.player1
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.fillRect(0, 0, frameWidth, 36)
  ctx.fillStyle = '#f0b429'
  ctx.font = 'bold 15px system-ui'
  ctx.textAlign = 'left'
  ctx.fillText(`YOU: ${you}`, 18, 24)
  ctx.textAlign = 'right'
  ctx.fillText(`OPPONENT: ${opp}`, frameWidth - 18, 24)
  ctx.textAlign = 'center'
  ctx.font = '13px system-ui'
  ctx.fillStyle = 'rgba(230,237,243,0.9)'
  ctx.fillText(
    `${ballOnLabel(snapshot.ballOn)}  ·  break ${snapshot.breakScore}  ·  ${snapshot.remainingReds} reds`,
    frameWidth / 2,
    24
  )
  if (options.youSeat !== undefined) {
    if (snapshot.cueInHand) {
      ctx.font = 'bold 12px system-ui'
      ctx.fillStyle = '#f0b429'
      ctx.textAlign = 'right'
      ctx.fillText('BALL IN HAND — place cue in the D', frameWidth - 18, 60)
    } else {
      const mine = snapshot.turnIndex === options.youSeat
      ctx.font = 'bold 12px system-ui'
      ctx.fillStyle = mine ? '#2ea043' : '#8b949e'
      ctx.textAlign = 'right'
      ctx.fillText(mine ? 'YOUR TURN' : 'WAITING', frameWidth - 18, 60)
    }
  }
}

function ballOnLabel(ballOn: string): string {
  if (ballOn === 'RED') return 'Ball on: RED'
  const match = /colour:(\d+)/.exec(ballOn)
  if (match) {
    const value = BALL_VALUE_LABEL[Number(match[1])]
    return value ? `Ball on: ${value}-point colour` : 'Ball on: colour'
  }
  return 'Ball on: colour'
}

function drawPocket(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number): void {
  const r = 5.2 * BALL_RADIUS * scale * 0.28
  ctx.fillStyle = '#0b0b0b'
  ctx.beginPath()
  ctx.arc(x, y, Math.max(r, 4), 0, Math.PI * 2)
  ctx.fill()
}

function drawBall(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  id: number,
  highlight: boolean
): void {
  const r = BALL_RADIUS * scale
  const color = BALL_COLORS[id] ?? RED
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  if (highlight) {
    ctx.strokeStyle = '#f0b429'
    ctx.lineWidth = 3
    ctx.stroke()
  }
  const gloss = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r)
  gloss.addColorStop(0, 'rgba(255,255,255,0.85)')
  gloss.addColorStop(0.35, 'rgba(255,255,255,0.08)')
  gloss.addColorStop(1, 'rgba(0,0,0,0.3)')
  ctx.fillStyle = gloss
  ctx.fill()
}

function drawAim(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, aim: AimState): void {
  const length = (40 + aim.power * 150) * scale * 0.018
  const endX = x + Math.cos(aim.angle) * length
  const endY = y + Math.sin(aim.angle) * length
  ctx.strokeStyle = `rgba(255,255,255,${0.45 + aim.power * 0.35})`
  ctx.lineWidth = 2
  ctx.setLineDash([6, 6])
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(endX, endY)
  ctx.stroke()
  ctx.setLineDash([])
  const glowR = 5 * scale * 0.5 * (0.8 + aim.power * 0.9)
  const glow = ctx.createRadialGradient(endX, endY, 1, endX, endY, glowR * 2.2)
  glow.addColorStop(0, 'rgba(255,215,120,0.55)')
  glow.addColorStop(1, 'rgba(255,215,120,0)')
  ctx.fillStyle = glow
  ctx.beginPath()
  ctx.arc(endX, endY, glowR * 2.2, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.55)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(endX, endY, glowR, 0, Math.PI * 2)
  ctx.stroke()
  const spinX = aim.spinX ?? 0
  const spinY = aim.spinY ?? 0
  const spinMag = Math.hypot(spinX, spinY)
  if (spinMag > 0.01) {
    const px = -Math.sin(aim.angle)
    const py = Math.cos(aim.angle)
    const off = (spinX * 14 + spinY * 6) * scale * 0.5
    const sx = endX + px * off
    const sy = endY + py * off
    ctx.strokeStyle = 'rgba(240,180,41,0.9)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(endX, endY)
    ctx.lineTo(sx, sy)
    ctx.stroke()
  }
}