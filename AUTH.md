# Authentication

Two separate systems, on purpose. Players authenticate with a local account and a
one-time code sent to their email; staff authenticate with a password on a route the
public app never links to. They share a database and a JWT secret and almost nothing
else.

## Player sign-in

There is one way in: a local account. A player signs up with a **name, username,
email address, date of birth and password**, then proves the email address with a
one-time code before the account is created. From then on they sign in with their
**username and password**, and a forgotten password is recovered with another code
sent to the same address.

There is no provider registry and no wallet button: nothing about the screen depends
on a third party being configured, so there is no button that can fail on click.

### Signup

The email address is captured, is **unique**, and is the only address a code is ever
sent to:

```
POST /api/auth/signup/start   { name, username, email, dateOfBirth, password, ref? }
       validates the form and that email and username are free, mints a code
       for the email address, and parks the whole form on the challenge.
       No user is created.  -> { challengeId, destination, expiresIn }
POST /api/auth/signup/verify  { challengeId, code }
       -> { user, token, created: true }  (only now does a User row exist)
POST /api/auth/otp/resend     { challengeId }
       -> { challengeId, destination, expiresIn }  (new id; the old one is spent)
```

The signup payload — including the bcrypt hash of the password and the date of birth
— is held server-side on the OTP challenge (`OtpChallenge.payload`) and **never handed
back to the browser**. That is why an unverified signup leaves no half-built user
behind, and why nothing sensitive has to travel in a token the client can edit.

Verifying the code sets `emailVerified = true`. There is no second contact address:
WhatsApp delivery and phone-based verification were removed, so `User.phone` /
`phoneVerified` are legacy columns that are no longer written or read.

### Login and password reset

```
POST /api/auth/login           { username, password }  -> { user, token }
POST /api/auth/password/forgot { identifier }          -> { challengeId, destination, expiresIn }
POST /api/auth/password/reset  { challengeId, code, password } -> { reset: true }
```

Login is username + password. An email address is accepted in place of the username
for the seeded/internal accounts and the e2e suite, but the public screen sends a
username.

`/api/auth/password/forgot` takes an **email address only** — anything that is not an
email is refused with a 400 rather than being interpreted as a phone number. It
returns an identical response whether or not the address is known: a challenge is
minted either way, and one with no user behind it simply never receives a code, so
the endpoint cannot be used to enumerate accounts. A forgotten-password code can be
resent with the same `/api/auth/otp/resend`.

An `ADMIN` or `SUPERADMIN` account is refused by `/api/auth/login` outright, even
with the right password, and the attempt is written to the audit trail. The only way
to an admin session is the separate admin route, which has its own session system.

### One-time codes

Implemented in `auth/otp.ts` and delivered by `auth/delivery.ts`.

- Six digits drawn from `crypto.randomInt` — a `Math.random` code is guessable.
- Only the **SHA-256 of the code** is stored; the plaintext goes to the sender and is
  never persisted.
- Wrong guesses are counted against a cap (`OTP_MAX_ATTEMPTS`), the code is burned
  only on success, and the challenge has a short life (`OTP_TTL_SEC`). A wrong guess
  can never cancel a legitimate in-flight code.
- Resends are rate-limited per identifier and purpose (`OTP_RESEND_COOLDOWN_SEC`).

`auth/delivery.ts` sends over SMTP. When SMTP is not configured the code is **written
to the server log instead**, and the log line says plainly that nothing was sent. A
fresh checkout can therefore register and sign in with no third-party account, and a
delivery failure is surfaced rather than swallowed — the caller never tells the player
"code sent" when the send threw.

The address is normalised before a code is minted (`normalizeEmail`), so the string
the code was sent to is byte-for-byte the string it is later compared against; stray
spaces or casing would otherwise never match.

### Usernames

3–24 characters, `[A-Za-z0-9_]`, not a reserved word, unique **case-insensitively**.
`checkUsername()` matches the database's `User_username_lower_key` semantics so the
live check and the insert agree — otherwise the form would say a name was free and the
insert would still fail. The check is advisory; the server re-validates on submit and
a lost race returns 409.

## Admin sign-in

`/api/admin/auth/*` on the server, used only by the Expo admin app. Not linked from
the public UI, and the player app has no route or token that can reach it.

### What it defends against, and how

| Property | Mechanism |
|---|---|
| Revocable access | Sessions are rows in `Session` with `purpose = 'ADMIN'`, keyed by a SHA-256 hash of a 32-byte random token. Deleting the row ends access immediately — a stateless JWT cannot do this. |
| Not a player token | A separate cookie (`admin_session`, scoped to `/api/admin`) and a guard that requires `purpose = 'ADMIN'`. A stolen player token is rejected on every admin route. |
| No account enumeration | Identical response for an unknown address and a wrong password. A dummy bcrypt hash is compared when no user exists, so the timing does not give it away either. |
| Who is staff | `OWNER_USER_IDS`, a comma-separated list of account ids. Empty means nobody. A role of ADMIN or SUPERADMIN does not grant access, and the server never picks an account by email, age or role. |
| Brute force | Failures for player sign-in, staff sign-in and password recovery are rows in `LoginThrottle`, so they survive a restart and are shared by every process using the same database. Defaults: 5 failures on the typed identifier and 15 on the client address, then a fixed 15 minute cooldown. The cooldown does not grow and further guesses do not extend it. A correct password clears that identifier only. |
| Address | The counter uses `request.ip`. `TRUST_PROXY` defaults to false, so a client-supplied `X-Forwarded-For` is ignored. Set it true only behind a proxy that overwrites that header. |
| Audit | Every staff attempt lands in `AdminAction`. The player login route refusing an owner is recorded too. Passwords are not written there. |
| Network scoping | Optional `ADMIN_ALLOWED_IPS` allowlist. Empty means any IP, and boot logs a warning while it is empty. |

### Credentials

Sign-in is **email + password, in one step**, and only for an id in `OWNER_USER_IDS`.
There is no authenticator app and no second factor. `POST /api/admin/auth/login`
returns the session (cookie and bearer token) when the password verifies and the
account is on that list. A correct password on any other account gets the same
`invalid credentials` response as a wrong password. The owner account is refused
by the player login route. Anyone else, including an account whose role is still
ADMIN, signs in as a player.

On startup every staff session whose user is not on the list is deleted. A request
with a leftover token is rejected and that session row is deleted as well.

## Local setup

The seeded accounts (`admin@snooker.test`, `player@snooker.test`, `player2@snooker.test`)
use passwords and are seeded by `pnpm db:seed`, which takes `SEED_ADMIN_PASSWORD`.
Seeding does not put anyone on `OWNER_USER_IDS`. The seed prints the admin account
id so it can be copied into that variable if, and only if, that account is the one
that should operate the admin app.

With SMTP not configured, verification codes are printed to the server log — search
the output for the six-digit code. To try real delivery, set `SMTP_HOST`, `SMTP_PORT`,
`SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` and `SMTP_FROM`. Email is the only delivery
channel; there is no WhatsApp path.

### Recovering a forgotten admin password

The seed uses `update: {}` and bcrypt is one-way, so a password set at seed time
cannot be changed by re-seeding or recovered from the database. If it is lost:

```bash
cd packages/server
pnpm exec tsx scripts/show-user-id.ts --email you@example.com
# put that id in OWNER_USER_IDS and restart, then:
pnpm exec tsx scripts/set-admin-password.ts --email you@example.com --generate
```

`--generate` prints a 160-bit password once. The script refuses any account that
is not in `OWNER_USER_IDS`, refuses short passwords, ends that account's staff
sessions and player logins, and never writes the password or its hash into the
audit trail. It prints the id and changes nothing when the account is not an owner.

## Internal registration

`POST /api/auth/register` creates a `PLAYER` with no OTP step. It exists for tests,
the e2e suite and the seed, always creates a PLAYER and never reads a role from the
body. It is switched off wholesale with `AUTH_ALLOW_DIRECT_REGISTER`, which should be
`false` in any real deployment; boot logs a warning while it is open.

## Tests

- `src/auth/username.test.ts` — format, reserved words, case-insensitive uniqueness
- `src/admin/auth.test.ts` — admin login, lockout and every session property, over HTTP

Run with `pnpm test`. The auth suites use the dev database and clean up after
themselves, so point them at a scratch database.
