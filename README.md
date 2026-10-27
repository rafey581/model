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
  shared/     deterministic physics + snooker rules engine (shared by server & client)
  server/     Node.js API, Socket.IO game server, wallet/settlement, admin
  client/     Vite browser app (game renderer + UI)
  admin-app/  Expo (React Native) staff app - the only admin surface
```

## Stakes

Open tables: **1, 5, 10, 20, 50, 100 USDT**. Master Match: **500, 1000, 2000, 3000, 5000 USDT**.

Reds follow the stake: below **100 USDT** (and practice) a frame is racked with **6 reds**,
from **100 USDT** up (the 100 table and every Master Match) with **10 reds**. The count is
fixed on the match when its game starts (`Match.reds`), so every frame and the admin
replay use the same rack. Matches from before this were 15-red.

The stake ceiling is an admin setting (`maxStake`, default 5000). A database set up with
the old default of 10 refuses every table above 10 USDT until it is raised in the admin
app (More → Settings).
Both use the same virtual ledger freeze and settlement. `REAL_MONEY_ENABLED` stays
`false`, so crypto deposits and withdrawals stay gated off. A new account still
starts with 1 USDT; a Master Match needs a balance that covers the stake.

The post-login home hall (not the sign-in screen) cycles its glow through red,
blue, and gold. `prefers-reduced-motion` holds it on the blue hall.

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
  with an error at signup, and signup already demands a unique email address
  verified by an emailed one-time code.

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

## Admin app

Staff do their work from `packages/admin-app`, an Expo (React Native) app — the
web client is player-only and exposes no admin surface. It covers the dashboard,
deposit and withdrawal review, users (role, status, balance adjustments),
matches with a stroke-by-stroke replay, settings, fraud/ledger checks and the
audit log.

```bash
pnpm --filter @snooker/admin-app start   # then press i / a, or scan with Expo Go
```

The app signs in with the admin email + password. It talks to the server on
port 4000: by default it reuses the Expo dev server's host, so a phone on the same
network needs nothing configured. Point it elsewhere with
`EXPO_PUBLIC_API_URL=http://host:4000/api` in `packages/admin-app/.env`. The
seeded admin account is created by `pnpm db:seed`.

### Player app (Android debug APK)

The playable client is Snooker Stake, a Capacitor app in `packages/client` (`com.snookerx.game`).
A debug APK is built with the JDK and Android SDK (compile/target SDK 35):

```bash
# Emulator default: the host machine is 10.0.2.2. A phone on your LAN needs that
# machine's address instead, then the same two commands.
#   VITE_API_ORIGIN=http://192.168.1.20:4000
cd packages/client
pnpm build:app          # reads packages/client/.env.app (VITE_API_ORIGIN)
pnpm cap:sync
cd android && ./gradlew assembleDebug
```

`VITE_API_ORIGIN` is baked in at build time. The checked-in `.env.app` points at
`http://10.0.2.2:4000`, which is the Android emulator's alias for the computer
running the API. Change that one line and rebuild to aim a handset at another host.
The API still has to be reachable, and `REAL_MONEY_ENABLED` is unchanged.

Graphics quality is automatic: low on weak phones, medium on typical Android,
high on desktop. Override with `?quality=low|medium|high` or the in-game setting.
Rails and pocket leather use the birch and hide photos in `public/textures`.

### Staff app (Android APK via EAS)

`packages/admin-app/eas.json` defines a `preview` profile that produces a
directly installable `.apk`. EAS builds in the cloud, so no Android SDK or Java
is needed locally:

```bash
cd packages/admin-app
npx eas-cli@latest login                      # once, with your Expo account
npx eas-cli@latest init                       # once, links the project
npx eas-cli@latest build -p android --profile preview
```

When the build finishes, scan the QR code on the build page or download the
`.apk` and install it (Android may ask you to allow "install unknown apps").

A standalone build cannot guess the server address the way Expo Go does (there
is no Metro dev server to read), so the URL is baked in at build time from
`EXPO_PUBLIC_API_URL` in `eas.json` — currently `http://54.252.128.235:4000/api`.
Change it there and rebuild if the server moves. The phone must be able to reach
that host, so the server has to be running and the port reachable.

The server speaks plain HTTP, so the Android build turns on cleartext traffic
(the `expo-build-properties` plugin in `app.json`); without it a release APK
fails to reach the API with no visible error.

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