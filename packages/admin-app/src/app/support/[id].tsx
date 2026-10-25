import { useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { api } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import { usePendingCounts } from '@/hooks/usePendingCounts'
import { formatDate, formatDateTime } from '@/lib/format'
import type { SupportMessage, SupportStatus, SupportThreadDetail } from '@/lib/types'
import { Button, ErrorState, Loading, Pill } from '@/components/ui'
import { useDialog } from '@/components/ActionDialog'
import { useToast } from '@/components/Toast'
import { colors, radius, spacing } from '@/theme'

const POLL_MS = 10_000
const MAX_LENGTH = 2000

/**
 * One support conversation.
 *
 * Opening it marks the player's messages read (server side). New player messages
 * are picked up by a light poll while the screen is open, so staff can stay on a
 * live conversation without pulling to refresh. Sending is optimistic only in the
 * sense that the box clears at once; the message is appended from the server's
 * answer, so what staff see is exactly what was stored.
 */
export default function SupportThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const threadId = typeof id === 'string' ? id : ''
  const state = useAsync(() => api<SupportThreadDetail>(`/admin/support/thread/${threadId}`), [threadId])
  const [thread, setThread] = useState<SupportThreadDetail | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [statusBusy, setStatusBusy] = useState(false)
  const scrollRef = useRef<ScrollView>(null)
  const pending = usePendingCounts()
  const dialog = useDialog()
  const toast = useToast()

  useEffect(() => {
    if (state.data) {
      setThread(state.data)
      pending.refresh()
    }
    // `pending.refresh` is stable per session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.data])

  useEffect(() => {
    if (!threadId) return
    const timer = setInterval(() => {
      api<SupportThreadDetail>(`/admin/support/thread/${threadId}`)
        .then((fresh) => {
          setThread((current) => (current && fresh.messages.length === current.messages.length && fresh.status === current.status ? current : fresh))
        })
        .catch(() => undefined)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [threadId])

  const send = async (): Promise<void> => {
    const body = draft.trim()
    if (!body || sending || !thread) return
    setSending(true)
    try {
      const message = await api<SupportMessage>(`/admin/support/thread/${thread.id}/reply`, { method: 'POST', body: { body } })
      setDraft('')
      setThread({ ...thread, status: 'OPEN', messages: [...thread.messages, message] })
      pending.refresh()
    } catch (caught) {
      toast.show((caught as Error).message, 'error')
    } finally {
      setSending(false)
    }
  }

  const setStatus = async (next: SupportStatus): Promise<void> => {
    if (!thread) return
    if (next === 'CLOSED') {
      const result = await dialog.confirm({
        title: 'Close conversation?',
        message: `Mark ${thread.user.username}'s conversation resolved. It reopens by itself if they write again.`,
        confirmLabel: 'Close'
      })
      if (!result.confirmed) return
    }
    setStatusBusy(true)
    try {
      await api(`/admin/support/thread/${thread.id}/${next === 'CLOSED' ? 'close' : 'reopen'}`, { method: 'POST', body: {} })
      setThread({ ...thread, status: next })
      toast.show(next === 'CLOSED' ? 'Conversation closed' : 'Conversation reopened', 'info')
      pending.refresh()
    } catch (caught) {
      toast.show((caught as Error).message, 'error')
    } finally {
      setStatusBusy(false)
    }
  }

  if (!thread) {
    return (
      <View style={styles.page}>
        <Stack.Screen options={{ title: 'Conversation' }} />
        {state.error ? <ErrorState message={state.error} onRetry={state.reload} /> : <Loading />}
      </View>
    )
  }

  const closed = thread.status === 'CLOSED'

  return (
    <SafeAreaView style={styles.page} edges={['bottom', 'left', 'right']}>
      <Stack.Screen options={{ title: thread.user.username }} />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
        <View style={styles.header}>
          <View style={styles.flex}>
            <Text style={styles.headerName}>{thread.user.username}</Text>
            <Text style={styles.headerMeta} selectable>
              {[thread.user.email, thread.user.phone].filter(Boolean).join(' - ') || 'No contact details'}
            </Text>
            <Text style={styles.headerMeta}>
              Player since {formatDate(thread.user.createdAt)}
              {thread.user.status !== 'ACTIVE' ? ` - account ${thread.user.status.toLowerCase()}` : ''}
              {thread.assignedTo ? ` - handled by ${thread.assignedTo.username}` : ''}
            </Text>
          </View>
          <View style={styles.headerSide}>
            <Pill label={thread.status} tone={closed ? undefined : 'ACTIVE'} />
            <Button
              label={closed ? 'Reopen' : 'Close'}
              variant="subtle"
              onPress={() => void setStatus(closed ? 'OPEN' : 'CLOSED')}
              loading={statusBusy}
              style={styles.statusButton}
            />
          </View>
        </View>

        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.messages}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
          keyboardShouldPersistTaps="handled"
        >
          {thread.messages.length === 0 ? <Text style={styles.empty}>No messages yet.</Text> : null}
          {thread.messages.map((message) => {
            const mine = message.senderRole === 'ADMIN'
            return (
              <View key={message.id} style={[styles.bubbleRow, mine ? styles.bubbleRowMine : null]}>
                <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
                  <Text style={[styles.bubbleText, mine ? styles.bubbleTextMine : null]} selectable>
                    {message.body}
                  </Text>
                </View>
                <Text style={styles.bubbleMeta}>
                  {mine ? `${message.sender.username} (staff)` : thread.user.username} - {formatDateTime(message.createdAt)}
                </Text>
              </View>
            )
          })}
        </ScrollView>

        <View style={styles.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={closed ? 'Replying reopens the conversation...' : 'Write a reply...'}
            placeholderTextColor={colors.muted}
            style={styles.input}
            multiline
            maxLength={MAX_LENGTH}
            editable={!sending}
            accessibilityLabel="Reply"
          />
          <Button label="Send" variant="primary" onPress={() => void send()} loading={sending} disabled={!draft.trim()} />
        </View>
        {draft.length > MAX_LENGTH - 200 ? (
          <Text style={styles.counter}>
            {draft.length}/{MAX_LENGTH}
          </Text>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  page: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.lg,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    backgroundColor: colors.surface
  },
  headerName: { color: colors.text, fontSize: 17, fontWeight: '700' },
  headerMeta: { color: colors.muted, fontSize: 12, marginTop: 2 },
  headerSide: { alignItems: 'flex-end', gap: spacing.sm },
  statusButton: { minHeight: 34, paddingVertical: 6 },
  messages: { padding: spacing.lg, gap: spacing.md },
  empty: { color: colors.muted, textAlign: 'center', marginTop: spacing.xl },
  bubbleRow: { alignItems: 'flex-start', maxWidth: '85%' },
  bubbleRowMine: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  bubble: { borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  bubbleTheirs: { backgroundColor: colors.surfaceAlt, borderTopLeftRadius: 4 },
  bubbleMine: { backgroundColor: colors.accent, borderTopRightRadius: 4 },
  bubbleText: { color: colors.text, fontSize: 14, lineHeight: 20 },
  bubbleTextMine: { color: '#10141c' },
  bubbleMeta: { color: colors.muted, fontSize: 11, marginTop: 3 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    padding: spacing.md,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    backgroundColor: colors.surface
  },
  input: {
    flex: 1,
    maxHeight: 140,
    minHeight: 42,
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 15
  },
  counter: { color: colors.muted, fontSize: 11, textAlign: 'right', paddingHorizontal: spacing.md, paddingBottom: spacing.xs }
})
