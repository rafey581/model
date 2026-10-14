import { StyleSheet, Text, View } from 'react-native'
import { api } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import { formatDateTime, humanize, jsonSummary } from '@/lib/format'
import type { AdminActionRow } from '@/lib/types'
import { Card, Empty, ErrorState, Loading, Screen, ScreenTitle } from '@/components/ui'
import { colors, spacing } from '@/theme'

/**
 * Who did what, newest first.
 *
 * The write path is not the interesting part of a money-moving action - the record
 * of it is. Every approve, reject, role change and balance adjustment lands here,
 * so "did someone credit this account, and why" has an answer.
 */
export default function AuditScreen() {
  const state = useAsync(() => api<AdminActionRow[]>('/admin/actions'), [])

  if (state.loading && !state.data) return <Screen scroll={false}><Loading /></Screen>
  if (state.error && !state.data) return <Screen><ErrorState message={state.error} onRetry={state.reload} /></Screen>

  const actions = state.data ?? []

  return (
    <Screen refreshing={state.refreshing} onRefresh={state.reload}>
      <ScreenTitle title="Admin audit log" subtitle={`${actions.length} most recent actions`} />
      {actions.length === 0 ? <Empty label="No admin actions recorded yet." /> : null}

      {actions.map((action) => (
        <Card key={action.id}>
          <View style={styles.headerRow}>
            <Text style={styles.action}>{humanize(action.action)}</Text>
            <Text style={styles.muted}>{formatDateTime(action.createdAt)}</Text>
          </View>
          <Text style={styles.actor}>
            by {action.adminUsername ?? action.adminId.slice(0, 10)} on {humanize(action.targetType)}
            {action.targetId ? ` ${action.targetId.slice(0, 10)}` : ''}
          </Text>
          {action.meta ? <Text style={styles.meta}>{jsonSummary(action.meta, 200)}</Text> : null}
        </Card>
      ))}
    </Screen>
  )
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  action: { color: colors.text, fontSize: 15, fontWeight: '700' },
  muted: { color: colors.muted, fontSize: 12 },
  actor: { color: colors.muted, fontSize: 12 },
  meta: { color: colors.text, fontSize: 12, marginTop: spacing.xs }
})
