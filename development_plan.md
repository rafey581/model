# Snooker Platform — Development Plan / Technical Specification

This document is the technical blueprint for building the platform in the base plan
(`online_multiplayer_snooker_game_complete_plan.md`). It defines exactly what we build,
the stack, the folder layout, the database schema, the game engine, the realtime
protocol, the wallet/settlement system, and the build order.

Build principle: everything is built and tested with **virtual credits** first.
The real-money/crypto module stays an isolated, disabled-by-default subsystem.

---

## 1. High-Level Architecture

```
                    Browser Client A                 Browser Client B
                 (render + input UI)              (render + input UI)
                          |   HTTPS / WS               |
                          +-------------+--------------+
                                        |  REST API + WebSocket (Socket.IO)
                                        v
                              ┌───────────────────┐
                              │   Node.js Server  │
                              │  (Fastify + WS)   │
                              └───┬──────┬───────┘
                     ┌────────────┼──────┼────────────┐
                     v            v      v            v
                 Auth/Users   Match/Game   Wallet    Admin
                  Service      Service     Ledger    Service
                     │            │          │          │
                     v            v          v          v
               ┌──────────────────────────────────────────┐
               │          PostgreSQL  (via Prisma)         │
               └──────────────────────────────────────────┘
                     (Redis optional later for scaling)
```

Separation of concerns (must be kept modular):

```
Game Engine  ->  Match Service  ->  Settlement Service  ->  Wallet Ledger  ->  Payment/Crypto Service
```

Rules:
- The **server is authoritative**. Clients only send shot inputs; the server
  simulates physics + rules and broadcasts the resulting state.
- The **game engine is shared code** (a `shared` package) so the server and client
  use the identical deterministic physics/rules code.
- The **wallet** never stores "one balance field". It is a ledger of transactions.
- **Crypto/deposits/withdrawals are a separate module** that stays off until legal setup is done.

---

## 2. Technology Stack

### Monorepo (npm workspaces / pnpm)
```
packages/
  shared/   pure TS: types, constants, deterministic physics, snooker rules engine
  server/   Node.js + TypeScript: REST API, Socket.IO game server, services
  client/   Vite + TypeScript: UI + Canvas/WebGL renderer
```

### Backend
| Concern            | Choice                      |
|--------------------|-----------------------------|
| Runtime            | Node.js 20+ (TypeScript)    |
| HTTP API           | Fastify                     |
| Realtime           | Socket.IO (engine.io)       |
| ORM / DB           | Prisma + PostgreSQL 16      |
| Validation         | Zod                          |
| Auth               | Argon2 password hash, JWT in httpOnly cookie |
| Config/Secrets     | dotenv / env vars, never in source |
| Logging            | pino                         |
| Task queue (later) | BullMQ + Redis               |

### Frontend
| Concern            | Choice                      |
|--------------------|-----------------------------|
| Build              | Vite                         |
| Language           | TypeScript                   |
| UI                | React (or vanilla TS; decide on start of Phase 1) |
| Game rendering     | Custom Canvas 2D renderer (2D top-down) with option to upgrade to WebGL/3D later |
| Realtime client    | Socket.IO client             |
| State              | Zustand (if React used)      |

### Why deterministic shared physics
Server and client must agree on outcomes without disagreement. The physics module:
- Fixed timestep (e.g. 240 Hz physics steps stepped at 60 Hz simulation ticks).
- No `Math.random()` inside the simulation; strictly seeded randomness only.
- Float-safe: use a fixed order of operations; snap tiny velocities to zero.
This lets only the server simulate, and clients simply render server snapshots.

---

## 3. Repository / Folder Structure

```
root
├─ package.json
├─ pnpm-workspace.yaml
├─ docker-compose.yml            # postgres (+ redis dev)
├─ .env.example
├─ README.md
├─ docs/
│  ├─ development_plan.md        # this file
│  └─ api.md                     # full REST + WS API reference (generated)
└─ packages/
   ├─ shared/
   │  ├─ src/
   │  │  ├─ constants.ts         # ball sizes, table dims, friction, restitution
   │  │  ├─ rng.ts               # seeded PRNG (mulberry32 / xorshift)
   │  │  ├─ vec.ts               # small vector math (deterministic)
   │  │  ├─ physics/
   │  │  │  ├─ world.ts          # ball simulation loop
   │  │  │  ├─ collision.ts      # ball-ball, cushion, pocket
   │  │  │  └─ cue.ts            # spin/english model
   │  │  ├─ rules/
   │  │  │  ├─ snooker.ts        # turn/colour/foul/re-spot logic
   │  │  │  └─ frame.ts          # frame + match (best-of) flow
   │  │  ├─ state.ts             # immutable-ish game state types
   │  │  └─ events.ts            # typed domain events (ballPotted, foul, ...)
   │  └─ package.json
   ├─ server/
   │  ├─ src/
   │  │  ├─ index.ts             # bootstraps HTTP + WS
   │  │  ├─ app.ts               # Fastify app, plugin wiring
   │  │  ├─ config.ts            # env validation (zod)
   │  │  ├─ db/                  # prisma client
   │  │  ├─ auth/                # register, login, guard hooks
   │  │  ├─ users/               # profile, stats, rankings
   │  │  ├─ wallet/              # ledger, balances, match accounting
   │  │  ├─ matches/             # lifecycle, escrow, settlement, history
   │  │  ├─ game/                # Socket.IO rooms, server-authoritative sim
   │  │  │  ├─ room-manager.ts
   │  │  │  ├─ match-simulator.ts
   │  │  │  └─ handlers.ts
   │  │  ├─ admin/               # admin routes + RBAC guard
   │  │  └─ crypto/              # DISABLED module: deposits/withdrawals stubs
   │  └─ prisma/
   │     └─ schema.prisma
   └─ client/
      ├─ src/
      │  ├─ main.ts
      │  ├─ app/                 # auth pages, dashboard, lobby, profile
      │  ├─ game/
      │  │  ├─ canvas-renderer.ts
      │  │  ├─ input-manager.ts  # aim/power/spin controls
      │  │  ├─ snapshot-interp.ts# interpolation of server snapshots
      │  │  └─ network.ts        # Socket.IO wrapper
      │  └─ ui/                  # react components / styles
      └─ index.html
```

---

## 4. Game Design Spec (Snooker)

### Table / physics constants (server-authoritative)
| Constant             | Value             | Notes |
|----------------------|-------------------|-------|
| Table playing area   | 3569 × 1778 mm (12ft × 6ft) | real snooker |
| Ball diameter        | 52.5 mm           | |
| Ball mass            | 1                | relative, for collisions |
| Slowest velocity     | 0.01 mm/tick     | below this -> 0 (deterministic stop) |
| Rolling deceleration | ~0.328 mm/tick²  | cloth resistance, tuned |
| Ball-ball restitution| 0.95             | |
| Cushion restitution  | 0.75 (long), 0.80 (short) race-track style | tuned per cushion |
| Cushion friction     | damp tangential velocity | |
| Pocket radius        | 54 mm (corner), 58 mm (middle) | entrance capture zone |
| Max cue power        | normalized 0..1 -> impulse | client power bar |
| Max spin (english)   | normalized -1..1 horiz/vert | follow/draw/side |

### Shot input (client -> server)
```ts
type ShotInput = {
  aimAngle: number;     // radians, 0 = toward red end
  power: number;        // 0..1
  spin: { x: number; y: number }; // horizontal (side) and vertical (follow/draw)
  elevation?: number;   // future: jump/swerve (Phase 2+)
  timestamp: number;    // client time, for anti-cheat timing checks
}
```
Server validates: is it this player's turn, is state `BALLS_SETTLED`, within turn timer,
input ranges sane. Then it simulates with the shared engine and produces `GameUpdate` events.

### Spin / english model (Phase 2 detail)
- Ball has position, velocity, angularVelocity (spin vector).
- On ball-ball contact, surface point contact imparts spin.
- Follow: vertical spin reduces post-impact rolling or creates friction-assisted roll-through.
- Draw: vertical negative spin pulls ball backward after contact.
- Side: alters cushion rebound angle.
- Keep the model simple + tunable first; add swerve/jump later.

### Renderer (client)
- Top-down 2D canvas render with polished styling:
  - Wooden snooker table frame, green cloth with slight radial lighting gradient.
  - Balls with radial-gradient gloss + fixed number/colour mapping.
  - Cue with aim line (direction + power length), spin indicator.
  - Pocket holes, cushion rails.
- Optional later: three-quarter 3D perspective via canvas transform, then WebGL.

## 4A. Table Types / Match Modes

Three match modes share the same engine + rules + server-authoritative flow.
Only the "wrapper" differs.

```
┌─────────────────────────────────────────────────────────────┐
│                       TABLE LOBBY                           │
│  [1] 1-on-1 Match     [2] Tournament     [3] Practice (AI)  │
└──────────────┬───────────────┬───────────────┬──────────────┘
               │               │               │
       Player vs Player   Multi-player     Player vs Robot
       entry stake locked    bracket         no stake / free
       winner gets prize   winner takes     unlimited plays
                            all (pool-fee)
```

### Mode 1 — One-by-One (`ONE_V_ONE`)
- The core competitive mode. Create/join a match on a **priced table tier**
  (`$1 / $5 / $10` = `100 / 500 / 1000 CR`).
- Stake locked on entry (`available -> locked`), winner takes `pool - fee`.
- Formats: `BO1 | BO3 | BO5`.

### Mode 2 — Tournament (`TOURNAMENT`)
- Entry via a stake-free (virtual) fee currently; same escrow/settlement rules as 1v1.
- **Fixed size v1: 8 players.** Single-elimination knockout:
```
Seed 1 ─┐
        ├─ QF ─┐
Seed 8 ─┘      │
               ├─ SF ─┐
Seed 4 ─┐      │      │
        ├─ QF ─┘      │
Seed 5 ─┘            ┌┴┐
Seed 3 ─┐            │ │ FINAL  ──> Champion
        ├─ QF ─┐     │ │
Seed 6 ─┘      │     └┬┘
               ├─ SF ─┘
Seed 2 ─┐      │
        ├─ QF ─┘
Seed 7 ─┘
```
- Brackets auto-built when 8 players joined. Each round creates a normal `Match`
  (`match_type=TOURNAMENT`) using the standard engine.
- Winner takes the full prize pool after platform commission; runner-up/3rd place
  tracking (optional v1+).
- States: `DRAFT -> OPEN -> FULL -> IN_PROGRESS -> COMPLETED | CANCELLED`.
- Cancellation/abandon policies mirror 1v1 (refund others, penalize abandoner).

### Mode 3 — Practice vs Robot (`PRACTICE`)
- Player vs a **bot opponent**. `stake = 0`, nothing is locked, never touches the wallet.
- Practice limit (see R2): free, but **max 3 matches/day when the player's wallet
  balance is 0**; **unlimited when the player has balance**.
- Bot uses the exact same `shot:play` path as a human (server simulates identically).
- Configurable skill level: EASY / MEDIUM / HARD (aim error, ball selection, break knowledge).
- Practice matches are **not** recorded in paid stats/rankings (flag on match result),
  but a light practice history is kept for UX.
- Also used as the onboarding tool: user learns rules/fouls risk-free.

### Rules for all modes
- Server-authoritative simulation and scoring no matter which mode.
- Match type recorded on `Match.matchType`.
- Monetary settlement runs **only** for `ONE_V_ONE` and `TOURNAMENT`; `PRACTICE`
  never touches the wallet.

---

## 4B. Business Rules (approved requirements — client decisions)

These decisions override any earlier draft wording. They are enforced in code, not
just documented.

### R1 — Bots can NEVER be real players
- A robot is a server-side account with `role = BOT`. It exists **only** inside
  `PRACTICE` matches.
- Bots are rejected from every real table path: bot accounts cannot create or join
  a `ONE_V_ONE` match, cannot join a `TOURNAMENT`, and cannot appear as a human
  opponent.
- Consequence: any **online table (1v1 / tournament) is always human vs human**.
  An idle/matchless human table is never filled with a bot.

### R2 — Practice vs Robot: daily limit when wallet is empty
- Practice is always free and never touches the wallet.
- If the player's **wallet available balance is 0** (no playable amount), they may
  play **at most `PRACTICE_DAILY_FREE_LIMIT = 3` practice matches per calendar day**
  (UTC day boundary).
- If the player **has a wallet balance > 0** (any amount), practice is **unlimited**.
- The daily counter counts practice matches created by that player since the start
  of the current UTC day.

### R3 — Tables priced by tier ("many tables according to price")
- 1v1 matches are organized into **stake tiers** (displayed as table prices):
  `$1`, `$5`, `$10`.
- In the current virtual-only build these map to credits: `$1 -> 100 CR`,
  `$5 -> 500 CR`, `$10 -> 1000 CR` (1 CR = $0.01). When the real-money module is
  enabled, they map to the actual USD amounts.
- The lobby shows tables split by tier; a player can only join a table whose stake
  (`stakePerPlayer`) they can cover — entry stake is locked until the result.
- Tier definitions live in `shared` (`STAKE_TIERS`) and are served by
  `GET /api/matches/tiers` so UI and server never drift.

---

## 5. Snooker Rules Engine (shared, deterministic)

State machine per frame:
```
FRAME_START -> PICKING_RED -> SIMULATING (server) -> SETTLED -> evaluate
                                                       ├─ potted -> continue
                                                       ├─ foul -> switch turn + penalty
                                                       └─ no pot/no foul -> switch turn
FRAME_END (no balls on, or conceded) -> MATCH_END (best-of-N) 
```

Key rule behaviours to implement (in order of value):
1. Opening: cue ball in "D", break on reds.
2. Colour sequence: red -> colour -> red -> colour ... while reds remain; colours
   re-spotted until all reds potted, then colours in order (y,g,brown,blue,pink,black).
3. Endgame: potting final colour sequence wins frame (re-spotted black for ties).
4. Fouls: first ball hit wrong, potting wrong ball, potting cue, no contact at all,
   off table (ball leaves table), touching ball, cue ball in pocket -> 4/5/6/7 points
   depending on ball involved ("value of the ball on", min 4).
5. Foul awards opponent: points + (for foul where the ball on is missed under a snooker)
   miss rule where configured server-side.
6. Free ball after snooker (advanced, Phase 3+ of the rules engine).
7. Turn ends after a foul, or after a potless/foulless visit.
8. Break tracking, highest break, frame + match (best-of configurable) scoring.
9. Concession ("conceding a frame with a snooker required") — optional, disabled by default.

The engine emits typed domain events so the server can persist `game_events` for replay.

---

## 6. Database Schema (Prisma)

```prisma
model User {
  id            String        @id @default(cuid())
  email         String        @unique
  username      String        @unique
  passwordHash  String
  role          String        @default("PLAYER")  // PLAYER | ADMIN | SUPERADMIN
  status        String        @default("ACTIVE")  // ACTIVE | SUSPENDED | BANNED
  jgCheck       Json?         // jurisdiction/geo compliance snapshot
  createdAt     DateTime      @default(now())
  profile       Profile?
  wallet        Wallet?
  sessions      Session[]
  matchesA      MatchPlayer[]
  transactions  WalletTransaction[]
}

model Profile {
  id          String  @id @default(cuid())
  userId      String  @unique
  countryCode String?
  avatarUrl   String?
  bio         String?
}

// session tokens (refresh tokens)
model Session {
  id        String   @id @default(cuid())
  userId    String
  tokenHash String
  expiresAt DateTime
  ip        String?
  userAgent String?
}

// one row per user
model Wallet {
  id         String  @id @default(cuid())
  userId     String  @unique
  available  Decimal @default(0)   // spendable
  locked     Decimal @default(0)   // funds inside active matches / pending withdrawals
  currency   String  @default("CR") // "CR" = virtual credits; future: USDT etc.
}

// every balance change is a row
model WalletTransaction {
  id            String   @id @default(cuid())
  userId        String
  type          String   // DEPOSIT | MATCH_ENTRY | MATCH_REFUND | PRIZE | PLATFORM_FEE | WITHDRAWAL | WITHDRAWAL_FEE | ADJUSTMENT | BONUS
  amount        Decimal
  currency      String   @default("CR")
  status        String   @default("COMPLETED") // PENDING | COMPLETED | FAILED | REVERSED
  refId         String?  // related match/deposit/withdrawal id
  balanceBefore Decimal
  balanceAfter  Decimal
  meta          Json?
  createdAt     DateTime @default(now())
  userId2       String?  // counterparty (opponent), for audit
  index refId type
}

model Match {
  id            String   @id @default(cuid())
  matchType     String   @default("ONE_V_ONE") // ONE_V_ONE | TOURNAMENT | PRACTICE
  tournamentId  String?  // set when matchType = TOURNAMENT
  round         Int?     // 1=QF | 2=SF | 3=FINAL
  aiLevel       String?  // BOT_EASY | BOT_MEDIUM | BOT_HARD (when PRACTICE)
  status        String   // CREATED | WAITING_FOR_PLAYER | PLAYER_JOINED | FUNDS_LOCKED | MATCH_STARTED | MATCH_IN_PROGRESS | MATCH_COMPLETED | RESULT_VERIFIED | PRIZE_SETTLED | CANCELLED | REFUNDED | DISPUTED | ABANDONED
  stakePerPlayer Decimal
  currency       String  @default("CR")
  platformFeePct Decimal  @default(0)   // snapshot of config at creation
  format         String  @default("BO3") // BO1 | BO3 | BO5
  winnerId       String?
  resultJson     Json?   // final frame scores + winner reason
  startedAt      DateTime?
  finishedAt     DateTime?
  createdAt      DateTime @default(now())
  players        MatchPlayer[]
  events         GameEvent[]
  tournament     Tournament? @relation(fields: [tournamentId], references: [id])
}

// 8-player knockout tournament (virtual stakes in v1)
model Tournament {
  id           String   @id @default(cuid())
  status       String   // DRAFT | OPEN | FULL | IN_PROGRESS | COMPLETED | CANCELLED
  name         String   @default("8-Player Cup")
  entryFee     Decimal  @default(0)
  size         Int      @default(8)
  format       String   @default("BO3")
  championId   String?
  runnerUpId   String?
  createdAt    DateTime @default(now())
  startedAt    DateTime?
  finishedAt   DateTime?
  players      TournamentPlayer[]
  matches      Match[]
  resultsJson  Json?    // full bracket tree for UI/replay
}

model TournamentPlayer {
  id           String @id @default(cuid())
  tournamentId String
  userId       String
  seed         Int     // 1..8 bracket seed
  status       String  @default("ALIVE") // ALIVE | ELIMINATED | CHAMPION
  eliminatedIn Int?    // round reached
  tournament   Tournament @relation(fields: [tournamentId], references: [id])
}

model MatchPlayer {
  id       String @id @default(cuid())
  matchId  String
  userId   String
  seat     Int    // 0, 1
  result   String? // "WIN" | "LOSS" | "REFUND"
  playSide Json?  // final score etc.
}

// persisted game events for replay/anti-cheat
model GameEvent {
  id        String   @id @default(cuid())
  matchId   String
  seq       Int
  type      String   // SHOT | BALL_POTTED | FOUL | TURN_CHANGE | STATE_START | SNAPSHOT | DISCONNECT | RESULT
  data      Json
  createdAt DateTime @default(now())
  @@unique([matchId, seq])
}

// crypto stubs (module disabled by default)
model CryptoDeposit {
  id            String @id @default(cuid())
  userId        String
  network       String
  address       String
  amount        Decimal
  confirmations Int    @default(0)
  status        String @default("PENDING")
  txHash        String?
  creditedAt    DateTime?
}

model CryptoWithdrawal {
  id       String   @id @default(cuid())
  userId   String
  address  String
  network  String
  amount   Decimal
  status   String   @default("PENDING") // PENDING | PROCESSING | COMPLETED | REJECTED | FAILED
  txHash   String?
  reviewBy String?
}

// admin boilerplate
model AdminUser    { ... admin sub-accounts behind User.role }
model AdminAction  { id, adminId, action, targetType, targetId, meta, createdAt }
model FraudFlag    { id, userId, kind, confidence, reason, createdAt }
model Notification { id, userId, kind, title, body, read, createdAt }

model KycRecord   { id, userId, status, providerRef?, submittedAt, reviewedAt, result }
```

All money math done in `Decimal` (node-pg-multicore-safe; use Prisma Decimal + `decimal.js` in TS). Never `float` for balances.

---

## 7. REST API (Phase 4+)

All responses `{ ok: boolean, data?: T, error?: string }`.

### Auth
- `POST /api/auth/register` {email, username, password} -> creates user + wallet (1000 CR starting virtual balance on dev)
- `POST /api/auth/login` -> sets httpOnly cookie
- `POST /api/auth/logout`
- `POST /api/auth/refresh`

### Users
- `GET /api/me`
- `GET /api/users/:username`
- `GET /api/me/stats` (matches, wins, winrate, highest break)
- `GET /api/leaderboard?period=week`

### Wallet
- `GET /api/wallet` -> { available, locked, currency }
- `GET /api/wallet/transactions?limit=&offset=`
- (crypto endpoints exist but return `{ enabled: false }` until module on)

### Matches
- `POST /api/matches` {type, stake, format} -> create lobby
- `GET /api/matches/lobby` -> open/created matches to join
- `POST /api/matches/:id/join`
- `GET /api/matches/:id`
- `GET /api/matches/history?mine=1`
- `POST /api/matches/:id/concede`

### Practice (Robot AI)
- `GET /api/practice/levels` -> EASY / MEDIUM / HARD
- `POST /api/practice/start` {aiLevel, format} -> creates a PRACTICE match with bot (no wallet changes)
- `POST /api/practice/:id/resign` -> end practice round

### Tournament
- `POST /api/tournaments` {name?, format?} -> create 8-player cup (free/virtual, no stake in v1)
- `GET /api/tournaments/open` -> list tournaments accepting players
- `POST /api/tournaments/:id/join`
- `GET /api/tournaments/:id` -> bracket tree, seeds, rounds, live match status
- `GET /api/tournaments/history`
- `GET /api/tournaments/leaderboard` / champion list

### Admin (RBAC: role ADMIN/SUPERADMIN)
- `GET /api/admin/stats`
- `GET /api/admin/users`, `PATCH /api/admin/users/:id` (status, adjust)
- `GET /api/admin/matches`, `GET /api/admin/matches/:id` (+ replay events)
- `POST /api/admin/wallet/adjust` (signed audit row)
- `PATCH /api/admin/settings` (commission %, min/max stake, maintenance mode)
- `GET /api/admin/fraud`

### Settings table (server config)
Stored in DB (Json/config table) so admin can change without deploy:
- commissionPct, minStake, maxStake, matchFormats[], turnTimeoutSec, reconnectGraceSec,
  maintenanceMode, allowedJurisdictions[], realMoneyEnabled(boolean, default false).

---

## 8. Realtime Protocol (Socket.IO)

Namespace: `/game`. Auth via handshake cookie/JWT.

Client -> Server:
```
match:create   {stake, format}
match:join     {matchId}
match:cancel   {matchId}            // only before FUNDS_LOCKED or pre-start with rules
shot:play      {matchId, input: ShotInput}
concede        {matchId}
ping           {}                    // latency probe (anti-cheat)
```

Server -> Client (room of matchId):
```
match:created   {matchId}
match:playerJoined {players, seat}
match:start     {frame: 1, breakSide, state snapshot}
game:update     {seq, type, data}    // events as they happen (pot, foul, cushions eta)
snapshot        {seq, balls[], turn, scores, step: 'SETTLED'|'RUNNING'}
turn:change     {playerId, scores}
frame:end       {winnerId, scores}
match:end       {result, reason}
error           {code, message}
```

Server-authoritative loop:
1. Receive `shot:play`.
2. Validate turn, state, timing, input.
3. Lock the room (reject further shots).
4. Simulate using `shared` engine (fixed steps). Collect `GameEvent[]`.
5. Persist events to `GameEvent` (batch), update frame/match state in DB where cheap.
6. Broadcast events + final snapshot.
7. If frame/match over -> transition, emit `frame:end` / `match:end`, trigger settlement.

Client rendering: `snapshot` interpolates ball positions; `game:update` plays audio/nudges.

Reconnect/disconnect handling:
- On disconnect, room marks player `DISCONNECTED`, starts grace timer (`reconnectGraceSec`).
- Reconnect restores state from last snapshot + replays missed events by `seq`.
- After timeout -> `ABANDONED` -> rules: opponent wins, funds settled per policy (virtual: refund opponent, confiscate abandoner to platform in real-money mode; disabled in dev with REFUND).

---

## 8A. Bot AI Opponent (Practice Mode)

The robot is implemented as another "player" in the room. It issues the same
`shot:play` inputs through the same server path — no special simulation.

```
BOT LOOP (server-side, per turn):
  1. Evaluate table state from shared rules engine
     - ball on, easiest pottable colours/reds
     - cue ball position + target pockets
  2. Choose a target ball (if potting) else a safety (roll back to baulk)
  3. Compute aim line + power (distance to ball, target pocket)
  4. Add skill-level error (angle/power jitter, chosen per RNG seed)
  5. Emit shot:play as if a human sent it (with bot difficulty obeying turn timer)
```

Skill levels control: aim error jitter, power error, willingness to attempt
difficult (long/angled) pots, foul avoidance, snooker safety awareness.

| Level    | Jitter      | Pot ability | Safety play |
|----------|-------------|-------------|-------------|
| EASY     | high        | weak        | none |
| MEDIUM   | medium      | moderate    | basic |
| HARD     | low         | strong      | active snookers |

Constraints:
- Bot never touches the wallet; `stake = 0`, no `MATCH_ENTRY`, no payout.
- Bot is role `BOT` and is **never** a real player in 1v1/tournament tables (R1).
- Bot move latency is randomized in a human-like band (1–4 s) to stay realistic.
- Practice matches excluded from rankings/leaderboards (`matchType=PRACTICE`
  filters stats queries).
- Practice plays/day limited only when the player has zero balance (R2).

---

## 9. Wallet & Settlement (the critical financial part)

### Ledger invariants
- `available + locked` always equals sum of wallet transactions' deltas (audit query to verify).
- No mutation of `available` without a `WalletTransaction` row. Use DB transaction.
- Concurrency: lock the wallet row (`FOR UPDATE`) before changes.

### Match accounting flow (virtual credits first)
```
match created:  debit MATCH_ENTRY (-stake) available -> locked
opponent joins: same for B
match starts
winner decided (server):
   winner:  credit PRIZE (+stake*(2 - feePct))   [from locked]
   platform: credit PLATFORM_FEE (+stake*feePct) to ADMIN wallet txn
  both locked amounts consumed
cancelled pre-start: refund (MATCH_REFUND) locked -> available for both
```

### Commission model (configurable)
```
Pool = stake * 2
PlatformFee = Pool * commissionPct   (e.g. 10%)
WinnerPrize = Pool - PlatformFee
```
Edge cases: odd rounding (use floor/round to 8 dp, document rule), abandoned match policy.

### Settlement service
Runs inside the same DB transaction that commits the match result. Idempotency:
- `match.status: MATCH_COMPLETED` must be guarded; only transition to `PRIZE_SETTLED`
  once per match (unique `refId` on transactions, `wallet_transactions.refId` unique where type in MATCH_ENTRY/PRIZE/...).

---

## 10. Anti-Cheat & Fairness

Implementation (in order):
1. Server-authoritative simulation (nothing trusted from client except shot intent).
2. Input validation + rate limiting per socket + per-user.
3. Turn timer enforced server-side; `shot:play` after timeout = auto foul / forfeit.
4. Timing/pattern analysis: reject shots with millisecond latency anomalies, replays of
   identical inputs.
5. Multi-account detection: IP/device fingerprint, same device co-login, referral anomalies.
6. Win-rate / stake anomaly monitoring -> `FraudFlag` + auto-restrict thresholds.
7. Full `GameEvent` log per match -> replay + audit + dispute resolution.
8. Anti-cheat tuning happens after enough real gameplay data (dev tournaments).

---

## 11. Compliance / Jurisdiction Module (design hooks only)

- `User.jgCheck` snapshot: geo, VPN/proxy detection result (client IP + `ipinfo` style lookup)
  stored at registration and re-checked at match entry.
- `allowedJurisdictions` config enforced server-side at deposit/match-entry/withdrawal.
- `KycRecord` + `KycProvider` interface stub (no provider configured by default).
- `realMoneyEnabled` flag gates: deposit endpoints, kyc enforcement, non-CR currency.
- Real-money mode = strictly opt-in config; until legal setup done it stays **false**.

---

## 12. Crypto Module (stub, disabled)

Interfaces defined, implementations empty until a licensed jurisdiction/provider exist:
```
DepositProvider  { generateAddress(network): Promise<string>; confirm(tx): Promise<...> }
WithdrawalProvider { submit(to, amount, network): Promise<{txHash}> }
MonitorService  (poll or webhook) -> marks deposits confirmed -> ledger credit
```
Nothing here can be turned on by a client; it requires server config + env secrets.

---

## 13. Build Order (Milestones)

### M0 — Scaffold (day 1)
- Monorepo, lint/format/tsconfig, docker-compose (postgres), Prisma schema, .env.example.
- CI-less local `pnpm -r dev`.

### M1 — Shared engine skeleton + ball physics (no rules)
- World sim, collisions, cushions, pockets, stop condition.
- Deterministic unit tests (seeded, golden snapshots).

### M2 — Rules engine
- Red/colour cycle, fouls, endgame, frame + best-of match, breaks.
- Tests: standard snooker scenarios, foul tables.

### M3 — Minimal renderer
- Canvas table, balls, cue, aim line, power/spin controls.

### M4 — Auth + users + wallet ledger
- Register/login, profiles, wallet + transactions API (virtual CR).
- Starting virtual balance for dev.

### M5 — Singleplayer vs AI (optional but very useful)
- AI plays via same ShotInput path; proves engine end-to-end.

### M6 — Multiplayer realtime
- Socket.IO rooms, turn system, snapshots + interpolation, disconnect/grace.
- Matches + match history + concession (Mode 1: 1v1 complete).

### M6b — Practice mode (Robot AI)
- Bot loop + skill levels, no-wallet PRACTICE matches, unlimited free plays.
- Bot also doubles as an M5 AI for engine testing.

### M6c — Tournament mode
- 8-player bracket builder, join flow, per-round match creation, bracket UI,
  champion tracking, pool/fee settlement.

### M7 — Admin panel
- Stats, users, matches+replay, settings (commission, stakes, maintenance).

### M8 — Anti-cheat + audit hardening, leaderboards, notifications.

### M9 — Polishing: audio, animations, lighting, animations, responsive UI.

### M10 — Production: deploy, backups, monitoring, scaling.
### M11 — Legal gate (NOT dev): enable jurisdiction checks, KYC provider, crypto provider.

Acceptance per milestone = automated tests pass + feature demo-able.

---

## 14. Testing Strategy

- **Shared engine**: unit tests with fixed seeds + golden-state snapshots.
- **REST**: Fastify `inject` tests + Prisma test DB (transactions rolled back).
- **Realtime**: two mock Socket.IO clients against one server (deterministic sim makes
  this easy).
- **Wallet**: property tests for invariants (`available+locked == ledger sum`),
  concurrency test (two join actions), idempotency test (settle twice = once).
- **E2E (later)**: Playwright for lobby->match->result on virtual credits.

---

## 15. Environment / Config

```env
DATABASE_URL=...
JWT_SECRET=...
COOKIE_SECRET=...
CR_START_BALANCE=1000
MATCH_TURN_TIMEOUT_SEC=60
MATCH_RECONNECT_GRACE_SEC=120
COMMISSION_PCT=0.10
MIN_STAKE=100   # lowest stake tier ($1 table -> 100 CR)
MAX_STAKE=1000  # highest stake tier ($10 table -> 1000 CR)
REAL_MONEY_ENABLED=false
CORS_ORIGIN=http://localhost:5173
```

---

## 16. Decisions Pending (open questions)

1. React vs vanilla TS for UI (recommend React for speed of building the wider UI).
2. Canvas 2D for MVP vs immediate WebGL (recommend 2D first, design renderer to be swappable).
3. AI opponent in M5/M6b — confirmed: yes, required for Practice mode (M6b).
4. Miss rule / free ball complexity level for v1 (recommend "miss rule: off; free ball: off, add later").
5. Concession rule allowed in real-money mode (recommend no, only "no balls on" + fouls).

---

## 17. Definition of Done (MVP)

A user can:
- register/login,
- see a starting virtual balance,
- play practice vs the Robot (EASY/MEDIUM/HARD) — free, up to the daily limit
  (3/day when balance is 0, unlimited when balance > 0),
- create/join a 1v1 match at a chosen stake,
- create/join an **8-player knockout tournament** and play its rounds,
- play a full snooker frame (or best-of-3) vs another real user in realtime,
- have the server apply rules, fouls and scoring correctly,
- see match end, winner, and correct virtual-credit prize/commission transactions in history
  (1v1 + tournament only; practice never touches the wallet),
- admin can configure commission/stakes, view matches + transaction audit, and manage tournaments.

No real-money path is reachable.