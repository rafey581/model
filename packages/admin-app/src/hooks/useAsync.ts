import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Fetches once on mount and on demand.
 *
 * Every admin screen is the same shape - load, show, reload after an action - so
 * the loading/error/refresh bookkeeping lives here instead of being repeated. The
 * latest `fn` is kept in a ref so the effect can stay keyed on `deps` without the
 * caller having to memoise the closure.
 */
export interface AsyncState<T> {
  data: T | null
  error: string | null
  loading: boolean
  refreshing: boolean
  reload: () => void
}

export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const mounted = useRef(true)
  const fnRef = useRef(fn)
  fnRef.current = fn

  const run = useCallback(async (refreshingMode: boolean) => {
    if (refreshingMode) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const result = await fnRef.current()
      if (mounted.current) setData(result)
    } catch (caught) {
      if (mounted.current) setError((caught as Error).message)
    } finally {
      if (mounted.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void run(false)
    return () => {
      mounted.current = false
    }
    // The caller owns the dependency list: it is the request's inputs, not `fn`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  const reload = useCallback(() => void run(true), [run])

  return { data, error, loading, refreshing, reload }
}
