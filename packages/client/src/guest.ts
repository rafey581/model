import { GUEST_STAKE_PROMPT } from '@snooker/shared'

export { GUEST_STAKE_PROMPT }

/** Set when guest play is running entirely on this device. */
export const LOCAL_GUEST_KEY = 'snooker_guest_local'
/** Set for the one reload that should open a local frame, then cleared. */
export const LOCAL_GUEST_AUTOSTART_KEY = 'snooker_guest_autostart'
export const LOCAL_GUEST_ID = 'local-guest'

export interface SessionUser {
  id: string
  username: string
  role: string
  status: string
  authProvider?: string
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function isLocalGuest(): boolean {
  return storage()?.getItem(LOCAL_GUEST_KEY) === '1'
}

export function markLocalGuest(): void {
  storage()?.setItem(LOCAL_GUEST_KEY, '1')
}

export function armLocalGuestAutostart(): void {
  storage()?.setItem(LOCAL_GUEST_AUTOSTART_KEY, '1')
}

/** True once, on the reload that follows Continue as Guest. */
export function consumeLocalGuestAutostart(): boolean {
  const store = storage()
  const armed = store?.getItem(LOCAL_GUEST_AUTOSTART_KEY) === '1'
  if (armed) store?.removeItem(LOCAL_GUEST_AUTOSTART_KEY)
  return armed
}

export function clearLocalGuest(): void {
  const store = storage()
  store?.removeItem(LOCAL_GUEST_KEY)
  store?.removeItem(LOCAL_GUEST_AUTOSTART_KEY)
}

export function isGuestAccount(user: { id?: string; authProvider?: string } | null | undefined): boolean {
  if (!user) return false
  return user.authProvider === 'GUEST' || user.id === LOCAL_GUEST_ID
}

export function localGuestUser(): SessionUser {
  return { id: LOCAL_GUEST_ID, username: 'Guest', role: 'PLAYER', status: 'ACTIVE', authProvider: 'GUEST' }
}

/** True when fetch never reached the server. A refused request is not unreachable. */
export function isUnreachable(error: unknown): boolean {
  if (error instanceof TypeError) return true
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  return (
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('network request failed') ||
    message.includes('load failed')
  )
}
