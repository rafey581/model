import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Modal, Platform, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio'
import { useAuth } from '@/auth/AuthContext'
import { usePendingCounts } from '@/hooks/usePendingCounts'
import { Button } from '@/components/ui'
import { colors, radius, spacing } from '@/theme'

/** Stops a ring nobody answered, so a phone left on a desk does not ring forever. */
const RING_TIMEOUT_MS = 60_000

interface Ringing {
  title: string
  body: string
  href: string
}

/** Rings that were asked for from elsewhere in the app (the test button on More). */
const ringRequests = new Set<(alert: Ringing) => void>()

/** Rings this phone now, as a new request would. For the "Test ring" button. */
export function testRing(): void {
  for (const ring of ringRequests) ring({ title: 'Test ring', body: 'This is how a new deposit or withdrawal request sounds.', href: '/' })
}

/**
 * Phone alerts for staff, worked out inside the app.
 *
 * The app already re-reads what is waiting every few seconds (usePendingCounts). When
 * the number of deposits or withdrawals waiting goes up, a new request has arrived:
 * the phone loops the ringtone and shows a full-screen card until someone taps View or
 * Silence (or a minute passes).
 *
 * This works while the app is open. Ringing a phone whose app is closed needs a push
 * service (Google's Firebase on Android), which is deliberately not part of this app.
 */
export function PhoneAlerts(): ReactNode {
  const { token } = useAuth()
  const router = useRouter()
  const { counts, loaded } = usePendingCounts()
  const [ringing, setRinging] = useState<Ringing | null>(null)
  const player = useRef<AudioPlayer | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** What was waiting last time we looked; null until the first reading of a session. */
  const seen = useRef<{ deposits: number; withdrawals: number } | null>(null)

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

  // The latest startRing for the test button, which outlives any one render.
  const startRef = useRef(startRing)
  startRef.current = startRing

  useEffect(() => {
    if (Platform.OS !== 'web') {
      // Ring through the silent switch on iPhone: a payout waiting is the point.
      void setAudioModeAsync({ playsInSilentMode: true }).catch(() => undefined)
    }
    const request = (alert: Ringing) => startRef.current(alert)
    ringRequests.add(request)
    return () => {
      ringRequests.delete(request)
      stopRing()
      try {
        player.current?.remove()
      } catch {
        // Nothing to release.
      }
      player.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A new session starts from what is already waiting: those are on the dashboard, and
  // ringing for them on every sign-in would only teach staff to ignore the ring.
  useEffect(() => {
    seen.current = null
    if (!token) stopRing()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    if (!token || !loaded) return
    const previous = seen.current
    seen.current = { deposits: counts.deposits, withdrawals: counts.withdrawals }
    if (!previous) return
    const newDeposits = counts.deposits - previous.deposits
    const newWithdrawals = counts.withdrawals - previous.withdrawals
    if (newWithdrawals > 0) {
      startRing({ title: 'New withdrawal request', body: describe(newWithdrawals, 'payout', counts.withdrawals), href: '/withdrawals' })
    } else if (newDeposits > 0) {
      startRing({ title: 'New deposit request', body: describe(newDeposits, 'deposit', counts.deposits), href: '/deposits' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, loaded, counts.deposits, counts.withdrawals])

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

function describe(added: number, noun: string, waiting: number): string {
  const what = added === 1 ? `1 new ${noun} request` : `${added} new ${noun} requests`
  return `${what}. ${waiting} waiting in total.`
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
