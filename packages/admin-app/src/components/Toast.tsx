import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { colors, radius, spacing } from '@/theme'

/**
 * A single transient banner, shown above everything.
 *
 * Used for the result of an action ("credited 10 USDT", "session expired") so a
 * screen does not have to own a message slot per operation.
 */
export type ToastKind = 'info' | 'error' | 'success'

interface ToastValue {
  show: (message: string, kind?: ToastKind) => void
}

const ToastContext = createContext<ToastValue | null>(null)

interface ActiveToast {
  id: number
  message: string
  kind: ToastKind
}

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [active, setActive] = useState<ActiveToast | null>(null)
  const counter = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = useCallback((message: string, kind: ToastKind = 'info') => {
    counter.current += 1
    setActive({ id: counter.current, message, kind })
  }, [])

  useEffect(() => {
    if (!active) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setActive(null), 3500)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [active])

  const value = useMemo<ToastValue>(() => ({ show }), [show])

  return (
    <ToastContext.Provider value={value}>
      {children}
      {active ? (
        <View pointerEvents="none" style={styles.host}>
          <View style={[styles.toast, TONES[active.kind]]}>
            <Text style={styles.text}>{active.message}</Text>
          </View>
        </View>
      ) : null}
    </ToastContext.Provider>
  )
}

const TONES: Record<ToastKind, { borderColor: string }> = {
  info: { borderColor: colors.info },
  error: { borderColor: colors.negative },
  success: { borderColor: colors.positive }
}

export function useToast(): ToastValue {
  const value = useContext(ToastContext)
  if (!value) throw new Error('useToast must be used inside <ToastProvider>')
  return value
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    top: 54,
    left: spacing.lg,
    right: spacing.lg,
    alignItems: 'center'
  },
  toast: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    maxWidth: '100%'
  },
  text: { color: colors.text, fontSize: 14, textAlign: 'center' }
})
