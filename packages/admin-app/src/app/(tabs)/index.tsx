import { useCallback, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { useAuth } from '@/auth/AuthContext'
import { api } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import { deviceTimeZone } from '@/lib/timezone'
import type { DashboardStats, FinancePeriod } from '@/lib/types'
import { Card, ErrorState, Loading, Row, Screen, ScreenTitle, SectionTitle, StatCard } from '@/components/ui'
import { FilterChips } from '@/components/FilterChips'
import { colors, spacing } from '@/theme'
import { formatAmount, formatSignedAmount } from '@/lib/format'

const PERIODS: Array<{ value: FinancePeriod; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: '7 days' },
  { value: 'month', label: '30 days' },
  { value: 'all', label: 'All time' }
]

const PERIOD_NOUN: Record<FinancePeriod, string> = {
  today: 'today',
  week: 'in the last 7 days',
  month: 'in the last 30 days',
  all: 'all time'
}

/**
 * The first thing an admin sees: what is waiting, where the money stands, and who
 * is playing.
 *
 * Money is shown for one period at a time (today by default, since that is the
 * question asked most), and "today" is the staff member's own day: the app sends
 * its timezone and the server counts from local midnight.
 */
export default function DashboardScreen() {
  const { admin } = useAuth()
  const router = useRouter()
  const [period, setPeriod] = useState<FinancePeriod>('today')
  const tz = deviceTimeZone()
  const state = useAsync(() => api<DashboardStats>(`/admin/stats?tz=${encodeURIComponent(tz)}`), [tz])

  // The numbers move while staff work in the other tabs; re-read on the way back.
  useFocusEffect(
    useCallback(() => {
      state.reload()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
  )

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

  const support = stats.supportAwaiting ?? 0
  const waiting: Array<{ count: number; label: string; href: string }> = [
    { count: stats.pendingDeposits, label: 'deposit(s) to verify', href: '/deposits' },
    { count: stats.pendingWithdrawals, label: 'payout(s) to review', href: '/withdrawals' },
    { count: support, label: 'player(s) waiting on support', href: '/support' }
  ].filter((w) => w.count > 0)

  const finance = stats.finance
  const people = stats.userActivity
  const money = (n: number) => `${formatAmount(n)} USDT`

  return (
    <Screen refreshing={state.refreshing} onRefresh={state.reload}>
      <ScreenTitle title={`Hello, ${admin?.username ?? 'admin'}`} subtitle={`Platform overview - ${stats.timeZone ?? tz}`} />

      {waiting.length > 0 ? (
        <Card style={styles.attention}>
          <Text style={styles.attentionTitle}>Needs your attention</Text>
          {waiting.map((w) => (
            <Pressable key={w.href} accessibilityRole="link" onPress={() => router.push(w.href as never)}>
              <Text style={styles.attentionBody}>
                <Text style={styles.attentionCount}>{w.count}</Text> {w.label} <Text style={styles.attentionLink}>Open</Text>
              </Text>
            </Pressable>
          ))}
        </Card>
      ) : null}

      <SectionTitle>Finance</SectionTitle>
      {finance ? (
        <>
          <FilterChips value={period} onChange={setPeriod} options={PERIODS} />
          <View style={styles.grid}>
            <StatCard label={`Deposits ${PERIOD_NOUN[period]}`} value={money(finance.deposits[period])} tone="WIN" />
            <StatCard label={`Withdrawals ${PERIOD_NOUN[period]}`} value={money(finance.withdrawals[period])} tone="LOSS" />
          </View>
          <Card style={finance.netProfit[period] >= 0 ? styles.profitUp : styles.profitDown}>
            <Text style={styles.profitLabel}>Net profit {PERIOD_NOUN[period]}</Text>
            <Text style={[styles.profitValue, { color: finance.netProfit[period] >= 0 ? colors.positive : colors.negative }]}>
              {formatSignedAmount(finance.netProfit[period])} USDT
            </Text>
            <Row label="Commission earned" value={`+${formatAmount(finance.commission[period])} USDT`} />
            <Row label="Bonuses paid (welcome, referral)" value={`-${formatAmount(finance.bonuses[period])} USDT`} />
            {finance.adjustments[period] !== 0 ? (
              <Row label="Staff balance adjustments" value={`${formatSignedAmount(-finance.adjustments[period])} USDT`} />
            ) : null}
          </Card>
          <Card>
            <Row label="Net cash flow (deposits - withdrawals)" value={`${formatSignedAmount(finance.netFlow[period])} USDT`} />
            <Row label="Held by players now" value={money(finance.playerBalances)} />
            <Row label="Approved deposits (all time)" value={String(finance.deposits.countAll)} />
            <Row label="Approved payouts (all time)" value={String(finance.withdrawals.countAll)} />
          </Card>
        </>
      ) : (
        <Card>
          <Row label="Platform revenue" value={`${formatSignedAmount(stats.platformRevenue)} USDT`} />
          <Text style={styles.note}>Update the server for deposit, withdrawal and profit totals.</Text>
        </Card>
      )}

      <SectionTitle>Players</SectionTitle>
      <View style={styles.grid}>
        <StatCard label="Total players" value={String(people?.total ?? stats.users)} />
        {people ? (
          <>
            <StatCard label="Active today" value={String(people.activeToday)} tone={people.activeToday > 0 ? 'WIN' : undefined} />
            <StatCard label="Active in 7 days" value={String(people.activeWeek)} />
            <StatCard label="New today" value={String(people.newToday)} />
          </>
        ) : null}
      </View>
      {people && (people.suspended > 0 || people.banned > 0) ? (
        <Card>
          <Row label="Suspended" value={String(people.suspended)} />
          <Row label="Banned" value={String(people.banned)} />
        </Card>
      ) : null}
      <Pressable accessibilityRole="link" onPress={() => router.push('/users' as never)}>
        <Text style={styles.link}>Open players</Text>
      </Pressable>

      <SectionTitle>Matches</SectionTitle>
      <View style={styles.grid}>
        <StatCard label="Live now" value={String(stats.activeMatches)} />
        <StatCard label="Completed" value={String(stats.completedMatches)} />
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  attention: { borderColor: colors.warning, backgroundColor: colors.warningSoft },
  attentionTitle: { color: colors.warning, fontSize: 15, fontWeight: '700' },
  attentionBody: { color: colors.text, fontSize: 13, paddingVertical: 2 },
  attentionCount: { fontWeight: '700' },
  attentionLink: { color: colors.info, fontWeight: '600' },
  profitUp: { borderColor: colors.positive },
  profitDown: { borderColor: colors.negative },
  profitLabel: { color: colors.muted, fontSize: 12, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  profitValue: { fontSize: 28, fontWeight: '800', marginBottom: spacing.xs },
  note: { color: colors.muted, fontSize: 12 },
  link: { color: colors.info, fontSize: 13, fontWeight: '600', textAlign: 'right' }
})
