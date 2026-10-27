import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppState } from 'react-native'
import { useAuth } from '@/auth/AuthContext'
import { api } from '@/lib/api'
import type { PendingCountsPayload } from '@/lib/types'

/**
 * What is waiting on staff, for the tab badges.
 *
 * One poll of /admin/pending for the whole app, every 10 seconds while signed in and
 * in the foreground, plus an immediate re-read whenever a screen finishes an action
 * (approve, reject, reply) so a badge never lags the work just done. The same reading
 * is what rings the phone for a new request (PhoneAlerts), hence the short interval.
 */
export interface PendingCounts {
  deposits: number
  withdrawals: number
  support: number
}

interface PendingValue {
  counts: PendingCounts
  /** False until the first reading of this session has come back. */
  loaded: boolean
  refresh: () => void
}

const EMPTY: PendingCounts = { deposits: 0, withdrawals: 0, support: 0 }
const POLL_MS = 10_000

const PendingContext = createContext<PendingValue>({ counts: EMPTY, loaded: false, refresh: () => undefined })

export function PendingCountsProvider({ children }: { children: ReactNode }): ReactNode {
  const { token } = useAuth()
  const [counts, setCounts] = useState<PendingCounts>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const inFlight = useRef(false)

  const refresh = useCallback(() => {
    if (!token || inFlight.current) return
    inFlight.current = true
    api<PendingCountsPayload>('/admin/pending')
      .then((stats) => {
        setCounts({
          deposits: stats.pendingDeposits,
          withdrawals: stats.pendingWithdrawals,
          support: stats.supportAwaiting ?? 0
        })
        setLoaded(true)
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight.current = false
      })
  }, [token])

  useEffect(() => {
    if (!token) {
      setCounts(EMPTY)
      setLoaded(false)
      return
    }
    refresh()
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') refresh()
    }, POLL_MS)
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh()
    })
    return () => {
      clearInterval(timer)
      sub.remove()
    }
  }, [token, refresh])

  const value = useMemo(() => ({ counts, loaded, refresh }), [counts, loaded, refresh])
  return <PendingContext.Provider value={value}>{children}</PendingContext.Provider>
}

export function usePendingCounts(): PendingValue {
  return useContext(PendingContext)
}

/** A tab badge: hidden at zero, capped so it never outgrows the icon. */
export function badge(count: number): string | number | undefined {
  if (count <= 0) return undefined
  return count > 99 ? '99+' : count
}
