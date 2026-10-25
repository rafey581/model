import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { colors, radius, spacing } from '@/theme'

/**
 * A promise-based confirm/prompt dialog.
 *
 * The web panel used `confirm()` and `prompt()`, which do not exist in React
 * Native (and `Alert.prompt` is iOS-only). This is the cross-platform stand-in:
 * screens `await confirm({...})` and get `{ confirmed, reason }` back, which keeps
 * the approve/reject flows readable instead of threading modal state by hand.
 */
export interface DialogRequest {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  /** Collect a free-text reason alongside the confirmation. */
  withReason?: boolean
  reasonPlaceholder?: string
  /** Refuse to confirm until a non-empty reason is entered. */
  requireReason?: boolean
}

export interface DialogResult {
  confirmed: boolean
  reason: string
}

interface DialogValue {
  confirm: (request: DialogRequest) => Promise<DialogResult>
}

const DialogContext = createContext<DialogValue | null>(null)

export function DialogProvider({ children }: { children: ReactNode }): ReactNode {
  // `request` outlives `open`: the modal fades out after settling, and clearing the
  // text at once would show an empty box with default buttons for the whole fade.
  const [request, setRequest] = useState<DialogRequest | null>(null)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const resolver = useRef<((result: DialogResult) => void) | null>(null)

  const confirm = useCallback((next: DialogRequest) => {
    setReason('')
    setRequest(next)
    setOpen(true)
    return new Promise<DialogResult>((resolve) => {
      resolver.current = resolve
    })
  }, [])

  const settle = useCallback((confirmed: boolean) => {
    const resolve = resolver.current
    resolver.current = null
    setOpen(false)
    resolve?.({ confirmed, reason: reason.trim() })
  }, [reason])

  const value = useMemo<DialogValue>(() => ({ confirm }), [confirm])
  const disabled = request?.requireReason === true && reason.trim().length === 0

  return (
    <DialogContext.Provider value={value}>
      {children}
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => settle(false)}>
        <Pressable style={styles.backdrop} onPress={() => settle(false)}>
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.center}>
            <Pressable style={styles.sheet} onPress={() => undefined}>
              <Text style={styles.title}>{request?.title}</Text>
              {request?.message ? <Text style={styles.message}>{request.message}</Text> : null}
              {request?.withReason ? (
                <TextInput
                  value={reason}
                  onChangeText={setReason}
                  placeholder={request.reasonPlaceholder ?? 'Reason'}
                  placeholderTextColor={colors.muted}
                  style={styles.input}
                  multiline
                  maxLength={200}
                  autoFocus
                />
              ) : null}
              <View style={styles.actions}>
                <Pressable style={[styles.action, styles.cancel]} onPress={() => settle(false)}>
                  <Text style={styles.cancelText}>{request?.cancelLabel ?? 'Cancel'}</Text>
                </Pressable>
                <Pressable
                  style={[styles.action, request?.destructive ? styles.destructive : styles.confirm, disabled ? styles.disabled : null]}
                  onPress={disabled ? undefined : () => settle(true)}
                >
                  <Text style={[styles.confirmText, request?.destructive ? styles.destructiveText : null]}>
                    {request?.confirmLabel ?? 'Confirm'}
                  </Text>
                </Pressable>
              </View>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>
    </DialogContext.Provider>
  )
}

export function useDialog(): DialogValue {
  const value = useContext(DialogContext)
  if (!value) throw new Error('useDialog must be used inside <DialogProvider>')
  return value
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  sheet: {
    width: '100%',
    maxWidth: 460,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md
  },
  title: { color: colors.text, fontSize: 17, fontWeight: '700' },
  message: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.text,
    padding: spacing.md,
    minHeight: 44,
    fontSize: 14
  },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  action: { paddingVertical: 10, paddingHorizontal: spacing.lg, borderRadius: radius.sm, borderWidth: 1 },
  cancel: { borderColor: colors.border },
  cancelText: { color: colors.text, fontWeight: '600' },
  confirm: { backgroundColor: colors.accent, borderColor: colors.accent },
  confirmText: { color: '#10141c', fontWeight: '700' },
  destructive: { backgroundColor: colors.negativeSoft, borderColor: colors.negative },
  destructiveText: { color: colors.negative },
  disabled: { opacity: 0.4 }
})
