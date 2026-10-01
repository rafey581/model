# Authentication

Two separate systems, on purpose. Players authenticate with an identity provider;
staff authenticate with a password and a second factor on a route the public app
never links to. They share a database and a JWT secret and almost nothing else.

## Player sign-in

The login screen is rendered from `GET /api/auth/providers`. The server decides
what is usable; a provider that is switched off is not in the list, so the client
cannot show a button that fails. Adding a provider is a registry entry plus a
handler — no client change.

| Provider | State | What it needs |
|---|---|---|
| Phantom | **On by default** | Nothing. A wallet signs a challenge we mint and we verify it with Node's own ed25519. |
| Google | On once credentials are set | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` |
| Binance | **Deferred** | No consumer "Sign in with Binance" OAuth is published for third-party web apps, and Binance's domains are behind bot protection, so the flow could not be verified. Gated in `auth/providers.ts`. |

Phantom is the one provider that works on a fresh checkout with no configuration,
which is why the login screen is never empty in a local dev environment.

### What each provider gives us

The login screen states this under each button, in the player's words, rather than
behind a link most people will not click. Consent nobody reads is not consent.

| Provider | Provides | Verifies email |
|---|---|---|
| Google | `sub` (stable id), `email`, `email_verified`, `name`, `given_name`, `family_name`, `picture` | yes |
| Phantom | the wallet address — nothing else | no |

Every account is keyed on **`(authProvider, providerAccountId)`** — Google's `sub`,
or the Solana address — **never on email**. Email is user-mutable, so keying on it
would let anyone claim an existing account by registering the same address. A
wallet account has no email at all, which is why `User.email` is nullable and why
`Password` is nullable too.

The same model covers the crypto side of the product later: for a Phantom player,
`providerAccountId` *is* the payout address, so payouts do not need a second
identity field or a linking step.

### Google

```
GET  /api/auth/google              -> 302 to Google (state, nonce, PKCE sealed in an httpOnly cookie)
GET  /api/auth/google/callback     -> verify id_token against Google's JWKS
      known account   -> session cookie, redirect to /
      new identity    -> redirect to /?auth=pending&t=<grant>&u=<suggestion>
```

`state`, `nonce` and the PKCE verifier live in a signed, httpOnly, 10-minute cookie
rather than in server-side state, so there is no flow store to grow. The id_token
is verified for signature, `aud`, `iss` and `nonce`; the `nonce` check is what
stops a token minted for someone else's flow from being replayed here.

A returning user's callback is a redirect, so the client has no socket token when
it lands. `GET /api/auth/session` exchanges the httpOnly cookie for a fresh one,
which avoids putting a token in a URL where it would reach history and logs.

### Phantom

Sign In With Solana: the wallet proves control of an address by signing a message
we minted, and we verify the signature. Nothing about the person is disclosed.

```
POST /api/auth/phantom/challenge   { address }        -> { message, challenge }
      the wallet signs `message` verbatim
POST /api/auth/phantom/verify      { challenge, signature }
      known wallet   -> session cookie and token
      new wallet     -> { pendingToken, suggestedUsername }
POST /api/auth/complete           { pendingToken, username }
```

The client must connect the wallet first, because the message names the account it
is asking about. That is what stops a signature for wallet A being replayed as a
login for wallet B — the message text differs, so the signature does not verify.

**The server generates the message and carries it inside a signed, 5-minute
challenge token.** The client signs those exact bytes and returns the token with
the signature, and verification reads the message back out of the token. The server
never rebuilds a message from fields, which is where SIWS implementations
classically fail: a single mismatched byte or line ending reconstructs a different
string, and either every legitimate signature is rejected or — worse — a mismatch
gets papered over and a challenge is accepted that nobody signed.

Two consequences worth stating:

- The address used for verification comes from the **signed token**, never from
  the request body, so a valid signature cannot be re-pointed at another wallet.
- The nonce is **single-use**, burned only *after* the signature verifies. A
  captured `(challenge, signature)` pair would otherwise be a valid login for the
  rest of the 5-minute window. Burning on failure instead would let anyone who can
  reach the endpoint cancel an in-flight sign-in, so the order matters.

Base58 and ed25519 are hand-rolled on top of `node:crypto` rather than pulled from
`bs58`/`tweetnacl`, so the auth path gains no dependencies. Base58 is pinned to the
reference `bs58` package's own documented vectors, so "hand-rolled" is verified
rather than assumed — including the all-zero case, where an uncapped leading-zero
run turns the 32-byte System Program address into 33 characters and every address
check downstream rejects it.

The client prefers the Wallet Standard API (`navigator.wallets`) and falls back to
Phantom's legacy `window.phantom.solana` injection, because that fallback is the
path most installed extensions actually take. Wallet Standard has no "list what is
installed" call, so `client/wallet.ts` asks for the ids it knows and accepts any
wallet that can sign — someone arriving on Solflare is not told to install a
different extension.

### Usernames

3–24 characters, `[A-Za-z0-9_]`, not a reserved word. Uniqueness is
**case-insensitive**: `User_username_key` alone was case-sensitive and accepted
both `Player` and `player`, so the migration adds `User_username_lower_key` on
`lower(username)`. `checkUsername()` matches that semantics so the UI and the
database agree — otherwise the form would say a name was free and the insert would
still fail.

On a first sign-in the server suggests a free name and the player confirms it.
Google seeds it from the profile name or the local part of the email; a wallet has
no profile, so it is seeded from the address as `player_<6 chars>` — a public value,
and therefore not usable as an identity on its own. A lost race on submit returns
409 with the conflicting name rather than restarting the flow.

`POST /api/auth/complete` is shared by both providers. They prove identity in
completely different ways, but the step that follows — *we know who you are, now
tell us what to call you* — is identical, and two completion endpoints would mean
two copies of the username validation to keep in step. The provider is inside the
signed pending token, so a Google grant cannot be redeemed as a wallet signup.

## Admin sign-in

`/api/admin` in the browser, `/api/admin/auth/*` on the server. Not linked from the
public UI, and the client bundle short-circuits the rest of the app when it sees
that path — no game loop, no socket, no player token.

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

The login is **not** reachable through `/api/auth/login`: that route refuses
`ADMIN` and `SUPERADMIN` outright, even with the correct password.

### The bootstrap

An admin with no enrolled TOTP is not let in on a password alone. Instead:

1. `POST /api/admin/auth/login` with the password returns `requiresTotp`, a
   freshly generated secret and a five-minute enrollment grant — **no session**.
2. The admin adds the secret to an authenticator app.
3. `POST /api/admin/auth/totp/activate` with a live code commits the secret and
   issues the session in the same request.

Nothing is written until a code comes back, which is what proves the admin holds
the authenticator, and there is no half-enrolled state to get stuck in.

TOTP is implemented in `auth/totp.ts` against the RFC 6238 test vectors, with one
step of clock drift tolerated either side. A 30-second window on a phone whose
clock runs slightly fast would otherwise lock an owner out roughly one time in
three.

## Local setup

Phantom works immediately — install the extension and click the button. Google is
off until credentials exist, and the login screen simply omits it rather than
rendering a button that fails. To try the real Google flow, set
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and register
`http://localhost:4000/api/auth/google/callback`.

The seeded accounts (`admin@snooker.test`, `player@snooker.test`) use passwords
and are seeded by `pnpm db:seed`, which takes `SEED_ADMIN_PASSWORD`. Password
login for them is the internal path described above, not a public option.

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

The seeded admin starts with no TOTP enrolled, so the first login returns an
enrollment grant and the second factor is set up as part of signing in.

## Tests

- `src/auth/base58.test.ts` — the reference `bs58` vectors, the all-zero case, and
  real ed25519 keys and signatures
- `src/auth/phantom.test.ts` — the wallet flow over real HTTP with a real keypair:
  cross-challenge reuse, another wallet's signature, replay, a forged attempt not
  burning a live nonce, and identical responses for "garbage" and "wrong key"
- `src/auth/username.test.ts` — format, reserved words, case-insensitive uniqueness
- `src/auth/totp.test.ts` — RFC 6238 vectors, drift, rejection
- `src/admin/auth.test.ts` — the whole bootstrap and every session property, over HTTP
- `packages/client/src/wallet.test.ts` — wallet discovery, the Wallet Standard
  fallback, and the guarantee that the message reaches the wallet byte-for-byte

Run with `pnpm test`. The auth suites use the dev database and clean up after
themselves, so point them at a scratch database.

`packages/server/scripts/phantom-e2e.ts` drives the same flow against the **running**
server, with a real keypair and a real signature, then deletes the account it made.
`app.inject()` proves the routes and the crypto but not that a real HTTP server, the
Vite proxy and the database agree — this does, and it leaves the database as it
found it.
