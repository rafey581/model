import { useMemo, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { api } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import { formatAmount, formatDate } from '@/lib/format'
import type { AdminUser, UserRole, UserStatus } from '@/lib/types'
import { USER_ROLES, USER_STATUSES } from '@/lib/types'
import { Button, Card, Empty, ErrorState, Loading, Pill, Row, Screen, ScreenTitle } from '@/components/ui'
import { FilterChips } from '@/components/FilterChips'
import { AdjustWalletModal } from '@/components/AdjustWalletModal'
import { useDialog } from '@/components/ActionDialog'
import { useToast } from '@/components/Toast'
import { colors, radius, spacing } from '@/theme'

/**
 * Player administration.
 *
 * Search runs on the loaded page (the API returns the newest 200) rather than
 * round-tripping per keystroke, which keeps the list responsive and avoids a
 * request per character. Role and status changes confirm first when they are
 * destructive, because suspending the wrong account is worse than a tap.
 */
export default function UsersScreen() {
  const [query, setQuery] = useState('')
  const [walletTarget, setWalletTarget] = useState<AdminUser | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const state = useAsync(() => api<AdminUser[]>('/admin/users'), [])
  const dialog = useDialog()
  const toast = useToast()

  const users = state.data ?? []
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return users
    return users.filter(
      (user) =>
        user.username.toLowerCase().includes(needle) ||
        (user.email ?? '').toLowerCase().includes(needle)
    )
  }, [users, query])

  const patch = async (user: AdminUser, change: { status?: UserStatus; role?: UserRole }): Promise<void> => {
    if (change.status === 'BANNED') {
      const result = await dialog.confirm({
        title: 'Ban this player?',
        message: `${user.username} will not be able to sign in or play until unbanned.`,
        confirmLabel: 'Ban',
        destructive: true
      })
      if (!result.confirmed) return
    }
    setBusyId(user.id)
    try {
      await api('/admin/users', { method: 'PATCH', body: { userId: user.id, ...change } })
      toast.show(`${user.username} updated`, 'success')
      state.reload()
    } catch (caught) {
      toast.show((caught as Error).message, 'error')
    } finally {
      setBusyId(null)
    }
  }

  const adjust = async (amount: number, reason: string): Promise<void> => {
    if (!walletTarget) return
    await api('/admin/wallet/adjust', { method: 'POST', body: { userId: walletTarget.id, amount, reason } })
    toast.show(`Adjusted ${walletTarget.username} by ${amount > 0 ? '+' : ''}${formatAmount(amount)} USDT`, 'success')
    setWalletTarget(null)
    state.reload()
  }

  return (
    <Screen refreshing={state.refreshing} onRefresh={state.reload}>
      <ScreenTitle title="Users" subtitle={`${users.length} loaded`} />
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search by username or email"
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.search}
      />

      {state.loading && !state.data ? <Loading /> : null}
      {state.error && !state.data ? <ErrorState message={state.error} onRetry={state.reload} /> : null}
      {state.data && filtered.length === 0 ? <Empty label="No players match that search." /> : null}

      {filtered.map((user) => (
        <Card key={user.id}>
          <View style={styles.headerRow}>
            <View style={styles.flex}>
              <Text style={styles.username}>{user.username}</Text>
              <Text style={styles.muted}>{user.email ?? 'no email'}</Text>
            </View>
            <Pill label={user.status} />
          </View>

          <Row label="Balance" value={`${formatAmount(user.wallet?.available)} USDT`} />
          {user.wallet?.locked !== undefined ? <Row label="Locked in play" value={`${formatAmount(user.wallet.locked)} USDT`} /> : null}
          <Row label="Joined" value={formatDate(user.createdAt)} />

          <Text style={styles.groupLabel}>Role</Text>
          <FilterChips
            value={user.role as UserRole}
            options={USER_ROLES.map((role) => ({ value: role, label: role }))}
            onChange={(role) => void patch(user, { role })}
          />
          <Text style={styles.groupLabel}>Status</Text>
          <FilterChips
            value={user.status as UserStatus}
            options={USER_STATUSES.map((status) => ({ value: status, label: status }))}
            onChange={(status) => void patch(user, { status })}
          />

          <Button
            label={busyId === user.id ? 'Updating...' : 'Adjust balance'}
            variant="subtle"
            onPress={() => setWalletTarget(user)}
            disabled={busyId === user.id}
            style={styles.adjustButton}
          />
        </Card>
      ))}

      <AdjustWalletModal user={walletTarget} onCancel={() => setWalletTarget(null)} onSubmit={adjust} />
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  search: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 15
  },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  username: { color: colors.text, fontSize: 16, fontWeight: '700' },
  muted: { color: colors.muted, fontSize: 12 },
  groupLabel: { color: colors.muted, fontSize: 12, fontWeight: '600', marginTop: spacing.sm },
  adjustButton: { marginTop: spacing.md }
})
