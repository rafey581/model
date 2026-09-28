import { TABLE_LENGTH, TABLE_WIDTH, BALL_RADIUS, pocketPositions } from '@snooker/shared'
import { computeAimGuide, objectDirection, type AimGuide } from './aim.js'

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

/**
 * Forgets every drawn ball position, so the next frame places balls exactly where
 * the rules say rather than easing them in from the last table that was on screen.
 * Called when leaving a match.
 */
export function resetTableAnimation(): void {
  interpPos.clear()
  lastInterpTime = 0
}

export interface RenderOptions {
  aim?: AimState
  youSeat?: number
  /**
   * Draw the given positions with no smoothing. Used while a streamed shot is
   * playing back, where the positions are already sampled from the simulation
   * and must not lag the replay clock.
   */
  immediate?: boolean
  /**
   * Whether the player is allowed to aim right now, which is the table being
   * settled and the visit being theirs.
   *
   * This is deliberately not the same question as "is it my turn". The turn index
   * does not change while a player keeps a visit, so a turn test alone would let
   * the cue and the aim guide be drawn on a cue ball that is still travelling.
   * With this false the aim guide and the cue stick are both suppressed, which is
   * what keeps the cue from riding a moving ball.
   */
  canAim?: boolean
}

const POCKETS = pocketPositions()

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
      drawPocket(ctx, offsetX + pocket.x * scale, offsetY + pocket.y * scale, scale, pocket.radius)
  }

  if (!snapshot) return

  const now = performance.now()
  const dt = lastInterpTime ? Math.min(0.1, (now - lastInterpTime) / 1000) : 0
  lastInterpTime = now
  const k = options.immediate ? 1 : dt ? 1 - Math.exp(-dt * 14) : 1

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
    // A ball with no drawn position yet is a newly racked or newly respotted ball,
    // so it appears where the rules put it rather than sliding in from wherever the
    // previous shot or previous match last left it. A jump of more than 500mm is
    // likewise a re-rack rather than travel, and snaps for the same reason the 3D
    // view snaps. Only genuine movement is smoothed.
    if (prev && options.immediate !== true && Math.hypot(tx - prev.x, ty - prev.y) <= 500) {
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
    if (myTurn && options.canAim !== false) {
      const interp = interpPos.get(0)
      const cx = interp ? interp.x : cueBall.x
      const cy = interp ? interp.y : cueBall.y
      // Aimed from the cue ball's drawn position, so the guide tracks the ball
      // while it is still settling rather than jumping to the snapshot.
      const guide = computeAimGuide({ x: cx, y: cy, id: 0 }, options.aim.angle, snapshot.balls)
      drawAim(ctx, offsetX + cx * scale, offsetY + cy * scale, offsetX, offsetY, scale, options.aim, guide)
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

function drawPocket(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, radius: number): void {
  ctx.fillStyle = '#0b0b0b'
  ctx.beginPath()
  ctx.arc(x, y, Math.max(radius * scale, 4), 0, Math.PI * 2)
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

/**
 * Draws where the cue ball itself goes after the contact, turning where it meets a
 * cushion.
 *
 * This is a separate claim from the two above: the dotted line says where the cue
 * ball is going, the arrow says where the ball it hits is going, and this says
 * where the cue ball ends up. On a full ball there is nothing to draw, because the
 * cue ball stops dead on the spot, and showing a path there would be a lie.
 *
 * Drawn in a cooler, thinner line than the object-ball arrow so the two departures
 * are never read as one, and dashed so a path crossing the aim line still reads as a
 * crossing rather than a junction.
 */
function drawCuePath(
  ctx: CanvasRenderingContext2D,
  offsetX: number,
  offsetY: number,
  scale: number,
  guide: AimGuide
): void {
  if (guide.cuePath.length === 0) return

  ctx.strokeStyle = 'rgba(150,205,255,0.75)'
  ctx.lineWidth = 1.5
  ctx.setLineDash([3, 5])
  ctx.beginPath()
  ctx.moveTo(offsetX + guide.cuePath[0]!.from.x * scale, offsetY + guide.cuePath[0]!.from.y * scale)
  for (const segment of guide.cuePath) {
    ctx.lineTo(offsetX + segment.to.x * scale, offsetY + segment.to.y * scale)
  }
  ctx.stroke()
  ctx.setLineDash([])

  // A small tick at the end so the path reads as a route with a destination rather
  // than as a stray line across the cloth.
  const last = guide.cuePath[guide.cuePath.length - 1]!
  const tipX = offsetX + last.to.x * scale
  const tipY = offsetY + last.to.y * scale
  ctx.fillStyle = 'rgba(150,205,255,0.85)'
  ctx.beginPath()
  ctx.arc(tipX, tipY, 2.5 * scale * 0.5, 0, Math.PI * 2)
  ctx.fill()
}

/**
 * Draws the aim. With a ball in the way it is two lines: a dotted line from the
 * cue ball out to the exact point the cue ball touches it, and a solid arrow
 * continuing past that point along the line of centres to show which way the
 * struck ball will leave. With nothing in the way there is only the dotted line
 * and a small tip marker, because there is no contact to predict.
 */
function drawAim(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  offsetX: number,
  offsetY: number,
  scale: number,
  aim: AimState,
  guide: AimGuide | null
): void {
  // With a ball in the way the line runs out to the exact point the cue ball
  // touches it. With clear table ahead the line shows direction only, and grows
  // with power so the player can still read how hard the shot is.
  const openLength = (150 + aim.power * 330) * scale
  const endX = guide ? offsetX + guide.contact.x * scale : x + Math.cos(aim.angle) * openLength
  const endY = guide ? offsetY + guide.contact.y * scale : y + Math.sin(aim.angle) * openLength

  ctx.strokeStyle = `rgba(255,255,255,${0.45 + aim.power * 0.35})`
  ctx.lineWidth = 2
  ctx.setLineDash([6, 6])
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(endX, endY)
  ctx.stroke()
  ctx.setLineDash([])

  if (guide) {
    drawContactMarker(ctx, offsetX, offsetY, scale, guide)
    drawCuePath(ctx, offsetX, offsetY, scale, guide)
  } else {
    // Nothing to contact, so there is no contact dot, no ring and no object-ball
    // arrow -- just a soft cap marking where the line stops.
    const glowR = 5 * scale * 0.5 * (0.8 + aim.power * 0.9)
    const glow = ctx.createRadialGradient(endX, endY, 1, endX, endY, glowR * 2.2)
    glow.addColorStop(0, 'rgba(255,215,120,0.55)')
    glow.addColorStop(1, 'rgba(255,215,120,0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(endX, endY, glowR * 2.2, 0, Math.PI * 2)
    ctx.fill()
  }

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

/**
 * Marks the contact and predicts what happens next: a ring round the target ball
 * so it is obvious which one is being aimed at, a filled dot on the exact point
 * the cue ball will touch it, and an arrow leaving that point along the line of
 * centres showing the direction the struck ball will travel.
 */
function drawContactMarker(
  ctx: CanvasRenderingContext2D,
  offsetX: number,
  offsetY: number,
  scale: number,
  guide: AimGuide
): void {
  // The guide works in table millimetres, so everything is offset from the table
  // origin rather than from the cue ball.
  const cx = offsetX + guide.contact.x * scale
  const cy = offsetY + guide.contact.y * scale
  // The contact point sits on the target's surface, so the target's own centre is
  // one radius further along the line of centres.
  const ballX = cx + guide.lineOfCentres.x * BALL_RADIUS * scale
  const ballY = cy + guide.lineOfCentres.y * BALL_RADIUS * scale
  const ringR = BALL_RADIUS * scale

  ctx.strokeStyle = 'rgba(255,255,255,0.35)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(ballX, ballY, ringR, 0, Math.PI * 2)
  ctx.stroke()

  // The object-ball departure: the line of centres continued out of the contact
  // point, arrowhead on the end. Drawn solid and in the target's own cue colour so
  // it reads as a different fact from the white dotted aim line.
  const arrow = objectDirection(guide)
  const tipX = offsetX + arrow.to.x * scale
  const tipY = offsetY + arrow.to.y * scale
  ctx.strokeStyle = 'rgba(255,215,120,0.95)'
  ctx.lineWidth = 2.5
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.lineTo(tipX, tipY)
  ctx.moveTo(tipX, tipY)
  ctx.lineTo(offsetX + arrow.barbs[0].x * scale, offsetY + arrow.barbs[0].y * scale)
  ctx.moveTo(tipX, tipY)
  ctx.lineTo(offsetX + arrow.barbs[1].x * scale, offsetY + arrow.barbs[1].y * scale)
  ctx.stroke()
  ctx.lineCap = 'butt'

  ctx.fillStyle = 'rgba(255,255,255,0.95)'
  ctx.beginPath()
  ctx.arc(cx, cy, 3.5 * scale * 0.5, 0, Math.PI * 2)
  ctx.fill()
}