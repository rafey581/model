import { useState } from 'react'
import { Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { api } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import { usePendingCounts } from '@/hooks/usePendingCounts'
import { formatAmount, formatDateTime, shortId } from '@/lib/format'
import type { AdminDeposit, AdminDepositsPayload, ReviewStatus } from '@/lib/types'
import { Button, Card, Empty, ErrorState, Loading, Pill, Row, Screen, ScreenTitle, SectionTitle } from '@/components/ui'
import { FilterChips } from '@/components/FilterChips'
import { useDialog } from '@/components/ActionDialog'
import { useToast } from '@/components/Toast'
import { colors, spacing } from '@/theme'

type Filter = '' | ReviewStatus

/**
 * Deposit review.
 *
 * Approving a deposit moves real money into a player's balance, so the confirm
 * step names the amount and the player rather than asking "are you sure?". The
 * reject step collects a reason the player will see.
 */
export default function DepositsScreen() {
  const [filter, setFilter] = useState<Filter>('PENDING')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [openShot, setOpenShot] = useState<string | null>(null)
  const state = useAsync(
    () => api<AdminDepositsPayload>(`/admin/deposits${filter ? `?status=${filter}` : ''}`),
    [filter]
  )
  const dialog = useDialog()
  const toast = useToast()
  const pending = usePendingCounts()

  const approve = async (item: AdminDeposit): Promise<void> => {
    const result = await dialog.confirm({
      title: 'Approve deposit?',
      message: `${formatAmount(item.amount)} ${item.currency} from ${item.user.username} will be credited to their balance now.`,
      confirmLabel: 'Approve'
    })
    if (!result.confirmed) return
    setBusyId(item.id)
    try {
      const approved = await api<{ credited: number }>(`/admin/deposits/${item.id}/approve`, { method: 'POST', body: {} })
      toast.show(`Credited ${formatAmount(approved.credited)} USDT to ${item.user.username}`, 'success')
      state.reload()
      pending.refresh()
    } catch (caught) {
      toast.show((caught as Error).message, 'error')
    } finally {
      setBusyId(null)
    }
  }

  const reject = async (item: AdminDeposit): Promise<void> => {
    const result = await dialog.confirm({
      title: 'Reject deposit?',
      message: `${formatAmount(item.amount)} ${item.currency} from ${item.user.username} will not be credited.`,
      confirmLabel: 'Reject',
      destructive: true,
      withReason: true,
      reasonPlaceholder: 'Reason the player will see (optional)'
    })
    if (!result.confirmed) return
    setBusyId(item.id)
    try {
      await api(`/admin/deposits/${item.id}/reject`, {
        method: 'POST',
        body: result.reason ? { reason: result.reason } : {}
      })
      toast.show('Deposit rejected', 'info')
      state.reload()
      pending.refresh()
    } catch (caught) {
      toast.show((caught as Error).message, 'error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Screen refreshing={state.refreshing} onRefresh={state.reload}>
      <ScreenTitle
        title="Deposits"
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
        <Empty label="Nothing here." hint="Deposits show up as soon as a player submits crypto." />
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
          <Row label="Paid to" value={item.address} />
          {item.txHash ? <Row label="Tx id" value={item.txHash} valueStyle={styles.mono} /> : null}
          {item.creditedAmount !== null ? <Row label="Credited" value={`${formatAmount(item.creditedAmount)} USDT`} /> : null}
          <Row label="Submitted" value={formatDateTime(item.createdAt)} />
          {item.reviewedAt ? <Row label="Reviewed" value={`${formatDateTime(item.reviewedAt)}${item.reviewedBy ? ` by ${item.reviewedBy.username}` : ''}`} /> : null}
          {item.rejectReason ? <Row label="Reason" value={item.rejectReason} /> : null}

          {item.screenshot ? (
            <>
              <Pressable onPress={() => setOpenShot(openShot === item.id ? null : item.id)}>
                <Text style={styles.link}>{openShot === item.id ? 'Hide proof' : 'Show proof'}</Text>
              </Pressable>
              {openShot === item.id ? (
                <Image source={{ uri: item.screenshot }} style={styles.screenshot} resizeMode="contain" />
              ) : null}
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

      <SectionTitle>Notes</SectionTitle>
      <Card>
        <Text style={styles.notes}>
          The screenshot is the player's proof of transfer. Look the tx id up on a Solana explorer (press and
          hold it to copy) and check the token (USDT or USDC, as shown on the request), the amount and the
          receiving address match before approving. Both coins are credited 1:1. A tx id can only be submitted once.
        </Text>
      </Card>
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  username: { color: colors.text, fontSize: 16, fontWeight: '700' },
  muted: { color: colors.muted, fontSize: 12 },
  link: { color: colors.info, fontSize: 13, fontWeight: '600' },
  screenshot: {
    width: '100%',
    height: 260,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 10,
    marginTop: spacing.sm
  },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  notes: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }), fontSize: 12 }
})
