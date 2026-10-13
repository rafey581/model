# Authentication

Two separate systems, on purpose. Players authenticate with a local account and a
one-time code; staff authenticate with a password and a second factor on a route the
public app never links to. They share a database and a JWT secret and almost nothing
else.

## Player sign-in

There is one way in: a local account. A player signs up with a **name, username,
email address, WhatsApp number, date of birth and password**, then proves the
address they chose — email or WhatsApp — with a one-time code before the account is
created. From then on they sign in with their **username and password**, and a
forgotten password is recovered with another code.

There is no provider registry and no wallet button: nothing about the screen depends
on a third party being configured, so there is no button that can fail on click.

### Signup

Both the email address and the WhatsApp number are captured and **both are unique** —
a second account may not reuse either. The player chooses which one to verify:

```
POST /api/auth/signup/start   { name, username, email, phone, dateOfBirth, password, verifyVia }
       validates the form and that email, phone and username are all free,
       mints a code against the chosen address, and parks the whole form
       on the challenge. No user is created.
       -> { challengeId, channel, destination, expiresIn }
POST /api/auth/signup/verify  { challengeId, code }
       -> { user, token, created: true }  (only now does a User row exist)
POST /api/auth/otp/resend     { challengeId }
       -> { challengeId, channel, destination, expiresIn }  (new id; the old one is spent)
```

The signup payload — including the bcrypt hash of the password and the date of birth
— is held server-side on the OTP challenge (`OtpChallenge.payload`) and **never handed
back to the browser**. That is why an unverified signup leaves no half-built user
behind, and why nothing sensitive has to travel in a token the client can edit.

The `verifyVia` choice decides which of the two addresses is proven now: the chosen
one gets `emailVerified` / `phoneVerified = true`, the other stays on file unverified.
Either can later be used for a password reset, because both are already unique
proofs of contact.

### Login and password reset

```
POST /api/auth/login           { username, password }  -> { user, token }
POST /api/auth/password/forgot { identifier }          -> { challengeId, channel, destination, expiresIn }
POST /api/auth/password/reset  { challengeId, code, password } -> { reset: true }
```

Login is username + password. An email address is accepted in place of the username
for the seeded/internal accounts and the e2e suite, but the public screen sends a
username.

`/api/auth/password/forgot` returns an identical response whether or not the address
is known — a challenge is minted either way, and one with no user behind it simply
never receives a code, so the endpoint cannot be used to enumerate accounts. A
forgotten-password code can be resent with the same `/api/auth/otp/resend`.

An `ADMIN` or `SUPERADMIN` account is refused by `/api/auth/login` outright, even
with the right password, and the attempt is written to the audit trail. The only way
to an admin session is the hardened route that also demands TOTP.

### One-time codes

Implemented in `auth/otp.ts` and delivered by `auth/delivery.ts`.

- Six digits drawn from `crypto.randomInt` — a `Math.random` code is guessable.
- Only the **SHA-256 of the code** is stored; the plaintext goes to the sender and is
  never persisted.
- Wrong guesses are counted against a cap (`OTP_MAX_ATTEMPTS`), the code is burned
  only on success, and the challenge has a short life (`OTP_TTL_SEC`). A wrong guess
  can never cancel a legitimate in-flight code.
- Resends are rate-limited per identifier and purpose (`OTP_RESEND_COOLDOWN_SEC`).

`auth/delivery.ts` sends over SMTP (email) or the Twilio WhatsApp API. When a channel
is not configured the code is **written to the server log instead**, and the log line
says plainly that nothing was sent. A fresh checkout can therefore register and sign
in with no third-party account, and a delivery failure is surfaced rather than
swallowed — the caller never tells the player "code sent" when the send threw.

Both addresses are normalised before a code is minted (`normalizeEmail`,
`normalizePhone`), so the string the code was sent to is byte-for-byte the string it
is later compared against; a stray space or a missing `+` would otherwise never match.

### Usernames

3–24 characters, `[A-Za-z0-9_]`, not a reserved word, unique **case-insensitively**.
`checkUsername()` matches the database's `User_username_lower_key` semantics so the
live check and the insert agree — otherwise the form would say a name was free and the
insert would still fail. The check is advisory; the server re-validates on submit and
a lost race returns 409.

## Admin sign-in

`/api/admin` in the browser, `/api/admin/auth/*` on the server. Not linked from the
public UI, and the client bundle short-circuits the rest of the app when it sees that
path — no game loop, no socket, no player token.

### What it defends against, and how

| Property | Mechanism |
|---|---|
| Revocable access | Sessions are rows in `Session` with `purpose = 'ADMIN'`, keyed by a SHA-256 hash of a 32-byte random token. Deleting the row ends access immediately — a stateless JWT cannot do this. |
| Not a player token | A separate cookie (`admin_session`, scoped to `/api/admin`) and a guard that requires `purpose = 'ADMIN'`. A stolen player token is rejected on every admin route. |
| No account enumeration | Identical response for an unknown address, a wrong password and a wrong code. A dummy bcrypt hash is compared when no user exists, so the timing does not give it away either. |
| Brute force | Failures counted per account **and** per IP, with a lockout that grows with the count. The IP budget is 3× the account budget — an IP is shared by an office or a carrier, and locking one after as few failures as it takes to lock an account would let one fumbled password lock out everyone behind that NAT. |
| Second factor | TOTP (RFC 6238, HMAC-SHA1), mandatory by default. |
| Audit | Every attempt lands in `AdminAction`; the player login route refusing an admin is recorded too, because that is either a mistake or a probe. |
| Network scoping | Optional `ADMIN_ALLOWED_IPS` allowlist. Empty means any IP, and boot logs a warning while it is empty. |

### The bootstrap

An admin with no enrolled TOTP is not let in on a password alone. Instead:

1. `POST /api/admin/auth/login` with the password returns `requiresTotp`, a
   freshly generated secret and a five-minute enrollment grant — **no session**.
2. The admin adds the secret to an authenticator app.
3. `POST /api/admin/auth/totp/activate` with a live code commits the secret and
   issues the session in the same request.

Nothing is written until a code comes back, which is what proves the admin holds the
authenticator, and there is no half-enrolled state to get stuck in.

TOTP is implemented in `auth/totp.ts` against the RFC 6238 test vectors, with one
step of clock drift tolerated either side. A 30-second window on a phone whose
clock runs slightly fast would otherwise lock an owner out roughly one time in
three.

## Local setup

The seeded accounts (`admin@snooker.test`, `player@snooker.test`, `player2@snooker.test`)
use passwords and are seeded by `pnpm db:seed`, which takes `SEED_ADMIN_PASSWORD`.
The seeded admin starts with no TOTP enrolled, so the first login returns an
enrollment grant and the second factor is set up as part of signing in.

With neither SMTP nor WhatsApp configured, verification codes are printed to the
server log — watch the server output for the six-digit code. To try real delivery,
set `SMTP_HOST` (email) and/or `WHATSAPP_PROVIDER=twilio` with the Twilio credentials.

### Recovering a forgotten admin password

The seed uses `update: {}` and bcrypt is one-way, so a password set at seed time
cannot be changed by re-seeding or recovered from the database. If it is lost:

```bash
cd packages/server
pnpm exec tsx scripts/set-admin-password.ts --email admin@snooker.test --generate
pnpm exec tsx scripts/set-admin-password.ts --email admin@snooker.test --generate --reset-totp  # if the authenticator is lost too
```

`--generate` prints a 160-bit password once. The script refuses non-admin
accounts and short passwords, never writes the password or its hash into the
audit trail, and clears TOTP only when `--reset-totp` is given — resetting a
password should not silently downgrade a second factor.

## Internal registration

`POST /api/auth/register` creates a `PLAYER` with no OTP step. It exists for tests,
the e2e suite and the seed, always creates a PLAYER and never reads a role from the
body. It is switched off wholesale with `AUTH_ALLOW_DIRECT_REGISTER`, which should be
`false` in any real deployment; boot logs a warning while it is open.

## Tests

- `src/auth/username.test.ts` — format, reserved words, case-insensitive uniqueness
- `src/auth/totp.test.ts` — RFC 6238 vectors, drift, rejection
- `src/admin/auth.test.ts` — the whole admin bootstrap and every session property, over HTTP

Run with `pnpm test`. The auth suites use the dev database and clean up after
themselves, so point them at a scratch database.
