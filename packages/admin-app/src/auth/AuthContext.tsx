import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, setTokenProvider } from '@/lib/api'
import { fetchSession, logout as logoutRequest } from '@/lib/adminAuth'
import { readToken, writeToken } from '@/lib/tokenStore'
import { unregisterPush } from '@/lib/push'
import type { AdminIdentity } from '@/lib/types'

/**
 * Holds the admin session for the whole app.
 *
 * The token lives in a ref as well as state: the API client reads it through a
 * provider that must be current on the very first bootstrap request, before any
 * re-render has happened. State alone would race that call.
 */
interface AuthValue {
  /** False until the stored token has been checked, so the UI can hold a splash. */
  ready: boolean
  token: string | null
  admin: AdminIdentity | null
  signIn: (token: string, admin: AdminIdentity) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }): ReactNode {
  const [ready, setReady] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [admin, setAdmin] = useState<AdminIdentity | null>(null)
  const tokenRef = useRef<string | null>(null)

  useEffect(() => {
    setTokenProvider(async () => tokenRef.current)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const stored = await readToken()
      if (!stored) {
        if (!cancelled) setReady(true)
        return
      }
      tokenRef.current = stored
      try {
        const session = await fetchSession()
        if (cancelled) return
        setToken(stored)
        setAdmin(session.user)
      } catch {
        // Expired or revoked: drop it so the sign-in screen is what shows next.
        tokenRef.current = null
        await writeToken(null)
      } finally {
        if (!cancelled) setReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const signIn = useCallback(async (nextToken: string, nextAdmin: AdminIdentity) => {
    tokenRef.current = nextToken
    await writeToken(nextToken)
    setToken(nextToken)
    setAdmin(nextAdmin)
  }, [])

  const signOut = useCallback(async () => {
    // While the session is still valid: stop this phone ringing for this account.
    await unregisterPush()
    try {
      await logoutRequest()
    } catch {
      // The session may already be gone; clearing locally is still correct.
    }
    tokenRef.current = null
    await writeToken(null)
    setToken(null)
    setAdmin(null)
  }, [])

  const value = useMemo<AuthValue>(
    () => ({ ready, token, admin, signIn, signOut }),
    [ready, token, admin, signIn, signOut]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>')
  return value
}

/** Convenience for screens that only need the client, not the token. */
export { api }
