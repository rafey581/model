import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Modal, Platform, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import * as Notifications from 'expo-notifications'
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio'
import { useAuth } from '@/auth/AuthContext'
import { usePendingCounts } from '@/hooks/usePendingCounts'
import { registerForPush } from '@/lib/push'
import { Button } from '@/components/ui'
import { colors, radius, spacing } from '@/theme'

/** Stops a ring nobody answered, so a phone left on a desk does not ring forever. */
const RING_TIMEOUT_MS = 60_000

interface Ringing {
  title: string
  body: string
  href: string
}

// While the app is open, a money request is announced by the looping in-app ring
// below rather than the system sound (which would play once, under it).
if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const ring = (notification.request.content.data as { ring?: boolean } | undefined)?.ring === true
      return { shouldShowBanner: !ring, shouldShowList: true, shouldPlaySound: !ring, shouldSetBadge: false }
    }
  })
}

/**
 * Phone alerts for staff: registers this phone once signed in, rings while the app is
 * open when a deposit or payout request arrives, and opens the right screen when a
 * notification is tapped.
 *
 * With the app closed the system plays the ring channel's 24-second ringtone; with it
 * open, this component loops the same ringtone and shows a full-screen card until
 * someone taps View or Silence (or a minute passes).
 */
export function PhoneAlerts(): ReactNode {
  const { token } = useAuth()
  const router = useRouter()
  const pending = usePendingCounts()
  const [ringing, setRinging] = useState<Ringing | null>(null)
  const player = useRef<AudioPlayer | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The listeners below are installed once; these keep them pointed at the current
  // router and badge refresher (which changes when a session starts).
  const routerRef = useRef(router)
  const refreshRef = useRef(pending.refresh)
  routerRef.current = router
  refreshRef.current = pending.refresh

  const stopRing = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    try {
      player.current?.pause()
      player.current?.seekTo(0)
    } catch {
      // Already stopped.
    }
    setRinging(null)
  }

  const startRing = (alert: Ringing): void => {
    setRinging(alert)
    try {
      if (!player.current) {
        player.current = createAudioPlayer(require('../../assets/sounds/ring.wav'))
        player.current.loop = true
      }
      player.current.seekTo(0)
      player.current.play()
    } catch {
      // No audio (muted output, web): the card still shows.
    }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(stopRing, RING_TIMEOUT_MS)
  }

  // Register this phone whenever a session starts.
  useEffect(() => {
    if (!token || Platform.OS === 'web') return
    void registerForPush()
  }, [token])

  useEffect(() => {
    if (Platform.OS === 'web') return
    // Ring through the silent switch on iPhone: a payout waiting is the point.
    void setAudioModeAsync({ playsInSilentMode: true }).catch(() => undefined)

    const received = Notifications.addNotificationReceivedListener((notification) => {
      const content = notification.request.content
      const data = (content.data ?? {}) as { ring?: boolean; href?: string }
      refreshRef.current()
      if (data.ring) startRing({ title: content.title ?? 'New request', body: content.body ?? '', href: data.href ?? '/' })
    })
    const tapped = Notifications.addNotificationResponseReceivedListener((response) => {
      const href = (response.notification.request.content.data as { href?: string } | undefined)?.href
      stopRing()
      refreshRef.current()
      if (href) routerRef.current.push(href as never)
    })
    return () => {
      received.remove()
      tapped.remove()
      stopRing()
      player.current?.remove()
      player.current = null
    }
    // Installed once; current router and refresher come through the refs above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Signing out silences anything ringing.
  useEffect(() => {
    if (!token) stopRing()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  return (
    <Modal visible={ringing !== null} transparent animationType="fade" onRequestClose={stopRing}>
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityRole="alert">
          <Text style={styles.bell}>RINGING</Text>
          <Text style={styles.title}>{ringing?.title}</Text>
          {ringing?.body ? <Text style={styles.body}>{ringing.body}</Text> : null}
          <View style={styles.actions}>
            <Button label="Silence" variant="ghost" onPress={stopRing} style={styles.flex} />
            <Button
              label="View"
              variant="primary"
              onPress={() => {
                const href = ringing?.href ?? '/'
                stopRing()
                router.push(href as never)
              }}
              style={styles.flex}
            />
          </View>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', padding: spacing.xl },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.accent,
    borderWidth: 2,
    borderRadius: radius.lg,
    padding: spacing.xl,
    gap: spacing.md
  },
  bell: { color: colors.accent, fontSize: 12, fontWeight: '800', letterSpacing: 2 },
  title: { color: colors.text, fontSize: 22, fontWeight: '800' },
  body: { color: colors.text, fontSize: 15, lineHeight: 21 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm }
})
