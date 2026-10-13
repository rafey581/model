# Snooker Platform

Online multiplayer snooker gaming platform. Real-time 1v1 matches, 8-player
knockout tournaments and free robot-AI practice, backed by a server-authoritative
deterministic physics + rules engine and a ledger-based wallet.

> Balances are held in **USDT at 1:1**: deposits credit exactly what was sent, and
> stakes/payouts are quoted in USDT. The real-money path (`REAL_MONEY_ENABLED`) stays
> disabled until legal & licensing setup is complete, so today this is a fully
> demonstrable, offline bookkeeping economy denominated in USDT.

See also:
- `development_plan.md` — full technical specification
- `product_showcase_client_review.md` — client-facing product overview
- `RUNBOOK.md` — boot, migration, backup/restore and monitoring procedures

## Structure

```
packages/
  shared/   deterministic physics + snooker rules engine (shared by server & client)
  server/   Node.js API, Socket.IO game server, wallet/settlement, admin
  client/   Vite browser app (game renderer + UI)
```

## 1v1 matchmaking

Online play is invitation-based rather than a browsed table list:

- **Public table** — when a player opens a staked table, it is broadcast to every
  connected player. Accepting the popup freezes both stakes and starts the match at
  once; the offer expires after ~90 seconds if nobody takes it.
- **Friend invite** — the player may instead invite a friend directly (from the
  Play setup screen or the FRIENDS screen). Only that friend is offered the table.

Nothing is staked while a table waits: both sides are frozen atomically at accept,
so an invitation nobody takes never holds anyone's balance. Offline players are not
offered public tables.

## Invitations (referral programme)

Every account carries one unique invite code and a shareable link
(`/signup?ref=CODE`). A new player arrives through the link (the code pre-fills
the signup form) or types a friend's code into the optional **Invite code** field;
either way the inviter is recorded on the new account.

- **Welcome grant** — a new account starts with `START_BALANCE` = **1 USDT**.
- **Referral bonus** — the inviter earns **1 USDT** (`REFERRAL_BONUS_USDT`) when
  the invited player finishes their first real match. Nothing is paid at signup,
  and the reward is paid once per invitee (the match gate + a one-time stamp make
  it race-safe). A vs-AI practice match only counts with
  `REFERRAL_COUNT_PRACTICE=true`.
- The home screen **INVITE** tile shows the code, a copy/share button, and a
  live list of invited players (signed up → first match played), plus the USDT
  earned so far.
- Anti-abuse: codes are unique, self-referral is refused, bad codes are answered
  with an error at signup, and signup already demands a unique email + WhatsApp
  number verified by OTP.

## Quick Start

```bash
pnpm install
pnpm db:up                # starts postgres (docker compose)
cp .env.example packages/server/.env   # then set DATABASE_URL + real secrets
pnpm db:deploy            # apply migrations (non-interactive, for any environment)
pnpm db:seed              # first-boot users (admin, player, player2)
pnpm dev                  # runs server + client in watch mode
```

- Client: http://localhost:5173
- Server: http://localhost:4000 (health: `/api/health`, readiness: `/api/ready`)

## Useful Scripts

```bash
pnpm test          # run all tests (physics, rules, services)
pnpm typecheck     # typecheck all packages
pnpm build         # build all packages
pnpm e2e           # full end-to-end suite (needs a running server; mutates dev DB)
pnpm db:backup     # Postgres custom-format dump -> backups/
pnpm db:restore -- -File .\backups\snooker-<timestamp>.sql
```

## Environment Variables

Copy `.env.example` to `packages/server/.env` and fill in real values.
`DATABASE_URL`, `JWT_SECRET` and `COOKIE_SECRET` are required — the server refuses
to boot without them. Never commit real secrets. Full reference: `RUNBOOK.md` §2.

## License / Compliance

Real-money wagering is regulated activity. The crypto/real-money module is
built but disabled (`REAL_MONEY_ENABLED=false`) and must not be enabled without
licensed legal setup in the target jurisdiction.