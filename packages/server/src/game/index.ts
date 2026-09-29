import { Server } from 'socket.io'
import type { Server as HttpServer } from 'node:http'
import type { FastifyInstance } from 'fastify'
import { prisma } from '../db/index.js'
import { config } from '../config.js'
import { GameRoom } from './room.js'
import type { GameUpdateEvent, ShotInputDto } from './room.js'
import { ShotEnforcement } from './throttle.js'
import { noteRejectedShot, recordFraudFlag } from '../fraud/index.js'
import { verifyToken } from '../auth/guards.js'
import { settleMatch, refundMatch } from '../matches/service.js'
import { notify, setNotificationPusher } from '../notifications/service.js'
import { isMaintenance, getSettings } from '../settings/index.js'
import { PRACTICE_DAILY_FREE_LIMIT } from '@snooker/shared'
import type { PracticeAiLevel } from '@snooker/shared'
import type { Prisma } from '@prisma/client'

export interface GameServerContext {
  io: Server
  rooms: Map<string, GameRoom>
}

export function createGameServer(app: FastifyInstance, httpServer: HttpServer): GameServerContext {
  const io = new Server(httpServer, {
    cors: { origin: config.CLIENT_ORIGIN, credentials: true }
  })
  const rooms = new Map<string, GameRoom>()
  const roomLocks = new Map<string, Promise<void>>()
  const graceTimers = new Map<string, NodeJS.Timeout>()
  const shots = new ShotEnforcement()

  function clearGraceTimer(matchId: string): void {
    const timer = graceTimers.get(matchId)
    if (timer) {
      clearTimeout(timer)
      graceTimers.delete(matchId)
    }
  }

  function startGraceTimer(matchId: string, room: GameRoom): void {
    if (graceTimers.has(matchId) || room.stopped) return
    void getSettings().then((settings) => {
      const graceMs = Math.max(1, Math.round(settings.reconnectGraceSec)) * 1000
      const timer = setTimeout(() => {
        graceTimers.delete(matchId)
        void resolveDisconnected(matchId, room)
      }, graceMs)
      graceTimers.set(matchId, timer)
    })
  }

  async function resolveDisconnected(matchId: string, room: GameRoom): Promise<void> {
    if (room.stopped) return
    const disconnected = room.disconnectedSeats()
    if (disconnected.length === 0) {
      clearGraceTimer(matchId)
      return
    }
    const practice = room.matchType === 'PRACTICE'
    const isBothGone = disconnected.length >= 2
    let winnerSeat: number | null = null
    if (!practice && !isBothGone) {
      winnerSeat = disconnected[0] === 0 ? 1 : 0
    } else if (!practice && isBothGone) {
      const frames = room.match.framesWon ?? [0, 0]
      if (frames[0] !== frames[1]) winnerSeat = frames[0] > frames[1] ? 0 : 1
    }
    app.log.info({ matchId, disconnected, winnerSeat, practice }, 'grace timer resolved disconnected match')
    room.dispose()
    rooms.delete(matchId)
    clearGraceTimer(matchId)
    if (practice) {
      await prisma.match.update({
        where: { id: matchId },
        data: { status: 'MATCH_COMPLETED', finishedAt: new Date(), resultJson: { reason: 'abandon' } }
      })
      return
    }
    if (winnerSeat !== null) {
      const winnerUserId = room.userIdForSeat(winnerSeat)
      if (winnerUserId) {
        room.broadcast('match:end', { winnerSeat, reason: 'abandon' })
        await settleMatch({ matchId, winnerId: winnerUserId, reason: 'abandon' })
      }
      return
    }
    await refundMatch(matchId, 'abandon_double_disconnect')
  }

  setNotificationPusher((userId, notification) => {
    io.to(`user:${userId}`).emit('notification:new', notification)
  })

  function runExclusive(matchId: string, fn: () => Promise<void>): Promise<void> {
    const prev = roomLocks.get(matchId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    roomLocks.set(matchId, next)
    return next
  }

  io.use(async (socket, next) => {
    const token = (socket.handshake.auth?.token as string | undefined) ?? socket.handshake.query.token as string | undefined
    const payload = token ? verifyToken(token) : null
    if (!payload) {
      next(new Error('unauthorized'))
      return
    }
    const user = await prisma.user.findUnique({ where: { id: payload.id } })
    if (!user || user.status !== 'ACTIVE') {
      next(new Error('forbidden'))
      return
    }
    if (await isMaintenance()) {
      next(new Error('maintenance'))
      return
    }
    socket.data.userId = user.id
    next()
  })

  const persist = async (events: GameUpdateEvent[]): Promise<void> => {
    if (events.length === 0) return
    await prisma.gameEvent.createMany({ data: events as unknown as Prisma.GameEventCreateManyInput[] })
  }

  const makeCallbacks = (matchId: string) => ({
    board: io,
    persist,
    log: (msg: string) => app.log.debug(msg),
    onFrameEnd: async (id: string, frameWinner: number, scores: { player0: number; player1: number }) => {
      app.log.info({ id, frameWinner, scores }, 'frame ended')
      void id
    },
    onMatchEnd: async (id: string, matchWinner: number, reason: string) => {
      app.log.info({ id, matchWinner, reason }, 'match ended')
      const endedRoom = rooms.get(id)
      if (endedRoom) {
        endedRoom.dispose()
        rooms.delete(id)
      }
      clearGraceTimer(id)
      try {
        const match = await prisma.match.findUnique({ where: { id }, include: { players: true, tournament: true } })
        if (!match) return
        const winnerUserId = match.players.find((p) => p.seat === matchWinner)?.userId
        if (!winnerUserId) return
        if (match.matchType === 'PRACTICE') {
          await prisma.match.update({
            where: { id },
            data: { status: 'MATCH_COMPLETED', finishedAt: new Date(), resultJson: { reason, winnerUserId } }
          })
          const human = match.players.find((p) => p.seat === 0)
          if (human) {
            const wallet = await prisma.wallet.findUnique({ where: { userId: human.userId } })
            const available = wallet ? Number(wallet.available) : 0
            let body = 'Your practice against the robot has ended — nice session.'
            if (available <= 0) {
              const dayStart = new Date()
              dayStart.setUTCHours(0, 0, 0, 0)
              const playedToday = await prisma.match.count({
                where: { matchType: 'PRACTICE', createdAt: { gte: dayStart }, players: { some: { userId: human.userId } } }
              })
              const remaining = Math.max(0, PRACTICE_DAILY_FREE_LIMIT - playedToday)
              body = `Practice complete — ${remaining} free practice match${remaining === 1 ? '' : 'es'} left today.`
            }
            await notify(human.userId, 'PRACTICE', 'Practice complete', body)
          }
          return
        }
        await settleMatch({
          matchId: id,
          winnerId: winnerUserId,
          reason,
          tournamentId: match.tournamentId ?? undefined,
          round: match.round ?? undefined
        })
        if (match.tournament) {
          const { advanceTournamentAfterMatch } = await import('../tournaments/service.js')
          await advanceTournamentAfterMatch(id, winnerUserId)
        }
      } catch (error) {
        app.log.error({ err: error, id, matchWinner, reason }, 'onMatchEnd failed')
      }
    }
  })

  function getOrCreateRoom(matchId: string): GameRoom | null {
    const existing = rooms.get(matchId)
    if (existing) return existing
    return null
  }

  io.on('connection', (socket) => {
    const userId = socket.data.userId as string
    socket.join(`user:${userId}`)

    socket.on('match:join', (payload: { matchId: string }) => {
      const { matchId } = payload ?? {}
      if (!matchId) {
        socket.emit('error', { code: 'bad_request' })
        return
      }
      void runExclusive(matchId, async () => {
        const match = await prisma.match.findUnique({
          where: { id: matchId },
          include: { players: true }
        })
        if (!match) {
          socket.emit('error', { code: 'match_not_found' })
          return
        }
        const entry = match.players.find((p) => p.userId === userId)
        if (!entry) {
          socket.emit('error', { code: 'not_in_match' })
          return
        }
        if (['PRIZE_SETTLED', 'REFUNDED', 'MATCH_COMPLETED'].includes(match.status)) {
          const winnerSeat = match.winnerId ? match.players.find((p) => p.userId === match.winnerId)?.seat ?? undefined : undefined
          socket.emit('match:end', {
            winnerSeat,
            reason: (match.resultJson as { reason?: string } | null)?.reason ?? 'settled'
          })
          return
        }
        const callbacks = makeCallbacks(matchId)
        let room = rooms.get(matchId)
        if (!room) {
          let aiLevel: PracticeAiLevel | undefined
          if (match.aiLevel) aiLevel = match.aiLevel as PracticeAiLevel
          const settings = await getSettings()
          room = new GameRoom(matchId, match.matchType, match.format, 0, aiLevel, callbacks, settings.turnTimeoutSec)
          rooms.set(matchId, room)
        }
        room.registerSocket(userId, entry.seat, socket.id)
        socket.join(`match:${matchId}`)
        const current = room.snapshot()
        // The turn timing goes out with the join, not just with the frame broadcasts.
        // A client that was away missed those, and the deadline it was last told
        // about has long since passed; without this it would come back to a clock
        // that says expired, or to no clock at all while the room was still counting.
        socket.emit('match:joined', { matchId, seat: entry.seat, snapshot: current, turn: room.turnTiming() })
        const missStart = room.deliveredSeqForUser(userId) + 1
        const untilSeq = room.currentSeq()
        if (missStart <= untilSeq) {
          const rows = await prisma.gameEvent.findMany({
            where: { matchId, seq: { gte: missStart, lte: untilSeq } },
            orderBy: { seq: 'asc' }
          })
          if (rows.length > 0) {
            socket.emit('match:replay', { events: rows as unknown as GameUpdateEvent[] })
          }
        }
        if (room.disconnectedSeats().length === 0) clearGraceTimer(matchId)
        const started = room.tryStart()
        if (started) {
          await prisma.match.update({
            where: { id: matchId },
            data: { status: 'MATCH_STARTED', startedAt: new Date() }
          })
        }
      })
    })

    const signalAbuse = (code: string): void => {
      const signal = noteRejectedShot(userId, code)
      if (signal) void recordFraudFlag(signal, userId)
    }

    socket.on('shot:play', (payload: { matchId: string; input: ShotInputDto }) => {
      const { matchId, input } = payload ?? {}
      // A shot that lands while the table is still replaying is the striker obeying
      // the pacing rule, so it is refused here, before the rate limiter sees it. The
      // limiter used to take a token first, which meant a player who waited as told
      // could empty the bucket purely by retrying, and the resulting rate_limited
      // rejection is recorded as a shot flood against them. Nothing is simulated on
      // this path and no state changes, so the exemption costs the flood guard
      // nothing; once the replay clears, the bucket applies to this shot again.
      const pacing = getOrCreateRoom(matchId)?.pacingRejection(userId)
      if (pacing) {
        socket.emit('error', { code: pacing })
        return
      }
      if (!shots.take(socket.id, userId)) {
        socket.emit('error', { code: 'rate_limited' })
        signalAbuse('rate_limited')
        return
      }
      const valid = shots.validate(input)
      if (!valid.ok) {
        socket.emit('error', { code: valid.reason })
        signalAbuse(valid.reason)
        return
      }
      if (shots.isReplay(socket.id, input)) {
        socket.emit('error', { code: 'duplicate_shot' })
        signalAbuse('duplicate_shot')
        return
      }
      const room = getOrCreateRoom(matchId)
      if (!room) {
        socket.emit('error', { code: 'match_not_found' })
        return
      }
      const result = room.handleShot(userId, input)
      if (!result.accepted) {
        socket.emit('error', { code: result.error ?? 'rejected' })
        return
      }
      shots.recordAccepted(socket.id, input)
    })

    // A client reports that a shot has finished animating. The room holds the next
    // shot until it hears this, which is what stops a bot firing a new shot into the
    // middle of the previous one's replay. It is a pacing signal, not a game
    // action, so it is not rate limited as a shot is and it can change no state of
    // its own.
    socket.on('shot:done', (payload: { matchId: string; token?: number }) => {
      const { matchId, token } = payload ?? {}
      if (!matchId) return
      const room = getOrCreateRoom(matchId)
      if (!room) return
      // The room itself checks that this user is seated in the match, so an
      // outsider who guessed the id cannot release somebody else's hold. It also
      // checks the token, so an acknowledgement delayed past the shot it belonged
      // to cannot cut short the shot that is on screen now, and it checks that this
      // socket was one of the ones watching, so a tab that joined late or reconnected
      // cannot end a replay it never saw.
      room.noteShotPlayed(socket.data.userId, token, socket.id)
    })

    socket.on('concede', (payload: { matchId: string }) => {
      const { matchId } = payload ?? {}
      if (!matchId) {
        socket.emit('error', { code: 'bad_request' })
        return
      }
      void runExclusive(matchId, async () => {
        const room = getOrCreateRoom(matchId)
        if (!room) {
          socket.emit('error', { code: 'match_not_found' })
          return
        }
        room.handleConcede(userId)
      })
    })

    socket.on('disconnect', () => {
      for (const [matchId, room] of rooms) {
        if (room.getSeat(userId) === undefined) continue
        const seat = room.getSeat(userId)!
        room.unregisterSocket(userId, socket.id)
        socket.leave(`match:${matchId}`)
        if (room.started && room.isSeatDisconnected(seat)) startGraceTimer(matchId, room)
      }
    })
  })

  return { io, rooms }
}

export async function recoverMatchValidity(): Promise<void> {
  const stale = await prisma.match.findMany({
    where: { status: 'MATCH_STARTED', matchType: { not: 'PRACTICE' } }
  })
  for (const match of stale) {
    await refundMatch(match.id, 'server_recovery_refund')
  }
}