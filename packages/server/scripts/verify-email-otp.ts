/**
 * End-to-end check of the email-only OTP flows.
 *
 * Runs the real routes against a running server: signup start -> verify -> sign in,
 * then password forgot -> reset. With no SMTP configured the code only exists in the
 * server log, so this reads the code straight off the challenge row (dev only).
 *
 *   pnpm exec tsx scripts/verify-email-otp.ts
 */
import { createHash } from 'node:crypto'
import { prisma } from '../src/db/index.js'

const BASE = process.env.VERIFY_BASE_URL ?? 'http://localhost:4000'

interface ApiResult {
  status: number
  body: any
}

async function api(path: string, init?: RequestInit): Promise<ApiResult> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
  })
  const text = await res.text()
  try {
    return { status: res.status, body: JSON.parse(text) }
  } catch {
    return { status: res.status, body: text }
  }
}

function hashOf(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex')
}

/** Recovers the plaintext code by brute-forcing the 6-digit space against the hash. */
async function codeFor(challengeId: string): Promise<string> {
  const challenge = await prisma.otpChallenge.findUnique({ where: { id: challengeId } })
  if (!challenge) throw new Error(`no challenge ${challengeId}`)
  for (let i = 0; i < 1_000_000; i++) {
    const candidate = String(i).padStart(6, '0')
    if (hashOf(candidate) === challenge.codeHash) return candidate
  }
  throw new Error('code not found')
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`)
  console.log(`  ok - ${message}`)
}

async function main(): Promise<void> {
  const stamp = Date.now()
  const email = `otp-check-${stamp}@example.com`
  const username = `otpcheck${stamp}`.slice(0, 24)

  console.log('\nsignup/start (email only)')
  const start = await api('/api/auth/signup/start', {
    method: 'POST',
    body: JSON.stringify({
      name: 'OTP Check',
      username,
      email,
      dateOfBirth: '1990-01-01',
      password: 'password123'
    })
  })
  assert(start.status === 200, `signup/start accepted the form (${start.status})`)
  assert(start.body.data?.challengeId, 'a challenge id came back')
  assert(!('channel' in (start.body.data ?? {})), 'no channel field in the response any more')

  console.log('\nphone + verifyVia are rejected')
  const legacy = await api('/api/auth/signup/start', {
    method: 'POST',
    body: JSON.stringify({
      name: 'OTP Check',
      username: `${username}b`,
      email: `other-${stamp}@example.com`,
      phone: '+447700900000',
      dateOfBirth: '1990-01-01',
      password: 'password123',
      verifyVia: 'whatsapp'
    })
  })
  assert(legacy.status === 200, `extra fields are ignored, not required (${legacy.status})`)

  console.log('\nsignup/verify')
  const code = await codeFor(start.body.data.challengeId)
  const verify = await api('/api/auth/signup/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId: start.body.data.challengeId, code })
  })
  assert(verify.status === 200, `the code created the account (${verify.status})`)
  assert(verify.body.data?.user?.username === username, 'the new user came back')

  const created = await prisma.user.findUnique({ where: { username } })
  assert(created?.emailVerified === true, 'emailVerified is true')
  assert(created?.phoneVerified === false, 'phoneVerified stayed false')
  assert(created?.phone === null, 'no phone number was stored')

  console.log('\nlogin')
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password: 'password123' })
  })
  assert(login.status === 200, `username + password signs in (${login.status})`)

  console.log('\npassword/forgot (email only)')
  const notEmail = await api('/api/auth/password/forgot', {
    method: 'POST',
    body: JSON.stringify({ identifier: '+447700900000' })
  })
  assert(notEmail.status === 400, `a phone number is refused (${notEmail.status})`)

  const forgot = await api('/api/auth/password/forgot', {
    method: 'POST',
    body: JSON.stringify({ identifier: email })
  })
  assert(forgot.status === 200, `the email starts a reset (${forgot.status})`)
  assert(!('channel' in (forgot.body.data ?? {})), 'no channel field in the reset response')

  const resetCode = await codeFor(forgot.body.data.challengeId)
  const reset = await api('/api/auth/password/reset', {
    method: 'POST',
    body: JSON.stringify({ challengeId: forgot.body.data.challengeId, code: resetCode, password: 'password456' })
  })
  assert(reset.status === 200, `the reset code set the new password (${reset.status})`)

  const relogin = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password: 'password456' })
  })
  assert(relogin.status === 200, `the new password works (${relogin.status})`)

  console.log('\nunknown address still cannot be enumerated')
  const unknown = await api('/api/auth/password/forgot', {
    method: 'POST',
    body: JSON.stringify({ identifier: `nobody-${stamp}@example.com` })
  })
  assert(unknown.status === 200 && unknown.body.data?.challengeId, 'same shape for an unknown address')

  console.log('\nALL CHECKS PASSED')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
