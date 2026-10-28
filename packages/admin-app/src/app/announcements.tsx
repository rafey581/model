import { useState, type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { api } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import { formatDateTime } from '@/lib/format'
import { Button, Card, Empty, ErrorState, Field, Loading, Pill, Screen, SectionTitle } from '@/components/ui'
import { useDialog } from '@/components/ActionDialog'
import { useToast } from '@/components/Toast'
import { colors, spacing } from '@/theme'

interface Announcement {
  id: string
  title: string
  body: string
  createdAt: string
  withdrawnAt: string | null
}

const TITLE_MAX = 80
const BODY_MAX = 1000

/**
 * Announcements: one message to every player.
 *
 * Players who are online get it at once; everyone else sees it the next time they
 * open the game (for 30 days). Withdrawing one stops it being shown to anyone who has
 * not seen it yet.
 */
export default function AnnouncementsScreen(): ReactNode {
  const state = useAsync(() => api<Announcement[]>('/admin/announcements'), [])
  const dialog = useDialog()
  const toast = useToast()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const send = async (): Promise<void> => {
    const t = title.trim()
    const b = body.trim()
    if (!t || !b) {
      toast.show('Write a title and a message first.', 'error')
      return
    }
    const confirmed = await dialog.confirm({
      title: 'Send to every player?',
      message: `"${t}" goes to all players now. Players who are offline see it the next time they open the game.`,
      confirmLabel: 'Send'
    })
    if (!confirmed.confirmed) return
    setSending(true)
    try {
      await api<Announcement>('/admin/announcements', { method: 'POST', body: { title: t, body: b } })
      setTitle('')
      setBody('')
      toast.show('Announcement sent.', 'success')
      state.reload()
    } catch (caught) {
      toast.show((caught as Error).message, 'error')
    } finally {
      setSending(false)
    }
  }

  const withdraw = async (item: Announcement): Promise<void> => {
    const confirmed = await dialog.confirm({
      title: 'Withdraw announcement?',
      message: `"${item.title}" will no longer be shown to players who have not seen it yet.`,
      confirmLabel: 'Withdraw',
      destructive: true
    })
    if (!confirmed.confirmed) return
    setBusyId(item.id)
    try {
      await api<Announcement>(`/admin/announcements/${item.id}/withdraw`, { method: 'POST', body: {} })
      toast.show('Announcement withdrawn.', 'success')
      state.reload()
    } catch (caught) {
      toast.show((caught as Error).message, 'error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Screen refreshing={state.refreshing} onRefresh={state.reload}>
      <Card>
        <Text style={styles.cardTitle}>New announcement</Text>
        <Field label="Title" value={title} onChangeText={setTitle} maxLength={TITLE_MAX} autoCapitalize="sentences" placeholder="e.g. Weekend tournament" />
        <Field
          label="Message"
          value={body}
          onChangeText={setBody}
          maxLength={BODY_MAX}
          multiline
          autoCapitalize="sentences"
          autoCorrect
          placeholder="What every player should know"
          style={styles.message}
          hint={`${body.length}/${BODY_MAX}`}
        />
        <Button label="Send to all players" variant="primary" onPress={() => void send()} loading={sending} />
      </Card>

      <SectionTitle>Sent</SectionTitle>
      {state.loading && !state.data ? <Loading /> : null}
      {state.error && !state.data ? <ErrorState message={state.error} onRetry={state.reload} /> : null}
      {state.data && state.data.length === 0 ? <Empty label="No announcements yet." /> : null}
      {state.data?.map((item) => (
        <Card key={item.id}>
          <View style={styles.row}>
            <Text style={styles.itemTitle}>{item.title}</Text>
            <Pill label={item.withdrawnAt ? 'WITHDRAWN' : 'ACTIVE'} tone={item.withdrawnAt ? 'REJECTED' : 'ACTIVE'} />
          </View>
          <Text style={styles.itemBody}>{item.body}</Text>
          <Text style={styles.meta}>
            Sent {formatDateTime(item.createdAt)}
            {item.withdrawnAt ? ` · withdrawn ${formatDateTime(item.withdrawnAt)}` : ''}
          </Text>
          {!item.withdrawnAt ? (
            <Button label="Withdraw" variant="ghost" onPress={() => void withdraw(item)} loading={busyId === item.id} />
          ) : null}
        </Card>
      ))}
    </Screen>
  )
}

const styles = StyleSheet.create({
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  message: { minHeight: 110, textAlignVertical: 'top' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  itemTitle: { color: colors.text, fontSize: 15, fontWeight: '700', flex: 1 },
  itemBody: { color: colors.text, fontSize: 14, lineHeight: 20 },
  meta: { color: colors.muted, fontSize: 12 }
})
