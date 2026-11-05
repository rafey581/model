# Runtime Runbook — Snooker Platform

Operational notes for booting, upgrading, backing up and monitoring the platform.
The live topology is one EC2 instance (API + Docker Postgres). Public-launch
gaps and the ship checklist are in `DEPLOY_READINESS.md`. Step-by-step install
is `DEPLOY.md`.

## 1. Prerequisites

- Node.js >= 20 and pnpm (`corepack enable`)
- Docker with Docker Compose v2
- Postgres 16 (via `docker-compose.yml`; compose also defines an unused Redis for future use)

## 2. Boot a fresh machine (ordered)

```bash
pnpm install

# 1) Secrets + config. Copy the template, then EDIT packages/server/.env:
#    - DATABASE_URL must point at postgres
#    - JWT_SECRET and COOKIE_SECRET must be long random values (>=16 chars)
#    The server REFUSES to start with any of those three missing.
cp .env.example packages/server/.env

# 2) Database up
pnpm db:up            # starts postgres only

# 3) Migrations — production order step (non-interactive, safe to run repeatedly)
pnpm db:deploy        # prisma migrate deploy — applies pending migrations, no prompts
pnpm db:status        # sanity: "Database schema is up to date"

# 4) First-boot seed (admin + player + player2). Use a custom admin password:
SEED_ADMIN_PASSWORD="<strong-value>" pnpm db:seed

# 5) Build + run
pnpm build            # builds shared, server (incl. prisma generate), client
pnpm --filter @snooker/server start     # API on :4000
# or serve the client build with any static host pointing /api + /socket.io at :4000
# (dev mode: `pnpm dev` — server + Vite client with proxy)
```

Dev-mode differences: `pnpm db:migrate` (`migrate dev`) is fine for a scratch DB,
but always use `db:deploy` for anything resembling a persistent environment.

## 3. Health / readiness

| Endpoint | Purpose | Behavior |
|---|---|---|
| `/api/health`  | liveness | Always 200; real `db` probe + `status` (`ok`/`maintenance`/`down`), `version`, `uptimeSec`, `realMoney`, `time` |
| `/api/ready`   | readiness | 200 `{db:'up', maintenance}` when the DB answers, else **503** |

Both are exempt from the maintenance gate so probes stay reachable. Probe
`/api/ready` from load balancers / cron; alert on 503 or `db:'down'`.

## 4. Logs

- JSON on stdout via Fastify/pino. Set `LOG_LEVEL` in `packages/server/.env`
  (`debug` for troubleshooting, `info` default, `warn`/`error` in noisy prod).
- Sensitive request headers (`authorization`, `cookie`) are redacted to `[REDACTED]`.
- Boot emits one structured `{event:'boot', version, port, env, realMoney, rooms}` line.
- Key events:
  - `recovered stale matches after restart` (`{count}`) — wallet locks for matches
    left `MATCH_STARTED` at boot are refunded (reason `server_recovery_refund`).
  - `frame ended`, `match ended`, grace-timer resolutions, room debug lines.
- Start failures and all Prisma `warn`/`error` lines also go to stderr/stdout JSON.

## 5. Backup / restore

Data lives entirely in the `pgdata` Docker volume (DB migrations, wallet ledger,
users, tournaments). Back up with:

`pnpm db:backup` and `pnpm db:restore` are Node scripts. They run on the Ubuntu
server and on a Windows dev machine, as long as `docker compose` can see the
postgres service. Dumps are Postgres custom format under `backups/` (gitignored).

```bash
pnpm db:backup
pnpm db:restore -- backups/snooker-<timestamp>.sql
# the previous Windows flag still works:
pnpm db:restore -- -File .\backups\snooker-<timestamp>.sql
```

`scripts/db-backup.ps1` and `scripts/db-restore.ps1` remain for a direct PowerShell call.

Generic \*nix one-liners (same topology):

```bash
# backup
docker compose exec -T postgres pg_dump -U snooker -Fc snooker > backups/snooker-$(date +%F).sql
# restore (DESTRUCTIVE — drops objects first)
docker compose up -d postgres
CID=$(docker compose ps -q postgres)
docker cp backups/snooker-2026-01-01.sql "$CID:/tmp/restore.sql"
docker compose exec postgres pg_restore -U snooker -d snooker --clean --if-exists /tmp/restore.sql
```

Restore runs while the server is down (or matches will fight the recreated DB).

## 6. Monitoring notes

- **Boot recovery:** `recoverMatchValidity()` refunds any non-practice `MATCH_STARTED`
  match at startup. Alert on `count > 0` — it means the previous run died mid-match.
- **Rooms / players:** watch `rooms` in the boot line and per-frame `frame ended`/
  `match ended` volume. Socket.IO runs on the same HTTP port as the API.
- **Wallets / ledger:** a LedgerEntry exists for every credit/debit; run the e2e
  §8 audit (`pnpm e2e`) or check `ledger.test.ts` invariants after any restore.
- **Fraud flags:** `packages/server/src/fraud/` flags suspicious activity — surfaced in
  the admin audit feed. Nothing is written to the process log for those flags.
- **Maintenance mode:** toggle in Admin → Settings; all non-admin HTTP + sockets get 503.
  Persisted in the DB, enforced server-side.
- **Database:** `docker compose ps` should show postgres `healthy` (`pg_isready`).
  Probe `/api/ready` from outside (503 when Postgres is down). Watch `pgdata` free space.
  Postgres and Redis publish on `127.0.0.1` only.

## 7. Shutdown

Send SIGINT/SIGTERM: server logs `shutting down`, closes HTTP + socket rooms, then
`prisma.$disconnect()`; force-exits after 10 s if stuck. Back up before any restore.

## 8. Security quicklist

- Never commit `packages/server/.env` (gitignored). `JWT_SECRET`/`COOKIE_SECRET`
  required and >=16 chars — the server won't start on defaults anymore.
- `REAL_MONEY_ENABLED` must stay `false` until the legal gate (Day 28 / legal team).
- The in-game currency is **USDT at 1:1**: balances, stakes and the stake tiers
  (open tables 1–100 USDT, Master Match 500–5000 USDT) are all denominated in USDT, and a new account starts with
  `START_BALANCE` (default 1) USDT — the welcome grant is deliberately small
  because the invitation programme, not the grant, is what funds a new player.
  While `REAL_MONEY_ENABLED=false` none of this moves real money — it is
  bookkeeping in a USDT unit.
- Invitations (`REFERRAL_*`): every account has one unique invite code and a
  shareable `?ref=` link. A new player may enter a code at signup (auto-filled
  from the link); the inviter earns `REFERRAL_BONUS_USDT` (default 1) once, and
  only once, when the invited player finishes their first **real** match
  (`REFERRAL_COUNT_PRACTICE=false` by default excludes vs-AI practice). The
  reward is gated on a played match, not on signup, so throwaway accounts cannot
  mint balance on their own.
- Deposits (`DEPOSIT_*`) are manual: players send USDT to the operator's external
  wallet (`DEPOSIT_WALLET_ADDRESS`) and an admin verifies a transaction id +
  screenshot before crediting. The credit is the same amount in USDT (1:1). No crypto
  moves through the server; review pending deposits in Admin → Deposits and keep the
  address set to a wallet the operator actually controls.
- Withdrawals (`WITHDRAW_*`) are the reverse: a player requests a payout to *their
  own* Solana address, and the request travels to the admins with a snapshot of the
  player's last `WITHDRAW_MATCH_SNAPSHOT_COUNT` finished matches. Approving in
  Admin → Withdrawals debits the same USDT amount (1:1) from the wallet in the same
  transaction; the operator must send the USDT out of band *before* approving.
- `CLIENT_ORIGIN` is a comma-separated allowlist; keep it to real origins.
- Turn timers, per-socket + per-user rate limits and shot-input validation are enforced
  server-side (Day 23).

## 9. Known gaps

- CI runs typecheck, unit tests and the build on pull requests (`.github/workflows/ci.yml`). There is still no Dockerfile for the app and no metrics endpoint.
- Redis is provisioned (localhost only, with a healthcheck) but unused. Game rooms
  live in the Node process; a second API instance would not share matches.
- e2e (`pnpm e2e`) needs a running server and mutates the dev DB — never point it at
  a shared environment.
- `COOKIE_SECRET` is required at boot and is not read anywhere else. Session
  cookies are not signed with it. `JWT_SECRET` signs player tokens and password-reset
  tokens. Admin sessions are random ids stored as a hash.=