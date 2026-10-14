import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { api } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import { formatAmount, formatDateTime, shortId } from '@/lib/format'
import type { AdminWithdrawal, AdminWithdrawalsPayload, AdminWithdrawalMatch, ReviewStatus } from '@/lib/types'
import { Button, Card, Divider, Empty, ErrorState, Loading, Pill, Row, Screen, ScreenTitle } from '@/components/ui'
import { FilterChips } from '@/components/FilterChips'
import { useDialog } from '@/components/ActionDialog'
import { useToast } from '@/components/Toast'
import { colors, spacing } from '@/theme'

type Filter = '' | ReviewStatus

/**
 * Payout review.
 *
 * A withdrawal left the player's balance when it was requested, so approving it
 * only marks the transfer done, while rejecting it puts the money back. The match
 * history is shown inline because a first payout is the moment a mismatched win
 * loss record is worth noticing.
 */
export default function WithdrawalsScreen() {
  const [filter, setFilter] = useState<Filter>('PENDING')
  const [busyId, setBusyId] = useState<string | null>(null)
  const state = useAsync(
    () => api<AdminWithdrawalsPayload>(`/admin/withdrawals${filter ? `?status=${filter}` : ''}`),
    [filter]
  )
  const dialog = useDialog()
  const toast = useToast()

  const approve = async (item: AdminWithdrawal): Promise<void> => {
    const result = await dialog.confirm({
      title: 'Approve payout?',
      message: `Send ${formatAmount(item.amount)} ${item.currency} to ${item.address}. Confirm you have paid the player.`,
      confirmLabel: 'Approve'
    })
    if (!result.confirmed) return
    setBusyId(item.id)
    try {
      const approved = await api<{ deducted: number }>(`/admin/withdrawals/${item.id}/approve`, { method: 'POST', body: {} })
      toast.show(`Payout of ${formatAmount(approved.deducted)} USDT marked complete`, 'success')
      state.reload()
    } catch (caught) {
      toast.show((caught as Error).message, 'error')
    } finally {
      setBusyId(null)
    }
  }

  const reject = async (item: AdminWithdrawal): Promise<void> => {
    const result = await dialog.confirm({
      title: 'Reject payout?',
      message: `${formatAmount(item.amount)} ${item.currency} will be returned to ${item.user.username}'s balance.`,
      confirmLabel: 'Reject',
      destructive: true,
      withReason: true,
      reasonPlaceholder: 'Reason the player will see (optional)'
    })
    if (!result.confirmed) return
    setBusyId(item.id)
    try {
      await api(`/admin/withdrawals/${item.id}/reject`, {
        method: 'POST',
        body: result.reason ? { reason: result.reason } : {}
      })
      toast.show('Payout rejected and refunded', 'info')
      state.reload()
    } catch (caught) {
      toast.show((caught as Error).message, 'error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Screen refreshing={state.refreshing} onRefresh={state.reload}>
      <ScreenTitle
        title="Withdrawals"
        subtitle={state.data ? `${state.data.pending} awaiting review` : 'Loading...'}
      />
      <FilterChips
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'PENDING', label: 'Pending' },
          { value: 'APPROVED', label: 'Approved' },
          { value: 'REJECTED', label: 'Rejected' },
          { value: '', label: 'All' }
        ]}
      />

      {state.loading && !state.data ? <Loading /> : null}
      {state.error && !state.data ? <ErrorState message={state.error} onRetry={state.reload} /> : null}
      {state.data && state.data.items.length === 0 ? (
        <Empty label="Nothing here." hint="A payout appears once a player requests one." />
      ) : null}

      {state.data?.items.map((item) => (
        <Card key={item.id}>
          <View style={styles.headerRow}>
            <View style={styles.flex}>
              <Text style={styles.username}>{item.user.username}</Text>
              <Text style={styles.muted}>{item.user.email ?? shortId(item.user.id)}</Text>
            </View>
            <Pill label={item.status} />
          </View>

          <Row label="Amount" value={`${formatAmount(item.amount)} ${item.currency}`} />
          <Row label="Network" value={item.network} />
          <Row label="Send to" value={item.address} />
          {item.deducted !== null ? <Row label="Returned on reject" value={`${formatAmount(item.deducted)} USDT`} /> : null}
          <Row label="Requested" value={formatDateTime(item.createdAt)} />
          {item.reviewedAt ? <Row label="Reviewed" value={`${formatDateTime(item.reviewedAt)}${item.reviewedBy ? ` by ${item.reviewedBy.username}` : ''}`} /> : null}
          {item.rejectReason ? <Row label="Reason" value={item.rejectReason} /> : null}

          {item.matchHistory && item.matchHistory.length > 0 ? (
            <>
              <Divider />
              <Text style={styles.historyTitle}>Recent matches</Text>
              {item.matchHistory.map((match) => (
                <MatchLine key={match.matchId} match={match} />
              ))}
            </>
          ) : null}

          {item.status === 'PENDING' ? (
            <View style={styles.actions}>
              <Button
                label="Approve"
                variant="primary"
                onPress={() => void approve(item)}
                loading={busyId === item.id}
                style={styles.flex}
              />
              <Button
                label="Reject"
                variant="danger"
                onPress={() => void reject(item)}
                disabled={busyId === item.id}
                style={styles.flex}
              />
            </View>
          ) : null}
        </Card>
      ))}
    </Screen>
  )
}

function MatchLine({ match }: { match: AdminWithdrawalMatch }) {
  const tone = match.result === 'WIN' ? colors.positive : match.result === 'LOSS' ? colors.negative : colors.muted
  return (
    <View style={styles.matchRow}>
      <Text style={[styles.matchResult, { color: tone }]}>{match.result}</Text>
      <Text style={styles.matchDetail} numberOfLines={1}>
        {match.mode} - {match.format} - {formatAmount(match.stake)} USDT vs {match.opponent ?? 'unknown'}
      </Text>
      <Text style={styles.muted}>{formatDateTime(match.finishedAt)}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  username: { color: colors.text, fontSize: 16, fontWeight: '700' },
  muted: { color: colors.muted, fontSize: 12 },
  historyTitle: { color: colors.muted, fontSize: 12, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
  matchRow: { gap: 2, paddingVertical: 3 },
  matchResult: { fontSize: 12, fontWeight: '700' },
  matchDetail: { color: colors.text, fontSize: 12 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm }
})
