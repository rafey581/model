import { useEffect, useState } from 'react'
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useAuth } from '@/auth/AuthContext'
import { apiBaseUrl } from '@/lib/config'
import { Button, Card, Row, Screen, ScreenTitle } from '@/components/ui'
import { useDialog } from '@/components/ActionDialog'
import { useToast } from '@/components/Toast'
import { pushStatus, registerForPush, sendTestRing, type PushStatus } from '@/lib/push'
import { colors, radius, spacing } from '@/theme'

/**
 * The things that do not need a tab.
 *
 * Matches, settings, fraud and the audit log are occasional visits, so they live
 * here rather than competing for thumb space with the money screens. Sign-out is
 * confirmed because an accidental tap mid-review costs the whole session.
 */
type IconName = keyof typeof Ionicons.glyphMap

const ITEMS: Array<{ href: string; label: string; description: string; icon: IconName }> = [
  { href: '/matches', label: 'Matches', description: 'History and stroke-by-stroke replay', icon: 'game-controller-outline' },
  { href: '/settings', label: 'Settings', description: 'Stakes, commission, maintenance mode', icon: 'options-outline' },
  { href: '/fraud', label: 'Fraud and ledger', description: 'Risk flags and balance reconciliation', icon: 'shield-checkmark-outline' },
  { href: '/audit', label: 'Admin audit log', description: 'Every staff action, in order', icon: 'list-outline' }
]

export default function MoreScreen() {
  const router = useRouter()
  const { admin, signOut } = useAuth()
  const dialog = useDialog()
  const toast = useToast()
  const [alerts, setAlerts] = useState<PushStatus | null>(pushStatus())
  const [alertsBusy, setAlertsBusy] = useState(false)

  useEffect(() => {
    // Registration starts at sign-in; pick up its result if it finished after mount.
    const timer = setInterval(() => setAlerts(pushStatus()), 1000)
    return () => clearInterval(timer)
  }, [])

  const enableAlerts = async (): Promise<void> => {
    setAlertsBusy(true)
    setAlerts(await registerForPush())
    setAlertsBusy(false)
  }

  const testRing = async (): Promise<void> => {
    setAlertsBusy(true)
    try {
      const result = await sendTestRing()
      toast.show(result.accepted > 0 ? 'Test sent. Your phone should ring now.' : 'Expo did not accept the test; check the server logs.', result.accepted > 0 ? 'success' : 'error')
    } catch (caught) {
      toast.show((caught as Error).message, 'error')
    } finally {
      setAlertsBusy(false)
    }
  }

  const confirmSignOut = async (): Promise<void> => {
    const result = await dialog.confirm({
      title: 'Sign out?',
      message: 'You will need your email and password to sign back in.',
      confirmLabel: 'Sign out',
      destructive: true
    })
    if (result.confirmed) await signOut()
  }

  return (
    <Screen>
      <ScreenTitle title="More" />

      <Card>
        <Row label="Signed in as" value={admin?.username ?? '-'} />
        <Row label="Role" value={admin?.role ?? '-'} />
        <Row label="Server" value={apiBaseUrl()} />
      </Card>

      <Card>
        <Text style={styles.cardTitle}>Phone alerts</Text>
        <Text style={styles.rowDescription}>
          New deposit and withdrawal requests ring this phone like a call, even when the app is closed.
        </Text>
        <Row label="Status" value={alertsLabel(alerts)} />
        {alerts?.state === 'denied' ? (
          <Text style={styles.hint}>Notifications are blocked. Allow them for Snooker Admin in the phone settings, then tap Turn on.</Text>
        ) : null}
        {alerts?.state === 'error' || alerts?.state === 'unsupported' ? <Text style={styles.hint}>{alerts.reason}</Text> : null}
        {Platform.OS !== 'web' ? (
          <View style={styles.alertActions}>
            {alerts?.state !== 'registered' ? (
              <Button label="Turn on" variant="primary" onPress={() => void enableAlerts()} loading={alertsBusy} style={styles.flex} />
            ) : (
              <Button label="Send test ring" variant="subtle" onPress={() => void testRing()} loading={alertsBusy} style={styles.flex} />
            )}
          </View>
        ) : null}
      </Card>

      <View style={styles.list}>
        {ITEMS.map((item) => (
          <Pressable
            key={item.href}
            accessibilityRole="button"
            onPress={() => router.push(item.href as never)}
            style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
          >
            <View style={styles.iconWrap}>
              <Ionicons name={item.icon} size={20} color={colors.accent} />
            </View>
            <View style={styles.flex}>
              <Text style={styles.rowLabel}>{item.label}</Text>
              <Text style={styles.rowDescription}>{item.description}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </Pressable>
        ))}
      </View>

      <Button label="Sign out" variant="danger" onPress={() => void confirmSignOut()} />
    </Screen>
  )
}

function alertsLabel(status: PushStatus | null): string {
  if (!status) return Platform.OS === 'web' ? 'Not available on web' : 'Setting up...'
  switch (status.state) {
    case 'registered':
      return 'On for this phone'
    case 'denied':
      return 'Blocked in phone settings'
    case 'unsupported':
      return 'Not available here'
    case 'error':
      return 'Could not turn on'
  }
}

const styles = StyleSheet.create({
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  hint: { color: colors.warning, fontSize: 12, lineHeight: 17 },
  alertActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  flex: { flex: 1 },
  list: { gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.lg
  },
  rowPressed: { backgroundColor: colors.surfaceAlt },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft
  },
  rowLabel: { color: colors.text, fontSize: 15, fontWeight: '600' },
  rowDescription: { color: colors.muted, fontSize: 12, marginTop: 2 }
})
