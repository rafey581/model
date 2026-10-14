import { useEffect, useState, type ReactNode } from 'react'
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import type { AdminUser } from '@/lib/types'
import { colors, radius, spacing } from '@/theme'

/**
 * Add or remove balance for one player.
 *
 * This is the one place an admin can move money directly, so it is a deliberate
 * two-field form (amount and a reason that goes into the audit log and the ledger
 * metadata) rather than a bare confirm. It resets between openings so an amount
 * typed for one player cannot be submitted for the next.
 */
export function AdjustWalletModal({
  user,
  onCancel,
  onSubmit
}: {
  user: AdminUser | null
  onCancel: () => void
  onSubmit: (amount: number, reason: string) => Promise<void>
}): ReactNode {
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (user) {
      setAmount('')
      setReason('')
      setError(null)
      setBusy(false)
    }
  }, [user])

  const submit = async (): Promise<void> => {
    const parsed = Number(amount)
    if (!Number.isFinite(parsed) || parsed === 0) {
      setError('Enter a non-zero amount. Negative values remove balance.')
      return
    }
    if (!reason.trim()) {
      setError('A reason is required - it is written to the audit log.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmit(parsed, reason.trim())
    } catch (caught) {
      setError((caught as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal visible={user !== null} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.center}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <Text style={styles.title}>Adjust balance</Text>
            <Text style={styles.message}>
              {user ? `${user.username} currently has ${Number(user.wallet?.available ?? 0).toFixed(2)} USDT available.` : ''}
            </Text>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Text style={styles.label}>Amount (USDT)</Text>
            <TextInput
              value={amount}
              onChangeText={setAmount}
              placeholder="10 or -10"
              placeholderTextColor={colors.muted}
              keyboardType="numbers-and-punctuation"
              style={styles.input}
            />
            <Text style={styles.label}>Reason</Text>
            <TextInput
              value={reason}
              onChangeText={setReason}
              placeholder="Why this adjustment is being made"
              placeholderTextColor={colors.muted}
              style={[styles.input, styles.multiline]}
              multiline
              maxLength={200}
            />
            <View style={styles.actions}>
              <Pressable style={[styles.action, styles.cancel]} onPress={onCancel}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.action, styles.confirm, busy ? styles.disabled : null]}
                onPress={busy ? undefined : () => void submit()}
              >
                <Text style={styles.confirmText}>{busy ? 'Saving...' : 'Apply'}</Text>
              </Pressable>
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  )
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
    gap: spacing.sm
  },
  title: { color: colors.text, fontSize: 17, fontWeight: '700' },
  message: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  error: { color: colors.negative, fontSize: 13 },
  label: { color: colors.muted, fontSize: 12, fontWeight: '600', marginTop: spacing.xs },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 15
  },
  multiline: { minHeight: 64, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.sm },
  action: { paddingVertical: 10, paddingHorizontal: spacing.lg, borderRadius: radius.sm, borderWidth: 1 },
  cancel: { borderColor: colors.border },
  cancelText: { color: colors.text, fontWeight: '600' },
  confirm: { backgroundColor: colors.accent, borderColor: colors.accent },
  confirmText: { color: '#10141c', fontWeight: '700' },
  disabled: { opacity: 0.5 }
})
