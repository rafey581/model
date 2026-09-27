import type { Server } from 'socket.io'
import {
  createMatch,
  createFrame,
  newFrameForMatch,
  applyStroke,
  applyFrameWinner,
  applyTimeoutFoul,
  maybeEndFrame,
  matchWinnerIndex,
  frameSnapshot,
  seededRandom
} from '@snooker/shared'
import type { MatchState, FrameState, ShotInput } from '@snooker/shared'
import type { PracticeAiLevel } from '@snooker/shared'
import { computeBotShot } from '../bot/bot.js'
import { config } from '../config.js'

export interface GameUpdateEvent {
  matchId: string
  seq: number
  type: string
  data: unknown
}

export interface RoomCallbacks {
  board: Server
  persist: (events: GameUpdateEvent[]) => Promise<void>
  onFrameEnd: (matchId: string, frameWinner: number, scores: { player0: number; player1: number }) => Promise<void>
  onMatchEnd: (matchId: string, matchWinner: number, reason: string) => Promise<void>
  log: (msg: string) => void
}

export type ShotInputDto = Pick<ShotInput, 'aimAngle' | 'power' | 'spin' | 'cuePos'>

export class GameRoom {
  readonly matchId: string
  readonly matchType: string
  readonly aiLevel?: PracticeAiLevel
  match: MatchState
  seatOfUser = new Map<string, number>()
  socketIds = new Map<number, Set<string>>()
  started = false
  stopped = false
  private seq = 0
  private simulating = false
  private botTimer: NodeJS.Timeout | null = null
  private turnTimer: NodeJS.Timeout | null = null
  private readonly turnTimeoutSec: number
  private callbacks: RoomCallbacks
  private disconnectedAt = new Map<number, number>()
  private deliveredSeqByUser = new Map<string, number>()

  constructor(
    matchId: string,
    matchType: string,
    format: string,
    breakFirst = 0,
    aiLevel?: PracticeAiLevel,
    callbacks?: RoomCallbacks,
    turnTimeoutSec?: number
  ) {
    this.matchId = matchId
    this.matchType = matchType
    this.aiLevel = aiLevel
    this.callbacks = callbacks ?? defaultCallbacks()
    this.turnTimeoutSec = turnTimeoutSec ?? config.MATCH_TURN_TIMEOUT_SEC
    this.match = createMatch(matchId, matchType, format)
    this.match.currentFrame = createFrame(breakFirst)
  }

  registerSocket(userId: string, seat: number, socketId: string): void {
    this.seatOfUser.set(userId, seat)
    const set = this.socketIds.get(seat) ?? new Set<string>()
    set.add(socketId)
    this.socketIds.set(seat, set)
    if (this.disconnectedAt.delete(seat)) {
      this.broadcast('opponent:reconnected', { seat })
    }
    this.armTurnTimer()
  }

  unregisterSocket(userId: string, socketId: string): void {
    const seat = this.seatOfUser.get(userId)
    if (seat === undefined) return
    const set = this.socketIds.get(seat)
    if (set) {
      set.delete(socketId)
      if (set.size === 0) {
        this.disconnectedAt.set(seat, Date.now())
        this.callbacks.log(`${userId} disconnected from ${this.matchId}`)
        this.broadcast('opponent:disconnected', { seat })
      }
    }
  }

  getSeat(userId: string): number | undefined {
    return this.seatOfUser.get(userId)
  }

  isSeatDisconnected(seat: number): boolean {
    return this.disconnectedAt.has(seat)
  }

  connectedSeats(): number[] {
    const seats = new Set<number>(this.seatOfUser.values())
    return [...seats].filter((s) => !this.disconnectedAt.has(s))
  }

  disconnectedSeats(): number[] {
    const seats = new Set<number>(this.seatOfUser.values())
    return [...seats].filter((s) => this.disconnectedAt.has(s))
  }

  userIdForSeat(seat: number): string | undefined {
    for (const [userId, s] of this.seatOfUser) {
      if (s === seat) return userId
    }
    return undefined
  }

  currentSeq(): number {
    return this.seq
  }

  deliveredSeqForUser(userId: string): number {
    return this.deliveredSeqByUser.get(userId) ?? 0
  }

  snapshot() {
    const frame = this.match.currentFrame
    return frame ? frameSnapshot(frame) : null
  }

  allUsers(): string[] {
    return [...this.seatOfUser.keys()]
  }

  tryStart(): boolean {
    if (this.started) return false
    const ready = this.matchType === 'PRACTICE' || this.seatOfUser.size >= 2
    if (!ready) return false
    this.started = true
    this.broadcast('match:start', { snapshot: this.snapshot(), frameIndex: this.match.frameIndex + 1 })
    this.armTurnTimer()
    this.scheduleBotIfNeeded()
    return true
  }

  isBotTurn(): boolean {
    const frame = this.match.currentFrame
    if (!frame) return false
    return this.matchType === 'PRACTICE' && frame.turnIndex === 1
  }

  private isHumanTurn(seat: number): boolean {
    if (this.matchType !== 'PRACTICE') return true
    return seat !== 1
  }

  private armTurnTimer(): void {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer)
      this.turnTimer = null
    }
    if (!this.started || this.stopped) return
    const frame = this.match.currentFrame
    if (!frame || frame.phase === 'FRAME_END') return
    const seat = frame.turnIndex
    if (!this.isHumanTurn(seat) || this.isSeatDisconnected(seat)) return
    if (this.turnTimeoutSec <= 0) return
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null
      this.onTurnTimeout()
    }, this.turnTimeoutSec * 1000)
  }

  private onTurnTimeout(): void {
    if (this.stopped || this.simulating) return
    const frame = this.match.currentFrame
    if (!frame || frame.phase === 'FRAME_END') return
    const seat = frame.turnIndex
    if (!this.isHumanTurn(seat) || this.isSeatDisconnected(seat)) return
    this.simulating = true
    try {
      const { foulValue, reason } = applyTimeoutFoul(frame, seat, 'turn timeout')
      const events = [
        this.event('FOUL', { penalty: foulValue, reason, bySeat: seat }),
        this.event('TURN_CHANGE', { turnSeat: frame.turnIndex })
      ]
      const end = maybeEndFrame(frame)
      this.commit(events, frame, end.frameEnded, end.frameWinner)
      this.callbacks.log(`turn timed out for seat ${seat} on ${this.matchId}`)
    } finally {
      this.simulating = false
    }
  }

  handleShot(userId: string, shot: ShotInputDto): { accepted: boolean; error?: string } {
    const frame = this.match.currentFrame
    if (!frame) return { accepted: false, error: 'frame not running' }
    const seat = this.seatOfUser.get(userId)
    if (seat === undefined) return { accepted: false, error: 'not in match' }
    if (seat !== frame.turnIndex) return { accepted: false, error: 'not your turn' }
    if (this.simulating) return { accepted: false, error: 'balls still moving' }
    if (this.isBotTurn()) return { accepted: false, error: 'robot is thinking' }
    return this.executeShot(seat, shot)
  }

  handleBotShot(shot: ShotInputDto): void {
    this.executeShot(1, shot)
  }

  private executeShot(seat: number, shot: ShotInputDto): { accepted: boolean; error?: string } {
    const frame = this.match.currentFrame
    if (!frame) return { accepted: false, error: 'frame not running' }
    if (this.simulating) return { accepted: false, error: 'busy' }
    this.simulating = true
    try {
      const normalized: ShotInput = {
        aimAngle: shot.aimAngle ?? 0,
        power: Math.min(1, Math.max(0, shot.power ?? 0)),
        spin: { x: shot.spin.x ?? 0, y: shot.spin.y ?? 0 },
        timestamp: 0,
        cuePos: shot.cuePos ?? undefined
      }
      const outcome = applyStroke(frame, seat, normalized)
      const events: GameUpdateEvent[] = []
      for (const id of outcome.sim.pottedIds) {
        events.push(this.event('BALL_POTTED', { ballId: id, bySeat: seat }))
      }
      if (outcome.resolution.foul) {
        events.push(this.event('FOUL', { penalty: outcome.resolution.foulValue, reason: outcome.resolution.reason, bySeat: seat }))
      }
      if (outcome.resolution.turnSwitches) {
        events.push(this.event('TURN_CHANGE', { turnSeat: frame.turnIndex }))
      }
      this.commit(events, frame, outcome.frameEnded, outcome.frameWinner)
      return { accepted: true }
    } finally {
      this.simulating = false
    }
  }

  private commit(events: GameUpdateEvent[], frame: FrameState, frameEnded: boolean, frameWinner: number | null): void {
    this.noteDelivered(events)
    void this.callbacks.persist(events)
    if (frameEnded && frameWinner !== null) {
      void this.handleFrameEnd(frameWinner, frame)
    } else {
      this.broadcast('game:update', { frame: frameSnapshot(frame), events })
      this.armTurnTimer()
      this.scheduleBotIfNeeded()
    }
  }

  private async handleFrameEnd(frameWinner: number, endedFrame: FrameState): Promise<void> {
    const scores = { player0: endedFrame.scores.player0, player1: endedFrame.scores.player1 }
    const frameEnd = this.event('FRAME_END', { winnerSeat: frameWinner, scores })
    this.noteDelivered([frameEnd])
    this.broadcast('game:update', {
      frame: frameSnapshot(endedFrame),
      events: [frameEnd]
    })
    void this.callbacks.persist([frameEnd])
    await this.callbacks.onFrameEnd(this.matchId, frameWinner, scores)

    const matchEnded = applyFrameWinner(this.match, frameWinner)
    if (matchEnded) {
      const winner = matchWinnerIndex(this.match)
      this.broadcast('match:end', { winnerSeat: winner, framesWon: this.match.framesWon })
      await this.callbacks.onMatchEnd(this.matchId, winner, 'frames')
    } else {
      const nextBreak = frameWinner === 0 ? 1 : 0
      const nextFrame = newFrameForMatch(this.match, nextBreak)
      this.broadcast('frame:start', {
        frameIndex: this.match.frameIndex + 1,
        snapshot: frameSnapshot(nextFrame)
      })
      this.armTurnTimer()
      this.scheduleBotIfNeeded()
    }
  }

  handleConcede(userId: string): string | null {
    const seat = this.seatOfUser.get(userId)
    if (seat === undefined) return null
    const winnerSeat = seat === 0 ? 1 : 0
    const winnerUserId = [...this.seatOfUser.entries()].find(([, s]) => s === winnerSeat)?.[0] ?? null
    if (winnerUserId) {
      this.broadcast('match:end', { winnerSeat, reason: 'concede' })
      void this.callbacks.onMatchEnd(this.matchId, winnerSeat, 'concede')
    }
    return winnerUserId
  }

  private scheduleBotIfNeeded(): void {
    if (!this.isBotTurn()) return
    if (this.botTimer) clearTimeout(this.botTimer)
    const level = this.aiLevel ?? 'MEDIUM'
    const delay = 800 + Math.floor(seededRandom(`${this.matchId}:t${this.seq}`)() * 1500)
    this.botTimer = setTimeout(() => {
      this.botTimer = null
      const frame = this.match.currentFrame
      if (!frame || frame.turnIndex !== 1 || this.simulating) return
      const bot = computeBotShot(frame, level, this.matchId)
      this.executeShot(1, { aimAngle: bot.shot.aimAngle, power: bot.shot.power, spin: bot.shot.spin, cuePos: bot.shot.cuePos })
    }, delay)
  }

  private noteDelivered(events: GameUpdateEvent[]): void {
    if (events.length === 0) return
    const maxSeq = Math.max(...events.map((e) => e.seq))
    for (const [userId, seat] of this.seatOfUser) {
      const set = this.socketIds.get(seat)
      if (!set || set.size === 0) continue
      const prev = this.deliveredSeqByUser.get(userId) ?? 0
      this.deliveredSeqByUser.set(userId, Math.max(prev, maxSeq))
    }
  }

  private event(type: string, data: unknown): GameUpdateEvent {
    const seq = ++this.seq
    return { matchId: this.matchId, seq, type, data }
  }

  broadcast(event: string, payload: unknown): void {
    this.callbacks.board.to(`match:${this.matchId}`).emit(event, payload)
  }

  dispose(): void {
    if (this.botTimer) clearTimeout(this.botTimer)
    this.botTimer = null
    if (this.turnTimer) clearTimeout(this.turnTimer)
    this.turnTimer = null
    this.stopped = true
  }
}

function defaultCallbacks(): RoomCallbacks {
  return {
    board: undefined as unknown as Server,
    persist: async () => {},
    onFrameEnd: async () => {},
    onMatchEnd: async () => {},
    log: () => {}
  }
}