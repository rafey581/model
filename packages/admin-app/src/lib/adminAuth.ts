import { api } from './api'
import type { AdminIdentity } from './types'

/**
 * The admin auth calls, typed once.
 *
 * The flow is three steps and the middle one happens only the first time an
 * account signs in: email + password, then (if the server says so) an
 * authenticator enrollment, then the session is issued. Both a fresh enrollment
 * and a normal sign-in end with a `token`, which is what the app stores.
 */
export interface LoginResult {
  user?: AdminIdentity
  expiresAt?: string
  token?: string
  requiresTotp?: boolean
  enrollToken?: string
  secret?: string
  otpauth?: string
}

export function login(email: string, password: string, totp?: string): Promise<LoginResult> {
  return api<LoginResult>('/admin/auth/login', {
    method: 'POST',
    body: { email, password, ...(totp ? { totp } : {}) }
  })
}

export function activateTotp(enrollToken: string, totp: string): Promise<LoginResult> {
  return api<LoginResult>('/admin/auth/totp/activate', {
    method: 'POST',
    body: { enrollToken, totp }
  })
}

export function fetchSession(): Promise<{ user: AdminIdentity }> {
  return api<{ user: AdminIdentity }>('/admin/auth/session')
}

export function logout(): Promise<void> {
  return api<void>('/admin/auth/logout', { method: 'POST' })
}
