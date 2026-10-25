import { api } from './api'
import type { AdminIdentity } from './types'

/**
 * The admin auth calls, typed once.
 *
 * Sign-in is a single step: email + password, then the session is issued. The app
 * stores the `token` (there is no cookie jar on a phone) and sends it as a bearer
 * token on every request.
 */
export interface LoginResult {
  user?: AdminIdentity
  expiresAt?: string
  token?: string
}

export function login(email: string, password: string): Promise<LoginResult> {
  return api<LoginResult>('/admin/auth/login', {
    method: 'POST',
    body: { email, password }
  })
}

export function fetchSession(): Promise<{ user: AdminIdentity }> {
  return api<{ user: AdminIdentity }>('/admin/auth/session')
}

export function logout(): Promise<void> {
  return api<void>('/admin/auth/logout', { method: 'POST' })
}
