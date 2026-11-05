# Deploy readiness — Snooker Stake

Audit date: 2026-11-05. Base commit: `0953d91` on `main`.
`origin/merge/friend-changes` is the same commit. Ship from `main`.

**Verdict:** the virtual-USDT game can run, and the live API is up. It is not ready
to hand to the public until the API is on HTTPS with a domain and both phone apps
are rebuilt against that address. Taking real USDT deposits is a separate legal
decision from `REAL_MONEY_ENABLED`, which stays `false`.

## What was checked

| Check | Result |
|---|---|
| Live `GET http://54.252.128.235:4000/api/health` | `ok: true`, `db: up`, `maintenance: false`, `realMoney: false`, `version: 0.1.0`, uptime about 5.3 days |
| Live `GET /api/ready` | HTTP 200, `db: up` |
| Live `GET /api/crypto/status` | `unauthorized` (the route requires a session; it does not expose a crypto rail) |
| Node / pnpm | Node v22.23.4. `pnpm install` completed with pnpm 9.15.9 (lockfile v9). CI pins that version. `pnpm-workspace.yaml` also has a pnpm 10 `allowBuilds` list, which pnpm 9 ignores and still installs |
| Database | Postgres 16. 21 migrations applied with `pnpm db:deploy`. `pnpm db:status`: schema up to date |
| `pnpm typecheck` | Pass. On a fresh tree this used to fail until `packages/shared` was built, because the client and admin app import `@snooker/shared` from `dist`. The root script now builds shared first |
| `pnpm test` | **982 passed.** Shared 204, client 545, server 197, admin app 36. Server suites ran against Postgres with rate limits off except where a test turns them back on |
| `pnpm build` | Pass. Shared `tsc`, server `prisma generate` + `tsc`, client Vite production build |
| `pnpm e2e` | Not run. It needs a live server and writes to the database. Do not point it at production |
| Phone APKs | Not rebuilt here. No Android SDK in this environment |
| Docker Compose healthcheck | The compose file was updated. This environment has no Docker daemon, so `docker compose ps` was not executed. Postgres for the tests was installed with apt |

`REAL_MONEY_ENABLED` was not turned on.

## How the money flags actually work

Three different switches. They are easy to mix up, and the old README mixed them up.

| Switch | Default | What it does |
|---|---|---|
| `REAL_MONEY_ENABLED` | `false` | Gates `POST /api/crypto/deposit` and `POST /api/crypto/withdraw`. Those routes answer **501** even when the flag is true. Leave it `false` |
| `DEPOSIT_ENABLED` | **on** if omitted | Players can submit a Solana tx id and a screenshot. Staff approval credits the USDT ledger. The server never moves the coin |
| `WITHDRAW_ENABLED` | **on** if omitted | Players can request a payout. Staff approval debits the ledger. Staff must send the USDT themselves, before approving |

Match stakes, the welcome grant (`START_BALANCE`, default 1 USDT), and the referral bonus move the ledger either way. A public launch that should **not** accept real coins must set `DEPOSIT_ENABLED=false` and `WITHDRAW_ENABLED=false` on the server. Health only reports `realMoney`. It does not report the deposit switches, so the live box has to be checked in `packages/server/.env`.

## Area notes

### Auth

Working, and covered by the server auth tests.

- Signup is direct (`AUTH_ALLOW_DIRECT_REGISTER=true`): email, username, password, phone, date of birth. Minimum age 18. Password at least 8 characters, bcrypt cost 12.
- The account is stored as email-verified without an emailed code. SMTP is unused on this path. If SMTP is empty, any OTP is written to the server log.
- One account per phone when the app sends a device id. Logins are not blocked by that cap.
- Password reset does not send email. The player submits name, username, email, phone and date of birth and receives a 10-minute token. Staff accounts cannot be reset this way.
- Login: 20 attempts / 5 minutes per address, and the account locks for 15 minutes after 5 wrong passwords. Signup: 10 / hour. Global cap: 600 / minute. Health and ready are exempt.
- The staff seed password `admin123` is refused at staff login. The seed itself still hashes with bcrypt cost 10; runtime passwords use cost 12.
- Player session cookie is `httpOnly` and `SameSite=Lax`. It is **not** marked `Secure`. The phone apps keep the bearer token. A browser on HTTPS should get a Secure cookie later; do not flip that while the API is plain HTTP or the current APKs will drop the cookie.
- `COOKIE_SECRET` is required at boot and is not used to sign cookies. `JWT_SECRET` signs player tokens and reset tokens. Admin sessions are random ids stored as a hash.

### Matchmaking

Invitation-based, not a browsed lobby. Covered by `challenges.test.ts` (11 tests).

- Public table: offered to other connected players, expires in 90 seconds.
- Friend invite: only that friend.
- Nothing is frozen while the invite is open. Accept freezes both stakes and creates the match in one transaction.
- Socket rooms live in the Node process. A second API process would not see them.
- On boot, non-practice matches left in `MATCH_STARTED` are refunded (`server_recovery_refund`). Alert if that count is not zero.

### Physics and rules

Shared engine tests passed (physics world, contacts, frame rules, stakes, red counts).

- Below 100 USDT, and practice: 6 reds. From 100 USDT up, including Master Match: 10 reds. The count is stored on the match.
- Open tables: 1, 5, 10, 20, 50, 100 USDT. Master Match: 500, 1000, 2000, 3000, 5000 USDT.
- A database created before Master Match can still have `maxStake = 10` in admin settings, and that saved value wins over `.env`.

### Wallet freeze and settlement

Covered by ledger, fee, deposit and withdrawal tests.

- Freeze moves available → locked. Settlement consumes both locks, credits the winner `pool - fee`, and credits the platform fee. Settlement is idempotent.
- Default commission is 10% (`COMMISSION_PCT`), copied onto the match from admin settings.
- Crash recovery refunds the lock instead of paying a winner.
- Proof screenshots are stored in Postgres as a base64 string, capped at 4 MB raw. nginx's default 1 MB body limit would reject them. `deploy/nginx/snooker.conf` sets 12 MB.

### Admin (Expo)

The staff app is the only admin surface. Unit tests: 36 passed (API URL, formatting, replay).

- Sign-in is email + password. Session lasts 30 minutes by default. 10 login attempts / 5 minutes, then lockout.
- `ADMIN_ALLOWED_IPS` should stay empty: staff phones change address. Boot logs a warning when it is empty. That warning is expected.
- While the app is open it polls every 10 seconds and rings. `ADMIN_PUSH_ENABLED` now defaults to **false** (it used to default to true if the variable was missing). The shipped product does not use Firebase. Tests still force the flag on so the push suite runs.
- `eas.json` bakes `EXPO_PUBLIC_API_URL=http://54.252.128.235:4000/api`. Android cleartext is on in `app.json`.
- EAS project id is set. Owner in `app.json` is `xast`.

### Player app (Capacitor)

- Package `com.snookerx.game`, name Snooker Stake. `packages/client/.env.app` bakes `VITE_API_ORIGIN=http://54.252.128.235:4000`.
- The WebView origin is `http://localhost`. `CLIENT_ORIGIN` must include that or the API rejects the browser calls. `.env.example` now includes it. Confirm the live `.env` does too.
- `usesCleartextTraffic` is true. A release build still talks HTTP until the URL is https and cleartext is turned off.
- No keystore is in the repo. That is correct. Back one up before the first release APK, and reuse it for every update.

## Blockers, in order

1. **HTTPS and a domain.** The apps talk to `http://54.252.128.235:4000`. Anyone on the path can read passwords and session tokens. Buy a domain, point `api.<domain>` at the Elastic IP, install `deploy/nginx/snooker.conf`, run certbot, set `TRUST_PROXY=true`, rebuild both apps with `https://api.<domain>` (staff URL ends in `/api`), then close inbound port 4000. Leave 22 for your IP and 80/443 open. Never open 5432.
2. **Decide whether this launch accepts real USDT.** If it is virtual ledger only, set `DEPOSIT_ENABLED=false` and `WITHDRAW_ENABLED=false` and restart. If staff will approve real transfers, legal sign-off comes first. Do not set `REAL_MONEY_ENABLED=true`.
3. **Confirm the live stake ceiling** is 5000 if Master Match is offered. Staff app: More → Settings. Or `SELECT value FROM "AppSetting" WHERE key='maxStake'`.
4. **Confirm the staff password** is not `admin123` (the server already rejects that one) and that `player@snooker.test` / `player2@snooker.test` are absent or suspended.
5. **Apply this compose change carefully on the server.** Postgres and Redis now bind to `127.0.0.1` only, with a healthcheck and `restart: unless-stopped`. Take `pnpm db:backup` first. Then `docker compose up -d postgres`. Do not run `docker compose down -v` (that deletes the database volume).
6. **One server only.** Game rooms are in memory. Do not run two Node processes against one database and expect matches to work. There is no metrics endpoint.

## Ship checklist

Do these in order.

- [ ] Back up the live database (`pnpm db:backup` on the Ubuntu host, after this branch is deployed; until then use `docker exec snooker-postgres pg_dump`).
- [ ] Pull this branch's result onto the server, `pnpm install && pnpm build && pnpm db:deploy`, recreate the postgres container without deleting `pgdata`, restart `snooker`.
- [ ] `curl -s localhost:4000/api/health` shows `"db":"up"` and `"realMoney":false`. `curl -s -o /dev/null -w '%{http_code}' localhost:4000/api/ready` is 200.
- [ ] `docker compose ps` shows postgres `healthy`.
- [ ] Live `.env`: strong `JWT_SECRET` and `COOKIE_SECRET`, `CLIENT_ORIGIN` includes `http://localhost`, `ADMIN_PUSH_ENABLED=false`, `REAL_MONEY_ENABLED=false`, deposit/withdraw flags match the legal decision, `TRUST_PROXY` still false until nginx is in front.
- [ ] `maxStake` is 5000. Staff password is strong. Demo players are suspended.
- [ ] Domain A record → Elastic IP. nginx site from `deploy/nginx/snooker.conf`. `certbot --nginx`. `TRUST_PROXY=true`. Restart the service. Health works on `https://api.<domain>/api/health`.
- [ ] Close security-group port 4000. Confirm 5432 is closed. SSH is your IP only.
- [ ] Rebuild the player APK with `VITE_API_ORIGIN=https://api.<domain>` (`pnpm build:app`, `pnpm cap:sync`, signed release). Rebuild the staff APK with `EXPO_PUBLIC_API_URL=https://api.<domain>/api`.
- [ ] On a phone not on the server's network: sign up, stay signed in after reload, start practice (6 reds), open a 100 USDT table (10 reds) if the ledger launch allows stakes.
- [ ] If deposits are enabled: request one, see the staff phone ring while the app is open, approve, balance increases. Withdrawal holds funds until approval. Support message arrives in the staff app.
- [ ] Staff dashboard shows today's deposits, withdrawals and profit.
- [ ] CI on this pull request is green (typecheck, unit tests, build, migrations).

## What is fine to leave for later

- Play Store listing and a release keystore ceremony beyond "back up the keystore".
- Firebase push (deliberately off; the staff phone must stay open to ring).
- Redis (present, unused, localhost only).
- An app Dockerfile, Prometheus, or a second API instance.
- Email OTP. Signup does not use it today.
- Using `COOKIE_SECRET` for something. Removing the requirement would be a separate change; operators already generate it.

## Next actions

1. Merge the readiness PR, then update the EC2 checkout and restart, after a database backup.
2. Read `DEPOSIT_ENABLED` and `WITHDRAW_ENABLED` on the live server and choose virtual-only or manual real USDT.
3. Put the API on `https://api.<your domain>`, rebuild both APKs, close port 4000.
4. Walk the phone checklist above once before inviting players.
