import { StyleSheet, Text, View } from 'react-native'
import { useAuth } from '@/auth/AuthContext'
import { api } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import type { DashboardStats } from '@/lib/types'
import { Card, ErrorState, Loading, Row, Screen, ScreenTitle, StatCard } from '@/components/ui'
import { colors, spacing } from '@/theme'
import { formatAmount, formatSignedAmount } from '@/lib/format'

/**
 * The first thing an admin sees: the numbers that decide what to do next.
 *
 * Deposits and withdrawals that need review are surfaced as their own cards, not
 * buried, because a pending payout is a person waiting on their money.
 */
export default function DashboardScreen() {
  const { admin } = useAuth()
  const state = useAsync(() => api<DashboardStats>('/admin/stats'), [])

  if (state.loading && !state.data) return <Screen scroll={false}><Loading /></Screen>
  if (state.error && !state.data) {
    return (
      <Screen>
        <ErrorState message={state.error} onRetry={state.reload} />
      </Screen>
    )
  }

  const stats = state.data
  if (!stats) return <Screen scroll={false}><Loading /></Screen>

  const needsReview = stats.pendingDeposits > 0 || stats.pendingWithdrawals > 0

  return (
    <Screen refreshing={state.refreshing} onRefresh={state.reload}>
      <ScreenTitle
        title={`Hello, ${admin?.username ?? 'admin'}`}
        subtitle="Platform overview"
      />

      {needsReview ? (
        <Card style={styles.attention}>
          <Text style={styles.attentionTitle}>Needs your attention</Text>
          <Text style={styles.attentionBody}>
            {stats.pendingDeposits} deposit(s) and {stats.pendingWithdrawals} withdrawal(s) are waiting.
          </Text>
        </Card>
      ) : null}

      <View style={styles.grid}>
        <StatCard label="Registered users" value={String(stats.users)} />
        <StatCard label="Platform revenue (USDT)" value={formatAmount(stats.platformRevenue)} tone="WIN" />
        <StatCard label="Pending deposits" value={String(stats.pendingDeposits)} tone={stats.pendingDeposits > 0 ? 'PENDING' : undefined} />
        <StatCard label="Pending payouts" value={String(stats.pendingWithdrawals)} tone={stats.pendingWithdrawals > 0 ? 'PENDING' : undefined} />
        <StatCard label="Live matches" value={String(stats.activeMatches)} />
        <StatCard label="Completed matches" value={String(stats.completedMatches)} />
        <StatCard label="Deposits (all time)" value={String(stats.deposits)} />
        <StatCard label="Withdrawals (all time)" value={String(stats.withdrawals)} />
      </View>

      <Card>
        <Row label="Revenue" value={`${formatSignedAmount(stats.platformRevenue)} USDT`} />
        <Row label="Live now" value={`${stats.activeMatches} match(es)`} />
        <Row label="Completed" value={`${stats.completedMatches} match(es)`} />
      </Card>
    </Screen>
  )
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  attention: { borderColor: colors.warning, backgroundColor: colors.warningSoft },
  attentionTitle: { color: colors.warning, fontSize: 15, fontWeight: '700' },
  attentionBody: { color: colors.text, fontSize: 13 }
})
