import { useCallback, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { api } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import { usePendingCounts } from '@/hooks/usePendingCounts'
import { formatRelative, truncate } from '@/lib/format'
import type { SupportStatus, SupportThreadRow } from '@/lib/types'
import { Empty, ErrorState, Loading, Pill, Screen, ScreenTitle } from '@/components/ui'
import { FilterChips } from '@/components/FilterChips'
import { colors, radius, spacing } from '@/theme'

type Filter = '' | SupportStatus

/**
 * The support inbox: one row per player, newest activity first.
 *
 * Threads with something unread carry a count and sort to where the eye lands, and
 * the list re-reads whenever the tab comes back into focus, so returning from a
 * conversation shows it as answered.
 */
export default function SupportInboxScreen() {
  const router = useRouter()
  const [filter, setFilter] = useState<Filter>('OPEN')
  const pending = usePendingCounts()
  const state = useAsync(
    () => api<SupportThreadRow[]>(`/admin/support/threads${filter ? `?status=${filter}` : ''}`),
    [filter]
  )

  useFocusEffect(
    useCallback(() => {
      state.reload()
      pending.refresh()
      // Re-read on every focus; the loaders themselves are stable.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
  )

  const rows = state.data ?? []
  const awaiting = rows.filter((r) => r.unreadCount > 0).length

  return (
    <Screen refreshing={state.refreshing} onRefresh={state.reload}>
      <ScreenTitle
        title="Support"
        subtitle={state.data ? `${awaiting} awaiting a reply` : 'Loading...'}
      />
      <FilterChips
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'OPEN', label: 'Open' },
          { value: 'CLOSED', label: 'Closed' },
          { value: '', label: 'All' }
        ]}
      />

      {state.loading && !state.data ? <Loading /> : null}
      {state.error && !state.data ? <ErrorState message={state.error} onRetry={state.reload} /> : null}
      {state.data && rows.length === 0 ? (
        <Empty
          label={filter === 'CLOSED' ? 'No closed conversations.' : 'No conversations here.'}
          hint="A conversation appears as soon as a player writes to support."
        />
      ) : null}

      {rows.map((row) => {
        const unread = row.unreadCount > 0
        const last = row.lastMessage
        return (
          <Pressable
            key={row.id}
            accessibilityRole="button"
            accessibilityLabel={`Conversation with ${row.user.username}${unread ? `, ${row.unreadCount} unread` : ''}`}
            onPress={() => router.push(`/support/${row.id}` as never)}
            style={({ pressed }) => [styles.row, unread ? styles.rowUnread : null, pressed ? styles.rowPressed : null]}
          >
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{row.user.username.slice(0, 1).toUpperCase()}</Text>
            </View>
            <View style={styles.flex}>
              <View style={styles.topLine}>
                <Text style={[styles.name, unread ? styles.nameUnread : null]} numberOfLines={1}>
                  {row.user.username}
                </Text>
                <Text style={styles.time}>{formatRelative(row.lastMessageAt)}</Text>
              </View>
              <Text style={[styles.preview, unread ? styles.previewUnread : null]} numberOfLines={2}>
                {last ? `${last.senderRole === 'ADMIN' ? 'You: ' : ''}${truncate(last.body, 140)}` : 'No messages yet'}
              </Text>
              <View style={styles.metaLine}>
                {row.status === 'CLOSED' ? <Pill label="CLOSED" /> : null}
                {row.assignedTo ? <Text style={styles.meta}>Handled by {row.assignedTo.username}</Text> : null}
              </View>
            </View>
            {unread ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{row.unreadCount > 99 ? '99+' : row.unreadCount}</Text>
              </View>
            ) : null}
          </Pressable>
        )
      })}
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.lg
  },
  rowUnread: { borderColor: colors.accent },
  rowPressed: { backgroundColor: colors.surfaceAlt },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft
  },
  avatarText: { color: colors.accent, fontSize: 16, fontWeight: '700' },
  topLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '600' },
  nameUnread: { fontWeight: '800' },
  time: { color: colors.muted, fontSize: 12 },
  preview: { color: colors.muted, fontSize: 13, marginTop: 2, lineHeight: 18 },
  previewUnread: { color: colors.text },
  metaLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 6 },
  meta: { color: colors.muted, fontSize: 11 },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
    alignSelf: 'center'
  },
  badgeText: { color: '#10141c', fontSize: 12, fontWeight: '800' }
})
