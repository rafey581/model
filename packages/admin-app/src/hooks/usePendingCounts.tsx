import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppState } from 'react-native'
import { useAuth } from '@/auth/AuthContext'
import { api } from '@/lib/api'
import type { DashboardStats } from '@/lib/types'

/**
 * What is waiting on staff, for the tab badges.
 *
 * One poll of /admin/stats for the whole app, every 30 seconds while signed in and
 * in the foreground, plus an immediate re-read whenever a screen finishes an action
 * (approve, reject, reply) so a badge never lags the work just done.
 */
export interface PendingCounts {
  deposits: number
  withdrawals: number
  support: number
}

interface PendingValue {
  counts: PendingCounts
  refresh: () => void
}

const EMPTY: PendingCounts = { deposits: 0, withdrawals: 0, support: 0 }
const POLL_MS = 30_000

const PendingContext = createContext<PendingValue>({ counts: EMPTY, refresh: () => undefined })

export function PendingCountsProvider({ children }: { children: ReactNode }): ReactNode {
  const { token } = useAuth()
  const [counts, setCounts] = useState<PendingCounts>(EMPTY)
  const inFlight = useRef(false)

  const refresh = useCallback(() => {
    if (!token || inFlight.current) return
    inFlight.current = true
    api<DashboardStats>('/admin/stats')
      .then((stats) =>
        setCounts({
          deposits: stats.pendingDeposits,
          withdrawals: stats.pendingWithdrawals,
          support: stats.supportAwaiting ?? 0
        })
      )
      .catch(() => undefined)
      .finally(() => {
        inFlight.current = false
      })
  }, [token])

  useEffect(() => {
    if (!token) {
      setCounts(EMPTY)
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

  const value = useMemo(() => ({ counts, refresh }), [counts, refresh])
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
