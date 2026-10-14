import { StyleSheet, Text, View } from 'react-native'
import { api } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import { formatDateTime, humanize } from '@/lib/format'
import type { FraudFlagRow, LedgerInvariance } from '@/lib/types'
import { Card, Empty, ErrorState, Loading, Pill, Row, Screen, ScreenTitle, SectionTitle } from '@/components/ui'
import { colors, spacing } from '@/theme'

/**
 * Risk flags and the ledger check, together.
 *
 * A fraud flag on its own is a hint; a ledger that does not balance is a fact. They
 * sit on the same screen because the second is what makes the first worth acting
 * on, and because a broken ledger should be impossible to miss.
 */
export default function FraudScreen() {
  const flags = useAsync(() => api<FraudFlagRow[]>('/admin/fraud'), [])
  const ledger = useAsync(() => api<LedgerInvariance>('/admin/ledger/invariance'), [])

  const loading = (flags.loading && !flags.data) || (ledger.loading && !ledger.data)
  if (loading) return <Screen scroll={false}><Loading /></Screen>

  const violation = ledger.data && !ledger.data.ok

  return (
    <Screen
      refreshing={flags.refreshing || ledger.refreshing}
      onRefresh={() => {
        flags.reload()
        ledger.reload()
      }}
    >
      <ScreenTitle title="Fraud and ledger" subtitle="Risk signals and wallet reconciliation" />

      <SectionTitle>Ledger invariance</SectionTitle>
      {ledger.error && !ledger.data ? (
        <ErrorState message={ledger.error} onRetry={ledger.reload} />
      ) : ledger.data ? (
        <Card style={violation ? styles.badCard : styles.goodCard}>
          <View style={styles.headerRow}>
            <Text style={[styles.verdict, { color: violation ? colors.negative : colors.positive }]}>
              {violation ? 'Balances do not reconcile' : 'Ledger is consistent'}
            </Text>
            <Pill label={violation ? 'ATTENTION' : 'OK'} tone={violation ? 'REJECTED' : 'APPROVED'} />
          </View>
          <Row label="Accounts checked" value={String(ledger.data.checked)} />
          <Row label="Accounts off" value={String(ledger.data.violations.length)} />
          {ledger.data.violations.slice(0, 20).map((item) => (
            <Row
              key={item.userId}
              label={item.userId.slice(0, 10)}
              value={`expected ${item.expected} / actual ${item.actual} (${item.delta > 0 ? '+' : ''}${item.delta})`}
              valueStyle={{ color: colors.negative }}
            />
          ))}
          {ledger.data.violations.length > 20 ? (
            <Text style={styles.more}>and {ledger.data.violations.length - 20} more</Text>
          ) : null}
        </Card>
      ) : null}

      <SectionTitle>Risk flags</SectionTitle>
      {flags.loading && !flags.data ? <Loading /> : null}
      {flags.error && !flags.data ? <ErrorState message={flags.error} onRetry={flags.reload} /> : null}
      {flags.data && flags.data.length === 0 ? (
        <Empty label="No flags raised." hint="Collusion and abnormal-win heuristics write here." />
      ) : null}

      {flags.data?.map((flag) => (
        <Card key={flag.id}>
          <View style={styles.headerRow}>
            <Text style={styles.kind}>{humanize(flag.kind)}</Text>
            <Pill label={`${Math.round(flag.confidence * 100)}%`} tone={flag.confidence >= 0.7 ? 'REJECTED' : 'PENDING'} />
          </View>
          <Row label="Player" value={flag.username ?? flag.userId.slice(0, 12)} />
          {flag.reason ? <Row label="Reason" value={flag.reason} /> : null}
          <Row label="Raised" value={formatDateTime(flag.createdAt)} />
        </Card>
      ))}
    </Screen>
  )
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  verdict: { fontSize: 15, fontWeight: '700', flexShrink: 1 },
  kind: { color: colors.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  goodCard: { borderColor: colors.positive },
  badCard: { borderColor: colors.negative, backgroundColor: colors.negativeSoft },
  more: { color: colors.muted, fontSize: 12, marginTop: spacing.xs }
})
