import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { api } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import { formatAmount, humanize, shortId } from '@/lib/format'
import type { AdminMatch } from '@/lib/types'
import { Card, Empty, ErrorState, Loading, Pill, Row, Screen } from '@/components/ui'
import { colors, spacing } from '@/theme'

/**
 * Every match, newest first, with the players and the money that was at stake.
 * Tapping a row opens the same match with its full replay.
 */
export default function MatchesScreen() {
  const router = useRouter()
  const state = useAsync(() => api<AdminMatch[]>('/admin/matches'), [])

  if (state.loading && !state.data) return <Screen scroll={false}><Loading /></Screen>
  if (state.error && !state.data) return <Screen><ErrorState message={state.error} onRetry={state.reload} /></Screen>

  const matches = state.data ?? []

  return (
    <Screen refreshing={state.refreshing} onRefresh={state.reload}>
      {matches.length === 0 ? <Empty label="No matches recorded yet." /> : null}
      {matches.map((match) => {
        const players = match.players.map((player) => player.user.username).join(' vs ') || '(empty table)'
        const winner = match.players.find((player) => player.userId === match.winnerId)?.user.username
        return (
          <Pressable key={match.id} onPress={() => router.push(`/match/${match.id}` as never)}>
            <Card>
              <View style={styles.headerRow}>
                <Text style={styles.players} numberOfLines={1}>
                  {players}
                </Text>
                <Pill label={humanize(match.status)} tone={match.status} />
              </View>
              <Row label="Mode" value={`${humanize(match.matchType)} - ${match.format}`} />
              <Row label="Stake per player" value={`${formatAmount(match.stakePerPlayer)} USDT`} />
              <Row label="Winner" value={winner ?? (match.winnerId ? shortId(match.winnerId) : 'undecided')} />
              <Row label="Match id" value={shortId(match.id, 12)} />
              <Text style={styles.replayHint}>Tap to open the replay</Text>
            </Card>
          </Pressable>
        )
      })}
    </Screen>
  )
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  players: { color: colors.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  replayHint: { color: colors.info, fontSize: 12, marginTop: spacing.xs }
})
