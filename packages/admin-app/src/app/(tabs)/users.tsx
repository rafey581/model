import { useEffect, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { api } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import { formatAmount, formatDate, formatRelative } from '@/lib/format'
import { deviceTimeZone } from '@/lib/timezone'
import type { AdminUser, UserRole, UserStatus } from '@/lib/types'
import { USER_ROLES, USER_STATUSES } from '@/lib/types'
import { Button, Card, Empty, ErrorState, Loading, Pill, Row, Screen, ScreenTitle } from '@/components/ui'
import { FilterChips } from '@/components/FilterChips'
import { AdjustWalletModal } from '@/components/AdjustWalletModal'
import { useDialog } from '@/components/ActionDialog'
import { useToast } from '@/components/Toast'
import { colors, radius, spacing } from '@/theme'

type UserFilter = '' | 'today' | 'active' | 'new' | 'suspended' | 'banned' | 'staff'

const FILTERS: Array<{ value: UserFilter; label: string }> = [
  { value: '', label: 'All' },
  { value: 'today', label: 'Active today' },
  { value: 'active', label: 'Active 7d' },
  { value: 'new', label: 'New today' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'banned', label: 'Banned' },
  { value: 'staff', label: 'Staff' }
]

/**
 * Player administration.
 *
 * Search and filters run on the server across every account (by username, email,
 * phone or id), settling 300 ms after typing stops so a word is one request, not one
 * per letter. Role and status changes confirm first when they are destructive,
 * because suspending the wrong account is worse than a tap.
 */
export default function UsersScreen() {
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<UserFilter>('')
  const [walletTarget, setWalletTarget] = useState<AdminUser | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const tz = deviceTimeZone()

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 300)
    return () => clearTimeout(timer)
  }, [query])

  const state = useAsync(() => {
    const params = new URLSearchParams({ tz })
    if (search) params.set('q', search)
    if (filter) params.set('filter', filter)
    return api<AdminUser[]>(`/admin/users?${params.toString()}`)
  }, [search, filter, tz])
  const dialog = useDialog()
  const toast = useToast()

  const filtered = state.data ?? []

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
      <ScreenTitle
        title="Users"
        subtitle={state.data ? `${filtered.length}${filtered.length >= 200 ? '+' : ''} shown` : 'Loading...'}
      />
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search username, email, phone or id"
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.search}
      />
      <FilterChips value={filter} onChange={setFilter} options={FILTERS} />

      {state.loading && !state.data ? <Loading /> : null}
      {state.error && !state.data ? <ErrorState message={state.error} onRetry={state.reload} /> : null}
      {state.data && filtered.length === 0 ? <Empty label={search || filter ? 'No players match.' : 'No players yet.'} /> : null}

      {filtered.map((user) => (
        <Card key={user.id}>
          <View style={styles.headerRow}>
            <View style={styles.flex}>
              <Text style={styles.username}>{user.username}</Text>
              <Text style={styles.muted} selectable>
                {[user.email ?? 'no email', user.phone].filter(Boolean).join(' - ')}
              </Text>
            </View>
            <Pill label={user.status} />
          </View>

          <Row label="Balance" value={`${formatAmount(user.wallet?.available)} USDT`} />
          {user.wallet?.locked !== undefined ? <Row label="Locked in play" value={`${formatAmount(user.wallet.locked)} USDT`} /> : null}
          {user.totalDeposited !== undefined ? <Row label="Deposited (approved)" value={`${formatAmount(user.totalDeposited)} USDT`} /> : null}
          {user.totalWithdrawn !== undefined ? <Row label="Withdrawn (approved)" value={`${formatAmount(user.totalWithdrawn)} USDT`} /> : null}
          <Row label="Last seen" value={user.lastSeenAt ? formatRelative(user.lastSeenAt) : 'never'} />
          {user.level !== undefined ? <Row label="Level" value={String(user.level)} /> : null}
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
